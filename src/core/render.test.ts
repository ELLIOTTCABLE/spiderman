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
const render = (md: string, anchors: string[], aText?: string) =>
   renderElided(md, { kind: "ok", anchors }, aText).text

test("no anchors renders the answer verbatim with no header", () => {
   assert.equal(render(answer, []), answer)
})

test("each elided block becomes a one-line preview of its own first words", () => {
   assert.equal(
      render(answer, ["Beta two", "Gamma three", "Epsilon"]),
      'Alpha one.\n\n[elided: "Beta two."]\n[elided: "Gamma three."]\n\nDelta four.\n\n[elided: "Epsilon five."]',
   )
})

test("a long block's preview quotes its first eight words and marks the cut", () => {
   const md = "Keep.\n\nOne two three four five six seven eight nine ten."
   assert.equal(
      render(md, ["One two three"]),
      'Keep.\n\n[elided: "One two three four five six seven eight…"]',
   )
})

test("a code block's preview skips the fence", () => {
   const md = "Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nOutro."
   assert.equal(
      render(md, ["const a"]),
      'Intro.\n\n[elided: "const a = 1 const b = 2"]\n\nOutro.',
   )
})

test("unparseable anchors show the answer in full under a header", () => {
   const rendered = renderElided(answer, { kind: "unparseable", reason: "no JSON" }).text
   assert.equal(rendered, `[elision unavailable (no JSON); shown in full]\n\n${answer}`)
})

test("anchors that match nothing are counted in a header and keep their paragraphs", () => {
   assert.equal(
      render(answer, ["Alpha one", "Zeta six", ""]),
      "[elision: 2 of 3 anchors matched no single paragraph; kept]\n\n" +
         '[elided: "Alpha one."]\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.',
   )
})

test("kept blocks are byte-identical to the source", () => {
   const md = "Keep *this*  exactly.\n\n- list\n- items\n\nDrop this one."
   assert.equal(
      render(md, ["Drop this"]),
      'Keep *this*  exactly.\n\n- list\n- items\n\n[elided: "Drop this one."]',
   )
})

test("given A's text, blocks with numbers A lacks stay, and the veto is counted", () => {
   const md = "Same point as A.\n\nIt saved 30% at 100M rows."
   const result = renderElided(
      md,
      { kind: "ok", anchors: ["Same point", "It saved"] },
      "Same point.",
   )
   assert.deepEqual(result, {
      text: '[elided: "Same point as A."]\n\nIt saved 30% at 100M rows.',
      vetoed: 1,
   })
})

test("an empty answer renders empty", () => {
   assert.equal(render("", []), "")
})
