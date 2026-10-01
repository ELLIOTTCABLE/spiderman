import type { PeerPackage, Segment } from "./package.ts"

/** Claude Code caps each hook string at 10,000 characters; beyond that the model sees only a
 * 2,000-character preview. The margin absorbs any wrapping Claude Code adds. */
export const CHUNK_CHARS = 9_500

/** Each chunk is one more `UserPromptSubmit` hook, and every delivered character is replayed in
 * A's context on every later request. Four chunks (~38k characters, ~9k tokens) hold a long
 * answer with its tool trail; past that the full package is on disk, one pointer away. */
export const MAX_CHUNKS = 4

export interface ChunkOptions {
   readonly maxChunks: number
   readonly maxChars: number
   /** Where the full, unshortened package is saved. */
   readonly fullPath: string
}

/**
 * Splits a package into at most `maxChunks` chunks labelled `[peer k/K]`, each at most
 * `maxChars` long, breaking between segments where possible. Hooks merge in completion order,
 * hence the labels.
 *
 * When the package is too long, it shrinks in steps, losing the least first:
 * 1. inline diffs become one-line references (lossless: the diff is in the store);
 * 2. tool lines are dropped, since each only points at a file, while prose is the answer;
 * 3. prose is cut at the end.
 * Steps 2 and 3 end the last chunk with a pointer to the full package.
 */
export function chunkPackage(pkg: PeerPackage, options: ChunkOptions): string[] {
   const { maxChunks, maxChars, fullPath } = options
   const label = (k: number, count: number) => `[peer ${k}/${count}]\n`
   const labelSize = label(maxChunks, maxChunks).length
   const pointer = `[peer answer shortened to fit; full text at ${fullPath}]`
   const fits = (chunks: readonly string[]) => chunks.length <= maxChunks
   const labelled = (chunks: readonly string[]) =>
      chunks.map((chunk, i) => label(i + 1, chunks.length) + chunk)

   const whole = pack(pkg.segments, maxChars - labelSize)
   if (fits(whole)) return labelled(whole)
   const compacted = pkg.segments.map((s) =>
      s.compact === undefined ? s : { ...s, text: s.compact },
   )
   const lossless = pack(compacted, maxChars - labelSize)
   if (fits(lossless)) return labelled(lossless)

   const budget = maxChars - labelSize - pointer.length - 2
   const shortened = pack(withoutTools(compacted), budget).slice(0, maxChunks)
   const last = shortened.length - 1
   shortened[last] = `${shortened[last]}\n\n${pointer}`
   return labelled(shortened)
}

function withoutTools(segments: readonly Segment[]): Segment[] {
   const kept: Segment[] = []
   let dropped = 0
   const flush = () => {
      if (dropped === 0) return
      const noun = dropped === 1 ? "line" : "lines"
      kept.push({ kind: "frame", text: `[${dropped} tool ${noun} omitted]` })
      dropped = 0
   }
   for (const segment of segments) {
      if (segment.kind === "tool") {
         dropped++
      } else {
         flush()
         kept.push(segment)
      }
   }
   flush()
   return kept
}

/** Greedy packing; a segment that can't fit even an empty chunk is split at lines, then hard. */
function pack(segments: readonly Segment[], budget: number): string[] {
   const chunks: string[] = []
   let current = ""
   for (const segment of segments) {
      for (const piece of pieces(segment.text, budget)) {
         const joined = current === "" ? piece : `${current}\n\n${piece}`
         if (joined.length <= budget) {
            current = joined
         } else {
            chunks.push(current)
            current = piece
         }
      }
   }
   if (current !== "") chunks.push(current)
   return chunks
}

function pieces(text: string, budget: number): string[] {
   if (text.length <= budget) return [text]
   const out: string[] = []
   let current: string | undefined
   for (const line of text.split("\n").flatMap((l) => hardSplit(l, budget))) {
      if (current !== undefined && current.length + 1 + line.length <= budget) {
         current = `${current}\n${line}`
      } else {
         if (current !== undefined) out.push(current)
         current = line
      }
   }
   if (current !== undefined) out.push(current)
   return out
}

function hardSplit(line: string, budget: number): string[] {
   if (line.length <= budget) return [line]
   const parts: string[] = []
   for (let i = 0; i < line.length; i += budget) parts.push(line.slice(i, i + budget))
   return parts
}
