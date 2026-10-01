import { splitBlocks } from "./blocks.ts"
import {
   classify,
   editHunks,
   type Hunk,
   inputPath,
   type ReadView,
   subagentBrief,
   type ToolKind,
} from "./tools.ts"
import type { Trail, TrailCall, TrailResult } from "./trail.ts"

/** truncation priority, highest first (chunk.ts) */
export type SegmentKind = "frame" | "prose" | "tool"

export interface Segment {
   readonly kind: SegmentKind
   readonly text: string
   /** lossless shorter form: the detail is in the store */
   readonly compact?: string
}

/** How the receiver can get at one thing the peer saw or did. */
export interface Interaction {
   readonly id: string | undefined
   readonly tool: string
   readonly kind: ToolKind | "orphan"
   /** paths the package points at for it; empty when everything is inline (or noise) */
   readonly pointers: readonly string[]
}

export interface PeerPackage {
   readonly segments: readonly Segment[]
   readonly interactions: readonly Interaction[]
}

export interface PackageEnv {
   /** stores text, returns a path the receiver can read */
   readonly refer: (text: string) => string
   /** a file's current text, or undefined; relative paths resolve against the peer's cwd */
   readonly readFile: (path: string) => string | undefined
}

// facts, not imperatives: out-of-band commands trip CC's prompt-injection defences
const OPENING =
   "[peer answer] What follows is an independent answer to the previous turn from a peer model " +
   "that worked on the same prompt in parallel. It is not endorsed by the human. Tool lines " +
   "record what the peer read, ran and changed; longer outputs are saved as files and " +
   "referenced by path."
const CLOSING = "[end of peer answer]"

// a pointer line is ~90 chars and costs the receiver a tool call to follow; below this, inline wins
const TINY_LINES = 5
const TINY_CHARS = 240
const INLINE_INPUT_LIMIT = 1_000
const GENERIC_INPUT_LIMIT = 300
const INLINE_DIFF_LIMIT = 2_000
const BRIEF_LIMIT = 160
const REPORT_LIMIT = 1_500

interface Rendered {
   readonly segments: readonly Segment[]
   readonly pointers: readonly string[]
}

export function formatPeerPackage(trail: Trail, env: PackageEnv): PeerPackage {
   const callIds = new Set(
      trail.items.flatMap((i) => (i.kind === "call" && i.id ? [i.id] : [])),
   )
   const results = new Map<string, TrailResult>()
   for (const item of trail.items) {
      if (item.kind === "result" && item.id !== undefined && callIds.has(item.id)) {
         results.set(item.id, item)
      }
   }

   const reads = new ReadMemory()
   const segments: Segment[] = [{ kind: "frame", text: OPENING }]
   const interactions: Interaction[] = []
   if (trail.issues.length > 0) {
      segments.push({
         kind: "frame",
         text:
            `[note] ${trail.issues.length} part(s) of the peer's record could not be read, ` +
            "so this answer may be incomplete.",
      })
   }
   for (const item of trail.items) {
      if (item.kind === "prompt") {
         segments.push({
            kind: "prose",
            text: `[the human's prompt to the peer]\n${item.text}`,
         })
      } else if (item.kind === "text") {
         for (const block of splitBlocks(item.text))
            segments.push({ kind: "prose", text: block.raw })
      } else if (item.kind === "call") {
         const result = item.id === undefined ? undefined : results.get(item.id)
         const spec = classify(item.name)
         const rendered = renderCall(item, result, env, reads)
         segments.push(...rendered.segments)
         interactions.push({
            id: item.id,
            tool: item.name,
            kind: spec.kind,
            pointers: rendered.pointers,
         })
      } else if (item.id === undefined || !callIds.has(item.id)) {
         const out = outputPhrase(item, env, true)
         segments.push({ kind: "tool", text: `[tool output]${out.text}` })
         interactions.push({
            id: item.id,
            tool: "?",
            kind: "orphan",
            pointers: out.pointers,
         })
      }
   }
   segments.push({ kind: "frame", text: CLOSING })
   return { segments, interactions }
}

export function packageText(pkg: PeerPackage): string {
   return pkg.segments.map((s) => s.text).join("\n\n")
}

function renderCall(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
   reads: ReadMemory,
): Rendered {
   const spec = classify(call.name)
   switch (spec.kind) {
      case "noise":
         return { segments: [], pointers: [] }
      case "read":
         return (
            renderRead(call, result, env, reads, spec.view) ??
            renderSearch(call, result, env)
         )
      case "edit":
         return renderEdit(call, result, env) ?? renderGeneric(call, result, env)
      case "write":
         return renderWrite(call, result, env) ?? renderGeneric(call, result, env)
      case "subagent":
         return renderSubagent(call, result, env) ?? renderGeneric(call, result, env)
      case "search":
         return renderSearch(call, result, env)
      case "remote":
         return renderOpaque(call, result, env, INLINE_INPUT_LIMIT)
      case "generic":
         return renderGeneric(call, result, env)
   }
}

function renderRead(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
   reads: ReadMemory,
   view:
      | ((output: string, input: Record<string, unknown>) => ReadView | undefined)
      | undefined,
): Rendered | undefined {
   const path = inputPath(call.input)
   if (path === undefined || view === undefined) return undefined
   const head = `[tool] read ${path}`
   if (result === undefined) return tool(`${head} → no result recorded`, [])
   if (result.isError) {
      const error = errorPhrase(result, env)
      return tool(`${head}${error.text}`, error.pointers)
   }
   const seen = view(result.text, call.input as Record<string, unknown>)
   if (seen === undefined) return undefined

   const range = `L${seen.start}–${seen.start + seen.lines.length - 1}`
   const earlier = reads.find(path, seen)
   if (earlier?.same === "range")
      return tool(`${head} ${range} (again)`, earlier.pointers)
   if (earlier?.same === "covered") return { segments: [], pointers: earlier.pointers }

   const current = env.readFile(path)
   const unchanged = current !== undefined && sameLines(current, seen)
   const pointers = unchanged ? [path] : [env.refer(seen.lines.join("\n"))]
   reads.add(path, seen, pointers)
   const notes = [result.partial ?? seen.note]
   if (!unchanged) notes.push(`file changed since; peer's view: ${pointers[0]}`)
   const said = notes.filter((n) => n !== undefined)
   const text =
      said.length === 0 ? `${head} ${range}` : `${head} ${range} (${said.join("; ")})`
   return tool(text, pointers)
}

function renderSearch(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
): Rendered {
   const input = inputPhrase(call.input, INLINE_INPUT_LIMIT, env)
   const output = outputPhrase(result, env, true)
   return tool(`[tool] ${call.name}${input.text}${output.text}`, [
      ...input.pointers,
      ...output.pointers,
   ])
}

// web and MCP output stays out of line: it is untrusted text, and often large
function renderOpaque(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
   inputLimit: number,
): Rendered {
   const input = inputPhrase(call.input, inputLimit, env)
   const output = outputPhrase(result, env, false)
   return tool(`[tool] ${call.name}${input.text}${output.text}`, [
      ...input.pointers,
      ...output.pointers,
   ])
}

function renderGeneric(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
): Rendered {
   return renderOpaque(call, result, env, GENERIC_INPUT_LIMIT)
}

function renderEdit(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
): Rendered | undefined {
   const path = inputPath(call.input)
   const hunks = editHunks(call.input)
   if (path === undefined || hunks === undefined) return undefined
   const diff = diffLines(hunks)
   const diffRef = env.refer(diff)
   const all =
      (call.input as Record<string, unknown>).replace_all === true
         ? " (all occurrences)"
         : ""
   const head = `[tool] edit ${path}${all}`
   if (result?.isError) {
      const error = errorPhrase(result, env)
      return tool(`${head}${error.text} (attempted diff: ${diffRef})`, [
         ...error.pointers,
         diffRef,
      ])
   }
   const status = result === undefined ? " → no result recorded" : ""
   const compact = `${head} → diff ${diffRef} (${plural(lineCount(diff), "line")})${status}`
   if (diff.length > INLINE_DIFF_LIMIT) return tool(compact, [diffRef])
   return {
      segments: [
         { kind: "tool", text: `${head}${status}\n${fenced(diff, "diff")}`, compact },
      ],
      pointers: [],
   }
}

function renderWrite(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
): Rendered | undefined {
   const path = inputPath(call.input)
   const content = (call.input as Record<string, unknown> | undefined)?.content
   if (path === undefined || typeof content !== "string") return undefined
   if (result?.isError) {
      const error = errorPhrase(result, env)
      const ref = env.refer(content)
      return tool(`[tool] write ${path}${error.text} (content: ${ref})`, [
         ...error.pointers,
         ref,
      ])
   }
   const head = `[tool] wrote ${path} (${plural(lineCount(content), "line")}`
   const status = result === undefined ? " → no result recorded" : ""
   const current = env.readFile(path)
   if (current !== undefined && normalise(current) === normalise(content)) {
      return tool(`${head})${status}`, [path])
   }
   const ref = env.refer(content)
   return tool(`${head}; file changed since; peer's version: ${ref})${status}`, [ref])
}

function renderSubagent(
   call: TrailCall,
   result: TrailResult | undefined,
   env: PackageEnv,
): Rendered | undefined {
   const brief = subagentBrief(call.input)
   if (brief === undefined) return undefined
   const pointers: string[] = []
   const summary = clip(brief.what, BRIEF_LIMIT)
   let head = `[tool] subagent${brief.who ? ` ${brief.who}` : ""}: ${summary}`
   if (summary !== brief.what || !brief.complete) {
      const ref = env.refer(JSON.stringify(call.input, null, 2))
      pointers.push(ref)
      head += ` (full prompt: ${ref})`
   }
   if (result?.transcript !== undefined) {
      pointers.push(result.transcript)
      head += ` (transcript: ${result.transcript})`
   }
   if (result === undefined) return tool(`${head} → no result recorded`, pointers)
   if (result.isError || result.saved !== undefined || result.text === "") {
      const output = outputPhrase(result, env, true)
      return tool(`${head}${output.text}`, [...pointers, ...output.pointers])
   }

   let report = result.text
   if (report.length > REPORT_LIMIT) {
      const ref = env.refer(report)
      pointers.push(ref)
      report = `${cutAtLine(report, REPORT_LIMIT)}\n… (full report: ${ref})`
   }
   return {
      segments: [
         { kind: "tool", text: head },
         { kind: "prose", text: `[subagent report]\n${report}` },
      ],
      pointers,
   }
}

function tool(text: string, pointers: readonly string[]): Rendered {
   return { segments: [{ kind: "tool", text }], pointers }
}

interface Phrase {
   readonly text: string
   readonly pointers: readonly string[]
}

function inputPhrase(input: unknown, limit: number, env: PackageEnv): Phrase {
   const json = JSON.stringify(input ?? {}, (_key, value) =>
      value === null ? undefined : value,
   )
   if (json.length <= limit) return { text: ` ${json}`, pointers: [] }
   const ref = env.refer(JSON.stringify(input, null, 2))
   return { text: ` ${json.slice(0, limit)}… (full input: ${ref})`, pointers: [ref] }
}

function outputPhrase(
   result: TrailResult | undefined,
   env: PackageEnv,
   inlineTiny: boolean,
): Phrase {
   if (result === undefined) return { text: " → no result recorded", pointers: [] }
   if (result.isError) return errorPhrase(result, env)
   if (result.saved !== undefined) {
      const size = result.saved.size === undefined ? "" : `${result.saved.size}, `
      return {
         text: ` → ${size}saved at ${result.saved.path}`,
         pointers: [result.saved.path],
      }
   }
   if (result.text === "") return { text: " → no output", pointers: [] }
   const lines = lineCount(result.text)
   if (inlineTiny && lines <= TINY_LINES && result.text.length <= TINY_CHARS) {
      const body = result.text.replace(/\n$/, "")
      return {
         text: lines === 1 ? ` → ${body}` : ` →\n  ${body.split("\n").join("\n  ")}`,
         pointers: [],
      }
   }
   const ref = env.refer(result.text)
   return { text: ` → ${plural(lines, "line")}, ${ref}`, pointers: [ref] }
}

function errorPhrase(result: TrailResult, env: PackageEnv): Phrase {
   const first = clip(result.text.split("\n")[0] ?? "", BRIEF_LIMIT)
   if (first === result.text.trim()) return { text: ` → error: ${first}`, pointers: [] }
   const ref = result.saved?.path ?? env.refer(result.text)
   return { text: ` → error: ${first} (full: ${ref})`, pointers: [ref] }
}

class ReadMemory {
   readonly #seen = new Map<string, { view: ReadView; pointers: readonly string[] }[]>()

   find(path: string, view: ReadView) {
      for (const earlier of this.#seen.get(path) ?? []) {
         const offset = view.start - earlier.view.start
         const fits =
            offset >= 0 && offset + view.lines.length <= earlier.view.lines.length
         if (
            !fits ||
            !view.lines.every((line, i) => line === earlier.view.lines[offset + i])
         )
            continue
         const same = offset === 0 && view.lines.length === earlier.view.lines.length
         return {
            same: same ? ("range" as const) : ("covered" as const),
            pointers: earlier.pointers,
         }
      }
      return undefined
   }

   add(path: string, view: ReadView, pointers: readonly string[]) {
      this.#seen.set(path, [...(this.#seen.get(path) ?? []), { view, pointers }])
   }
}

function sameLines(current: string, view: ReadView): boolean {
   const lines = normalise(current)
      .split("\n")
      .slice(view.start - 1, view.start - 1 + view.lines.length)
   return (
      lines.length === view.lines.length &&
      lines.every((line, i) => line === view.lines[i])
   )
}

function normalise(text: string): string {
   return text.replace(/\r\n/g, "\n")
}

function diffLines(hunks: readonly Hunk[]): string {
   return hunks
      .map((h) => {
         const removed = h.old === "" ? [] : h.old.split("\n").map((l) => `-${l}`)
         const added = h.new === "" ? [] : h.new.split("\n").map((l) => `+${l}`)
         return [...removed, ...added].join("\n")
      })
      .join("\n@@\n")
}

function fenced(text: string, info: string): string {
   const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
   const fence = "`".repeat(Math.max(3, longestRun + 1))
   return `${fence}${info}\n${text}\n${fence}`
}

function clip(text: string, limit: number): string {
   const line = text.split("\n")[0] ?? ""
   return line.length > limit
      ? `${line.slice(0, limit)}…`
      : line === text
        ? text
        : `${line}…`
}

function cutAtLine(text: string, limit: number): string {
   const head = text.slice(0, limit)
   const lastBreak = head.lastIndexOf("\n")
   return lastBreak > limit / 2 ? head.slice(0, lastBreak) : head
}

export function lineCount(text: string): number {
   if (text === "") return 0
   const lines = text.split("\n").length
   return text.endsWith("\n") ? lines - 1 : lines
}

function plural(count: number, noun: string): string {
   return `${count} ${noun}${count === 1 ? "" : "s"}`
}
