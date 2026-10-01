import assert from "node:assert/strict"
import { test } from "node:test"
import { formatPeerPackage, type PackageEnv, packageText } from "./package.ts"
import type { Trail, TrailItem, TrailReport } from "./trail.ts"

function fakeEnv(files: Record<string, string> = {}) {
   const stored = new Map<string, string>()
   const env: PackageEnv = {
      refer(text) {
         for (const [path, existing] of stored) if (existing === text) return path
         const path = `peer/${stored.size + 1}.txt`
         stored.set(path, text)
         return path
      },
      readFile: (path) => files[path],
   }
   return { env, stored }
}

function trail(...items: TrailItem[]): Trail {
   return { items, issues: [] }
}

/** The segments between the opening frame and the end marker. */
function body(t: Trail, env: PackageEnv = fakeEnv().env): string[] {
   return packageText(formatPeerPackage(t, env)).split("\n\n").slice(1, -1)
}

const call = (id: string, name: string, input: unknown): TrailItem => ({
   kind: "call",
   id,
   name,
   input,
})
const ok = (id: string, text: string): TrailItem => ({
   kind: "result",
   id,
   text,
   isError: false,
})
const fail = (id: string, text: string): TrailItem => ({
   kind: "result",
   id,
   text,
   isError: true,
})
const numbered = (start: number, lines: string[]) =>
   lines.map((line, i) => `${start + i}\t${line}`).join("\n")

test("the frame is factual, anonymous, and says the human has not endorsed it", () => {
   const text = packageText(
      formatPeerPackage(trail({ kind: "text", text: "Hi." }), fakeEnv().env),
   )
   const [first] = text.split("\n")
   assert.ok(first)
   assert.match(first, /independent answer/i)
   assert.match(first, /not endorsed by the human/i)
   assert.doesNotMatch(text, /claude|anthropic|openai|gpt|codex|astra|luna/i)
   assert.doesNotMatch(first, /\b(you must|ignore|do not|always|never)\b/i)
   assert.match(text, /\[end of peer answer\]$/)
})

test("a read of an unchanged file is one line with no content", () => {
   const { env, stored } = fakeEnv({ "a.ts": "one\ntwo\nthree\n" })
   const t = trail(
      call("r", "Read", { file_path: "a.ts" }),
      ok("r", numbered(1, ["one", "two", "three", ""])),
   )
   assert.deepEqual(body(t, env), ["[tool] read a.ts L1–4"])
   assert.equal(stored.size, 0)
})

test("a read of a file that has changed since stores the peer's view", () => {
   const { env, stored } = fakeEnv({ "a.ts": "one\nTWO\n" })
   const t = trail(
      call("r", "Read", { file_path: "a.ts", offset: 2, limit: 1 }),
      ok("r", numbered(2, ["two"])),
   )
   assert.deepEqual(body(t, env), [
      "[tool] read a.ts L2–2 (file changed since; peer's view: peer/1.txt)",
   ])
   assert.equal(stored.get("peer/1.txt"), "two")
})

test("a read of a file that is gone also stores the peer's view", () => {
   const { env } = fakeEnv()
   const t = trail(call("r", "read", { path: "gone.md", offset: null }), ok("r", "x\ny"))
   assert.deepEqual(body(t, env), [
      "[tool] read gone.md L1–2 (file changed since; peer's view: peer/1.txt)",
   ])
})

test("a read cut short says how, so the receiver knows the peer never saw the rest", () => {
   const { env } = fakeEnv({ "big.log": "a\nb\nc\nd\n" })
   const cc: TrailItem = {
      kind: "result",
      id: "r",
      text: numbered(1, ["a", "b"]),
      isError: false,
      partial: "cut by token cap; 2501 lines in file",
   }
   assert.deepEqual(body(trail(call("r", "Read", { file_path: "big.log" }), cc), env), [
      "[tool] read big.log L1–2 (cut by token cap; 2501 lines in file)",
   ])
   const pi = ok(
      "p",
      "a\nb\n\n[Showing lines 1-2 of 2501 (50.0KB limit). Use offset=3 to continue.]",
   )
   assert.deepEqual(body(trail(call("p", "read", { path: "big.log" }), pi), env), [
      "[tool] read big.log L1–2 (2501 lines in file)",
   ])
})

test("repeated reads collapse: same range is 'again', a covered range disappears", () => {
   const { env } = fakeEnv({ "a.ts": "1\n2\n3\n4\n" })
   const t = trail(
      call("a", "Read", { file_path: "a.ts" }),
      ok("a", numbered(1, ["1", "2", "3", "4", ""])),
      call("b", "Read", { file_path: "a.ts" }),
      ok("b", numbered(1, ["1", "2", "3", "4", ""])),
      call("c", "Read", { file_path: "a.ts", offset: 2, limit: 2 }),
      ok("c", numbered(2, ["2", "3"])),
   )
   assert.deepEqual(body(t, env), [
      "[tool] read a.ts L1–5",
      "[tool] read a.ts L1–5 (again)",
   ])
})

test("a re-read after the peer's own edit is a new read, not a repeat", () => {
   const { env } = fakeEnv({ "a.ts": "new\n" })
   const t = trail(
      call("a", "Read", { file_path: "a.ts" }),
      ok("a", numbered(1, ["old", ""])),
      call("b", "Read", { file_path: "a.ts" }),
      ok("b", numbered(1, ["new", ""])),
   )
   const lines = body(t, env)
   assert.match(lines[0] ?? "", /changed since/)
   assert.equal(lines[1], "[tool] read a.ts L1–2")
})

test("an unparseable read result falls back to plain output handling", () => {
   const t = trail(call("r", "Read", { file_path: "img.png" }), ok("r", "[image]"))
   assert.deepEqual(body(t), ['[tool] Read {"file_path":"img.png"} → [image]'])
})

test("tiny search output is inline; larger output is a pointer with a size", () => {
   const { env, stored } = fakeEnv()
   const big = Array.from({ length: 412 }, (_, i) => `line ${i}`).join("\n")
   const t = trail(
      call("a", "Glob", { pattern: "*.md" }),
      ok("a", "inventory.md"),
      call("b", "Grep", { pattern: "heron" }),
      ok("b", "Found 2 files\ninventory.md\nnotes.txt"),
      call("c", "bash", { command: "seq 412", timeout: null }),
      ok("c", big),
   )
   assert.deepEqual(body(t, env), [
      '[tool] Glob {"pattern":"*.md"} → inventory.md',
      '[tool] Grep {"pattern":"heron"} →\n  Found 2 files\n  inventory.md\n  notes.txt',
      '[tool] bash {"command":"seq 412"} → 412 lines, peer/1.txt',
   ])
   assert.equal(stored.get("peer/1.txt"), big)
})

test("identical outputs share one stored file", () => {
   const { env, stored } = fakeEnv()
   const big = "x\n".repeat(50)
   body(
      trail(
         call("a", "Bash", { command: "a" }),
         ok("a", big),
         call("b", "Bash", { command: "b" }),
         ok("b", big),
      ),
      env,
   )
   assert.equal(stored.size, 1)
})

test("output the harness already saved is pointed at, not copied", () => {
   const { env, stored } = fakeEnv()
   const t = trail(call("a", "Bash", { command: "seq 1 5000" }), {
      kind: "result",
      id: "a",
      text: "<persisted-output>\nOutput too large (223.5KB). Full output saved to: C:/x/tool-results/b.txt\n…",
      isError: false,
      saved: { path: "C:/x/tool-results/b.txt", size: "223.5KB" },
   })
   assert.deepEqual(body(t, env), [
      '[tool] Bash {"command":"seq 1 5000"} → 223.5KB, saved at C:/x/tool-results/b.txt',
   ])
   assert.equal(stored.size, 0)
})

test("errors are a one-line marker, with a pointer only when there is more", () => {
   const { env } = fakeEnv()
   const t = trail(
      call("a", "Read", { file_path: "missing.txt" }),
      fail("a", "File does not exist."),
      call("b", "Bash", { command: "make" }),
      fail("b", "make: *** no rule\nline 2\nline 3"),
   )
   assert.deepEqual(body(t, env), [
      "[tool] read missing.txt → error: File does not exist.",
      '[tool] Bash {"command":"make"} → error: make: *** no rule (full: peer/1.txt)',
   ])
})

test("a CC Edit is an inline compact diff", () => {
   const t = trail(
      call("e", "Edit", { file_path: "a.ts", old_string: "a\nb", new_string: "a\nc" }),
      ok("e", "The file a.ts has been updated successfully."),
   )
   assert.deepEqual(body(t), ["[tool] edit a.ts\n```diff\n-a\n-b\n+a\n+c\n```"])
})

test("a pi multi-hunk edit renders each hunk", () => {
   const t = trail(
      call("e", "edit", {
         path: "b.md",
         edits: [
            { oldText: "x", newText: "y" },
            { oldText: "p", newText: "" },
         ],
      }),
      ok("e", "ok"),
   )
   assert.deepEqual(body(t), ["[tool] edit b.md\n```diff\n-x\n+y\n@@\n-p\n```"])
})

test("a diff containing a code fence gets a longer fence", () => {
   const t = trail(
      call("e", "Edit", { file_path: "r.md", old_string: "```js", new_string: "```ts" }),
      ok("e", ""),
   )
   assert.match(
      packageText(formatPeerPackage(t, fakeEnv().env)),
      /\n````diff\n-```js\n\+```ts\n````/,
   )
})

test("a failed edit is a marker with the attempted diff by reference", () => {
   const { env, stored } = fakeEnv()
   const t = trail(
      call("e", "Edit", { file_path: "a", old_string: "x", new_string: "y" }),
      fail("e", "old_string not found"),
   )
   assert.deepEqual(body(t, env), [
      "[tool] edit a → error: old_string not found (attempted diff: peer/1.txt)",
   ])
   assert.equal(stored.get("peer/1.txt"), "-x\n+y")
})

test("an oversized edit is referenced instead of inlined", () => {
   const old = "z\n".repeat(1500)
   const t = trail(
      call("e", "Edit", { file_path: "a", old_string: old, new_string: "" }),
      ok("e", ""),
   )
   assert.deepEqual(body(t), ["[tool] edit a → diff peer/1.txt (1501 lines)"])
})

test("a write is path and line count; the content is stored only if the file changed since", () => {
   const content = "one\ntwo\nthree\n"
   const same = fakeEnv({ "n.txt": content })
   const t = trail(
      call("w", "Write", { file_path: "n.txt", content }),
      ok("w", "File created"),
   )
   assert.deepEqual(body(t, same.env), ["[tool] wrote n.txt (3 lines)"])
   assert.equal(same.stored.size, 0)
   const changed = fakeEnv({ "n.txt": "other" })
   assert.deepEqual(body(t, changed.env), [
      "[tool] wrote n.txt (3 lines; file changed since; peer's version: peer/1.txt)",
   ])
})

test("a subagent shows a brief, its report, and where its transcript is", () => {
   const t = trail(
      call("s", "Agent", {
         description: "List markdown files",
         prompt: "Glob *.md and report",
      }),
      {
         kind: "result",
         id: "s",
         text: "inventory.md",
         isError: false,
         transcript: "sess/subagents/agent-1.jsonl",
      },
   )
   assert.deepEqual(body(t), [
      "[tool] subagent: List markdown files (full prompt: peer/1.txt) (transcript: sess/subagents/agent-1.jsonl)",
      "[subagent report]\ninventory.md",
   ])
})

test("a long subagent prompt and report are cut, with the full text by reference", () => {
   const { env, stored } = fakeEnv()
   const report = `${"finding\n".repeat(300)}`
   const t = trail(
      call("s", "subagent", { agent: "scout", task: `${"look ".repeat(60)}` }),
      ok("s", report),
   )
   const [head, shown] = body(t, env)
   assert.match(
      head ?? "",
      /^\[tool\] subagent scout: (look ){30,}.*… \(full prompt: peer\/1\.txt\)$/,
   )
   assert.match(
      shown ?? "",
      /^\[subagent report\]\nfinding\n[\s\S]*\n… \(full report: peer\/2\.txt\)$/,
   )
   assert.ok((shown?.length ?? 0) < 1_700)
   assert.equal(stored.get("peer/2.txt"), report)
})

test("web and MCP output is always by reference, even when tiny", () => {
   const t = trail(
      call("w", "WebFetch", { url: "https://example.com" }),
      ok("w", "Example Domain"),
      call("m", "mcp__docs__query", { q: "x" }),
      ok("m", "one"),
   )
   assert.deepEqual(body(t), [
      '[tool] WebFetch {"url":"https://example.com"} → 1 line, peer/1.txt',
      '[tool] mcp__docs__query {"q":"x"} → 1 line, peer/2.txt',
   ])
})

test("noise tools are dropped with their results, but still accounted for", () => {
   const t = trail(
      call("n", "TodoWrite", { todos: [{ content: "x" }] }),
      ok("n", "Todos updated"),
      { kind: "text", text: "Done." },
   )
   const pkg = formatPeerPackage(t, fakeEnv().env)
   assert.deepEqual(packageText(pkg).split("\n\n").slice(1, -1), ["Done."])
   assert.deepEqual(pkg.interactions, [
      { id: "n", tool: "TodoWrite", kind: "noise", pointers: [] },
   ])
})

test("an unknown tool falls back to a truncated input and an output pointer, never dropped", () => {
   const { env } = fakeEnv()
   const t = trail(call("u", "Frobnicate", { blob: "q".repeat(400) }), ok("u", "done"))
   const [line] = body(t, env)
   assert.match(
      line ?? "",
      /^\[tool\] Frobnicate \{"blob":"q+… \(full input: peer\/1\.txt\) → 1 line, peer\/2\.txt$/,
   )
})

test("parallel calls pair with their results by id; missing and orphan results are stated", () => {
   const t = trail(
      call("a", "Grep", { pattern: "x" }),
      call("b", "Glob", { pattern: "*.ts" }),
      ok("b", "b.ts"),
      ok("a", ""),
      call("c", "Bash", { command: "sleep 99" }),
      ok("zzz", "stray"),
   )
   assert.deepEqual(body(t), [
      '[tool] Grep {"pattern":"x"} → no output',
      '[tool] Glob {"pattern":"*.ts"} → b.ts',
      '[tool] Bash {"command":"sleep 99"} → no result recorded',
      "[tool output] → stray",
   ])
})

test("a human prompt inside the span is marked as the human's", () => {
   assert.deepEqual(
      body(
         trail(
            { kind: "prompt", text: "and the cache?" },
            { kind: "text", text: "Warm." },
         ),
      ),
      ["[the human's prompt to the peer]\nand the cache?", "Warm."],
   )
})

test("a degraded trail is flagged as possibly incomplete", () => {
   const pkg = formatPeerPackage(
      { items: [{ kind: "text", text: "Partial." }], issues: ["bad"] },
      fakeEnv().env,
   )
   assert.match(packageText(pkg), /\[note\][^\n]*incomplete/)
})

test("multi-block text becomes one segment per markdown block", () => {
   const pkg = formatPeerPackage(
      trail({ kind: "text", text: "Para.\n\n```\na\n\nb\n```\n\n- x\n- y" }),
      fakeEnv().env,
   )
   const prose = pkg.segments.filter((s) => s.kind === "prose").map((s) => s.text)
   assert.deepEqual(prose, ["Para.", "```\na\n\nb\n```", "- x\n- y"])
})

const report = (fields: Partial<TrailReport>): TrailReport => ({
   kind: "report",
   id: undefined,
   agent: undefined,
   label: undefined,
   text: "",
   ...fields,
})

test("a background subagent's call says so; its later report is labelled with its task", () => {
   const t = trail(
      call("s", "Agent", { description: "Scan notes", prompt: "Scan every note." }),
      { kind: "result", id: "s", text: "", isError: false, background: true },
      { kind: "text", text: "Meanwhile, more work." },
      report({ id: "s", agent: "a1", label: "Scan notes", text: "Found three." }),
   )
   assert.deepEqual(body(t), [
      "[tool] subagent: Scan notes (full prompt: peer/1.txt) → running in the background",
      "Meanwhile, more work.",
      "[subagent report: Scan notes]\nFound three.",
   ])
})

test("a report from a subagent started earlier says so, with its status and transcript", () => {
   const { env } = fakeEnv()
   const pkg = formatPeerPackage(
      trail(
         report({
            id: "gone",
            agent: "a1",
            label: "Scan notes",
            text: "Partial findings.",
            status: "killed",
            transcript: "s/agent-a1.jsonl",
         }),
      ),
      env,
   )
   assert.deepEqual(packageText(pkg).split("\n\n").slice(1, -1), [
      "[subagent report: Scan notes] (started earlier; killed; transcript: s/agent-a1.jsonl)\nPartial findings.",
   ])
   assert.deepEqual(pkg.interactions, [
      { id: "gone", tool: "subagent", kind: "report", pointers: ["s/agent-a1.jsonl"] },
   ])
})

test("a long report is cut with the full text by reference, and compacts losslessly", () => {
   const { env, stored } = fakeEnv()
   const text = "finding\n".repeat(400)
   const pkg = formatPeerPackage(trail(report({ label: "Scan", text })), env)
   const [shown] = pkg.segments.filter((s) => s.kind === "report")
   assert.ok(shown !== undefined)
   assert.ok(shown.text.length < 1_700, `${shown.text.length}`)
   assert.match(shown.text, /\n… \(full report: peer\/1\.txt\)$/)
   assert.equal(
      shown.compact,
      "[subagent report: Scan] (started earlier) → 400 lines, peer/1.txt",
   )
   assert.equal(stored.get("peer/1.txt"), text)
})

test("a subagent that ended without a report is one line", () => {
   assert.deepEqual(body(trail(report({ label: "Scan", status: "killed" }))), [
      "[subagent finished: Scan] (started earlier; killed) → no report",
   ])
})

test("a turn cut short says how", () => {
   assert.deepEqual(
      body(
         trail(
            { kind: "text", text: "Starting." },
            { kind: "halt", why: "interrupted" },
            { kind: "halt", why: "error", detail: "WebSocket closed 1012" },
            { kind: "halt", why: "aborted" },
         ),
      ),
      [
         "Starting.",
         "[the human interrupted the peer here]",
         "[the peer's turn ended with an error: WebSocket closed 1012]",
         "[the peer's turn was aborted here]",
      ],
   )
})

test("a message to a subagent shows its summary, the full message by reference", () => {
   const { env, stored } = fakeEnv()
   const message = "Please wrap up.\n".repeat(30)
   const t = trail(
      call("m", "SendMessage", { to: "a1", summary: "wrap up", message }),
      ok("m", "Message sent."),
      call("s", "steer_subagent", { agent_id: "a2", message: "Stop now." }),
      ok("s", "Steering message sent."),
   )
   assert.deepEqual(body(t, env), [
      "[tool] message to subagent a1: wrap up (full message: peer/1.txt)",
      "[tool] message to subagent a2: Stop now.",
   ])
   assert.equal(stored.get("peer/1.txt"), message)
})

test("an image read points at the file and says what it was", () => {
   const t = trail(call("r", "Read", { file_path: "spec.pdf" }), {
      kind: "result",
      id: "r",
      text: "PDF file read",
      isError: false,
      media: "3 images",
   })
   const pkg = formatPeerPackage(t, fakeEnv().env)
   assert.deepEqual(packageText(pkg).split("\n\n").slice(1, -1), [
      "[tool] read spec.pdf (3 images)",
   ])
   assert.deepEqual(pkg.interactions[0]?.pointers, ["spec.pdf"])
})

test("pi's todo bookkeeping is dropped like Claude Code's", () => {
   const t = trail(
      call("n", "todo", { action: "create", subject: "x" }),
      ok("n", "Created"),
   )
   assert.deepEqual(body(t), [])
})

test("reading back what was just written adds nothing", () => {
   const content = "one\ntwo\n"
   const { env } = fakeEnv({ "n.md": content })
   const t = trail(
      call("w", "Write", { file_path: "n.md", content }),
      ok("w", "File created"),
      call("r", "Read", { file_path: "n.md" }),
      ok("r", numbered(1, ["one", "two", ""])),
   )
   assert.deepEqual(body(t, env), ["[tool] wrote n.md (2 lines)"])
})

test("a view already given in an earlier package is not repeated; a changed one is", () => {
   const { env } = fakeEnv({ "a.md": "one\ntwo\n" })
   const read = (id: string, lines: string[]) =>
      trail(call(id, "Read", { file_path: "a.md" }), ok(id, numbered(1, lines)))
   const first = formatPeerPackage(read("r1", ["one", "two", ""]), env)
   const memory = JSON.parse(JSON.stringify(first.memory))
   const again = formatPeerPackage(read("r2", ["one", "two", ""]), env, memory)
   assert.deepEqual(packageText(again).split("\n\n").slice(1, -1), [])
   assert.deepEqual(again.interactions[0]?.pointers, ["a.md"])
   const changed = formatPeerPackage(read("r3", ["one", "TWO", ""]), env, again.memory)
   assert.match(packageText(changed), /\[tool\] read a\.md L1–3 \(file changed since/)
})
