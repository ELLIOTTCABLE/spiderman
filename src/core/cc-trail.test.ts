import assert from "node:assert/strict"
import { test } from "node:test"
import { ccTrail } from "./cc-trail.ts"

// Synthetic entries shaped after ref-cc-hooks §8 (observed keys); no real transcript content.
const base = { sessionId: "s", cwd: "C:/p", version: "2.1.286", isSidechain: false }
let n = 0
const uuid = () => `u${++n}`

const prompt = (text: string, promptId: string) => ({
   ...base,
   type: "user",
   uuid: uuid(),
   promptId,
   promptSource: "typed",
   message: { role: "user", content: text },
})
const assistant = (...content: unknown[]) => ({
   ...base,
   type: "assistant",
   uuid: uuid(),
   requestId: "req",
   message: { id: "msg", role: "assistant", content },
})
const toolResult = (id: string, content: unknown, promptId: string, isError = false) => ({
   ...base,
   type: "user",
   uuid: uuid(),
   promptId,
   message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
   },
   toolUseResult: { stdout: "ignored" },
})
const attachment = (attachment: unknown) => ({
   ...base,
   type: "attachment",
   uuid: uuid(),
   attachment,
})

const jsonl = (...entries: unknown[]) =>
   `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`

const turn1 = [
   prompt("first question", "p1"),
   attachment({
      type: "hook_additional_context",
      content: ["[peer 1/1] earlier peer"],
      hookName: "UserPromptSubmit",
   }),
   assistant({ type: "thinking", thinking: "private", signature: "sig" }),
   assistant({ type: "text", text: "Let me check." }),
   assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
   toolResult("t1", "a.ts\nb.ts", "p1"),
   assistant({ type: "text", text: "Two files." }),
   { ...base, type: "system", subtype: "turn_duration", uuid: uuid() },
]
const turn2 = [
   prompt("second question", "p2"),
   assistant({ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.ts" } }),
   toolResult("t2", [{ type: "text", text: "export {}" }], "p2", true),
   assistant({ type: "text", text: "Empty." }),
]
const transcript = jsonl(...turn1, ...turn2, prompt("third question", "p3"))

test("the span after one prompt and before the next is that turn's answer", () => {
   const trail = ccTrail(transcript, {
      after: { promptId: "p1" },
      until: { promptId: "p2" },
   })
   assert.deepEqual(trail, {
      items: [
         { kind: "text", text: "Let me check." },
         { kind: "call", id: "t1", name: "Bash", input: { command: "ls" } },
         { kind: "result", id: "t1", text: "a.ts\nb.ts", isError: false },
         { kind: "text", text: "Two files." },
      ],
      issues: [],
   })
})

test("block-array tool results and error flags carry through", () => {
   const trail = ccTrail(transcript, {
      after: { promptId: "p2" },
      until: { promptId: "p3" },
   })
   assert.deepEqual(trail.items, [
      { kind: "call", id: "t2", name: "Read", input: { file_path: "a.ts" } },
      { kind: "result", id: "t2", text: "export {}", isError: true },
      { kind: "text", text: "Empty." },
   ])
})

test("without an end cursor the span runs to the end of the file", () => {
   const trail = ccTrail(jsonl(...turn2), { after: { promptId: "p2" } })
   assert.equal(trail.items.at(-1)?.kind, "text")
   assert.equal(trail.items.length, 3)
})

test("prompts the peer never received appear as prompt items", () => {
   const trail = ccTrail(transcript, {
      after: { promptId: "p1" },
      until: { promptId: "p3" },
   })
   assert.deepEqual(
      trail.items.filter((i) => i.kind === "prompt"),
      [{ kind: "prompt", text: "second question" }],
   )
})

test("without a start cursor the whole file is read, first prompt included", () => {
   const trail = ccTrail(jsonl(...turn1))
   assert.deepEqual(trail.items[0], { kind: "prompt", text: "first question" })
})

test("a uuid also works as a cursor", () => {
   const marker = assistant({ type: "text", text: "marker" })
   const trail = ccTrail(jsonl(marker, assistant({ type: "text", text: "after" })), {
      after: { uuid: marker.uuid },
   })
   assert.deepEqual(trail.items, [{ kind: "text", text: "after" }])
})

test("an unknown start cursor yields nothing and says so, so callers can fall back", () => {
   const trail = ccTrail(transcript, { after: { promptId: "gone" } })
   assert.deepEqual(trail.items, [])
   assert.equal(trail.issues.length, 1)
})

test("injected hook context, meta, sidechain, and system entries never enter the trail", () => {
   const trail = ccTrail(
      jsonl(
         prompt("q", "p9"),
         attachment({
            type: "hook_additional_context",
            content: ["[peer 1/1] peer text"],
         }),
         { ...prompt("caveat", "p9"), isMeta: true },
         { ...assistant({ type: "text", text: "subagent" }), isSidechain: true },
         { ...base, type: "summary", summary: "s" },
         assistant({ type: "text", text: "visible" }),
      ),
      { after: { promptId: "p9" } },
   )
   assert.deepEqual(trail, { items: [{ kind: "text", text: "visible" }], issues: [] })
})

test("unknown entry types and block types are ignored without degrading", () => {
   const trail = ccTrail(
      jsonl(
         { ...base, type: "atis-latch", uuid: uuid() },
         { ...base, type: "brand-new-entry-type", uuid: uuid(), payload: 1 },
         assistant({ type: "brand_new_block", data: 1 }, { type: "text", text: "kept" }),
      ),
   )
   assert.deepEqual(trail, { items: [{ kind: "text", text: "kept" }], issues: [] })
})

test("malformed lines and entries degrade the trail instead of throwing", () => {
   const text = [
      JSON.stringify(assistant({ type: "text", text: "one" })),
      "{not json",
      JSON.stringify({ ...base, type: "assistant", uuid: uuid(), message: "nope" }),
      JSON.stringify(assistant({ type: "tool_use", name: "Bash" })),
      JSON.stringify(assistant({ type: "text", text: "two" })),
      '{"type":"assistant","message":{"content":[{"type":"te',
   ].join("\n")
   const trail = ccTrail(text)
   assert.deepEqual(trail.items, [
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
   ])
   assert.equal(trail.issues.length, 4)
})

test("CRLF line endings are tolerated", () => {
   const trail = ccTrail(jsonl(...turn2).replaceAll("\n", "\r\n"), {
      after: { promptId: "p2" },
   })
   assert.deepEqual(trail.issues, [])
   assert.equal(trail.items.length, 3)
})

test("a prompt given as text blocks is joined; images are noted", () => {
   const entry = {
      ...prompt("", "p1"),
      message: {
         role: "user",
         content: [
            { type: "text", text: "look at" },
            { type: "image", source: { type: "base64", data: "AAAA" } },
         ],
      },
   }
   assert.deepEqual(ccTrail(jsonl(entry)).items, [
      { kind: "prompt", text: "look at\n[image]" },
   ])
})
