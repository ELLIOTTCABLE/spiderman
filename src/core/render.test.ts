import assert from "node:assert/strict"
import { test } from "node:test"
import { renderElided } from "./render.ts"

const answer = [
   "Alpha one.",
   "Beta two.",
   "Gamma three.",
   "Delta four.",
   "Epsilon five.",
].join("\n\n")
const render = (md: string, indices: number[], aText?: string) =>
   renderElided(md, { kind: "ok", indices }, aText).text

test("no indices renders the answer verbatim with no header", () => {
   assert.equal(render(answer, []), answer)
})

test("each elided block becomes a one-line preview of its own first words", () => {
   assert.equal(
      render(answer, [2, 3, 5]),
      'Alpha one.\n\n[elided: "Beta two."]\n[elided: "Gamma three."]\n\nDelta four.\n\n[elided: "Epsilon five."]',
   )
})

test("a long block's preview quotes its first eight words and marks the cut", () => {
   const md = "Keep.\n\nOne two three four five six seven eight nine ten."
   assert.equal(
      render(md, [2]),
      'Keep.\n\n[elided: "One two three four five six seven eight…"]',
   )
})

test("a code block's preview skips the fence", () => {
   const md = "Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nOutro."
   assert.equal(
      render(md, [2]),
      'Intro.\n\n[elided: "const a = 1 const b = 2"]\n\nOutro.',
   )
})

test("indices count our blocks, so a fence with blank lines is one paragraph", () => {
   const md = "Intro.\n\n```\nx\n\ny\n```\n\n- a\n\n- b\n\nOutro."
   assert.equal(
      render(md, [4]),
      'Intro.\n\n```\nx\n\ny\n```\n\n- a\n\n- b\n\n[elided: "Outro."]',
   )
})

test("unparseable output shows the answer in full under a header", () => {
   const rendered = renderElided(answer, { kind: "unparseable", reason: "no list" }).text
   assert.equal(rendered, `[elision unavailable (no list); shown in full]\n\n${answer}`)
})

test("out-of-range and repeated indices elide nothing more; out-of-range ones are named", () => {
   assert.deepEqual(renderElided(answer, { kind: "ok", indices: [0, 1, 1, 9] }), {
      text:
         "[elision: ignored paragraph numbers out of range: 0, 9]\n\n" +
         '[elided: "Alpha one."]\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.',
      elided: [1],
      vetoed: [],
   })
})

test("kept blocks are byte-identical to the source", () => {
   const md = "Keep *this*  exactly.\n\n- list\n- items\n\nDrop this one."
   assert.equal(
      render(md, [3]),
      'Keep *this*  exactly.\n\n- list\n- items\n\n[elided: "Drop this one."]',
   )
})

test("given A's text, blocks with numbers A lacks stay, and the veto is reported", () => {
   const md = "Same point as A.\n\nIt saved 30% at 100M rows."
   assert.deepEqual(renderElided(md, { kind: "ok", indices: [1, 2] }, "Same point."), {
      text: '[elided: "Same point as A."]\n\nIt saved 30% at 100M rows.',
      elided: [1],
      vetoed: [2],
   })
})

test("an empty answer renders empty", () => {
   assert.equal(render("", []), "")
})
