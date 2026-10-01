import assert from "node:assert/strict"
import { resolve } from "node:path"
import { test } from "node:test"
import {
   bAnswerText,
   bMessage,
   bOutcome,
   displayChunks,
   plainPaths,
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

const cwd = resolve("/project")

test("@path mentions of files and directories under cwd become plain paths", () => {
   const real = new Set(["notes/plan.md", "src"].map((p) => resolve(cwd, p)))
   const plain = (prompt: string) => plainPaths(prompt, cwd, (path) => real.has(path))
   assert.equal(plain("see @notes/plan.md"), "see notes/plan.md")
   assert.equal(plain("@notes/plan.md#L10-20 and @src."), "notes/plan.md#L10-20 and src.")
   assert.equal(plain("(@notes/plan.md)"), "(@notes/plan.md)", "only at a word start")
})

test("emails, handles, missing files and paths outside cwd keep their @", () => {
   const plain = (prompt: string) => plainPaths(prompt, cwd, () => false)
   assert.equal(
      plain("mail me@example.com or ping @alice"),
      "mail me@example.com or ping @alice",
   )
   assert.equal(
      plainPaths("read @../secrets.txt", cwd, () => true),
      "read @../secrets.txt",
   )
   assert.equal(plain("@notes/gone.md"), "@notes/gone.md")
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
