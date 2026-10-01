import type { Block } from "./blocks.ts"

export type AnchorMatch =
   | { readonly anchor: string; readonly status: "matched"; readonly block: number }
   | { readonly anchor: string; readonly status: "unmatched" | "ambiguous" | "empty" }

export interface ElisionPlan {
   readonly elided: ReadonlySet<number>
   readonly matches: readonly AnchorMatch[]
}

export function matchAnchors(
   blocks: readonly Block[],
   anchors: readonly string[],
): ElisionPlan {
   const blockWords = blocks.map((block) => words(block.raw))
   const matches = anchors.map((anchor): AnchorMatch => {
      const prefix = words(anchor)
      if (prefix.length === 0) return { anchor, status: "empty" }
      const hits = blockWords.flatMap((bw, i) => (startsWith(bw, prefix) ? [i] : []))
      const [hit, ...more] = hits
      if (hit === undefined) return { anchor, status: "unmatched" }
      if (more.length > 0) return { anchor, status: "ambiguous" }
      return { anchor, status: "matched", block: hit }
   })
   const elided = new Set(
      matches.flatMap((m) => (m.status === "matched" ? [m.block] : [])),
   )
   return { elided, matches }
}

// letter/digit runs only: subsumes quotes, dashes, emphasis, inline code. Ordered-list numbers and
// fence info strings are words, so they're stripped first
export function words(text: string): string[] {
   const stripped = text
      .normalize("NFKC")
      .split("\n")
      .map((line) =>
         line
            .replace(/^\s*(?:`{3,}|~{3,})[^\s`]*/, "")
            .replace(/^\s*(?:>\s*)*(?:\d{1,9}[.)](?=\s))?/, ""),
      )
      .join("\n")
      .replace(/\]\([^)]*\)/g, "]")
   return stripped.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function startsWith(haystack: readonly string[], prefix: readonly string[]): boolean {
   return (
      prefix.length <= haystack.length && prefix.every((word, i) => haystack[i] === word)
   )
}
