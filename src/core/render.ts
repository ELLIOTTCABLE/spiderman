import type { AnchorParse } from "./anchors.ts"
import { type Block, splitBlocks } from "./blocks.ts"
import { matchAnchors } from "./match.ts"
import { vetoElisions } from "./veto.ts"

export interface Rendered {
   readonly text: string
   /** blocks the anchors elided but the veto kept */
   readonly vetoed: number
}

const PREVIEW_WORDS = 8

// adds only header lines and previews quoting B's own first words; never invents content
export function renderElided(
   answer: string,
   parse: AnchorParse,
   aText?: string,
): Rendered {
   const blocks = splitBlocks(answer)
   if (parse.kind === "unparseable") {
      const text = joinParts([
         `[elision unavailable (${parse.reason}); shown in full]`,
         ...blocks.map((b) => b.raw),
      ])
      return { text, vetoed: 0 }
   }

   const plan = matchAnchors(blocks, parse.anchors)
   const { elided, vetoed } =
      aText === undefined
         ? { elided: plan.elided, vetoed: [] }
         : vetoElisions(blocks, plan.elided, aText)
   const misses = plan.matches.filter((m) => m.status !== "matched").length
   const parts: string[] = []
   if (misses > 0) {
      parts.push(
         `[elision: ${misses} of ${plan.matches.length} anchors matched no single paragraph; kept]`,
      )
   }
   let run: string[] = []
   const flush = () => {
      if (run.length > 0) parts.push(run.join("\n"))
      run = []
   }
   blocks.forEach((block, i) => {
      if (elided.has(i)) {
         run.push(preview(block))
         return
      }
      flush()
      parts.push(block.raw)
   })
   flush()
   return { text: joinParts(parts), vetoed: vetoed.length }
}

/** One line per elided block, so a wrong collapse is visible at a glance. */
function preview(block: Block): string {
   const source =
      block.kind === "code" ? block.raw.split("\n").slice(1).join("\n") : block.raw
   const words = source
      .split(/\s+/)
      .filter((w) => w !== "" && !/^(?:`{3,}|~{3,})$/.test(w))
   const head = words.slice(0, PREVIEW_WORDS).join(" ")
   return `[elided: "${head}${words.length > PREVIEW_WORDS ? "…" : ""}"]`
}

function joinParts(parts: readonly string[]): string {
   return parts.join("\n\n")
}
