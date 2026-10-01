import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { type CcViewOptions, ccView } from "./cc-trail.ts"
import { measurePackage } from "./measure.ts"
import { formatPeerPackage, type PackageEnv, packageText } from "./package.ts"
import { piTrail } from "./pi-trail.ts"

// scrubbed real sessions from the prober (CC 2.1.286 + haiku; pi 0.99.1 + gpt-6-luna)
const fixturePath = (name: string) =>
   fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const fixture = (name: string) => readFileSync(fixturePath(name), "utf8")
// the injected user turn is ours: a session view leaves it out the same way
const piMessages = (jsonl: string) =>
   jsonl
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "message" && entry.message.role !== "user")
      .map((entry) => entry.message)

/** A's live trail after the prompt with this id. */
function ccTrailAfter(jsonl: string, promptId: string, options: CcViewOptions = {}) {
   const prompt = jsonl
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.promptId === promptId)
   const view = ccView(jsonl, options)
   const ids = view.live.map((e) => e.id)
   return view.trail(ids.slice(ids.indexOf(prompt?.uuid) + 1))
}

/** Files the peer touched are gone, so every read stores the peer's view. */
function storeEnv() {
   const stored = new Map<string, string>()
   const env: PackageEnv = {
      refer(text) {
         for (const [path, existing] of stored) if (existing === text) return path
         const path = `.spiderman/peer/${stored.size + 1}.txt`
         stored.set(path, text)
         return path
      },
      readFile: () => undefined,
   }
   return { env, stored }
}

test("simple CC turn: calls, results and the answer, nothing injected", () => {
   const trail = ccTrailAfter(
      fixture("cc-transcript.jsonl"),
      "dd41731d-f63f-4324-b8d2-ef7b13e73534",
   )
   assert.deepEqual(trail.issues, [])
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" ? `call ${i.name}` : i.kind)),
      ["call Read", "result", "call Grep", "result", "call Glob", "result", "text"],
   )
   assert.doesNotMatch(JSON.stringify(trail), /Chunk k\d|\[redacted\]/)
})

test("simple pi session: messages read cleanly, minus the injected user turn", () => {
   const trail = piTrail(piMessages(fixture("pi-session.jsonl")))
   assert.deepEqual(trail.issues, [])
   assert.deepEqual(
      trail.items.map((i) => (i.kind === "call" ? `call ${i.name}` : i.kind)),
      ["call read", "result", "call grep", "result", "text"],
   )
})

const ccRich = "cc-rich/ef355700-22ae-4585-a3e0-c6adaa344d3c.jsonl"
const ccPersisted =
   "C:/Users/user\\.claude\\projects\\C--Users-user-AppData-Local-Temp-claude-C--Users-user-Sync-Code-spiderman-841ae747-b803-42a5-8162-61d1499fb24a-scratchpad-probes-p5b-cc-work\\ef355700-22ae-4585-a3e0-c6adaa344d3c\\tool-results\\bq2lt4hua.txt"

function ccRichPackage() {
   const trail = ccTrailAfter(fixture(ccRich), "36c16836-f293-4bfe-a837-e3748bcb4188", {
      transcriptPath: fixturePath(ccRich),
      exists: existsSync,
   })
   const { env, stored } = storeEnv()
   const pkg = formatPeerPackage(trail, env)
   return { trail, pkg, text: packageText(pkg), stored }
}

test("tool-heavy CC turn: everything reachable, at a fraction of the raw size", () => {
   const { trail, pkg, stored } = ccRichPackage()
   assert.deepEqual(trail.issues, [])
   const measure = measurePackage(
      trail,
      pkg,
      (p) => stored.has(p) || p === ccPersisted || existsSync(p),
   )
   assert.deepEqual(measure.unreachable, [])
   assert.deepEqual(measure.unaccounted, [])
   assert.ok(
      measure.packageChars < measure.rawChars / 10,
      `${measure.packageChars} of ${measure.rawChars}`,
   )
})

test("tool-heavy CC turn: reads state the range seen, the token cap, and repeats", () => {
   const { text } = ccRichPackage()
   assert.match(
      text,
      /\[tool\] read \S*big\.log L1–738 \(cut by token cap; 2501 lines in file; file changed/,
   )
   assert.match(text, /\[tool\] read \S*big\.log L1200–1249 \(/)
   assert.match(text, /\[tool\] read \S*big\.log L1–738 \(again\)/)
   assert.match(text, /\[tool\] read \S*missing-file\.txt → error: File does not exist\./)
})

test("tool-heavy CC turn: persisted shell output is pointed at, not copied", () => {
   const { text } = ccRichPackage()
   assert.ok(text.includes(`→ 223.5KB, saved at ${ccPersisted}`))
   assert.doesNotMatch(text, /Preview \(first 2KB\)/)
})

test("tool-heavy CC turn: the background subagent's report and transcript are attached", () => {
   const { text } = ccRichPackage()
   const transcript = fixturePath(
      "cc-rich/ef355700-22ae-4585-a3e0-c6adaa344d3c/subagents/agent-a12bb874aa93a3500.jsonl",
   ).replaceAll("\\", "/")
   assert.match(
      text,
      /\[tool\] subagent: List markdown files in current directory \(full prompt:/,
   )
   assert.ok(text.replaceAll("\\", "/").includes(`(transcript: ${transcript})`))
   assert.match(text, /→ running in the background\n/)
   assert.match(
      text,
      /\[subagent report: List markdown files in current directory\] \(transcript: [^)]+\)\ninventory\.md/,
   )
   assert.doesNotMatch(text, /Async agent launched/)
   assert.doesNotMatch(text, /task-notification/)
})

test("tool-heavy CC turn: the edit is an inline diff and the write a line count", () => {
   const { text } = ccRichPackage()
   assert.match(text, /\[tool\] edit \S*notes\.txt\n```diff\n-/)
   assert.match(text, /\[tool\] wrote \S*summary\.txt \(\d+ lines?; /)
})

test("tool-heavy pi session: everything reachable, with pi's own notices kept", () => {
   const trail = piTrail(piMessages(fixture("pi-rich.jsonl")))
   assert.deepEqual(trail.issues, [])
   const { env, stored } = storeEnv()
   const pkg = formatPeerPackage(trail, env)
   const text = packageText(pkg)
   const piBashLog = "C:/Users/user\\AppData\\Local\\Temp\\pi-bash-0f4ed1afb9c10b63.log"
   const measure = measurePackage(trail, pkg, (p) => stored.has(p) || p === piBashLog)
   assert.deepEqual(measure.unreachable, [])
   assert.deepEqual(measure.unaccounted, [])
   assert.ok(measure.packageChars < measure.rawChars / 10)
   assert.match(
      text,
      /\[tool\] read big\.log L1–799 \(2501 lines in file; file changed since/,
   )
   assert.match(text, /\[tool\] read big\.log L1200–1249 \(1252 more lines in file; /)
   assert.match(text, /\[tool\] read big\.log L1–799 \(again\)/)
   assert.ok(text.includes(`→ 5000 lines, saved at ${piBashLog}`))
   assert.match(text, /\[tool\] read missing-file\.txt → error: ENOENT/)
})
