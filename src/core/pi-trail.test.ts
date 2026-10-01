import assert from "node:assert/strict"
import { test } from "node:test"
import { piTrail } from "./pi-trail.ts"

const usage = {
   input: 1,
   output: 1,
   cacheRead: 0,
   cacheWrite: 0,
   totalTokens: 2,
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const assistant = (content: unknown[], stopReason = "stop") => ({
   role: "assistant",
   content,
   api: "openai-codex-responses",
   provider: "openai-codex",
   model: "m",
   usage,
   stopReason,
   timestamp: 1,
})

test("assistant text, tool calls and tool results become an ordered trail", () => {
   const trail = piTrail([
      { role: "user", content: "[peer answer] … the human's prompt", timestamp: 0 },
      assistant(
         [
            { type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
            { type: "text", text: "Checking." },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
         ],
         "toolUse",
      ),
      {
         role: "toolResult",
         toolCallId: "call_1",
         toolName: "read",
         content: [{ type: "text", text: "export {}" }],
         isError: false,
         timestamp: 2,
      },
      assistant([{ type: "text", text: "It is empty." }]),
   ])
   assert.deepEqual(trail, {
      items: [
         { kind: "text", text: "Checking." },
         { kind: "call", id: "call_1", name: "read", input: { path: "a.ts" } },
         { kind: "result", id: "call_1", text: "export {}", isError: false },
         { kind: "text", text: "It is empty." },
      ],
      issues: [],
   })
})

test("user messages are skipped: they are the extension's own injected turns", () => {
   const trail = piTrail([
      { role: "user", content: [{ type: "text", text: "U_N" }], timestamp: 0 },
   ])
   assert.deepEqual(trail.items, [])
})

test("thinking never reaches the trail", () => {
   const trail = piTrail([
      assistant([
         { type: "thinking", thinking: "secret", redacted: true },
         { type: "text", text: "x" },
      ]),
   ])
   assert.doesNotMatch(JSON.stringify(trail), /secret/)
})

test("image blocks in tool results are noted, text is joined", () => {
   const trail = piTrail([
      {
         role: "toolResult",
         toolCallId: "c",
         toolName: "read",
         content: [
            { type: "text", text: "before" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "text", text: "after" },
         ],
         isError: true,
         timestamp: 0,
      },
   ])
   assert.deepEqual(trail.items, [
      { kind: "result", id: "c", text: "before\n[image]\nafter", isError: true },
   ])
})

test("other extensions' message roles are skipped quietly", () => {
   const trail = piTrail([
      { role: "custom", customType: "x", content: "c", display: true, timestamp: 0 },
      { role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 0 },
      { role: "bashExecution", command: "ls", output: "", timestamp: 0 },
   ])
   assert.deepEqual(trail, { items: [], issues: [] })
})

test("malformed messages and blocks are reported, not thrown", () => {
   const trail = piTrail([
      null,
      { role: "assistant", content: "not an array" },
      assistant([
         { type: "toolCall", id: 5, name: "read" },
         { type: "text", text: "ok" },
      ]),
   ])
   assert.deepEqual(trail.items, [{ kind: "text", text: "ok" }])
   assert.equal(trail.issues.length, 3)
})
