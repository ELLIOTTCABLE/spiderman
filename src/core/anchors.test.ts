import assert from "node:assert/strict"
import { test } from "node:test"
import { parseAnchors } from "./anchors.ts"

test("bare JSON object", () => {
   assert.deepEqual(parseAnchors('{"elide": ["first words of a paragraph"]}'), {
      kind: "ok",
      anchors: ["first words of a paragraph"],
   })
})

test("empty elide list is a valid answer, not a failure", () => {
   assert.deepEqual(parseAnchors('{"elide": []}'), { kind: "ok", anchors: [] })
})

test("fenced JSON with surrounding prose", () => {
   const output = [
      "Here are the redundant paragraphs:",
      "",
      "```json",
      '{"elide": ["The cache is keyed by", "Second anchor here"]}',
      "```",
      "",
      "Let me know if you need anything else.",
   ].join("\n")
   assert.deepEqual(parseAnchors(output), {
      kind: "ok",
      anchors: ["The cache is keyed by", "Second anchor here"],
   })
})

test("braces in prose before the object do not derail extraction", () => {
   const output = 'Sets like {a, b} are unrelated. {"elide": ["kept anchor"]}'
   assert.deepEqual(parseAnchors(output), { kind: "ok", anchors: ["kept anchor"] })
})

test("braces inside anchor strings are not structure", () => {
   assert.deepEqual(parseAnchors('{"elide": ["use {x} and } then"]}'), {
      kind: "ok",
      anchors: ["use {x} and } then"],
   })
})

test("extra keys are tolerated", () => {
   assert.deepEqual(parseAnchors('{"elide": ["a b c"], "note": "two were close"}'), {
      kind: "ok",
      anchors: ["a b c"],
   })
})

test("the same object repeated is not a conflict", () => {
   const output = '{"elide": ["x y z"]}\n\nAgain: {"elide": ["x y z"]}'
   assert.deepEqual(parseAnchors(output), { kind: "ok", anchors: ["x y z"] })
})

test("two different elide objects are unparseable", () => {
   const result = parseAnchors('{"elide": ["x y z"]} or maybe {"elide": ["p q r"]}')
   assert.equal(result.kind, "unparseable")
})

test("no JSON at all is unparseable", () => {
   const result = parseAnchors("I think paragraphs 2 and 3 are redundant.")
   assert.equal(result.kind, "unparseable")
})

test("empty output is unparseable", () => {
   assert.equal(parseAnchors("").kind, "unparseable")
})

test("JSON without an elide key is unparseable", () => {
   assert.equal(parseAnchors('{"keep": ["a"]}').kind, "unparseable")
})

test("elide that is not an array is unparseable", () => {
   assert.equal(parseAnchors('{"elide": "first words"}').kind, "unparseable")
})

test("a non-string anchor makes the whole answer unparseable", () => {
   const result = parseAnchors('{"elide": ["fine anchor", 3]}')
   assert.equal(result.kind, "unparseable")
})

test("smart-quoted pseudo-JSON is unparseable rather than guessed at", () => {
   assert.equal(parseAnchors("{“elide”: [“first words”]}").kind, "unparseable")
})

test("truncated JSON is unparseable", () => {
   assert.equal(parseAnchors('{"elide": ["first words", "sec').kind, "unparseable")
})

test("an object nested under another key is not the answer", () => {
   assert.equal(parseAnchors('{"result": {"elide": ["a b"]}}').kind, "unparseable")
})

test("an unparseable result carries a reason", () => {
   const result = parseAnchors('{"elide": 5}')
   assert.equal(result.kind, "unparseable")
   if (result.kind === "unparseable") assert.match(result.reason, /elide/)
})
