import assert from "node:assert/strict"
import { test } from "node:test"
import { splitBlocks } from "./blocks.ts"
import {
   bxPrompt,
   MEDIATOR_SYSTEM_PROMPT,
   mediatorInput,
   parseIndices,
} from "./elision.ts"

const ok = (indices: number[]) => ({ kind: "ok", indices })

test("a bare list or none parses", () => {
   assert.deepEqual(parseIndices("2,5,7"), ok([2, 5, 7]))
   assert.deepEqual(parseIndices(" 2, 5 ;7 and 9 "), ok([2, 5, 7, 9]))
   assert.deepEqual(parseIndices("none"), ok([]))
   assert.deepEqual(parseIndices("None."), ok([]))
})

test("fences, decoration, labels and surrounding prose are tolerated", () => {
   assert.deepEqual(parseIndices("```\n2, 5\n```"), ok([2, 5]))
   assert.deepEqual(
      parseIndices("Comparing the two:\n\n**2, 5**\n\nBoth restate A."),
      ok([2, 5]),
   )
   assert.deepEqual(parseIndices("Redundant paragraphs: [¶2], [¶5]"), ok([2, 5]))
   assert.deepEqual(parseIndices("Answer: none"), ok([]))
})

test("repeats and out-of-range numbers parse as given; rendering ignores them", () => {
   assert.deepEqual(parseIndices("0, 2, 2, 99"), ok([0, 2, 2, 99]))
})

test("digits inside prose are never taken as an answer", () => {
   assert.deepEqual(parseIndices("Paragraph 2 repeats A's 3 points."), {
      kind: "unparseable",
      reason: "no line of paragraph numbers or none",
   })
   assert.equal(parseIndices("").kind, "unparseable")
})

test("two different answer lines are unparseable; the same one twice is fine", () => {
   assert.deepEqual(parseIndices("2,5\n\nnone"), {
      kind: "unparseable",
      reason: "several different answers",
   })
   assert.deepEqual(parseIndices("2, 5\n\n`2,5`"), ok([2, 5]))
})

const bAnswer =
   "First point here.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nLast point."

test("the mediator sees B numbered by our own block split", () => {
   assert.equal(
      mediatorInput("A's answer.", bAnswer),
      "<answer_a>\nA's answer.\n</answer_a>\n\n<answer_b>\n[¶1]\nFirst point here.\n\n[¶2]\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n[¶3]\nLast point.\n</answer_b>",
   )
})

test("Bx gets A's text and a one-line index of B's blocks, under the mediator's criteria", () => {
   const prompt = bxPrompt(
      "A's answer.",
      splitBlocks(`${bAnswer}\n\nOne two three four five six seven.`),
   )
   assert.match(prompt, /<answer_a>\nA's answer\.\n<\/answer_a>/)
   assert.match(
      prompt,
      /\n1: "First point here\."\n2: "const a = 1 const b…"\n3: "Last point\."\n4: "One two three four five six…"\n/,
   )
   const criteria = MEDIATOR_SYSTEM_PROMPT.split("\n\n")[1] ?? ""
   assert.match(criteria, /When in doubt, it is not redundant\.$/)
   assert.ok(prompt.includes(criteria))
   assert.match(prompt, /comma-separated \(for example 2,5,7\), or none\.$/)
})
