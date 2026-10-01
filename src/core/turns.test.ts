import assert from "node:assert/strict"
import { test } from "node:test"
import {
   defaultTurnConfig,
   initialTurnState,
   step,
   type TurnEffect,
   type TurnEvent,
   type TurnState,
} from "./turns.ts"

const config = {
   ...defaultTurnConfig,
   promptWaitMs: 1_000,
   stopWaitMs: 5_000,
   retryMs: 100,
}

class Sim {
   state: TurnState = initialTurnState
   now = 0

   send(event: TurnEvent, at = this.now): TurnEffect[] {
      this.now = at
      const result = step(this.state, event, at, config)
      this.state = result.state
      return result.effects.filter((e) => e.type !== "log")
   }
}

let requests = 0
function submit(
   prompt: string,
   promptId: string | undefined,
   extra: Partial<TurnEvent> = {},
   k = 1,
) {
   return {
      type: "submit",
      requestId: `r${++requests}`,
      part: { index: k, count: 2 },
      ccSessionId: "cc1",
      key: `cc1|${promptId}|${prompt}`,
      prompt,
      ...(promptId === undefined ? {} : { promptId }),
      ...extra,
   } as TurnEvent
}
function stop(promptId: string, last = "A's answer", k = 1, session = "cc1") {
   return {
      type: "stop",
      requestId: `r${++requests}`,
      part: { index: k, count: 1 },
      ccSessionId: session,
      key: `${session}|${promptId}|${last}`,
      promptId,
      lastAssistantMessage: last,
   } as TurnEvent
}
const settled = (
   turn: number,
   outcome: "completed" | "error" | "aborted" = "completed",
   answered = true,
): TurnEvent => ({
   type: "bSettled",
   turn,
   outcome,
   answered,
})

const replies = (effects: TurnEffect[]) =>
   effects.flatMap((e) =>
      e.type === "respond" ? [{ reply: e.reply, notice: e.notice }] : [],
   )
const starts = (effects: TurnEffect[]) =>
   effects.flatMap((e) =>
      e.type === "startB" ? [{ turn: e.turn, prompts: e.prompts, until: e.until }] : [],
   )

test("common case: B starts at submit; Stop shows B's answer; the next submit delivers it to A", () => {
   const sim = new Sim()
   assert.deepEqual(
      replies(
         sim.send({
            type: "sessionStart",
            requestId: "s",
            ccSessionId: "cc1",
            source: "startup",
         }),
      ),
      [{ reply: { kind: "empty" }, notice: undefined }],
   )
   const first = sim.send(submit("U1", "p1"), 10)
   assert.deepEqual(replies(first), [{ reply: { kind: "empty" }, notice: undefined }])
   assert.deepEqual(starts(first), [
      { turn: 1, prompts: ["U1"], until: { promptId: "p1" } },
   ])
   assert.deepEqual(sim.send(settled(1), 20), [])
   assert.deepEqual(replies(sim.send(stop("p1"), 30)), [
      { reply: { kind: "display", turn: 1 }, notice: undefined },
   ])
   const second = sim.send(submit("U2", "p2"), 40)
   assert.deepEqual(replies(second), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
   assert.deepEqual(starts(second), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
})

test("the K chunk hooks of one submit are one event: one B start, the same reply each", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"))
   sim.send(settled(1))
   const a = sim.send(submit("U2", "p2", {}, 1))
   const b = sim.send(submit("U2", "p2", {}, 2))
   assert.equal(starts(a).length + starts(b).length, 1)
   assert.deepEqual(replies(a), replies(b))
   assert.deepEqual(replies(b), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
})

test("stale prompt_ids don't merge different prompts; the same prompt after the window is new", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   const u2 = sim.send(submit("U2", "p1"), 10)
   const u3 = sim.send(submit("U3", "p1"), 20)
   assert.equal(replies(u2).length, 1)
   assert.equal(replies(u3).length, 1)
   assert.equal(sim.state.pending.length, 2)
   sim.send(submit("U3", "p1"), 30)
   assert.equal(sim.state.pending.length, 2, "duplicate inside the window")
   sim.send(submit("U3", "p1"), 30 + defaultTurnConfig.dedupeWindowMs)
   assert.equal(sim.state.pending.length, 3, "a repeat after the window is a new prompt")
})

test("B slower than the human: an idle-time submit waits for B, capped", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   const waiting = sim.send(submit("U2", "p2"), 100)
   assert.deepEqual(replies(waiting), [])
   assert.deepEqual(
      waiting.filter((e) => e.type === "wake"),
      [{ type: "wake", at: 1_100 }],
   )
   const done = sim.send(settled(1), 600)
   assert.deepEqual(replies(done), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
   assert.deepEqual(starts(done), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
})

test("B slower than the cap: the submit goes through with a notice; B catches up later", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(submit("U2", "p2"), 100)
   const capped = sim.send({ type: "tick" }, 1_100)
   assert.equal(replies(capped)[0]?.reply.kind, "empty")
   assert.match(replies(capped)[0]?.notice ?? "", /still answering/)
   const late = sim.send(settled(1), 2_000)
   assert.deepEqual(starts(late), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
   sim.send(settled(2), 3_000)
   assert.deepEqual(replies(sim.send(submit("U3", "p3"), 4_000)), [
      { reply: { kind: "deliver", turns: [1, 2] }, notice: undefined },
   ])
})

test("Stop waits for B's matching turn, and shows a notice at the cap", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   assert.deepEqual(replies(sim.send(stop("p1"), 10)), [])
   assert.deepEqual(replies(sim.send(settled(1), 20)), [
      { reply: { kind: "display", turn: 1 }, notice: undefined },
   ])

   const slow = new Sim()
   slow.send(submit("U1", "p1"), 0)
   slow.send(stop("p1"), 10)
   const capped = slow.send({ type: "tick" }, 5_010)
   assert.equal(replies(capped)[0]?.reply.kind, "empty")
   assert.match(replies(capped)[0]?.notice ?? "", /still answering/)
})

test("mid-turn submit: answered at once, and B starts at Stop with A's finished answer", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   const mid = sim.send(submit("U2", "p1"), 20)
   assert.deepEqual(replies(mid), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
   assert.deepEqual(starts(mid), [])
   const atStop = sim.send(stop("p1", "A1 text"), 30)
   assert.deepEqual(starts(atStop), [{ turn: 2, prompts: ["U2"], until: "end" }])
   assert.equal(atStop.find((e) => e.type === "startB")?.lastAssistantMessage, "A1 text")
   assert.deepEqual(replies(atStop), [
      { reply: { kind: "display", turn: 1 }, notice: undefined },
   ])
})

test("a queued prompt's own A turn (no submit of its own) gets its B answer shown at its Stop", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(submit("U2", "p1"), 20)
   sim.send(stop("p1", "A1"), 30)
   sim.send(settled(2), 40)
   assert.deepEqual(replies(sim.send(stop("p1", "A2"), 50)), [
      { reply: { kind: "display", turn: 2 }, notice: undefined },
   ])
})

test("submit while Stop hooks run: B waits for nothing from A and starts once free", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(stop("p1"), 10)
   const during = sim.send(submit("U2", "p1"), 20)
   assert.deepEqual(replies(during), [])
   const done = sim.send(settled(1), 30)
   assert.deepEqual(
      replies(done).map((r) => r.reply.kind),
      ["display", "deliver"],
   )
   assert.deepEqual(starts(done), [{ turn: 2, prompts: ["U2"], until: "end" }])
})

test("solo prefix: B skips the turn, A still gets B's earlier answer", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(stop("p1"), 20)
   const solo = sim.send(submit("~quick one", "p2"), 30)
   assert.deepEqual(starts(solo), [])
   assert.deepEqual(replies(solo), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
   assert.deepEqual(replies(sim.send(stop("p2"), 40)), [
      { reply: { kind: "empty" }, notice: undefined },
   ])
   assert.deepEqual(starts(sim.send(submit("U3", "p3"), 50)), [
      { turn: 2, prompts: ["U3"], until: { promptId: "p3" } },
   ])
})

test("system prompts are never queued for B, and their Stop shows nothing", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(stop("p1"), 20)
   const notification = sim.send(
      submit("<task-notification>\n<result>x</result>", "p9"),
      30,
   )
   assert.deepEqual(starts(notification), [])
   assert.deepEqual(replies(notification), [
      { reply: { kind: "empty" }, notice: undefined },
   ])
   const wakeup = sim.send(submit("continue", "p10", { source: "system" }), 35)
   assert.deepEqual(starts(wakeup), [])
   assert.deepEqual(replies(sim.send(stop("p9"), 40)), [
      { reply: { kind: "empty" }, notice: undefined },
   ])
   assert.deepEqual(sim.state.pending, [])
})

test("A interrupted (no Stop): a fresh prompt_id means A is idle again", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   const next = sim.send(submit("U2", "p2"), 100)
   assert.deepEqual(
      replies(next),
      [],
      "waits for B's turn 1, as an idle-time submit would",
   )
   const done = sim.send(settled(1, "aborted"), 200)
   assert.deepEqual(replies(done), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
   assert.deepEqual(starts(done), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
})

test("B errors still settle, so their partial answers are delivered", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1, "error"), 10)
   assert.deepEqual(replies(sim.send(submit("U2", "p2"), 20)), [
      { reply: { kind: "deliver", turns: [1] }, notice: undefined },
   ])
})

test("a failed B start (e.g. compaction in flight) is retried with the same prompts", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   const failed = sim.send({ type: "bFailed", turn: 1, reason: "compacting" }, 10)
   assert.deepEqual(failed, [{ type: "wake", at: 110 }])
   assert.deepEqual(starts(sim.send({ type: "tick" }, 50)), [])
   assert.deepEqual(starts(sim.send({ type: "tick" }, 110)), [
      { turn: 2, prompts: ["U1"], until: { promptId: "p1" } },
   ])
})

test("a second CC session gets a notice; the first keeps the pair until a /clear", () => {
   const sim = new Sim()
   sim.send({
      type: "sessionStart",
      requestId: "a",
      ccSessionId: "cc1",
      source: "startup",
   })
   const other = sim.send({
      type: "sessionStart",
      requestId: "b",
      ccSessionId: "cc2",
      source: "startup",
   })
   assert.equal(replies(other)[0]?.reply.kind, "empty")
   assert.match(replies(other)[0]?.notice ?? "", /another Claude Code session/)
   const stray = sim.send(stop("x", "y", 1, "cc2"))
   assert.match(replies(stray)[0]?.notice ?? "", /another Claude Code session/)
   assert.equal(sim.state.pairedSession, "cc1")
   sim.send({ type: "sessionStart", requestId: "c", ccSessionId: "cc3", source: "clear" })
   assert.equal(sim.state.pairedSession, "cc3")
})

test("notices only ever ride on part 1", () => {
   const sim = new Sim()
   sim.send({
      type: "sessionStart",
      requestId: "a",
      ccSessionId: "cc1",
      source: "startup",
   })
   const effects = sim.send({
      ...(submit("U", "p", { ccSessionId: "cc2" }, 2) as object),
   } as TurnEvent)
   assert.deepEqual(replies(effects), [{ reply: { kind: "empty" }, notice: undefined }])
})

test("waits never outlast the hook's own budget, whatever the configured caps", () => {
   const sim = new Sim()
   sim.send(submit("U1", "p1"), 0)
   const waiting = sim.send(submit("U2", "p2", { budgetMs: 2_000 }), 100)
   assert.deepEqual(
      waiting.filter((e) => e.type === "wake"),
      [{ type: "wake", at: 100 + 2_000 - config.submitReserveMs }],
   )

   const display = new Sim()
   display.send(submit("U1", "p1"), 0)
   const stopping = display.send(
      { ...(stop("p1") as object), budgetMs: config.stopReserveMs + 1_000 } as TurnEvent,
      10,
   )
   assert.deepEqual(
      stopping.filter((e) => e.type === "wake"),
      [{ type: "wake", at: 1_010 }],
   )
})

class BxSim extends Sim {
   override send(event: TurnEvent, at = this.now): TurnEffect[] {
      this.now = at
      const result = step(this.state, event, at, { ...config, bx: true })
      this.state = result.state
      return result.effects.filter((e) => e.type !== "log")
   }
}
const bxStarts = (effects: TurnEffect[]) =>
   effects.flatMap((e) =>
      e.type === "startBx" ? [{ turn: e.turn, aText: e.aText }] : [],
   )
const bxDone = (turn: number): TurnEvent => ({ type: "bxDone", turn })

test("Bx: a shown answer starts B's elision turn; B takes no new turn until it is rewound", () => {
   const sim = new BxSim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   const atStop = sim.send(stop("p1", "A1"), 20)
   assert.deepEqual(replies(atStop), [
      { reply: { kind: "display", turn: 1 }, notice: undefined },
   ])
   assert.deepEqual(bxStarts(atStop), [{ turn: 1, aText: "A1" }])

   const next = sim.send(submit("U2", "p2"), 30)
   assert.deepEqual(
      replies(next),
      [{ reply: { kind: "deliver", turns: [1] }, notice: undefined }],
      "B's answer is settled, so A gets it at once; the elision turn doesn't hold it",
   )
   assert.deepEqual(starts(next), [])
   assert.deepEqual(starts(sim.send(bxDone(1), 40)), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
})

test("Bx: a Stop already waiting starts the elision turn when B settles, with its A text", () => {
   const sim = new BxSim()
   sim.send(submit("U1", "p1"), 0)
   assert.deepEqual(sim.send(stop("p1", "A1"), 10), [{ type: "wake", at: 5_010 }])
   const done = sim.send(settled(1), 20)
   assert.deepEqual(replies(done), [
      { reply: { kind: "display", turn: 1 }, notice: undefined },
   ])
   assert.deepEqual(bxStarts(done), [{ turn: 1, aText: "A1" }])
})

test("Bx: no elision turn for an errored, aborted or empty answer, nor against empty A text", () => {
   for (const [outcome, answered, aText] of [
      ["error", true, "A1"],
      ["aborted", true, "A1"],
      ["completed", false, "A1"],
      ["completed", true, " "],
   ] as const) {
      const sim = new BxSim()
      sim.send(submit("U1", "p1"), 0)
      sim.send(settled(1, outcome, answered), 10)
      const atStop = sim.send(stop("p1", aText), 20)
      assert.equal(replies(atStop)[0]?.reply.kind, "display")
      assert.deepEqual(bxStarts(atStop), [], `${outcome}/${answered}/${aText}`)
      assert.equal(sim.state.bx, undefined)
   }
})

test("Bx: a mid-turn prompt waits for the elision turn, then starts with A's final answer", () => {
   const sim = new BxSim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(submit("U2", "p1"), 20)
   const atStop = sim.send(stop("p1", "A1 text"), 30)
   assert.deepEqual(bxStarts(atStop), [{ turn: 1, aText: "A1 text" }])
   assert.deepEqual(starts(atStop), [])
   const after = sim.send(bxDone(1), 40)
   assert.deepEqual(starts(after), [{ turn: 2, prompts: ["U2"], until: "end" }])
   assert.equal(after.find((e) => e.type === "startB")?.lastAssistantMessage, "A1 text")
})

test("Bx: a Stop whose prompt is held back by the elision turn waits for that prompt's answer", () => {
   const sim = new BxSim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(stop("p1", "A1"), 20)
   sim.send(submit("U2", "p2"), 30)
   assert.deepEqual(replies(sim.send(stop("p2", "A2"), 40)), [])
   assert.deepEqual(starts(sim.send(bxDone(1), 50)), [
      { turn: 2, prompts: ["U2"], until: { promptId: "p2" } },
   ])
   const done = sim.send(settled(2), 60)
   assert.deepEqual(replies(done), [
      { reply: { kind: "display", turn: 2 }, notice: undefined },
   ])
   assert.deepEqual(bxStarts(done), [{ turn: 2, aText: "A2" }])
})

test("Bx: a stray bxDone for another turn frees nothing", () => {
   const sim = new BxSim()
   sim.send(submit("U1", "p1"), 0)
   sim.send(settled(1), 10)
   sim.send(stop("p1", "A1"), 20)
   sim.send(submit("U2", "p2"), 30)
   assert.deepEqual(starts(sim.send(bxDone(7), 40)), [])
   assert.equal(sim.state.bx?.turn, 1)
})
