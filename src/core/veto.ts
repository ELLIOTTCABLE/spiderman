import type { Block } from "./blocks.ts"

// numbers with their units: 5%, 300ms, 1.5, 100M, 64KB, 2,000
const NUMBER = /\d+(?:[.,]\d+)*(?:%|ms|[kmbgt]b?|[kmbgt]i?b)?/gi

/**
 * Specifics an elider must not collapse away: B's numbers and code that A's answer lacks. A
 * block holding any of them is kept, whatever the elider picked. Keep-only: it never elides.
 */
export function vetoElisions(
   blocks: readonly Block[],
   elided: ReadonlySet<number>,
   aText: string,
): { readonly elided: ReadonlySet<number>; readonly vetoed: readonly number[] } {
   const aNumbers = new Set(numbers(aText))
   const vetoed = [...elided].filter((i) => {
      const block = blocks[i]
      if (block === undefined) return false
      return (
         numbers(block.raw).some((n) => !aNumbers.has(n)) ||
         codeFragments(block).some((code) => !aText.includes(code))
      )
   })
   return { elided: new Set([...elided].filter((i) => !vetoed.includes(i))), vetoed }
}

function numbers(text: string): string[] {
   return (text.match(NUMBER) ?? []).map((n) => n.toLowerCase())
}

function codeFragments(block: Block): string[] {
   const inline = [...block.raw.matchAll(/`([^`\n]+)`/g)].flatMap((m) => {
      const code = m[1]?.trim()
      return code ? [code] : []
   })
   const fenced =
      block.kind === "code"
         ? block.raw
              .split("\n")
              .filter((line) => !/^\s*(?:`{3,}|~{3,})/.test(line))
              .map((line) => line.trim())
              .filter((line) => line !== "")
         : []
   return [...inline, ...fenced]
}
