import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { ccTrail } from "./cc-trail.ts"
import { formatPeerPackage, packageText } from "./package.ts"
import { piTrail } from "./pi-trail.ts"

// scrubbed real sessions (CC 2.1.286 + haiku; pi 0.99.1 + gpt-6-luna), one turn each
const fixture = (name: string) =>
   readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const ccTranscript = fixture("cc-transcript.jsonl")
const piSession = fixture("pi-session.jsonl")

test("a real CC turn reads cleanly: calls, results and the answer, nothing injected", () => {
   const trail = ccTrail(ccTranscript, {
      after: { promptId: "dd41731d-f63f-4324-b8d2-ef7b13e73534" },
   })
   assert.deepEqual(trail.issues, [])
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" ? `call ${i.name}` : i.kind)),
      ["call Read", "result", "call Grep", "result", "call Glob", "result", "text"],
   )
   assert.deepEqual(trail.items.at(-1), {
      kind: "text",
      text: "The files mentioning a heron are `notes.txt` and `inventory.md`.",
   })
   assert.doesNotMatch(JSON.stringify(trail), /Chunk k\d|\[redacted\]/)
})

test("tool results in a real CC turn pair with their calls", () => {
   const trail = ccTrail(ccTranscript, {
      after: { promptId: "dd41731d-f63f-4324-b8d2-ef7b13e73534" },
   })
   const grep = trail.items.find(
      (i) => i.kind === "result" && i.id === "toolu_01NG4w48hZF4L7Temu2zxd6B",
   )
   assert.deepEqual(grep, {
      kind: "result",
      id: "toolu_01NG4w48hZF4L7Temu2zxd6B",
      text: "Found 2 files\ninventory.md\nnotes.txt",
      isError: false,
   })
})

test("a real CC transcript read from the top starts with the human's prompt", () => {
   const [first] = ccTrail(ccTranscript).items
   assert.equal(first?.kind, "prompt")
})

test("a real pi session's messages read cleanly, minus the injected user turn", () => {
   const messages = piSession
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message)
   const trail = piTrail(messages)
   assert.deepEqual(trail.issues, [])
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" ? `call ${i.name}` : i.kind)),
      ["call read", "result", "call grep", "result", "text"],
   )
   assert.doesNotMatch(JSON.stringify(trail), /Use the read tool/)
})

test("a real CC turn packages with every output referenced and no inline outputs", () => {
   const stored: string[] = []
   const refer = (text: string) => {
      stored.push(text)
      return `.spiderman/peer/${stored.length}.txt`
   }
   const trail = ccTrail(ccTranscript, {
      after: { promptId: "dd41731d-f63f-4324-b8d2-ef7b13e73534" },
   })
   const text = packageText(formatPeerPackage(trail, refer))
   assert.equal(text.match(/^\[tool\] /gm)?.length, 3)
   assert.equal(stored.length, 3)
   assert.doesNotMatch(text, /The heron waited/)
   assert.match(
      text,
      /The files mentioning a heron are `notes\.txt` and `inventory\.md`\./,
   )
})
