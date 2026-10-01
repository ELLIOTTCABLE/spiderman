import assert from "node:assert/strict"
import { test } from "node:test"
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

function harness(
   options: {
      elision?: Elision
      refuse?: number
      /** refuses only the elision prompt, with this reason */
      refuseBx?: string
      rewind?: () => Promise<Outcome>
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
   }
   const sent: string[] = []
   const scripted = new Map<number, unknown[]>()
   let refusals = options.refuse ?? 0
   /** sends, rewinds and aborts, in the order B saw them */
   const seen: string[] = []
   const logs: Record<string, unknown>[] = []
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
         return { ok: true }
      },
      leafId: () => `leaf-${sent.length}`,
      rewindPoint: () => `leaf-${sent.length}`,
      messagesSince: () => scripted.get(sent.length) ?? [],
      rewind(entryId) {
         seen.push(`rewind ${entryId}`)
         return options.rewind?.() ?? Promise.resolve({ ok: true })
      },
      abort: () => void seen.push("abort"),
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
   return { runtime, files, sent, scripted, advance, transcript, seen, logs, flush }
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
      elision: {
         strategy: "mediator",
         mediate: async (a, b) => {
            asked.push([a, b])
            return "1"
         },
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
      '[peer 1/1]\n[peer answer] full text: .spiderman/turns/s1/b-1.md\n\n[elided: "B says X."]\n\nB also says Y.',
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
      elision: {
         strategy: "mediator",
         mediate: async () => {
            throw new Error("model not found")
         },
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

test("a short sentence A repeats verbatim in a later turn still reaches B", async () => {
   const h = harness()
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   h.runtime.bStarted()
   h.runtime.bSettled()
   h.transcript(aText("Done.", "a1"), userEntry("U2", "p2"))
   await h.runtime.handle(stop("p1", "Done."))
   await h.runtime.handle(prompt("U2", "p2"))
   assert.match(h.sent[1] ?? "", /Done\./)
   h.runtime.bStarted()
   h.runtime.bSettled()
   h.transcript(aText("Done.", "a2"), userEntry("U3", "p3"))
   await h.runtime.handle(stop("p2", "Done."))
   await h.runtime.handle(prompt("U3", "p3"))
   assert.match(h.sent[2] ?? "", /Done\.[\s\S]*\[the human's message\]\nU3$/)
})

const bx = { strategy: "bx" } as const
const logged = (logs: Record<string, unknown>[], what: string) =>
   logs.flatMap(({ what: w, at: _at, ...rest }) => (w === what ? [rest] : []))

/** B answered U1 and A stopped: the display now waits on B's elision turn, already sent. */
async function elisionPending(h: ReturnType<typeof harness>) {
   h.transcript(userEntry("U1", "p1"))
   await h.runtime.handle(prompt("U1", "p1"))
   h.runtime.bStarted()
   h.scripted.set(1, bReply("Same as A.\n\nOnly B says this."))
   h.runtime.bSettled()
   h.transcript(aText("Same as A.", "a1"))
   const display = h.runtime.handle(stop("p1", "Same as A."))
   await h.flush()
   h.transcript(userEntry("U2", "p2"))
   await h.runtime.handle(prompt("U2", "p2"))
   // wrapped: an async function returning a promise would wait for it
   return { display }
}

test("Bx: the display waits on B's elision turn; B is rewound before its next turn", async () => {
   const h = harness({ elision: bx })
   const { display } = await elisionPending(h)
   assert.match(
      h.sent[1] ?? "",
      /^\[elision request[\s\S]*<answer_a>\nSame as A\.\n<\/answer_a>[\s\S]*\n1: "Same as A\."\n2: "Only B says this\."\n/,
   )
   assert.equal(h.sent.length, 2, "U2 is held while B elides")

   h.runtime.bStarted()
   h.scripted.set(2, [
      { role: "user", content: "the elision request" },
      {
         role: "assistant",
         content: [{ type: "text", text: "1" }],
         stopReason: "stop",
         usage: { input: 1_900, cacheRead: 1_792, output: 3 },
      },
   ])
   h.runtime.bSettled()
   assert.match(
      (await display).systemMessage ?? "",
      /\[elided: "Same as A\."\]\n\nOnly B says this\.$/,
   )
   await h.flush()
   assert.deepEqual(h.seen, ["send 1", "send 2", "rewind leaf-1", "send 3"])
   assert.match(h.sent[2] ?? "", /\[the human's message\]\nU2$/)
   assert.doesNotMatch(h.sent[2] ?? "", /elision request/)
   assert.deepEqual(logged(h.logs, "bx"), [
      {
         turn: 1,
         sent: true,
         outcome: "completed",
         reply: "1",
         usage: { input: 1_900, cacheRead: 1_792, output: 3 },
         rewind: "ok",
         bxMs: 0,
      },
   ])
   assert.deepEqual(
      logged(h.logs, "display").map((d) => [d.strategy, d.indices, d.elided, d.vetoed]),
      [["bx", [1], [1], []]],
   )
})

test("Bx: an errored or unparseable elision turn shows B in full, flagged, and still rewinds", async () => {
   for (const [reply, flag] of [
      [
         [{ role: "assistant", content: [], stopReason: "error" }],
         "elision turn failed: B's turn error",
      ],
      [bReply("Probably the first one."), "no line of paragraph numbers or none"],
   ] as const) {
      const h = harness({ elision: bx })
      const { display } = await elisionPending(h)
      h.runtime.bStarted()
      h.scripted.set(2, [...reply])
      h.runtime.bSettled()
      assert.equal(
         (await display).systemMessage?.split("\n\n")[1],
         `[elision unavailable (${flag}); shown in full]`,
      )
      await h.flush()
      assert.deepEqual(h.seen, ["send 1", "send 2", "rewind leaf-1", "send 3"])
   }
})

test("Bx: a slow elision turn is given up for display and stopped; its settle still rewinds", async () => {
   const h = harness({ elision: bx })
   const { display } = await elisionPending(h)
   h.runtime.bStarted()
   await h.advance(90_000)
   assert.match((await display).systemMessage ?? "", /elision turn failed: timed out/)
   assert.deepEqual(h.seen, ["send 1", "send 2", "abort"])
   h.scripted.set(2, [{ role: "assistant", content: [], stopReason: "aborted" }])
   h.runtime.bSettled()
   await h.flush()
   assert.deepEqual(h.seen, ["send 1", "send 2", "abort", "rewind leaf-1", "send 3"])
})

test("Bx: a refused or never-started elision turn needs no rewind and frees B", async () => {
   const refused = harness({ elision: bx, refuseBx: "busy" })
   const { display: shown } = await elisionPending(refused)
   assert.match((await shown).systemMessage ?? "", /elision turn failed: not sent: busy/)
   await refused.flush()
   assert.deepEqual(refused.seen, ["send 1", "send 2"])
   assert.match(refused.sent[1] ?? "", /U2$/)

   const stalled = harness({ elision: bx })
   const { display } = await elisionPending(stalled)
   await stalled.advance(5_000)
   assert.match(
      (await display).systemMessage ?? "",
      /elision turn failed: B did not start it/,
   )
   assert.deepEqual(stalled.seen, ["send 1", "send 2", "send 3"])
})

test("Bx: a rewind that fails or hangs is logged, and B is freed anyway", async () => {
   for (const [rewind, result] of [
      [() => Promise.resolve({ ok: false as const, reason: "cancelled" }), "cancelled"],
      [() => new Promise<never>(() => {}), "timed out"],
   ] as const) {
      const h = harness({ elision: bx, rewind })
      const { display } = await elisionPending(h)
      h.runtime.bStarted()
      h.scripted.set(2, bReply("none"))
      h.runtime.bSettled()
      assert.doesNotMatch((await display).systemMessage ?? "", /elided|unavailable/)
      await h.advance(15_000)
      assert.deepEqual(
         logged(h.logs, "bx").map((e) => e.rewind),
         [result],
      )
      assert.match(h.sent[2] ?? "", /U2$/)
   }
})
