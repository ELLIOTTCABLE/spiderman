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

test("no anchors renders the answer verbatim with no header", () => {
   assert.equal(renderElided(answer, { kind: "ok", anchors: [] }), answer)
})

test("consecutive elided blocks collapse into one counted marker", () => {
   const rendered = renderElided(answer, {
      kind: "ok",
      anchors: ["Beta two", "Gamma three", "Epsilon"],
   })
   assert.equal(rendered, "Alpha one.\n\n[2¶ elided]\n\nDelta four.\n\n[1¶ elided]")
})

test("eliding everything leaves only the marker", () => {
   const anchors = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
   assert.equal(renderElided(answer, { kind: "ok", anchors }), "[5¶ elided]")
})

test("unparseable anchors show the answer in full under a header", () => {
   const rendered = renderElided(answer, { kind: "unparseable", reason: "no JSON" })
   assert.equal(rendered, `[elision unavailable (no JSON); shown in full]\n\n${answer}`)
})

test("anchors that match nothing are counted in a header and keep their paragraphs", () => {
   const rendered = renderElided(answer, {
      kind: "ok",
      anchors: ["Alpha one", "Zeta six", ""],
   })
   assert.equal(
      rendered,
      "[elision: 2 of 3 anchors matched no single paragraph; kept]\n\n" +
         "[1¶ elided]\n\nBeta two.\n\nGamma three.\n\nDelta four.\n\nEpsilon five.",
   )
})

test("a code block containing blank lines is elided as one paragraph", () => {
   const md = "Intro.\n\n```\na\n\nb\n```\n\nOutro."
   assert.equal(
      renderElided(md, { kind: "ok", anchors: ["a b"] }),
      "Intro.\n\n[1¶ elided]\n\nOutro.",
   )
})

test("kept blocks are byte-identical to the source", () => {
   const md = "Keep *this*  exactly.\n\n- list\n- items\n\nDrop this one."
   assert.equal(
      renderElided(md, { kind: "ok", anchors: ["Drop this"] }),
      "Keep *this*  exactly.\n\n- list\n- items\n\n[1¶ elided]",
   )
})

test("an empty answer renders empty", () => {
   assert.equal(renderElided("", { kind: "ok", anchors: [] }), "")
})
