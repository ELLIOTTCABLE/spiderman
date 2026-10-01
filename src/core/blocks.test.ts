import assert from "node:assert/strict"
import { test } from "node:test"
import { splitBlocks } from "./blocks.ts"

const kinds = (markdown: string) => splitBlocks(markdown).map((b) => b.kind)
const raws = (markdown: string) => splitBlocks(markdown).map((b) => b.raw)

test("blank lines separate paragraphs; single newlines don't", () => {
   assert.deepEqual(raws("one\nstill one\n\ntwo\n\n\n\nthree"), [
      "one\nstill one",
      "two",
      "three",
   ])
})

test("a fenced code block with blank lines inside stays whole", () => {
   const md = "Before:\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nAfter."
   assert.deepEqual(raws(md), [
      "Before:",
      "```ts\nconst a = 1\n\n\nconst b = 2\n```",
      "After.",
   ])
   assert.deepEqual(kinds(md), ["paragraph", "code", "paragraph"])
})

test("a loose list with blank lines between items stays whole", () => {
   const md = "- first item\n\n  more about first\n\n- second item\n\nNext paragraph."
   assert.deepEqual(raws(md), [
      "- first item\n\n  more about first\n\n- second item",
      "Next paragraph.",
   ])
   assert.deepEqual(kinds(md), ["list", "paragraph"])
})

test("tables, blockquotes and headings are their own blocks", () => {
   const md =
      "## Options\nThe choices:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> more"
   assert.deepEqual(kinds(md), ["heading", "paragraph", "table", "blockquote"])
   assert.deepEqual(raws(md)[2], "| a | b |\n|---|---|\n| 1 | 2 |")
})

test("an unclosed fence swallows the rest rather than splitting it", () => {
   const md = "Intro.\n\n```\ncode\n\nmore code"
   assert.deepEqual(kinds(md), ["paragraph", "code"])
})

test("blocks re-join to the original modulo separating blank lines", () => {
   const md = [
      "# Title",
      "Opening paragraph with *emphasis* and `code`.",
      "",
      "1. one",
      "2. two",
      "",
      "```",
      "x",
      "```",
      "",
      "> quote",
      "",
      "Closing.",
   ].join("\n")
   const squash = (s: string) => s.replace(/\n{2,}/g, "\n").trim()
   const joined = splitBlocks(md)
      .map((b) => b.raw)
      .join("\n\n")
   assert.equal(squash(joined), squash(md))
})

test("trailing whitespace inside a block is kept verbatim", () => {
   assert.deepEqual(raws("line with hard break  \nnext"), [
      "line with hard break  \nnext",
   ])
})

test("empty and whitespace-only input has no blocks", () => {
   assert.deepEqual(splitBlocks(""), [])
   assert.deepEqual(splitBlocks("\n\n  \n"), [])
})
