import assert from "node:assert/strict"
import { test } from "node:test"
import { ccTrail } from "./cc-trail.ts"

// synthetic, shaped after ref-cc-hooks §8; never real transcripts (private data)
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

// chains entries in order; an explicit parentUuid (even null) wins
function jsonl(...entries: object[]): string {
   let previous: unknown = null
   const linked = entries.map((e) => {
      const entry: Record<string, unknown> = { ...e }
      if (typeof entry.uuid !== "string") return entry
      if (!("parentUuid" in entry)) entry.parentUuid = previous
      previous = entry.uuid
      return entry
   })
   return `${linked.map((e) => JSON.stringify(e)).join("\n")}\n`
}

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

// CC writes one entry per content block, grouped by message.id
const reply = (messageId: string, block: unknown) => ({
   ...base,
   type: "assistant",
   uuid: uuid(),
   requestId: "req",
   message: { id: messageId, role: "assistant", content: [block] },
})
const said = (messageId: string, text: string) => reply(messageId, { type: "text", text })
const after = <T extends object>(parent: { uuid: string }, entry: T) => ({
   ...entry,
   parentUuid: parent.uuid,
})

test("a rewound branch is left out; the branch the human continued on is read", () => {
   const p1 = prompt("first", "p1")
   const a1 = said("m1", "answer one")
   const p2 = prompt("abandoned", "p2")
   const a2 = said("m2", "abandoned answer")
   const p3 = after(a1, prompt("edited instead", "p3"))
   const a3 = said("m3", "answer three")
   const text = jsonl(p1, a1, p2, a2, p3, a3)
   assert.deepEqual(ccTrail(text, { after: { promptId: "p1" } }).items, [
      { kind: "text", text: "answer one" },
      { kind: "prompt", text: "edited instead" },
      { kind: "text", text: "answer three" },
   ])
   assert.deepEqual(
      ccTrail(text, { after: { promptId: "p1" }, until: { promptId: "p3" } }).items,
      [{ kind: "text", text: "answer one" }],
   )
})

test("a start that was rewound away is marked, then the live branch after the fork follows", () => {
   const p1 = prompt("first", "p1")
   const a1 = said("m1", "answer one")
   const p2 = prompt("abandoned", "p2")
   const a2 = said("m2", "abandoned answer")
   const p3 = after(a1, prompt("edited instead", "p3"))
   const a3 = said("m3", "answer three")
   const trail = ccTrail(jsonl(p1, a1, p2, a2, p3, a3), { after: { promptId: "p2" } })
   assert.deepEqual(trail, {
      items: [
         { kind: "rewind", withdrawn: "abandoned" },
         { kind: "prompt", text: "edited instead" },
         { kind: "text", text: "answer three" },
      ],
      issues: [],
   })
})

test("a rewind past several delivered turns names the first one withdrawn", () => {
   const p1 = prompt("first", "p1")
   const a1 = said("m1", "answer one")
   const p2 = prompt("second", "p2")
   const a2 = said("m2", "answer two")
   const p3 = prompt("third", "p3")
   const a3 = said("m3", "answer three")
   const p4 = after(a1, prompt("second, again", "p4"))
   const trail = ccTrail(jsonl(p1, a1, p2, a2, p3, a3, p4), {
      after: { uuid: a3.uuid },
      until: { promptId: "p4" },
   })
   assert.deepEqual(trail.items, [{ kind: "rewind", withdrawn: "second" }])
})

test("a start beside the chain that holds no turns is not a rewind", () => {
   const p1 = prompt("first", "p1")
   const a1 = said("m1", "answer one")
   const hook = after(a1, attachment({ type: "hook_success" }))
   const p2 = after(a1, prompt("next", "p2"))
   const a2 = said("m2", "answer two")
   const trail = ccTrail(jsonl(p1, a1, hook, p2, a2), { after: { uuid: hook.uuid } })
   assert.deepEqual(trail.items, [
      { kind: "prompt", text: "next" },
      { kind: "text", text: "answer two" },
   ])
})

test("parallel tool calls on side branches keep both calls and both results", () => {
   const p = prompt("look", "p1")
   const first = reply("m1", { type: "tool_use", id: "t1", name: "Read", input: {} })
   const second = reply("m1", { type: "tool_use", id: "t2", name: "Grep", input: {} })
   // observed: an earlier parallel call's result hangs off that call, off the chain
   const firstResult = after(first, toolResult("t1", "one", "p1"))
   const secondResult = after(second, toolResult("t2", "two", "p1"))
   const done = after(secondResult, said("m2", "done"))
   const trail = ccTrail(jsonl(p, first, second, firstResult, secondResult, done), {
      after: { promptId: "p1" },
   })
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" || i.kind === "result" ? i.id : i.kind)),
      ["t1", "t2", "t1", "t2", "text"],
   )
})

test("a transcript without parent links is read in file order", () => {
   const entries = [prompt("q", "p1"), said("m1", "one"), said("m2", "two")]
   const text = entries.map((e) => JSON.stringify(e)).join("\n")
   assert.deepEqual(
      ccTrail(text, { after: { promptId: "p1" } }).items.map((i) => i.kind),
      ["text", "text"],
   )
})

test("compaction keeps the chain; its summary is the harness's, not a prompt", () => {
   const p1 = prompt("first", "p1")
   const a1 = said("m1", "answer one")
   const boundary = {
      ...base,
      type: "system",
      subtype: "compact_boundary",
      uuid: uuid(),
      parentUuid: null,
      logicalParentUuid: a1.uuid,
   }
   const summary = {
      ...prompt("This session is being continued from a previous conversation…", "p1"),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
   }
   const p2 = prompt("second", "p2")
   const a2 = said("m2", "answer two")
   const trail = ccTrail(jsonl(p1, a1, boundary, summary, p2, a2), {
      after: { promptId: "p1" },
   })
   assert.deepEqual(trail.items, [
      { kind: "text", text: "answer one" },
      { kind: "prompt", text: "second" },
      { kind: "text", text: "answer two" },
   ])
})

const spawnInput = { description: "Scan notes", prompt: "Scan every note and report." }
const spawn = () =>
   reply("m1", { type: "tool_use", id: "t9", name: "Agent", input: spawnInput })
const launched = () => ({
   ...toolResult(
      "t9",
      [{ type: "text", text: "Async agent launched successfully. agentId: ag1 …" }],
      "p1",
   ),
   toolUseResult: { isAsync: true, status: "async_launched", agentId: "ag1" },
})
const handBack = () => ({
   ...base,
   type: "user",
   uuid: uuid(),
   promptId: "p1b",
   isMeta: true,
   promptSource: "system",
   origin: { kind: "peer", from: "ag1", senderTaskId: "ag1" },
   message: {
      role: "user",
      content: [
         "Another Claude session sent a message:",
         '<agent-message from="ag1">',
         "[Subagent hand-back] The text below is the final report of a subagent. The report follows:",
         "  # Report",
         "  ",
         "  Found three notes.",
         "</agent-message>",
         "",
         'That "other Claude session" is an agent working inside this same session.',
      ].join("\n"),
   },
})
const notice = (body: string) => ({
   ...base,
   type: "user",
   uuid: uuid(),
   promptId: "p1c",
   promptSource: "system",
   origin: { kind: "task-notification" },
   message: {
      role: "user",
      content: `<task-notification>\n${body}\n</task-notification>`,
   },
})

test("a subagent's hand-back is its report: framing stripped, linked to the spawning call", () => {
   const transcript = "C:/s/main/subagents/agent-ag1.jsonl"
   const trail = ccTrail(
      jsonl(prompt("go", "p1"), spawn(), launched(), said("m2", "Started."), handBack()),
      { after: { promptId: "p1" } },
      { transcriptPath: "C:/s/main.jsonl", exists: () => true },
   )
   assert.deepEqual(trail.items, [
      { kind: "call", id: "t9", name: "Agent", input: spawnInput },
      {
         kind: "result",
         id: "t9",
         text: "",
         isError: false,
         background: true,
         transcript,
      },
      { kind: "text", text: "Started." },
      {
         kind: "report",
         id: "t9",
         agent: "ag1",
         label: "Scan notes",
         text: "# Report\n\nFound three notes.",
         transcript,
      },
   ])
   assert.doesNotMatch(
      JSON.stringify(trail),
      /Subagent hand-back|Another Claude session|other Claude session|Async agent launched/,
   )
})

test("a report for a subagent started in an earlier span still names it", () => {
   const trail = ccTrail(
      jsonl(
         prompt("go", "p1"),
         spawn(),
         launched(),
         said("m2", "Started."),
         prompt("next", "p2"),
         handBack(),
      ),
      { after: { promptId: "p2" } },
   )
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "report" ? [i.id, i.label] : i.kind)),
      [["t9", "Scan notes"]],
   )
})

test("a completion notice gives way to the full report; alone, it carries its result", () => {
   const done = () =>
      notice(
         "<task-id>ag1</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>Found three.</result>",
      )
   const both = ccTrail(
      jsonl(prompt("go", "p1"), spawn(), launched(), handBack(), done()),
      {
         after: { promptId: "p1" },
      },
   )
   assert.equal(both.items.filter((i) => i.kind === "report").length, 1)

   const alone = ccTrail(jsonl(prompt("go", "p1"), spawn(), launched(), done()), {
      after: { promptId: "p1" },
   })
   assert.deepEqual(alone.items.at(-1), {
      kind: "report",
      id: "t9",
      agent: "ag1",
      label: "Scan notes",
      text: "Found three.",
      status: "completed",
      notice: true,
   })
   assert.deepEqual(alone.issues, [])
})

test("a background shell's completion notice is that shell call's late result", () => {
   const run = reply("m1", {
      type: "tool_use",
      id: "t5",
      name: "Bash",
      input: { command: "make", run_in_background: true },
   })
   const started = {
      ...toolResult("t5", "Command running in background with ID: b1", "p1"),
      toolUseResult: { backgroundTaskId: "b1" },
   }
   const done = notice(
      "<task-id>b1</task-id>\n<tool-use-id>t5</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>",
   )
   const trail = ccTrail(jsonl(prompt("go", "p1"), run, started, done), {
      after: { promptId: "p1" },
   })
   assert.deepEqual(trail.items.at(-1), {
      kind: "result",
      id: "t5",
      text: "Background command completed (exit code 0)",
      isError: false,
   })
})

test("interrupts are halts, not prompts", () => {
   const stopped = (content: unknown) => ({
      ...base,
      type: "user",
      uuid: uuid(),
      message: { role: "user", content },
   })
   const trail = ccTrail(
      jsonl(
         stopped("[Request interrupted by user]"),
         stopped([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      ),
   )
   assert.deepEqual(trail.items, [
      { kind: "halt", why: "interrupted" },
      { kind: "halt", why: "interrupted" },
   ])
})

test("an API error is a halt; other synthetic messages are dropped", () => {
   const synthetic = (text: string, isApiErrorMessage: boolean) => ({
      ...said("m9", text),
      isApiErrorMessage,
      message: {
         id: "m9",
         model: "<synthetic>",
         role: "assistant",
         content: [{ type: "text", text }],
      },
   })
   const trail = ccTrail(
      jsonl(synthetic("No response requested.", false), synthetic("Rate limited.", true)),
   )
   assert.deepEqual(trail.items, [
      { kind: "halt", why: "error", detail: "Rate limited." },
   ])
})

test("meta entries never enter the trail: skill bodies, reminders, caveats", () => {
   const meta = (content: unknown) => ({
      ...base,
      type: "user",
      uuid: uuid(),
      isMeta: true,
      message: { role: "user", content },
   })
   const trail = ccTrail(
      jsonl(
         meta([
            { type: "text", text: "Base directory for this skill: C:/s\n# Skill body" },
         ]),
         meta("<system-reminder>remember</system-reminder>"),
         meta("<local-command-caveat>Caveat</local-command-caveat>"),
         said("m1", "visible"),
      ),
   )
   assert.deepEqual(trail.items, [{ kind: "text", text: "visible" }])
})

test("image output is noted as media, keeping only its text", () => {
   const trail = ccTrail(
      jsonl(
         toolResult(
            "t1",
            [
               { type: "text", text: "PDF file read" },
               { type: "image", source: { type: "base64", data: "AAAA" } },
               { type: "image", source: { type: "base64", data: "BBBB" } },
            ],
            "p1",
         ),
      ),
   )
   assert.deepEqual(trail.items, [
      {
         kind: "result",
         id: "t1",
         text: "PDF file read",
         isError: false,
         media: "2 images",
      },
   ])
})
