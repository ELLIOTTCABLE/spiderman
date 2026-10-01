import assert from "node:assert/strict"
import { test } from "node:test"
import { splitBlocks } from "./blocks.ts"
import { vetoElisions } from "./veto.ts"

const veto = (b: string, a: string, elided: number[]) => {
   const result = vetoElisions(splitBlocks(b), new Set(elided), a)
   return { elided: [...result.elided], vetoed: result.vetoed }
}

test("the observed false elision: B's numbers that A lacks keep the paragraph", () => {
   const a =
      "UUIDv7 keys sort by time, so inserts stay local in the index. Use them for the events table."
   const b = [
      "UUIDv7 keys sort by time, so inserts land at the right edge of the index.",
      "In our benchmark, index bloat fell about 5% and insert latency about 30% at 100M rows.",
   ].join("\n\n")
   assert.deepEqual(veto(b, a, [0, 1]), { elided: [0], vetoed: [1] })
})

test("numbers A also states don't block an elision", () => {
   assert.deepEqual(
      veto("Latency drops 30% with 300ms timeouts.", "a 30% drop; 300ms timeouts", [0]),
      {
         elided: [0],
         vetoed: [],
      },
   )
})

test("code A lacks keeps the block: inline spans and fenced lines", () => {
   const a = "Call fetchUser before render."
   assert.deepEqual(veto("Call `fetchUser(id, { cache: true })` first.", a, [0]), {
      elided: [],
      vetoed: [0],
   })
   assert.deepEqual(
      veto("```ts\nfetchUser(id)\nawait warm()\n```", "fetchUser(id) then", [0]),
      {
         elided: [],
         vetoed: [0],
      },
   )
   assert.deepEqual(veto("Use `fetchUser`.", a, [0]), { elided: [0], vetoed: [] })
})

test("the veto only keeps: blocks the anchors kept are never touched", () => {
   assert.deepEqual(veto("Plain words.\n\nMore 42 words.", "", []), {
      elided: [],
      vetoed: [],
   })
})
