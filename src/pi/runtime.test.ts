import assert from "node:assert/strict"
import { test } from "node:test"
import type { HookRequest } from "../core/protocol.ts"
import { sha256Hex } from "../core/store.ts"
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
      hash: sha256Hex,
      fs,
      projectDir: "P",
      sessionId: "s1",
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
      "[peer 1/1]\n[peer answer] full text: .spiderman/turns/s1/b-1.md\n\n[1¶ elided]\n\nB also says Y.",
   )
   assert.equal(
      h.files.get("P/.spiderman/turns/s1/b-1.md"),
      "B says X.\n\nB also says Y.",
   )

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

test("B1 repro: mid-turn prompt, solo turn, then a normal prompt never repeats A's earlier answer to B", async () => {
   const h = harness()
   h.transcript(userEntry("U3a", "p3a"))
   await h.runtime.handle(prompt("U3a", "p3a"))
   h.runtime.bStarted()
   h.scripted.set(1, bReply("B3a."))
   h.runtime.bSettled()

   h.transcript(aText("Looking.", "a3a-1"))
   await h.runtime.handle(prompt("U3b", "p3a"))
   // Stop arrives before A's final text reaches the transcript
   await h.runtime.handle(stop("p3a", "A3a final."))
   assert.match(
      h.sent[1] ?? "",
      /Looking\.[\s\S]*A3a final\.[\s\S]*\[the human's message\]\nU3b$/,
   )
   h.runtime.bStarted()
   h.scripted.set(2, bReply("B3b."))
   h.runtime.bSettled()

   h.transcript(
      aText("A3a final.", "a3a-2"),
      userEntry("U3b", "p3b"),
      aText("A3b answer.", "a3b-1"),
   )
   await h.runtime.handle(stop("p3b", "A3b answer."))
   h.transcript(userEntry("~solo", "p4"), aText("Solo answer.", "a4-1"))
   await h.runtime.handle(prompt("~solo", "p4"))
   await h.runtime.handle(stop("p4", "Solo answer."))
   h.transcript(userEntry("U5", "p5"))
   await h.runtime.handle(prompt("U5", "p5"))

   const fifth = h.sent[2] ?? ""
   assert.match(
      fifth,
      /A3b answer\.[\s\S]*~solo[\s\S]*Solo answer\.[\s\S]*\[the human's message\]\nU5$/,
   )
   assert.doesNotMatch(fifth, /Looking\.|A3a final\./)
   assert.doesNotMatch(fifth, /U3b/)
})

test("a newly paired B gets A's last completed turn, not nothing and not everything", async () => {
   const h = harness()
   h.transcript(
      userEntry("ancient question", "p0"),
      aText("Ancient answer.", "a0"),
      userEntry("U1", "p1"),
      aText("A1 answer.", "a1"),
      userEntry("U2", "p2"),
   )
   await h.runtime.handle(prompt("U2", "p2"))
   const first = h.sent[0] ?? ""
   assert.match(
      first,
      /\[the human's prompt to the peer\]\nU1[\s\S]*A1 answer\.[\s\S]*\[the human's message\]\nU2$/,
   )
   assert.doesNotMatch(first, /ancient|Ancient/)
})

test("several B answers reaching A at once are sectioned by the prompt each answered", async () => {
   const h = harness()
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   h.runtime.bStarted()
   h.transcript(userEntry("U2", "p2"))
   const capped = h.runtime.handle(prompt("U2", "p2"))
   await h.advance(1_000)
   assert.deepEqual(await capped, {
      systemMessage:
         "spiderman: the peer is still answering; its answer reaches Claude with your next prompt.",
   })
   h.scripted.set(1, bReply("Answer to one."))
   h.runtime.bSettled()
   h.runtime.bStarted()
   h.scripted.set(2, bReply("Answer to two."))
   h.runtime.bSettled()
   h.transcript(userEntry("U3", "p3"))
   const delivered = (await h.runtime.handle(prompt("U3", "p3"))).additionalContext ?? ""
   assert.match(
      delivered,
      /\[peer answer 1 of 2, to the human's message "U1"\]\n\nAnswer to one\.\n\n\[peer answer 2 of 2, to the human's message "U2"\]\n\nAnswer to two\./,
   )
})
