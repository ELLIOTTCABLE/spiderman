import type { Trail, TrailItem, TrailResult } from "./trail.ts"
import { isRecord } from "./validate.ts"

export type Cursor = { readonly promptId: string } | { readonly uuid: string }

export interface Span {
   /** exclusive: start after the first match; absent = top of file */
   readonly after?: Cursor
   /** exclusive: stop before the first later match; absent = end of file */
   readonly until?: Cursor
}

export interface CcTrailOptions {
   /** the main transcript's own path, to find subagent transcripts beside it */
   readonly transcriptPath?: string
   readonly exists?: (path: string) => boolean
}

// undocumented, version-volatile format (ref-cc-hooks §8): ignore the unknown, report the malformed
// attachments are never read: they include the peer packages this harness injected
export function ccTrail(
   jsonl: string,
   span: Span = {},
   options: CcTrailOptions = {},
): Trail {
   const issues: string[] = []
   const entries: { line: number; entry: Record<string, unknown> }[] = []
   jsonl.split("\n").forEach((raw, i) => {
      const line = raw.trim()
      if (line === "") return
      try {
         const entry: unknown = JSON.parse(line)
         if (isRecord(entry)) entries.push({ line: i + 1, entry })
         else issues.push(`line ${i + 1}: not an object`)
      } catch {
         issues.push(`line ${i + 1}: not JSON`)
      }
   })

   const { after, until } = span
   let start = 0
   if (after !== undefined) {
      const at = entries.findIndex(({ entry }) => matches(entry, after))
      if (at === -1) return { items: [], issues: [...issues, "start position not found"] }
      start = at + 1
   }
   let end = entries.length
   if (until !== undefined) {
      const at = entries.findIndex(({ entry }, i) => i >= start && matches(entry, until))
      if (at !== -1) end = at
   }

   const transcripts = new SubagentTranscripts(options)
   const items: TrailItem[] = []
   for (const { line, entry } of entries.slice(start, end)) {
      if (entry.isSidechain === true || entry.isMeta === true) continue
      const converted =
         entry.type === "assistant"
            ? assistantItems(entry)
            : entry.type === "user"
              ? userItems(entry, transcripts)
              : []
      if (converted === undefined)
         issues.push(`line ${line}: unreadable ${String(entry.type)} entry`)
      else items.push(...converted)
   }
   return { items, issues }
}

function matches(entry: Record<string, unknown>, cursor: Cursor): boolean {
   return "uuid" in cursor
      ? entry.uuid === cursor.uuid
      : entry.promptId === cursor.promptId
}

function assistantItems(entry: Record<string, unknown>): TrailItem[] | undefined {
   const content = isRecord(entry.message) ? entry.message.content : undefined
   if (typeof content === "string") return [{ kind: "text", text: content }]
   if (!Array.isArray(content)) return undefined
   const items: TrailItem[] = []
   for (const block of content) {
      if (!isRecord(block)) return undefined
      if (block.type === "text") {
         if (typeof block.text !== "string") return undefined
         items.push({ kind: "text", text: block.text })
      } else if (block.type === "tool_use") {
         if (typeof block.id !== "string" || typeof block.name !== "string")
            return undefined
         items.push({ kind: "call", id: block.id, name: block.name, input: block.input })
      }
   }
   return items
}

/** The human's prompt, a batch of tool results, or a background subagent's completion. */
function userItems(
   entry: Record<string, unknown>,
   transcripts: SubagentTranscripts,
): TrailItem[] | undefined {
   const content = isRecord(entry.message) ? entry.message.content : undefined
   if (isTaskNotification(entry, content)) {
      const result = taskNotificationResult(String(content), transcripts)
      return result === undefined ? undefined : [result]
   }
   if (typeof content === "string") return [{ kind: "prompt", text: content }]
   if (!Array.isArray(content)) return undefined

   const meta = isRecord(entry.toolUseResult) ? entry.toolUseResult : {}
   const items: TrailItem[] = []
   const promptParts: string[] = []
   for (const block of content) {
      if (!isRecord(block)) return undefined
      if (block.type === "tool_result") {
         if (typeof block.tool_use_id !== "string") return undefined
         items.push(toolResult(block.tool_use_id, block, meta, transcripts))
      } else if (block.type === "text" && typeof block.text === "string") {
         promptParts.push(block.text)
      } else if (block.type === "image") {
         promptParts.push("[image]")
      }
   }
   if (promptParts.length > 0)
      items.unshift({ kind: "prompt", text: promptParts.join("\n") })
   return items
}

function toolResult(
   id: string,
   block: Record<string, unknown>,
   meta: Record<string, unknown>,
   transcripts: SubagentTranscripts,
): TrailResult {
   const text = contentText(block.content)
   let result: TrailResult = {
      kind: "result",
      id,
      text,
      isError: block.is_error === true,
   }

   const savedPath =
      typeof meta.persistedOutputPath === "string"
         ? meta.persistedOutputPath
         : /^<persisted-output>\s*Output too large[^\n]*?saved to: ([^\n]+)/
              .exec(text)?.[1]
              ?.trim()
   if (savedPath !== undefined) {
      const size = /^<persisted-output>\s*Output too large \(([^)]+)\)/.exec(text)?.[1]
      result = {
         ...result,
         saved: size === undefined ? { path: savedPath } : { path: savedPath, size },
      }
   }

   const file = isRecord(meta.file) ? meta.file : {}
   if (file.truncatedByTokenCap === true) {
      const total =
         typeof file.totalLines === "number" ? `; ${file.totalLines} lines in file` : ""
      result = { ...result, partial: `cut by token cap${total}` }
   }

   if (typeof meta.agentId === "string") {
      transcripts.launched(id, meta.agentId)
      const transcript = transcripts.forTool(id)
      if (transcript !== undefined) result = { ...result, transcript }
   }
   return result
}

function isTaskNotification(entry: Record<string, unknown>, content: unknown): boolean {
   const origin = isRecord(entry.origin) ? entry.origin.kind : undefined
   return (
      typeof content === "string" &&
      (origin === "task-notification" ||
         content.trimStart().startsWith("<task-notification>"))
   )
}

/** A background subagent's completion arrives as a user turn; it is that subagent's result. */
function taskNotificationResult(
   content: string,
   transcripts: SubagentTranscripts,
): TrailResult | undefined {
   const tag = (name: string) =>
      new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)?.[1]?.trim()
   const id = tag("tool-use-id")
   if (id === undefined) return undefined
   const agentId = tag("task-id")
   if (agentId !== undefined) transcripts.launched(id, agentId)
   const status = tag("status")
   const transcript = transcripts.forTool(id)
   const result: TrailResult = {
      kind: "result",
      id,
      text: tag("result") ?? tag("summary") ?? "",
      isError: status !== undefined && status !== "completed",
   }
   return transcript === undefined ? result : { ...result, transcript }
}

// <session>.jsonl → <session>/subagents/agent-<agentId>.jsonl (observed on 2.1.286)
class SubagentTranscripts {
   readonly #agents = new Map<string, string>()
   readonly #options: CcTrailOptions

   constructor(options: CcTrailOptions) {
      this.#options = options
   }

   launched(toolUseId: string, agentId: string) {
      this.#agents.set(toolUseId, agentId)
   }

   forTool(toolUseId: string): string | undefined {
      const agentId = this.#agents.get(toolUseId)
      const main = this.#options.transcriptPath
      if (agentId === undefined || main === undefined || !main.endsWith(".jsonl"))
         return undefined
      const path = `${main.slice(0, -".jsonl".length)}/subagents/agent-${agentId}.jsonl`
      return (this.#options.exists?.(path) ?? true) ? path : undefined
   }
}

function contentText(content: unknown): string {
   if (typeof content === "string") return content
   if (!Array.isArray(content)) return ""
   return content
      .map((block) => {
         if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
            return block.text
         }
         return isRecord(block) && block.type === "image"
            ? "[image]"
            : "[unreadable content]"
      })
      .join("\n")
}
