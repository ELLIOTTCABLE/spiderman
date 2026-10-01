import assert from "node:assert/strict"
import { test } from "node:test"
import { carrierHash } from "../core/coherence.ts"
import { piView } from "../core/pi-trail.ts"
import type { HookRequest } from "../core/protocol.ts"
import { sha256Hex } from "../core/store.ts"
import { defaultTurnConfig } from "../core/turns.ts"
import {
   type BSide,
   type Elision,
   type Outcome,
   Runtime,
   type RuntimeFs,
} from "./runtime.ts"

const POLL = 50

function harness(
   options: {
      elision?: Elision
      refuse?: number
      refuseBx?: string
      rewind?: () => Promise<Outcome>
      bxRoom?: boolean
   } = {},
) {
   let now = 0
   const timers: { at: number; run: () => void; live: boolean }[] = []
   const files = new Map<string, string>()
   const fs: RuntimeFs = {
      mkdirSync() {},
      writeFileSync(path, data, opts) {
         if (opts.flag === "wx" && files.has(path))
            throw Object.assign(new Error("EEXIST"), { code: "EEXIST" })
         files.set(path, data)
      },
      readText: (path) => files.get(path),
      writeText: (path, data) => void files.set(path, data),
      appendFileSync: (path, data) =>
         void files.set(path, (files.get(path) ?? "") + data),
      exists: (path) => files.has(path),
      size: (path) => files.get(path)?.length,
      readFrom: (path, offset) => files.get(path)?.slice(offset),
   }
   let branch: { type: string; id: string; message: unknown }[] = []
   let ids = 0
   const push = (message: unknown) =>
      branch.push({ type: "message", id: `b${++ids}`, message })
   const sent: string[] = []
   const seen: string[] = []
   const logs: Record<string, unknown>[] = []
   let refusals = options.refuse ?? 0
   const since = (leaf: string | undefined) =>
      branch.slice(leaf === undefined ? 0 : branch.findIndex((e) => e.id === leaf) + 1)
   const b: BSide = {
      send(text) {
         if (refusals > 0) {
            refusals--
            return { ok: false, reason: "compacting" }
         }
         if (options.refuseBx !== undefined && text.startsWith("[elision request"))
            return { ok: false, reason: options.refuseBx }
         sent.push(text)
         seen.push(`send ${sent.length}`)
         push({ role: "user", content: [{ type: "text", text }] })
         return { ok: true }
      },
      leafId: () => branch.at(-1)?.id,
      rewindPoint: () => branch.at(-1)?.id,
      messagesSince: (leaf) => since(leaf).map((e) => e.message),
      idsSince: (leaf) => since(leaf).map((e) => e.id),
      view: ({ delivered, never }) =>
         piView(branch, {
            parent: (id) => {
               const at = branch.findIndex((e) => e.id === id)
               return at === -1 ? undefined : (branch[at - 1]?.id ?? null)
            },
            carrier: (text) => carrierHash(sha256Hex, text),
            delivered,
            never,
         }),
      rewind(entryId) {
         seen.push(`rewind ${entryId}`)
         branch = branch.slice(0, branch.findIndex((e) => e.id === entryId) + 1)
         return options.rewind?.() ?? Promise.resolve({ ok: true })
      },
      abort: () => void seen.push("abort"),
      bxRoom: () => options.bxRoom ?? true,
   }
   const runtime = new Runtime({
      now: () => now,
      setTimer(ms, run) {
         const timer = { at: now + ms, run, live: true }
         timers.push(timer)
         return () => {
            timer.live = false
         }
      },
      hash: sha256Hex,
      fs,
      projectDir: "P",
      sessionId: "s1",
      b,
      elision: options.elision ?? { strategy: "off" },
      log: (entry) => void logs.push(entry),
      config: {
         ...defaultTurnConfig,
         promptWaitMs: 1_000,
         retryMs: 100,
         chunkDelayMs: 250,
         startTimeoutMs: 5_000,
         entryWaitMs: 2_000,
         pollMs: POLL,
         bx: options.elision?.strategy === "bx",
      },
   })
   const flush = () => new Promise((resolve) => setImmediate(resolve))
   const advance = async (ms: number) => {
      await flush()
      now += ms
      for (const timer of timers
         .filter((t) => t.live && t.at <= now)
         .sort((x, y) => x.at - y.at)) {
         timer.live = false
         timer.run()
      }
      await flush()
   }
   const transcript = (...entries: unknown[]) =>
      files.set(
         "t.jsonl",
         `${(files.get("t.jsonl") ?? "") + entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
      )
   const start = (text = sent.at(-1) ?? "") => {
      runtime.bRunStarting(text)
      runtime.bStarted()
   }
   const answer = (text: string, usage?: object) =>
      push({
         role: "assistant",
         content: [{ type: "text", text }],
         stopReason: "stop",
         ...(usage === undefined ? {} : { usage }),
      })
   const pane = (text: string) => {
      runtime.bRunStarting(text)
      push({ role: "user", content: [{ type: "text", text }] })
      runtime.bStarted()
   }
   const submit = async (text: string, promptId: string) => {
      const reply = runtime.handle(prompt(text, promptId))
      transcript(userEntry(text, promptId))
      await advance(POLL)
      return reply
   }
   return {
      runtime,
      files,
      sent,
      seen,
      logs,
      advance,
      transcript,
      start,
      answer,
      submit,
      flush,
      pane,
   }
}

const prompt = (text: string, promptId: string): HookRequest => ({
   kind: "prompt",
   ccSessionId: "cc1",
   transcriptPath: "t.jsonl",
   cwd: "P",
   prompt: text,
   promptId,
   part: { index: 1, count: 1 },
})
const stop = (promptId: string, last: string): HookRequest => ({
   kind: "stop",
   ccSessionId: "cc1",
   transcriptPath: "t.jsonl",
   promptId,
   lastAssistantMessage: last,
   part: { index: 1, count: 1 },
})
let uuids = 0
let parent: string | null = null
const linked = (entry: Record<string, unknown>) => {
   const uuid = `u${++uuids}`
   const out = { ...entry, uuid, parentUuid: parent }
   parent = uuid
   return out
}
const userEntry = (text: string, promptId: string) =>
   linked({ type: "user", promptId, message: { role: "user", content: text } })
const aText = (text: string) =>
   linked({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
   })

test("a full turn: B starts once CC wrote the prompt; elided display; then B's answer reaches A", async () => {
   const h = harness({ elision: { strategy: "mediator", mediate: async () => "1" } })
   await h.submit("U1", "p1")
   assert.deepEqual(h.sent, ["[the human's message]\nU1"])
   h.start()
   h.answer("B says X.\n\nB also says Y.")
   h.runtime.bSettled()
   h.transcript(aText("A says X."))
   const display = await h.runtime.handle(stop("p1", "A says X."))
   assert.match(
      display.systemMessage ?? "",
      /\[elided: "B says X\."\]\n\nB also says Y\.$/,
   )

   const delivered = await h.submit("U2", "p2")
   assert.match(delivered.additionalContext ?? "", /B says X\.\n\nB also says Y\./)
   assert.match(h.sent[1] ?? "", /A says X\.[\s\S]*\[the human's message\]\nU2$/)
   assert.doesNotMatch(
      h.sent[1] ?? "",
      /\[the human's prompt to the peer\]\nU1/,
      "B has U1",
   )
})

test("a prompt CC never writes (another hook blocked it) never starts B", async () => {
   const h = harness()
   void h.runtime.handle(prompt("blocked", "p1"))
   await h.advance(2_000)
   await h.advance(POLL)
   assert.deepEqual(h.sent, [])
   assert.ok(h.logs.some((l) => l.what === "promptNeverWritten"))
})

test("a mediator failure shows B in full, flagged; with no elider, unflagged", async () => {
   for (const [elision, shown] of [
      [
         {
            strategy: "mediator",
            mediate: async () => {
               throw new Error("model not found")
            },
         },
         /\[elision unavailable \(mediator failed: Error: model not found\); shown in full\]\n\nOnly\.$/,
      ],
      [{ strategy: "off" }, /full text: \S+\n\nOnly\.$/],
   ] as const) {
      const h = harness({ elision })
      await h.submit("U1", "p1")
      h.start()
      h.answer("Only.")
      h.runtime.bSettled()
      assert.match((await h.runtime.handle(stop("p1", "A"))).systemMessage ?? "", shown)
   }
})

test("B refusing a message is retried with the same prompt; a start that never comes is too", async () => {
   const h = harness({ refuse: 1 })
   await h.submit("U1", "p1")
   assert.deepEqual(h.sent, [])
   await h.advance(100)
   await h.advance(POLL)
   assert.deepEqual(h.sent, ["[the human's message]\nU1"])
   await h.advance(5_000)
   await h.advance(100)
   await h.advance(POLL)
   assert.equal(h.sent.length, 2)
   assert.ok(
      h.logs.some((l) => l.what === "lost"),
      "the unstarted delivery is struck",
   )
})

test("dispose answers every waiting hook, so none hangs until its timeout", async () => {
   const h = harness()
   await h.submit("U1", "p1")
   const waiting = h.runtime.handle(stop("p1", "A"))
   h.runtime.dispose()
   assert.deepEqual(await waiting, {})
})

test("the human's own turn in B holds the next shared prompt; A gets it as a direct message", async () => {
   const h = harness()
   await h.submit("U1", "p1")
   h.start()
   h.answer("B1.")
   h.runtime.bSettled()
   h.transcript(aText("A1."))
   await h.runtime.handle(stop("p1", "A1."))

   h.pane("why B1?")
   h.answer("Because.")
   const during = await h.submit("U2", "p2")
   assert.doesNotMatch(
      during.additionalContext ?? "",
      /why B1/,
      "an unfinished pane turn waits",
   )
   assert.equal(h.sent.length, 1, "U2 waits for the pane turn")
   h.runtime.bSettled()
   await h.flush()
   assert.equal(h.sent.length, 2)
   h.start()
   h.answer("B2.")
   h.runtime.bSettled()
   const next = await h.submit("U3", "p3")
   assert.match(
      next.additionalContext ?? "",
      /\[the human messaged the peer directly\]\nwhy B1\?\n\nBecause\.[\s\S]*B2\./,
   )
})

const bx = { strategy: "bx" } as const
const logged = (logs: Record<string, unknown>[], what: string) =>
   logs.flatMap(({ what: w, at: _at, ...rest }) => (w === what ? [rest] : []))

async function elisionPending(h: ReturnType<typeof harness>) {
   await h.submit("U1", "p1")
   h.start()
   h.answer("Same as A.\n\nOnly B says this.")
   h.runtime.bSettled()
   h.transcript(aText("Same as A."))
   const display = h.runtime.handle(stop("p1", "Same as A."))
   await h.flush()
   await h.submit("U2", "p2")
   // wrapped: an async function returning a promise would adopt it
   return { display }
}

test("Bx: the display waits on B's elision turn; B is rewound before its next turn", async () => {
   const h = harness({ elision: bx })
   const { display } = await elisionPending(h)
   assert.match(
      h.sent[1] ?? "",
      /^\[elision request[\s\S]*\n1: "Same as A\."\n2: "Only B says this\."\n/,
   )
   assert.equal(h.sent.length, 2, "U2 is held while B elides")
   h.start()
   h.answer("1", { input: 1_900, cacheRead: 1_792, output: 3 })
   h.runtime.bSettled()
   assert.match(
      (await display).systemMessage ?? "",
      /\[elided: "Same as A\."\]\n\nOnly B says this\.$/,
   )
   await h.flush()
   assert.deepEqual(h.seen, ["send 1", "send 2", "rewind b2", "send 3"])
   assert.doesNotMatch(h.sent[2] ?? "", /elision request/)
   const [done] = logged(h.logs, "bx")
   assert.deepEqual(
      [done?.usage, done?.rewind],
      [{ input: 1_900, cacheRead: 1_792, output: 3 }, "ok"],
   )
   assert.deepEqual(logged(h.logs, "never"), [{ ids: ["b3", "b4"] }])
})

test("Bx: a failed or unparseable elision turn shows B in full, flagged, and still rewinds", async () => {
   for (const [reply, flag] of [
      ["", "elision turn failed: B's turn error"],
      ["Probably the first one.", "no line of paragraph numbers or none"],
   ] as const) {
      const h = harness({ elision: bx })
      const { display } = await elisionPending(h)
      h.start()
      if (reply === "") h.answer("")
      else h.answer(reply)
      if (reply === "") h.runtime.bSettled()
      else h.runtime.bSettled()
      const shown = (await display).systemMessage ?? ""
      if (reply !== "")
         assert.match(shown, new RegExp(`\\[elision unavailable \\(${flag}\\)`))
      await h.flush()
      assert.deepEqual(h.seen.slice(0, 3), ["send 1", "send 2", "rewind b2"])
   }
})

test("Bx: a slow elision turn is given up and stopped; its settle still rewinds", async () => {
   const h = harness({ elision: bx })
   const { display } = await elisionPending(h)
   h.start()
   await h.advance(90_000)
   assert.match((await display).systemMessage ?? "", /elision turn failed: timed out/)
   assert.deepEqual(h.seen, ["send 1", "send 2", "abort"])
   h.runtime.bSettled()
   await h.flush()
   assert.deepEqual(h.seen.slice(0, 4), ["send 1", "send 2", "abort", "rewind b2"])
})

test("Bx: refused, or with B's context near compaction, there is no elision turn to rewind", async () => {
   for (const [options, reason] of [
      [{ refuseBx: "busy" }, /not sent: busy/],
      [{ bxRoom: false }, /near compaction/],
   ] as const) {
      const h = harness({ elision: bx, ...options })
      const { display } = await elisionPending(h)
      assert.match((await display).systemMessage ?? "", reason)
      await h.flush()
      assert.deepEqual(h.seen, ["send 1", "send 2"])
      assert.match(h.sent[1] ?? "", /U2$/)
   }
})
