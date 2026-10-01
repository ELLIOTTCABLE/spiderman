import assert from "node:assert/strict"
import { test } from "node:test"
import type { HookRequest } from "../core/protocol.ts"
import { defaultTurnConfig } from "../core/turns.ts"
import { type BSide, Runtime, type RuntimeDeps, type RuntimeFs } from "./runtime.ts"

function harness(options: { mediate?: RuntimeDeps["mediate"]; refuse?: number } = {}) {
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
   }
   const sent: string[] = []
   const scripted = new Map<number, unknown[]>()
   let refusals = options.refuse ?? 0
   const b: BSide = {
      send(text) {
         if (refusals > 0) {
            refusals--
            return { ok: false, reason: "compacting" }
         }
         sent.push(text)
         return { ok: true }
      },
      leafId: () => `leaf-${sent.length}`,
      messagesSince: () => scripted.get(sent.length) ?? [],
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
      hash: (text) => `h${text.length}`,
      fs,
      projectDir: "P",
      b,
      ...(options.mediate === undefined ? {} : { mediate: options.mediate }),
      log: () => {},
      config: {
         ...defaultTurnConfig,
         promptWaitMs: 1_000,
         retryMs: 100,
         chunkDelayMs: 250,
         startTimeoutMs: 5_000,
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
   return { runtime, files, sent, scripted, advance, transcript }
}

const base = { ccSessionId: "cc1", transcriptPath: "t.jsonl", cwd: "P" }
const prompt = (text: string, promptId: string, index = 1): HookRequest => ({
   kind: "prompt",
   ...base,
   prompt: text,
   promptId,
   part: { index, count: 2 },
})
const stop = (promptId: string, last: string): HookRequest => ({
   kind: "stop",
   ccSessionId: "cc1",
   transcriptPath: "t.jsonl",
   promptId,
   lastAssistantMessage: last,
   part: { index: 1, count: 1 },
})
const userEntry = (text: string, promptId: string) => ({
   type: "user",
   uuid: `u-${promptId}`,
   promptId,
   message: { role: "user", content: text },
})
const aText = (text: string, uuid: string) => ({
   type: "assistant",
   uuid,
   message: { role: "assistant", content: [{ type: "text", text }] },
})
const bReply = (text: string) => [
   { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
]

test("a full turn: standing context, B in parallel, elided display, then delivery to A", async () => {
   const asked: string[][] = []
   const h = harness({
      mediate: async (a, b) => {
         asked.push([a, b])
         return '{"elide": ["B says X"]}'
      },
   })
   assert.deepEqual(
      await h.runtime.handle({ kind: "session-start", ...base, source: "startup" }),
      {},
   )

   h.transcript(userEntry("U1", "p1"))
   const first = [
      h.runtime.handle(prompt("U1", "p1", 1)),
      h.runtime.handle(prompt("U1", "p1", 2)),
   ]
   await h.advance(250)
   assert.deepEqual(await Promise.all(first), [{}, {}])
   assert.deepEqual(h.sent, ["[the human's message]\nU1"])

   h.runtime.bStarted()
   h.scripted.set(1, bReply("B says X.\n\nB also says Y."))
   h.runtime.bSettled()

   h.transcript(aText("A says X.", "a1"))
   const display = await h.runtime.handle(stop("p1", "A says X."))
   assert.deepEqual(asked, [["A says X.", "B says X.\n\nB also says Y."]])
   assert.equal(
      display.systemMessage,
      "[peer 1/1]\n[peer answer] full text: .spiderman/turns/b-1.md\n\n[1¶ elided]\n\nB also says Y.",
   )
   assert.equal(h.files.get("P/.spiderman/turns/b-1.md"), "B says X.\n\nB also says Y.")

   h.transcript(userEntry("U2", "p2"))
   const part1 = h.runtime.handle(prompt("U2", "p2", 1))
   const part2 = h.runtime.handle(prompt("U2", "p2", 2))
   const delivered = await part1
   assert.match(
      delivered.additionalContext ?? "",
      /^\[peer 1\/1\]\n\[peer answer\][\s\S]*B says X\.\n\nB also says Y\./,
   )
   await h.advance(250)
   assert.deepEqual(await part2, {})
   assert.match(
      h.sent[1] ?? "",
      /\[peer answer\][\s\S]*A says X\.[\s\S]*\[the human's message\]\nU2$/,
   )
})

test("a mediator failure shows B in full, flagged", async () => {
   const h = harness({
      mediate: async () => {
         throw new Error("model not found")
      },
   })
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   h.runtime.bStarted()
   h.scripted.set(1, bReply("Only paragraph."))
   h.runtime.bSettled()
   const display = await h.runtime.handle(stop("p1", "A"))
   assert.match(
      display.systemMessage ?? "",
      /\[elision unavailable \(mediator failed: Error: model not found\); shown in full\]\n\nOnly paragraph\./,
   )
})

test("with no mediator (strategy off) B is shown in full, unflagged", async () => {
   const h = harness()
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   h.runtime.bStarted()
   h.scripted.set(1, bReply("All of it."))
   h.runtime.bSettled()
   const display = await h.runtime.handle(stop("p1", "A"))
   assert.match(display.systemMessage ?? "", /full text: \S+\n\nAll of it\.$/)
})

test("B refusing a message (compaction, model guard) is retried with the same prompt", async () => {
   const h = harness({ refuse: 1 })
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   assert.deepEqual(h.sent, [])
   await h.advance(100)
   assert.deepEqual(h.sent, ["[the human's message]\nU1"])
})

test("a B turn that never starts is given up on and retried", async () => {
   const h = harness()
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   assert.equal(h.sent.length, 1)
   await h.advance(5_000)
   await h.advance(100)
   assert.equal(h.sent.length, 2)
})

test("dispose answers every waiting hook, so none hangs until its timeout", async () => {
   const h = harness()
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   const waiting = h.runtime.handle(stop("p1", "A"))
   h.runtime.dispose()
   assert.deepEqual(await waiting, {})
})
