import type { AnchorParse } from "./anchors.ts"
import { splitBlocks } from "./blocks.ts"
import { matchAnchors } from "./match.ts"

/** The peer answer as the human reads it. Only the header and `[n¶ elided]` markers are added;
 * every other character comes from the answer itself. */
export function renderElided(answer: string, parse: AnchorParse): string {
   const blocks = splitBlocks(answer)
   if (parse.kind === "unparseable") {
      return joinParts([
         `[elision unavailable (${parse.reason}); shown in full]`,
         ...blocks.map((b) => b.raw),
      ])
   }

   const plan = matchAnchors(blocks, parse.anchors)
   const misses = plan.matches.filter((m) => m.status !== "matched").length
   const parts: string[] = []
   if (misses > 0) {
      parts.push(
         `[elision: ${misses} of ${plan.matches.length} anchors matched no single paragraph; kept]`,
      )
   }
   let run = 0
   blocks.forEach((block, i) => {
      if (plan.elided.has(i)) {
         run++
         return
      }
      if (run > 0) parts.push(marker(run))
      run = 0
      parts.push(block.raw)
   })
   if (run > 0) parts.push(marker(run))
   return joinParts(parts)
}

function marker(count: number): string {
   return `[${count}¶ elided]`
}

function joinParts(parts: readonly string[]): string {
   return parts.join("\n\n")
}
