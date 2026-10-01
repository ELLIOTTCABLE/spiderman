import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { HOOK_PATH, type HookReply } from "../core/protocol.ts"
import { STANDING_FOR_B } from "../core/standing.ts"
import spiderman from "./extension.ts"

type Handler = (event: unknown, ctx: unknown) => unknown

/** The slice of pi's API the extension uses, recorded. */
function fakePi(
   cwd: string,
   provider = "openai-codex",
   flagValues: Record<string, string> = { "spiderman-strategy": "off" },
) {
   const handlers = new Map<string, Handler>()
   const flags = new Map<string, string>(Object.entries(flagValues))
   const elisions: { model: string; options: Record<string, unknown> }[] = []
   const catalog = new Map([
      ["openai-codex/gpt-6-sol", { provider: "openai-codex", id: "gpt-6-sol" }],
      ["openai/gpt-6-sol", { provider: "openai", id: "gpt-6-sol" }],
   ])
   const sent: string[] = []
   const notices: string[] = []
   const branch: {
      type: string
      id: string
      message?: unknown
      customType?: string
      data?: unknown
   }[] = []
   const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
   const ctx = {
      cwd,
      model: { provider, id: "gpt-6-astra" },
      thinkingLevel: "high",
      modelRegistry: {
         find: (p: string, id: string) => catalog.get(`${p}/${id}`),
         streamSimple(
            model: { provider: string; id: string },
            _context: unknown,
            options: Record<string, unknown>,
         ) {
            elisions.push({ model: `${model.provider}/${model.id}`, options })
            return {
               result: async () => ({
                  content: [{ type: "text", text: "1" }],
                  stopReason: "stop",
                  usage: {},
               }),
            }
         },
      },
      isIdle: () => true,
      abort: () => {},
      ui: { notify: (message: string) => void notices.push(message) },
      sessionManager: {
         getSessionFile: () => undefined,
         getSessionId: () => "pi-session",
         getLeafId: () => branch.at(-1)?.id ?? null,
         getLeafEntry: () => branch.at(-1),
         getBranch: () => branch,
      },
   }
   const commandCtx = {
      ...ctx,
      async navigateTree(targetId: string) {
         const verdict = handlers.get("session_before_tree")?.(
            { type: "session_before_tree", preparation: { targetId } },
            ctx,
         ) as { cancel?: boolean } | undefined
         if (verdict?.cancel) return { cancelled: true }
         branch.splice(branch.findIndex((e) => e.id === targetId) + 1)
         return { cancelled: false }
      },
   }
   const pi = {
      registerFlag: (name: string, options: { default: string }) => {
         if (!flags.has(name)) flags.set(name, options.default)
      },
      getFlag: (name: string) => flags.get(name),
      on: (event: string, handler: Handler) => void handlers.set(event, handler),
      registerCommand: (
         name: string,
         options: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => void commands.set(name, options.handler),
      sendUserMessage(text: string, options?: { expandPromptTemplates?: boolean }) {
         const [, name, args] = /^\/(\S+)\s*(.*)$/s.exec(text) ?? []
         const command = name === undefined ? undefined : commands.get(name)
         if (options?.expandPromptTemplates && command !== undefined)
            setImmediate(() => void command(args ?? "", commandCtx))
         else sent.push(text)
      },
      appendEntry: (customType: string, data: unknown) =>
         void branch.push({ type: "custom", id: `c${branch.length}`, customType, data }),
   }
   spiderman(pi as unknown as ExtensionAPI)
   const emit = (event: string, payload: unknown = {}) =>
      handlers.get(event)?.(payload, ctx)
   const command = (name: string, args: string) => commands.get(name)?.(args, commandCtx)
   return { emit, sent, notices, branch, elisions, command }
}

async function until(condition: () => boolean) {
   for (let i = 0; i < 200 && !condition(); i++)
      await new Promise((resolve) => setImmediate(resolve))
   assert.ok(condition(), "condition never held")
}

const assistant = (id: string, text: string) => ({
   type: "message",
   id,
   message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
})

async function post(cwd: string, body: unknown): Promise<HookReply> {
   const peer = JSON.parse(readFileSync(join(cwd, ".spiderman", "peer.json"), "utf8"))
   const res = await fetch(`http://127.0.0.1:${peer.port}${HOOK_PATH}`, {
      method: "POST",
      headers: {
         authorization: `Bearer ${peer.token}`,
         "content-type": "application/json",
      },
      body: JSON.stringify(body),
   })
   return (await res.json()) as HookReply
}

test("the extension pairs, relays a turn, and cleans up after itself", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd)
   try {
      await pi.emit("session_start", { reason: "startup" })
      assert.equal(readFileSync(join(cwd, ".spiderman", ".gitignore"), "utf8"), "*\n")
      const common = { ccSessionId: "cc", transcriptPath: join(cwd, "none.jsonl"), cwd }
      assert.deepEqual(
         await post(cwd, { kind: "session-start", source: "startup", ...common }),
         {},
      )

      await post(cwd, {
         kind: "prompt",
         prompt: "U1",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      assert.deepEqual(pi.sent, ["[the human's message]\nU1"])

      pi.emit("agent_start")
      pi.branch.push({
         type: "message",
         id: "m1",
         message: {
            role: "assistant",
            content: [{ type: "text", text: "B's answer." }],
            stopReason: "stop",
         },
      })
      pi.emit("agent_settled")
      const shown = await post(cwd, {
         kind: "stop",
         lastAssistantMessage: "A's answer.",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ccSessionId: "cc",
         transcriptPath: common.transcriptPath,
      })
      assert.match(shown.systemMessage ?? "", /B's answer\.$/)
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      assert.equal(existsSync(join(cwd, ".spiderman", "peer.json")), false)
      rmSync(cwd, { recursive: true, force: true })
   }
})

test("standing instructions are appended once and identically every turn", () => {
   const pi = fakePi("unused")
   const first = pi.emit("before_agent_start", { systemPrompt: "base" }) as {
      systemPrompt: string
   }
   const again = pi.emit("before_agent_start", { systemPrompt: "base" }) as {
      systemPrompt: string
   }
   assert.equal(first.systemPrompt, `base${STANDING_FOR_B}`)
   assert.deepEqual(again, first)
   assert.equal(
      pi.emit("before_agent_start", { systemPrompt: first.systemPrompt }),
      undefined,
   )
})

test("typing in B's pane is swallowed with a pointer to Claude Code", () => {
   const pi = fakePi("unused")
   assert.deepEqual(pi.emit("input", { source: "interactive", text: "hi" }), {
      action: "handled",
   })
   assert.match(pi.notices[0] ?? "", /type in Claude Code/)
   assert.deepEqual(pi.emit("input", { source: "extension", text: "x" }), {
      action: "continue",
   })
})

test("B on a provider outside the allowlist is never sent the human's prompt", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd, "openai")
   try {
      await pi.emit("session_start", { reason: "startup" })
      const common = { ccSessionId: "cc", transcriptPath: join(cwd, "none.jsonl"), cwd }
      await post(cwd, {
         kind: "prompt",
         prompt: "U1",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      assert.deepEqual(pi.sent, [])
      assert.match(pi.notices[0] ?? "", /not one of openai-codex/)
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      rmSync(cwd, { recursive: true, force: true })
   }
})

test("/tree in B's pane is cancelled with a pointer to Claude Code", () => {
   const pi = fakePi("unused")
   assert.deepEqual(pi.emit("session_before_tree", {}), { cancel: true })
   assert.match(pi.notices[0] ?? "", /type in Claude Code/)
})

async function displayedTurn(pi: ReturnType<typeof fakePi>, cwd: string) {
   await pi.emit("session_start", { reason: "startup" })
   const common = { ccSessionId: "cc", transcriptPath: join(cwd, "none.jsonl"), cwd }
   await post(cwd, {
      kind: "prompt",
      prompt: "U1",
      promptId: "p1",
      part: { index: 1, count: 1 },
      ...common,
   })
   pi.emit("agent_start")
   pi.branch.push({
      type: "message",
      id: "m1",
      message: {
         role: "assistant",
         content: [{ type: "text", text: "B's answer." }],
         stopReason: "stop",
      },
   })
   pi.emit("agent_settled")
   const shown = await post(cwd, {
      kind: "stop",
      lastAssistantMessage: "A's answer.",
      promptId: "p1",
      part: { index: 1, count: 1 },
      ...common,
   })
   return shown.systemMessage ?? ""
}

test("the mediator is B's own model at B's thinking level by default", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd, "openai-codex", {})
   try {
      assert.match(await displayedTurn(pi, cwd), /\[elided: "B's answer\."\]$/)
      assert.deepEqual(
         pi.elisions.map((e) => [e.model, e.options.reasoning]),
         [["openai-codex/gpt-6-astra", "high"]],
      )
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      rmSync(cwd, { recursive: true, force: true })
   }
})

test("a mediator override resolves exactly and stays inside the provider allowlist", async () => {
   for (const [spec, called, shown] of [
      ["openai-codex/gpt-6-sol", ["openai-codex/gpt-6-sol"], /elided/],
      ["openai/gpt-6-sol", [], /mediator provider openai is not one of openai-codex/],
      ["gpt-6-sol", [], /mediator model gpt-6-sol not found/],
   ] as const) {
      const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
      const pi = fakePi(cwd, "openai-codex", { "spiderman-mediator": spec })
      try {
         assert.match(await displayedTurn(pi, cwd), shown)
         assert.deepEqual(
            pi.elisions.map((e) => e.model),
            called,
         )
      } finally {
         await pi.emit("session_shutdown", { reason: "quit" })
         rmSync(cwd, { recursive: true, force: true })
      }
   }
})

test("Bx: B's own turn picks the elided paragraphs, then B is rewound to before that turn", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd, "openai-codex", { "spiderman-strategy": "bx" })
   try {
      await pi.emit("session_start", { reason: "startup" })
      const common = { ccSessionId: "cc", transcriptPath: join(cwd, "none.jsonl"), cwd }
      await post(cwd, {
         kind: "prompt",
         prompt: "U1",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      pi.emit("agent_start")
      pi.branch.push(assistant("m1", "Same as A.\n\nOnly B says this."))
      pi.emit("agent_settled")
      const shown = post(cwd, {
         kind: "stop",
         lastAssistantMessage: "Same as A.",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      await until(() => pi.sent.length === 2)
      assert.match(
         pi.sent[1] ?? "",
         /^\[elision request[\s\S]*\n1: "Same as A\."\n2: "Only B says this\."\n/,
      )

      pi.emit("agent_start")
      pi.branch.push({
         type: "message",
         id: "bx-u",
         message: { role: "user", content: [{ type: "text", text: pi.sent[1] }] },
      })
      pi.branch.push(assistant("bx-a", "1"))
      pi.emit("agent_settled")
      assert.match(
         (await shown).systemMessage ?? "",
         /\[elided: "Same as A\."\]\n\nOnly B says this\.$/,
      )

      await until(() => pi.branch.at(-1)?.type === "custom")
      assert.deepEqual(
         pi.branch.map((e) => e.id),
         ["m1", "c1"],
         "the elision exchange is off the branch; a marker entry pins the leaf",
      )
      assert.deepEqual(pi.branch.at(-1)?.data, { from: "bx-a", to: "m1" })
      assert.equal(pi.sent.length, 2, "the rewind command is never a message to B")
      assert.deepEqual(pi.notices, [], "our own navigation passes the /tree guard")
      assert.deepEqual(
         pi.emit("session_before_tree", { preparation: { targetId: "m1" } }),
         {
            cancel: true,
         },
      )
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      rmSync(cwd, { recursive: true, force: true })
   }
})

test("the rewind command does nothing unless spiderman itself asked for it", async () => {
   const pi = fakePi("unused", "openai-codex", { "spiderman-strategy": "bx" })
   pi.branch.push(assistant("m1", "x"), assistant("m2", "y"))
   await pi.command("spiderman-rewind", "guess")
   assert.deepEqual(
      pi.branch.map((e) => e.id),
      ["m1", "m2"],
   )
   assert.match(pi.notices[0] ?? "", /run by spiderman itself/)
})

test("an unknown strategy turns elision off, with a notice", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd, "openai-codex", { "spiderman-strategy": "Bx " })
   try {
      assert.match(await displayedTurn(pi, cwd), /full text: \S+\n\nB's answer\.$/)
      assert.deepEqual(pi.elisions, [])
      assert.match(
         pi.notices[0] ?? "",
         /unknown --spiderman-strategy Bx ; elision is off/,
      )
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      rmSync(cwd, { recursive: true, force: true })
   }
})

test("a rewind that runs after B has moved on navigates nowhere", async () => {
   const cwd = mkdtempSync(join(tmpdir(), "spiderman-ext-"))
   const pi = fakePi(cwd, "openai-codex", { "spiderman-strategy": "bx" })
   try {
      await pi.emit("session_start", { reason: "startup" })
      const common = { ccSessionId: "cc", transcriptPath: join(cwd, "none.jsonl"), cwd }
      await post(cwd, {
         kind: "prompt",
         prompt: "U1",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      pi.emit("agent_start")
      pi.branch.push(assistant("m1", "Only B says this."))
      pi.emit("agent_settled")
      const shown = post(cwd, {
         kind: "stop",
         lastAssistantMessage: "A's answer.",
         promptId: "p1",
         part: { index: 1, count: 1 },
         ...common,
      })
      await until(() => pi.sent.length === 2)
      pi.emit("agent_start")
      pi.branch.push(assistant("bx-a", "none"))
      pi.emit("agent_settled")
      pi.branch.push(assistant("later", "a turn B took meanwhile"))
      await shown
      const log = join(cwd, ".spiderman", "log.jsonl")
      await until(() => readFileSync(log, "utf8").includes('"what":"bx"'))
      assert.match(readFileSync(log, "utf8"), /"rewind":"B moved on"/)
      assert.deepEqual(
         pi.branch.map((e) => e.id),
         ["m1", "bx-a", "later"],
      )
   } finally {
      await pi.emit("session_shutdown", { reason: "quit" })
      rmSync(cwd, { recursive: true, force: true })
   }
})
