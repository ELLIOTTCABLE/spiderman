import assert from "node:assert/strict"
import { test } from "node:test"
import { formatPeerPackage, packageText } from "./package.ts"
import type { Trail, TrailItem } from "./trail.ts"

function fakeStore() {
   const stored = new Map<string, string>()
   const put = (text: string) => {
      const existing = stored.get(text)
      if (existing !== undefined) return existing
      const path = `peer/${stored.size + 1}.txt`
      stored.set(text, path)
      return path
   }
   return { put, stored }
}

function trail(...items: TrailItem[]): Trail {
   return { items, issues: [] }
}

function body(text: string): string[] {
   return text.split("\n\n").slice(1, -1)
}

test("the frame is factual, anonymous, and says the human has not endorsed it", () => {
   const text = packageText(
      formatPeerPackage(trail({ kind: "text", text: "Hi." }), fakeStore().put),
   )
   const [first] = text.split("\n")
   assert.ok(first)
   assert.match(first, /independent answer/i)
   assert.match(first, /not endorsed by the human/i)
   assert.doesNotMatch(text, /claude|anthropic|openai|gpt|codex|astra|luna/i)
   assert.doesNotMatch(first, /\b(you must|ignore|do not|always|never)\b/i)
   assert.match(text, /\[end of peer answer\]$/)
})

test("text and tool calls stay interleaved, with outputs referenced by path", () => {
   const store = fakeStore()
   const text = packageText(
      formatPeerPackage(
         trail(
            { kind: "text", text: "Let me look." },
            { kind: "call", id: "c1", name: "Read", input: { file_path: "src/a.ts" } },
            {
               kind: "result",
               id: "c1",
               text: "line 1\nline 2\nline 3\n",
               isError: false,
            },
            { kind: "text", text: "It reads three lines." },
         ),
         store.put,
      ),
   )
   assert.deepEqual(body(text), [
      "Let me look.",
      '[tool] Read {"file_path":"src/a.ts"} → output peer/1.txt (3 lines)',
      "It reads three lines.",
   ])
   assert.equal(store.stored.get("line 1\nline 2\nline 3\n"), "peer/1.txt")
})

test("parallel calls pair with their results by id, not by position", () => {
   const text = packageText(
      formatPeerPackage(
         trail(
            { kind: "call", id: "a", name: "Grep", input: { pattern: "x" } },
            { kind: "call", id: "b", name: "Glob", input: { pattern: "*.ts" } },
            { kind: "result", id: "b", text: "b.ts", isError: false },
            { kind: "result", id: "a", text: "", isError: false },
         ),
         fakeStore().put,
      ),
   )
   assert.deepEqual(body(text), [
      '[tool] Grep {"pattern":"x"} → no output',
      '[tool] Glob {"pattern":"*.ts"} → output peer/1.txt (1 line)',
   ])
})

test("errors, missing results, and orphan results are all stated", () => {
   const text = packageText(
      formatPeerPackage(
         trail(
            { kind: "call", id: "a", name: "Bash", input: { command: "false" } },
            { kind: "result", id: "a", text: "exit 1", isError: true },
            { kind: "call", id: "b", name: "Bash", input: { command: "sleep 99" } },
            { kind: "result", id: "zzz", text: "stray", isError: false },
         ),
         fakeStore().put,
      ),
   )
   assert.deepEqual(body(text), [
      '[tool] Bash {"command":"false"} → error output peer/1.txt (1 line)',
      '[tool] Bash {"command":"sleep 99"} → no result recorded',
      "[tool output] peer/2.txt (1 line)",
   ])
})

test("a Claude Code Edit renders inline as a compact diff", () => {
   const text = packageText(
      formatPeerPackage(
         trail(
            {
               kind: "call",
               id: "e",
               name: "Edit",
               input: { file_path: "src/a.ts", old_string: "a\nb", new_string: "a\nc" },
            },
            { kind: "result", id: "e", text: "The file was updated.", isError: false },
         ),
         fakeStore().put,
      ),
   )
   assert.match(text, /\[tool\] Edit src\/a\.ts\n```diff\n-a\n-b\n\+a\n\+c\n```/)
})

test("a pi multi-hunk edit renders each hunk", () => {
   const text = packageText(
      formatPeerPackage(
         trail({
            kind: "call",
            id: "e",
            name: "edit",
            input: {
               path: "b.md",
               edits: [
                  { oldText: "x", newText: "y" },
                  { oldText: "p", newText: "" },
               ],
            },
         }),
         fakeStore().put,
      ),
   )
   assert.match(
      text,
      /\[tool\] edit b\.md → no result recorded\n```diff\n-x\n\+y\n@@\n-p\n```/,
   )
})

test("a diff containing a code fence gets a longer fence", () => {
   const text = packageText(
      formatPeerPackage(
         trail({
            kind: "call",
            id: "e",
            name: "Edit",
            input: { file_path: "r.md", old_string: "```js", new_string: "```ts" },
         }),
         fakeStore().put,
      ),
   )
   assert.match(text, /\n````diff\n-```js\n\+```ts\n````/)
})

test("a failed edit says so", () => {
   const text = packageText(
      formatPeerPackage(
         trail(
            {
               kind: "call",
               id: "e",
               name: "Edit",
               input: { file_path: "a", old_string: "x", new_string: "y" },
            },
            { kind: "result", id: "e", text: "old_string not found", isError: true },
         ),
         fakeStore().put,
      ),
   )
   assert.match(
      text,
      /\[tool\] Edit a → failed, error output peer\/1\.txt \(1 line\)\n```diff/,
   )
})

test("a Write is referenced with its line count, never inlined", () => {
   const store = fakeStore()
   const content = "one\ntwo\nthree\n"
   const text = packageText(
      formatPeerPackage(
         trail(
            {
               kind: "call",
               id: "w",
               name: "Write",
               input: { file_path: "n.txt", content },
            },
            { kind: "result", id: "w", text: "ok", isError: false },
         ),
         store.put,
      ),
   )
   assert.deepEqual(body(text), ["[tool] Write n.txt (3 lines) → content peer/1.txt"])
   assert.equal(store.stored.get(content), "peer/1.txt")
})

test("an oversized tool input is referenced instead of inlined", () => {
   const store = fakeStore()
   const command = "echo x\n".repeat(400)
   const text = packageText(
      formatPeerPackage(
         trail(
            { kind: "call", id: "a", name: "Bash", input: { command } },
            { kind: "result", id: "a", text: "x", isError: false },
         ),
         store.put,
      ),
   )
   assert.deepEqual(body(text), [
      `[tool] Bash → input peer/1.txt (${JSON.stringify({ command }, null, 2).length} chars) → output peer/2.txt (1 line)`,
   ])
   assert.doesNotMatch(text, /echo x/)
})

test("a human prompt inside the span is marked as the human's", () => {
   const text = packageText(
      formatPeerPackage(
         trail(
            { kind: "prompt", text: "and the cache?" },
            { kind: "text", text: "Warm." },
         ),
         fakeStore().put,
      ),
   )
   assert.deepEqual(body(text), [
      "[the human's prompt to the peer]\nand the cache?",
      "Warm.",
   ])
})

test("a degraded trail is flagged as possibly incomplete", () => {
   const text = packageText(
      formatPeerPackage(
         { items: [{ kind: "text", text: "Partial." }], issues: ["line 3: bad JSON"] },
         fakeStore().put,
      ),
   )
   assert.match(text, /\[note\][^\n]*incomplete/)
})

test("multi-block text becomes one segment per markdown block", () => {
   const pkg = formatPeerPackage(
      trail({ kind: "text", text: "Para.\n\n```\na\n\nb\n```\n\n- x\n- y" }),
      fakeStore().put,
   )
   const prose = pkg.segments.filter((s) => s.kind === "prose").map((s) => s.text)
   assert.deepEqual(prose, ["Para.", "```\na\n\nb\n```", "- x\n- y"])
})
