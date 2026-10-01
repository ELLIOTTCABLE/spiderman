import assert from "node:assert/strict"
import { test } from "node:test"
import { splitBlocks } from "./blocks.ts"
import { matchAnchors, words } from "./match.ts"

const answer = [
   "## Caching",
   "The **prompt cache** is keyed by the session id, so a fork starts cold.",
   "",
   "- First, the hook posts the prompt.",
   "- Then the extension replies.",
   "",
   "1. Ordered steps begin here and continue",
   "",
   "> Quoted: “don’t” — said the docs.",
   "",
   "```ts",
   "const cacheKey = sessionId",
   "```",
   "",
   "See [the docs](https://example.com/caching) for details on TTLs.",
   "",
   "The cache is warm.",
   "",
   "The cache is cold.",
].join("\n")
const blocks = splitBlocks(answer)

function matched(anchor: string): number | string {
   const [only] = matchAnchors(blocks, [anchor]).matches
   assert.ok(only)
   return only.status === "matched" ? only.block : only.status
}

test("case, emphasis, and whitespace differences still match", () => {
   assert.equal(matched("the prompt  cache is KEYED by the session"), 1)
})

test("smart quotes and dashes match their straight forms, and vice versa", () => {
   assert.equal(matched(`Quoted: "don't" - said the docs`), 4)
})

test("block markers are ignored on both sides", () => {
   assert.equal(matched("First, the hook posts the prompt"), 2)
   assert.equal(matched("- First, the hook posts"), 2)
   assert.equal(matched("Ordered steps begin here"), 3)
   assert.equal(matched("1. Ordered steps begin here"), 3)
   assert.equal(matched("Caching"), 0)
})

test("a code block matches by its first code line, not its fence", () => {
   assert.equal(matched("const cacheKey = sessionId"), 5)
   assert.equal(matched("```ts const cacheKey"), 5)
})

test("link text matches without its URL", () => {
   assert.equal(matched("See the docs for details on TTLs"), 6)
   assert.equal(matched("See [the docs](https://example.com/caching) for details"), 6)
})

test("a trailing ellipsis on the anchor is ignored", () => {
   assert.equal(matched("The prompt cache is keyed by…"), 1)
   assert.equal(matched("The prompt cache is keyed by ..."), 1)
})

test("a prefix shared by two blocks is ambiguous", () => {
   assert.equal(matched("The cache is"), "ambiguous")
   assert.equal(matched("The cache is cold"), 8)
})

test("an anchor from the middle of a block does not match", () => {
   assert.equal(matched("keyed by the session id"), "unmatched")
})

test("an anchor longer than its block does not match", () => {
   assert.equal(matched("The cache is warm and getting warmer"), "unmatched")
})

test("anchors with no words are empty, not wildcards", () => {
   assert.equal(matched(""), "empty")
   assert.equal(matched("…"), "empty")
   assert.equal(matched("**"), "empty")
})

test("the elided set holds only uniquely matched blocks", () => {
   const plan = matchAnchors(blocks, [
      "The cache is cold",
      "The cache is",
      "nothing like this",
      "Caching",
   ])
   assert.deepEqual([...plan.elided].sort(), [0, 8])
   assert.deepEqual(
      plan.matches.map((m) => m.status),
      ["matched", "ambiguous", "unmatched", "matched"],
   )
})

test("words() splits on anything that is not a letter or digit", () => {
   assert.deepEqual(words("Don’t use foo_bar() — it’s *slow*!"), [
      "don",
      "t",
      "use",
      "foo",
      "bar",
      "it",
      "s",
      "slow",
   ])
})
