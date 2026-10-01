import type { PeerPackage, Segment, SegmentKind } from "./package.ts"

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
// 1. inline diffs and subagent reports → one-line refs (lossless: the detail is in the store)
// 2. drop tool lines (each only points at a file), then report lines
// 3. drop the interim narration between tool calls; the final answer stays
// 4. cut the final answer at the end
// 2–4 end the last chunk with a pointer to the full package
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

   const lastWork = compacted.findLastIndex(
      (s) => s.kind === "tool" || s.kind === "report",
   )
   const stages: ((s: Segment, i: number) => boolean)[] = [
      (s) => s.kind === "tool",
      (s) => s.kind === "tool" || s.kind === "report",
      (s, i) =>
         s.kind === "tool" || s.kind === "report" || (s.kind === "prose" && i < lastWork),
   ]
   const budget = maxChars - labelSize - pointer.length - 2
   let shortened: string[] = []
   for (const drop of stages) {
      shortened = pack(omitting(compacted, drop), budget)
      if (fits(shortened)) break
   }
   shortened = shortened.slice(0, maxChunks)
   const last = shortened.length - 1
   shortened[last] = `${shortened[last]}\n\n${pointer}`
   return labelled(shortened)
}

const NOUNS: Partial<Record<SegmentKind, readonly [string, string]>> = {
   tool: ["tool line", "tool lines"],
   report: ["subagent report", "subagent reports"],
   prose: ["paragraph of interim narration", "paragraphs of interim narration"],
}

function omitting(
   segments: readonly Segment[],
   drop: (segment: Segment, index: number) => boolean,
): Segment[] {
   const kept: Segment[] = []
   let run = new Map<SegmentKind, number>()
   const flush = () => {
      if (run.size === 0) return
      const parts = [...run].map(([kind, n]) => {
         const [one, many] = NOUNS[kind] ?? ["segment", "segments"]
         return `${n} ${n === 1 ? one : many}`
      })
      kept.push({ kind: "frame", text: `[${parts.join(", ")} omitted]` })
      run = new Map()
   }
   segments.forEach((segment, i) => {
      if (drop(segment, i)) {
         run.set(segment.kind, (run.get(segment.kind) ?? 0) + 1)
      } else {
         flush()
         kept.push(segment)
      }
   })
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
