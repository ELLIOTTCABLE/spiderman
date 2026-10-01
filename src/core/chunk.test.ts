import assert from "node:assert/strict"
import { test } from "node:test"
import { chunkPackage } from "./chunk.ts"
import type { PeerPackage, Segment } from "./package.ts"

const frame = (text: string): Segment => ({ kind: "frame", text })
const prose = (text: string): Segment => ({ kind: "prose", text })
const tool = (text: string, compact?: string): Segment =>
   compact === undefined ? { kind: "tool", text } : { kind: "tool", text, compact }

const pkg = (...segments: Segment[]): PeerPackage => ({
   segments,
   interactions: [],
   memory: { reads: [] },
})
const fullPath = ".spiderman/peer/full.txt"

function stripLabel(chunk: string): string {
   return chunk.replace(/^\[peer \d+\/\d+\]\n/, "")
}

function assertLabelledAndSized(chunks: readonly string[], maxChars: number) {
   chunks.forEach((chunk, i) => {
      assert.ok(chunk.length <= maxChars, `chunk ${i + 1} is ${chunk.length} chars`)
      assert.ok(
         chunk.startsWith(`[peer ${i + 1}/${chunks.length}]\n`),
         chunk.slice(0, 20),
      )
   })
}

test("a small package is one labelled chunk with the package verbatim", () => {
   const chunks = chunkPackage(pkg(frame("[open]"), prose("Short."), frame("[end]")), {
      maxChunks: 3,
      maxChars: 200,
      fullPath,
   })
   assert.deepEqual(chunks, ["[peer 1/1]\n[open]\n\nShort.\n\n[end]"])
})

test("an empty package has no chunks", () => {
   assert.deepEqual(chunkPackage(pkg(), { maxChunks: 3, maxChars: 200, fullPath }), [])
})

test("chunks split between segments, never inside one that fits", () => {
   const segments = [
      frame("[open]"),
      ...["a", "b", "c", "d"].map((c) => prose(c.repeat(80))),
   ]
   const chunks = chunkPackage(pkg(...segments), {
      maxChunks: 3,
      maxChars: 200,
      fullPath,
   })
   assert.equal(chunks.length, 2)
   assertLabelledAndSized(chunks, 200)
   assert.equal(
      chunks.map(stripLabel).join("\n\n"),
      segments.map((s) => s.text).join("\n\n"),
   )
})

test("a segment larger than a chunk splits at line boundaries", () => {
   const big = Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join(
      "\n",
   )
   const chunks = chunkPackage(pkg(prose(big)), { maxChunks: 3, maxChars: 200, fullPath })
   assert.equal(chunks.length, 2)
   assertLabelledAndSized(chunks, 200)
   assert.equal(chunks.map(stripLabel).join("\n"), big)
})

test("a single line longer than a chunk is hard-split rather than dropped", () => {
   const chunks = chunkPackage(pkg(prose("y".repeat(250))), {
      maxChunks: 3,
      maxChars: 200,
      fullPath,
   })
   assertLabelledAndSized(chunks, 200)
   assert.equal(chunks.map(stripLabel).join(""), "y".repeat(250))
})

test("over budget, inline diffs are compacted before anything is dropped", () => {
   const diff = tool(
      `[tool] Edit a\n\`\`\`diff\n${"-x\n".repeat(250)}\`\`\``,
      "[tool] Edit a → diff d.txt",
   )
   const chunks = chunkPackage(pkg(prose("Kept prose."), diff, prose("More prose.")), {
      maxChunks: 3,
      maxChars: 200,
      fullPath,
   })
   assert.deepEqual(chunks, [
      "[peer 1/1]\nKept prose.\n\n[tool] Edit a → diff d.txt\n\nMore prose.",
   ])
})

test("still over budget, tool lines go before prose, and the full file is pointed to", () => {
   const segments = [
      prose("p".repeat(100)),
      tool("[tool] Read 1"),
      tool("[tool] Read 2"),
      prose("q".repeat(100)),
      tool("t".repeat(300)),
      prose("r".repeat(100)),
   ]
   const chunks = chunkPackage(pkg(...segments), {
      maxChunks: 2,
      maxChars: 400,
      fullPath,
   })
   assert.equal(chunks.length, 2)
   assertLabelledAndSized(chunks, 400)
   const text = chunks.map(stripLabel).join("\n\n")
   assert.equal(
      text,
      [
         "p".repeat(100),
         "[2 tool lines omitted]",
         "q".repeat(100),
         "[1 tool line omitted]",
         "r".repeat(100),
         `[peer answer shortened to fit; full text at ${fullPath}]`,
      ].join("\n\n"),
   )
})

test("prose beyond K chunks is truncated, ending with a pointer to the full file", () => {
   const segments = ["a", "b", "c", "d", "e", "f", "g"].map((c) => prose(c.repeat(150)))
   const chunks = chunkPackage(pkg(frame("[open]"), ...segments), {
      maxChunks: 3,
      maxChars: 400,
      fullPath,
   })
   assert.equal(chunks.length, 3)
   assertLabelledAndSized(chunks, 400)
   assert.ok(chunks[0]?.startsWith("[peer 1/3]\n[open]\n\naaa"))
   assert.ok(
      chunks[2]?.endsWith(`\n\n[peer answer shortened to fit; full text at ${fullPath}]`),
   )
   assert.doesNotMatch(chunks.join(""), /g{150}/)
})
