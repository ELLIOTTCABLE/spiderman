import type { PeerPackage, Segment } from "./package.ts"

// CC caps each hook string at 10k chars (over: 2k preview + a file the model isn't told to read)
export const CHUNK_CHARS = 9_500

// every delivered char is replayed in A's context on every later request; ~38k chars holds a
// long answer with its trail, and the rest is one pointer away on disk
export const MAX_CHUNKS = 4

export interface ChunkOptions {
   readonly maxChunks: number
   readonly maxChars: number
   readonly fullPath: string
}

// labelled because hooks merge in completion order. Over budget, shrink losing the least first:
// 1. inline diffs → one-line refs (lossless: diff is in the store)
// 2. drop tool lines (each only points at a file; prose is the answer)
// 3. cut prose at the end
// 2 and 3 end the last chunk with a pointer to the full package
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
