import type { Trail, TrailItem } from "./trail.ts"
import { isRecord } from "./validate.ts"

export type Cursor = { readonly promptId: string } | { readonly uuid: string }

export interface Span {
   /** Start after the first entry this matches; from the top of the file when absent. */
   readonly after?: Cursor
   /** Stop before the first later entry this matches; at the end of the file when absent. */
   readonly until?: Cursor
}

/**
 * Builds a trail from a Claude Code transcript JSONL (ref-cc-hooks §8). The format is
 * undocumented and changes between versions: unknown entry and block types are ignored, and
 * anything malformed is reported in `issues` rather than thrown.
 *
 * Attachments are never read; among them are the peer packages this harness injected.
 */
export function ccTrail(jsonl: string, span: Span = {}): Trail {
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

   const items: TrailItem[] = []
   for (const { line, entry } of entries.slice(start, end)) {
      if (entry.isSidechain === true || entry.isMeta === true) continue
      const converted =
         entry.type === "assistant"
            ? assistantItems(entry)
            : entry.type === "user"
              ? userItems(entry)
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

/** A user entry is either the human's prompt or a batch of tool results. */
function userItems(entry: Record<string, unknown>): TrailItem[] | undefined {
   const content = isRecord(entry.message) ? entry.message.content : undefined
   if (typeof content === "string") return [{ kind: "prompt", text: content }]
   if (!Array.isArray(content)) return undefined
   const items: TrailItem[] = []
   const promptParts: string[] = []
   for (const block of content) {
      if (!isRecord(block)) return undefined
      if (block.type === "tool_result") {
         if (typeof block.tool_use_id !== "string") return undefined
         items.push({
            kind: "result",
            id: block.tool_use_id,
            text: contentText(block.content),
            isError: block.is_error === true,
         })
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
