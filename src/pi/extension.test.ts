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
function fakePi(cwd: string, provider = "openai-codex") {
   const handlers = new Map<string, Handler>()
   const flags = new Map<string, string>([["spiderman-strategy", "off"]])
   const sent: string[] = []
   const notices: string[] = []
   const branch: { type: string; id: string; message?: unknown }[] = []
   const ctx = {
      cwd,
      model: { provider },
      isIdle: () => true,
      ui: { notify: (message: string) => void notices.push(message) },
      sessionManager: {
         getSessionFile: () => undefined,
         getSessionId: () => "pi-session",
         getLeafId: () => branch.at(-1)?.id ?? null,
         getBranch: () => branch,
      },
   }
   const pi = {
      registerFlag: (name: string, options: { default: string }) => {
         if (!flags.has(name)) flags.set(name, options.default)
      },
      getFlag: (name: string) => flags.get(name),
      on: (event: string, handler: Handler) => void handlers.set(event, handler),
      sendUserMessage: (text: string) => void sent.push(text),
   }
   spiderman(pi as unknown as ExtensionAPI)
   const emit = (event: string, payload: unknown = {}) =>
      handlers.get(event)?.(payload, ctx)
   return { emit, sent, notices, branch }
}

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
