import { splitBlocks } from "./blocks.ts"
import type { Trail, TrailItem } from "./trail.ts"
import { isRecord } from "./validate.ts"

/** truncation priority, highest first (chunk.ts) */
export type SegmentKind = "frame" | "prose" | "tool"

export interface Segment {
   readonly kind: SegmentKind
   readonly text: string
   /** lossless shorter form: the detail is in the store */
   readonly compact?: string
}

export interface PeerPackage {
   readonly segments: readonly Segment[]
}

export type Refer = (text: string) => string

// facts, not imperatives: out-of-band commands trip CC's prompt-injection defences
const OPENING =
   "[peer answer] What follows is an independent answer to the previous turn from a peer model " +
   "that worked on the same prompt in parallel. It is not endorsed by the human. Its tool " +
   "outputs are saved as files and referenced by path."
const CLOSING = "[end of peer answer]"

const INLINE_INPUT_LIMIT = 1_000
const INLINE_DIFF_LIMIT = 2_000

export function formatPeerPackage(trail: Trail, refer: Refer): PeerPackage {
   const results = new Map<string, Extract<TrailItem, { kind: "result" }>>()
   const callIds = new Set(
      trail.items.flatMap((i) => (i.kind === "call" && i.id ? [i.id] : [])),
   )
   for (const item of trail.items) {
      if (item.kind === "result" && item.id !== undefined && callIds.has(item.id)) {
         results.set(item.id, item)
      }
   }

   const segments: Segment[] = [{ kind: "frame", text: OPENING }]
   if (trail.issues.length > 0) {
      segments.push({
         kind: "frame",
         text:
            `[note] ${trail.issues.length} part(s) of the peer's record could not be read, ` +
            "so this answer may be incomplete.",
      })
   }
   for (const item of trail.items) {
      switch (item.kind) {
         case "prompt":
            segments.push({
               kind: "prose",
               text: `[the human's prompt to the peer]\n${item.text}`,
            })
            break
         case "text":
            for (const block of splitBlocks(item.text)) {
               segments.push({ kind: "prose", text: block.raw })
            }
            break
         case "call":
            segments.push(
               callSegment(item, item.id ? results.get(item.id) : undefined, refer),
            )
            break
         case "result":
            if (item.id === undefined || !callIds.has(item.id)) {
               segments.push({
                  kind: "tool",
                  text: `[tool output] ${outputRef(item.text, refer)}`,
               })
            }
            break
      }
   }
   segments.push({ kind: "frame", text: CLOSING })
   return { segments }
}

export function packageText(pkg: PeerPackage): string {
   return pkg.segments.map((s) => s.text).join("\n\n")
}

function callSegment(
   call: Extract<TrailItem, { kind: "call" }>,
   result: Extract<TrailItem, { kind: "result" }> | undefined,
   refer: Refer,
): Segment {
   const effect = fileEffect(call.name, call.input)
   if (effect?.kind === "write") {
      const head = `[tool] ${call.name} ${effect.path} (${plural(lineCount(effect.content), "line")})`
      return {
         kind: "tool",
         text: `${head} → content ${refer(effect.content)}${failure(result, refer)}`,
      }
   }
   if (effect?.kind === "edit") {
      const head = `[tool] ${call.name} ${effect.path}${effect.replaceAll ? " (all occurrences)" : ""}`
      const status =
         result === undefined ? " → no result recorded" : failure(result, refer)
      const diff = diffLines(effect.hunks)
      const compact = `${head} → diff ${refer(diff)} (${plural(lineCount(diff), "line")})${status}`
      if (diff.length > INLINE_DIFF_LIMIT) return { kind: "tool", text: compact }
      return { kind: "tool", text: `${head}${status}\n${fenced(diff, "diff")}`, compact }
   }

   const json = JSON.stringify(call.input ?? {})
   const pretty = JSON.stringify(call.input ?? {}, null, 2)
   const input =
      json.length > INLINE_INPUT_LIMIT
         ? ` → input ${refer(pretty)} (${pretty.length} chars)`
         : ` ${json}`
   return {
      kind: "tool",
      text: `[tool] ${call.name}${input} → ${resultPhrase(result, refer)}`,
   }
}

function resultPhrase(
   result: Extract<TrailItem, { kind: "result" }> | undefined,
   refer: Refer,
) {
   if (result === undefined) return "no result recorded"
   if (result.text === "") return result.isError ? "error with no output" : "no output"
   return `${result.isError ? "error output" : "output"} ${outputRef(result.text, refer)}`
}

function failure(
   result: Extract<TrailItem, { kind: "result" }> | undefined,
   refer: Refer,
) {
   return result?.isError ? ` → failed, ${resultPhrase(result, refer)}` : ""
}

function outputRef(text: string, refer: Refer): string {
   return `${refer(text)} (${plural(lineCount(text), "line")})`
}

type FileEffect =
   | { kind: "write"; path: string; content: string }
   | { kind: "edit"; path: string; hunks: Hunk[]; replaceAll: boolean }
type Hunk = { old: string; new: string }

// CC: Edit/MultiEdit/Write, file_path, old_string. pi: edit/write, path, edits[].oldText
function fileEffect(name: string, input: unknown): FileEffect | undefined {
   if (!isRecord(input)) return undefined
   const path = typeof input.file_path === "string" ? input.file_path : input.path
   if (typeof path !== "string") return undefined
   const tool = name.toLowerCase()

   if (tool === "write") {
      return typeof input.content === "string"
         ? { kind: "write", path, content: input.content }
         : undefined
   }
   if (tool !== "edit" && tool !== "multiedit") return undefined
   const raw = Array.isArray(input.edits) ? input.edits : [input]
   const hunks = raw.map(hunk)
   if (hunks.length === 0 || hunks.some((h) => h === undefined)) return undefined
   return {
      kind: "edit",
      path,
      hunks: hunks as Hunk[],
      replaceAll: input.replace_all === true,
   }
}

function hunk(edit: unknown): Hunk | undefined {
   if (!isRecord(edit)) return undefined
   const old = edit.old_string ?? edit.oldText
   const replacement = edit.new_string ?? edit.newText
   return typeof old === "string" && typeof replacement === "string"
      ? { old, new: replacement }
      : undefined
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

function lineCount(text: string): number {
   if (text === "") return 0
   const lines = text.split("\n").length
   return text.endsWith("\n") ? lines - 1 : lines
}

function plural(count: number, noun: string): string {
   return `${count} ${noun}${count === 1 ? "" : "s"}`
}
