import assert from "node:assert/strict"
import { test } from "node:test"
import {
   bAnswerText,
   bMessage,
   bOutcome,
   displayChunks,
   emptyLedger,
   lastMessageUuid,
   lastTurnStart,
   reconcileWithLast,
   sectioned,
   withoutDelivered,
} from "./bridge.ts"
import type { PeerPackage } from "./package.ts"

test("B's message is A's package, then the human's messages in order", () => {
   assert.equal(
      bMessage("[peer answer] …", ["first", "second"]),
      "[peer answer] …\n\n[the human's message]\nfirst\n\n[the human's message]\nsecond",
   )
   assert.equal(bMessage(undefined, ["only"]), "[the human's message]\nonly")
})

test("A's final text is appended only when the lagging transcript lacks it", () => {
   const trail = { items: [{ kind: "text" as const, text: "Done." }], issues: [] }
   assert.equal(reconcileWithLast(trail, "Done.\n"), trail)
   assert.deepEqual(reconcileWithLast(trail, "Final answer.").items.at(-1), {
      kind: "text",
      text: "Final answer.",
   })
   assert.equal(reconcileWithLast(trail, undefined), trail)
})

const line = (entry: object) => JSON.stringify(entry)

test("the cut lands on the last conversation entry, never a hook or system line", () => {
   const jsonl = [
      line({ type: "user", uuid: "u1", message: { content: "q" } }),
      line({ type: "assistant", uuid: "a1", message: { content: [] } }),
      line({ type: "attachment", uuid: "h1" }),
      line({ type: "system", uuid: "s1" }),
      '{"type":"assistant","uuid":"partial',
   ].join("\n")
   assert.equal(lastMessageUuid(jsonl), "a1")
   assert.equal(lastMessageUuid(""), undefined)
})

test("a newly paired B starts from A's last completed turn", () => {
   const jsonl = [
      line({ type: "user", uuid: "u1", promptId: "p1", message: { content: "old" } }),
      line({ type: "assistant", uuid: "a1", message: { content: [] } }),
      line({
         type: "user",
         uuid: "r1",
         promptId: "p1",
         message: { content: [{ type: "tool_result" }] },
      }),
      line({ type: "user", uuid: "u2", promptId: "p2", message: { content: "last" } }),
      line({ type: "assistant", uuid: "a2", message: { content: [] } }),
      line({ type: "user", uuid: "u3", promptId: "p3", message: { content: "now" } }),
   ].join("\n")
   assert.deepEqual(lastTurnStart(jsonl, "p3"), { uuid: "r1" })
   assert.equal(lastTurnStart(jsonl, "p2"), "top")
   assert.equal(lastTurnStart(jsonl, "p1"), undefined)
})

const text = (t: string) => ({ kind: "text" as const, text: t })

test("the Stop-reconciled final text is suppressed once, at its first exact match only", () => {
   const ledger = { ...emptyLedger, reconciled: "Final answer." }
   const { trail, ledger: next } = withoutDelivered(
      { items: [text("Final answer.  "), text("Final answer.")], issues: [] },
      ledger,
   )
   assert.deepEqual(trail.items, [text("Final answer.")])
   assert.equal(next.reconciled, undefined)
})

test("a short sentence repeated verbatim is never suppressed", () => {
   const once = withoutDelivered({ items: [text("Done.")], issues: [] }, emptyLedger)
   const twice = withoutDelivered({ items: [text("Done.")], issues: [] }, once.ledger)
   assert.deepEqual(twice.trail.items, [text("Done.")])
})

test("calls and results B was sent are suppressed by id; a direct message by one prompt item", () => {
   const call = { kind: "call" as const, id: "c1", name: "Read", input: {} }
   const sent = withoutDelivered(
      { items: [call], issues: [] },
      { ...emptyLedger, prompts: ["U3b"] },
   )
   const later = withoutDelivered(
      {
         items: [
            call,
            { kind: "result", id: "c1", text: "x", isError: false },
            { kind: "prompt", text: "U3b" },
            { kind: "prompt", text: "U3b" },
         ],
         issues: [],
      },
      sent.ledger,
   )
   assert.deepEqual(later.trail.items, [
      { kind: "result", id: "c1", text: "x", isError: false },
      { kind: "prompt", text: "U3b" },
   ])
})

test("several B answers in one delivery each get a heading naming the prompt", () => {
   const pkg = (text: string): PeerPackage => ({
      segments: [
         { kind: "frame", text: "[open]" },
         { kind: "prose", text },
         { kind: "frame", text: "[end]" },
      ],
      interactions: [],
      memory: { reads: [] },
   })
   const merged = sectioned([
      { pkg: pkg("B3"), prompt: "first question" },
      { pkg: pkg("B4"), prompt: `second ${"x".repeat(80)}` },
   ])
   assert.deepEqual(
      merged.segments.map((s) => s.text),
      [
         "[open]",
         '[peer answer 1 of 2, to the human\'s message "first question"]',
         "B3",
         `[peer answer 2 of 2, to the human's message "second ${"x".repeat(53)}…"]`,
         "B4",
         "[end]",
      ],
   )
})

test("B's answer is its last assistant text; its outcome comes from the stop reason", () => {
   const messages = [
      {
         role: "assistant",
         content: [{ type: "text", text: "Checking." }, { type: "toolCall" }],
      },
      { role: "toolResult", content: [] },
      {
         role: "assistant",
         content: [{ type: "thinking" }, { type: "text", text: "Answer." }],
         stopReason: "stop",
      },
   ]
   assert.equal(bAnswerText(messages), "Answer.")
   assert.equal(bOutcome(messages), "completed")
   assert.equal(
      bOutcome([{ role: "assistant", content: [], stopReason: "aborted" }]),
      "aborted",
   )
})

test("display chunks fit the systemMessage cap and point at the full text", () => {
   const long = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i} ${"x".repeat(400)}`,
   ).join("\n\n")
   const chunks = displayChunks(long, {
      maxChunks: 2,
      fullPath: ".spiderman/turns/b-3.md",
   })
   assert.equal(chunks.length, 2)
   for (const chunk of chunks) assert.ok(chunk.length <= 9_500)
   assert.match(
      chunks[0] ?? "",
      /^\[peer 1\/2\]\n\[peer answer\] full text: \.spiderman\/turns\/b-3\.md/,
   )
   assert.match(chunks[1] ?? "", /\.spiderman\/turns\/b-3\.md\]$/)
})
