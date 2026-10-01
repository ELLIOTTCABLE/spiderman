import assert from "node:assert/strict"
import { test } from "node:test"
import {
   bAnswerText,
   bMessage,
   bOutcome,
   displayChunks,
   lastUuid,
   reconcileWithLast,
} from "./bridge.ts"

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

test("lastUuid skips a trailing partial line", () => {
   assert.equal(lastUuid('{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"c'), "b")
   assert.equal(lastUuid(""), undefined)
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
