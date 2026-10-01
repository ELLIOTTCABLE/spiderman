import assert from "node:assert/strict"
import { test } from "node:test"
import { BX_MARK } from "./elision.ts"
import { piTrail, piView } from "./pi-trail.ts"
import { sha256Hex } from "./store.ts"

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

test("a user message is the human typing to this side directly", () => {
   const trail = piTrail([
      { role: "user", content: [{ type: "text", text: "why?" }], timestamp: 0 },
   ])
   assert.deepEqual(trail.items, [{ kind: "prompt", text: "why?", direct: true }])
})

// a branch as pi's getBranch() returns it
let ids = 0
const entry = (message: unknown) => ({ type: "message", id: `e${++ids}`, message })
const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }] })
const said = (text: string) => entry(assistant([{ type: "text", text }]))

function view(
   branch: readonly { id: string }[],
   deliveries: Record<string, string[]>,
   never: readonly string[] = [],
   asked = false,
) {
   const byHash = new Map(
      Object.entries(deliveries).map(([t, prompts]) => [
         sha256Hex(t),
         { prompts, asked },
      ]),
   )
   return piView(branch, {
      parent: (id) => {
         const at = branch.findIndex((e) => e.id === id)
         return at === -1 ? undefined : (branch[at - 1]?.id ?? null)
      },
      carrier: sha256Hex,
      delivered: (hash) => byHash.get(hash),
      never: new Set(never),
   })
}
const all = (v: ReturnType<typeof view>) => v.trail(v.live.map((e) => e.id)).items

test("our deliveries start answers to shared messages; the human's own messages are prompts", () => {
   const ours = user("[peer answer] …\n\n[the human's message]\nU1")
   const branch = [ours, said("B1."), user("and why?"), said("Because.")]
   const v = view(branch, { "[peer answer] …\n\n[the human's message]\nU1": ["U1"] })
   assert.deepEqual(
      v.live.map((e) => [e.startsTurn, e.content, e.carries.length]),
      [
         [true, false, 1],
         [false, true, 0],
         [true, true, 0],
         [false, true, 0],
      ],
   )
   assert.deepEqual(all(v), [
      { kind: "turn", prompts: ["U1"] },
      { kind: "text", text: "B1." },
      { kind: "prompt", text: "and why?", direct: true },
      { kind: "text", text: "Because." },
   ])
})

test("an elision exchange left on the branch never reaches a trail", () => {
   const branch = [
      said("B1."),
      user(`${BX_MARK} …`),
      said("2,5"),
      user("next"),
      said("B2."),
   ]
   assert.deepEqual(all(view(branch, {})), [
      { kind: "text", text: "B1." },
      { kind: "prompt", text: "next", direct: true },
      { kind: "text", text: "B2." },
   ])
})

test("a delivery's answer still running shows nothing for it, not an empty heading", () => {
   const ours = user("U2 package")
   const branch = [said("B1."), ours]
   assert.deepEqual(all(view(branch, { "U2 package": ["U2"] })), [
      { kind: "text", text: "B1." },
   ])
})

test("recorded elision entries never reach a trail, even where the marker can't tell", () => {
   const reply = said("2,5")
   const branch = [said("B1."), reply]
   assert.deepEqual(all(view(branch, {}, [reply.id])), [{ kind: "text", text: "B1." }])
})

test("an answer whose question the receiver lost brings its question along", () => {
   const ours = user("package + U1")
   const v = view([ours, said("B1.")], { "package + U1": ["U1"] }, [], true)
   assert.deepEqual(all(v), [
      { kind: "turn", prompts: ["U1"], asked: true },
      { kind: "text", text: "B1." },
   ])
})

test("only the asked-for entries are read, each still under its delivery's heading", () => {
   const first = user("p1")
   const second = user("p2")
   const b2 = said("B2.")
   const v = view([first, said("B1."), second, b2], { p1: ["U1"], p2: ["U2"] })
   assert.deepEqual(v.trail([b2.id]).items, [
      { kind: "turn", prompts: ["U2"] },
      { kind: "text", text: "B2." },
   ])
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

test("image blocks in tool results become a media note; text is joined", () => {
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
      { kind: "result", id: "c", text: "before\nafter", isError: true, media: "1 image" },
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

// pi-subagents, as observed
const startAgent = [
   assistant(
      [
         {
            type: "toolCall",
            id: "c1",
            name: "Agent",
            arguments: { description: "Map ledgers", prompt: "Map the ledgers." },
         },
      ],
      "toolUse",
   ),
   {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "Agent",
      content: [{ type: "text", text: "Agent started in background.\nAgent ID: a1" }],
      details: { agentId: "a1", status: "background", description: "Map ledgers" },
      isError: false,
      timestamp: 1,
   },
]
const notification = {
   role: "custom",
   customType: "subagent-notification",
   content:
      "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>c1</tool-use-id>\n" +
      "<status>Done</status>\n<result>Two &lt;ledgers&gt; found.</result>\n" +
      "</task-notification>\nFull transcript available at: T:/tasks/a1.output",
   display: true,
   details: { id: "a1", description: "Map ledgers", status: "completed" },
   timestamp: 2,
}
const fetched = [
   assistant(
      [
         {
            type: "toolCall",
            id: "c2",
            name: "get_subagent_result",
            arguments: { agent_id: "a1" },
         },
      ],
      "toolUse",
   ),
   {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "get_subagent_result",
      content: [
         {
            type: "text",
            text:
               "Agent: a1\nType: scout | Status: completed | Tool uses: 3\n" +
               "Description: Map ledgers\n\n## Ledgers\n\nTwo found.",
         },
      ],
      isError: false,
      timestamp: 3,
   },
]

test("a background subagent's notification is its report, unescaped and linked", () => {
   const trail = piTrail([...startAgent, notification])
   assert.deepEqual(trail.items.slice(1), [
      { kind: "result", id: "c1", text: "", isError: false, background: true },
      {
         kind: "report",
         id: "c1",
         agent: "a1",
         label: "Map ledgers",
         text: "Two <ledgers> found.",
         notice: true,
         status: "Done",
         transcript: "T:/tasks/a1.output",
      },
   ])
})

test("a fetched result becomes the report, replacing its call and the notice", () => {
   const trail = piTrail([...startAgent, notification, ...fetched])
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" ? `call ${i.name}` : i.kind)),
      ["call Agent", "result", "report"],
   )
   assert.deepEqual(trail.items.at(-1), {
      kind: "report",
      id: "c1",
      agent: "a1",
      label: "Map ledgers",
      text: "## Ledgers\n\nTwo found.",
      status: "completed",
   })
})

test("a fetch that is not a report stays an ordinary call and result", () => {
   const trail = piTrail([
      assistant(
         [{ type: "toolCall", id: "c3", name: "get_subagent_result", arguments: {} }],
         "toolUse",
      ),
      {
         role: "toolResult",
         toolCallId: "c3",
         toolName: "get_subagent_result",
         content: [{ type: "text", text: 'Agent not found: "zz".' }],
         isError: false,
         timestamp: 1,
      },
   ])
   assert.deepEqual(
      trail.items.map((i) => i.kind),
      ["call", "result"],
   )
})

test("a turn that ended in an error or an abort says so", () => {
   const failed = { ...assistant([], "error"), errorMessage: "WebSocket closed 1012" }
   const aborted = { ...assistant([{ type: "text", text: "Partial" }], "aborted") }
   assert.deepEqual(piTrail([failed, aborted]).items, [
      { kind: "halt", why: "error", detail: "WebSocket closed 1012" },
      { kind: "text", text: "Partial" },
      { kind: "halt", why: "aborted" },
   ])
})
