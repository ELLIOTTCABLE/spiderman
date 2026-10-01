import { leadWords, splitBlocks } from "./blocks.ts"
import type { IndexParse } from "./elision.ts"
import { vetoElisions } from "./veto.ts"

export interface Rendered {
   readonly text: string
   /** 1-based numbers of the paragraphs shown as previews */
   readonly elided: readonly number[]
   /** 1-based numbers the elider picked but the veto kept */
   readonly vetoed: readonly number[]
}

const PREVIEW_WORDS = 8

// adds only header lines and previews quoting B's own first words; never invents content
export function renderElided(
   answer: string,
   parse: IndexParse,
   aText?: string,
): Rendered {
   const blocks = splitBlocks(answer)
   if (parse.kind === "unparseable") {
      const text = joinParts([
         `[elision unavailable (${parse.reason}); shown in full]`,
         ...blocks.map((b) => b.raw),
      ])
      return { text, elided: [], vetoed: [] }
   }

   const outOfRange = parse.indices.filter((k) => !(k >= 1 && k <= blocks.length))
   const picked = new Set(
      parse.indices.filter((k) => !outOfRange.includes(k)).map((k) => k - 1),
   )
   const { elided, vetoed } =
      aText === undefined
         ? { elided: picked, vetoed: [] }
         : vetoElisions(blocks, picked, aText)
   const parts: string[] = []
   if (outOfRange.length > 0) {
      parts.push(
         `[elision: ignored paragraph numbers out of range: ${[...new Set(outOfRange)].join(", ")}]`,
      )
   }
   let run: string[] = []
   const flush = () => {
      if (run.length > 0) parts.push(run.join("\n"))
      run = []
   }
   blocks.forEach((block, i) => {
      if (elided.has(i)) {
         run.push(`[elided: "${leadWords(block, PREVIEW_WORDS)}"]`)
         return
      }
      flush()
      parts.push(block.raw)
   })
   flush()
   return {
      text: joinParts(parts),
      elided: [...elided].sort((x, y) => x - y).map((i) => i + 1),
      vetoed: [...vetoed].sort((x, y) => x - y).map((i) => i + 1),
   }
}

function joinParts(parts: readonly string[]): string {
   return parts.join("\n\n")
}
