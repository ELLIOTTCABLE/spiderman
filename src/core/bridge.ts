import { splitBlocks } from "./blocks.ts"
import { CHUNK_CHARS, chunkPackage } from "./chunk.ts"
import type { PeerPackage, Segment } from "./package.ts"
import type { Trail, TrailItem } from "./trail.ts"
import { isRecord } from "./validate.ts"

export function bMessage(
   aPackage: string | undefined,
   prompts: readonly string[],
): string {
   const parts = aPackage === undefined ? [] : [aPackage]
   for (const prompt of prompts) parts.push(`[the human's message]\n${prompt}`)
   return parts.join("\n\n")
}

/** At Stop the transcript may lag; `last_assistant_message` is A's final text for certain. */
export function reconcileWithLast(trail: Trail, last: string | undefined): Trail {
   const wanted = last?.trim()
   if (wanted === undefined || wanted === "") return trail
   const present = trail.items.some((i) => i.kind === "text" && i.text.trim() === wanted)
   return present
      ? trail
      : { ...trail, items: [...trail.items, { kind: "text", text: last ?? "" }] }
}

function entries(jsonl: string): Record<string, unknown>[] {
   return jsonl.split("\n").flatMap((line) => {
      try {
         const entry: unknown = JSON.parse(line)
         return isRecord(entry) ? [entry] : []
      } catch {
         return []
      }
   })
}

/** A cut on a conversation entry: hook and system lines can sit off the parent chain. */
export function lastMessageUuid(jsonl: string): string | undefined {
   return entries(jsonl).findLast(
      (e) =>
         (e.type === "user" || e.type === "assistant") &&
         e.isSidechain !== true &&
         typeof e.uuid === "string",
   )?.uuid as string | undefined
}

function isHumanPromptEntry(entry: Record<string, unknown>): boolean {
   if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true)
      return false
   const origin = isRecord(entry.origin) ? entry.origin.kind : undefined
   if (origin !== undefined && origin !== "human") return false
   const content = isRecord(entry.message) ? entry.message.content : undefined
   if (typeof content === "string") return !content.trimStart().startsWith("<")
   return (
      Array.isArray(content) &&
      content.every((b) => !isRecord(b) || b.type !== "tool_result")
   )
}

/**
 * Where A's last completed turn starts, before `untilPromptId`'s entry: a newly paired B gets
 * that one turn, not A's whole history. "top" when it starts the file.
 */
export function lastTurnStart(
   jsonl: string,
   untilPromptId: string | undefined,
): { readonly uuid: string } | "top" | undefined {
   const all = entries(jsonl)
   const until =
      untilPromptId === undefined
         ? -1
         : all.findIndex((e) => e.promptId === untilPromptId)
   const before = until === -1 ? all : all.slice(0, until)
   const prompt = before.findLastIndex(isHumanPromptEntry)
   if (prompt === -1) return undefined
   const previous = before.slice(0, prompt).findLast((e) => typeof e.uuid === "string")
   return previous === undefined ? "top" : { uuid: previous.uuid as string }
}

/** What B already has, so a slice that starts early never repeats it. */
export interface BLedger {
   /** calls, results and reports B was sent, by id */
   readonly ids: ReadonlySet<string>
   /** human messages sent to B directly; each suppresses one prompt item, once */
   readonly prompts: readonly string[]
   /** A's final text, appended from `last_assistant_message` while the transcript lagged */
   readonly reconciled: string | undefined
}

export const emptyLedger: BLedger = { ids: new Set(), prompts: [], reconciled: undefined }

/**
 * Suppresses only what B provably has: ids it was sent, a human message it got directly, and
 * the one text item a lagging Stop made us send early. Repeated wording is never suppressed:
 * failures cost reading time, never information.
 */
export function withoutDelivered(
   trail: Trail,
   ledger: BLedger,
): { readonly trail: Trail; readonly ledger: BLedger } {
   const ids = new Set(ledger.ids)
   const prompts = [...ledger.prompts]
   let reconciled = ledger.reconciled?.trimEnd()
   const idOf = (item: TrailItem) =>
      item.kind === "call" || item.kind === "result" || item.kind === "report"
         ? item.id === undefined
            ? undefined
            : `${item.kind}:${item.id}`
         : undefined
   const items = trail.items.filter((item) => {
      if (
         item.kind === "text" &&
         reconciled !== undefined &&
         item.text.trimEnd() === reconciled
      ) {
         reconciled = undefined
         return false
      }
      if (item.kind === "prompt") {
         const at = prompts.indexOf(item.text.trim())
         if (at !== -1) {
            prompts.splice(at, 1)
            return false
         }
      }
      const id = idOf(item)
      if (id === undefined) return true
      if (ids.has(id)) return false
      ids.add(id)
      return true
   })
   return { trail: { ...trail, items }, ledger: { ids, prompts, reconciled: undefined } }
}

/** Several B answers in one delivery: one package, a short heading per answered prompt. */
export function sectioned(
   turns: readonly { readonly pkg: PeerPackage; readonly prompt: string }[],
): PeerPackage {
   const [first] = turns
   const last = turns.at(-1)
   if (first === undefined || last === undefined) throw new Error("no turns")
   if (turns.length === 1) return first.pkg
   const segments: Segment[] = []
   const opening = first.pkg.segments[0]
   if (opening !== undefined) segments.push(opening)
   turns.forEach(({ pkg, prompt }, i) => {
      const quoted = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt
      segments.push({
         kind: "frame",
         text: `[peer answer ${i + 1} of ${turns.length}, to the human's message "${quoted.replace(/\s+/g, " ")}"]`,
      })
      segments.push(...pkg.segments.slice(1, -1))
   })
   const closing = last.pkg.segments.at(-1)
   if (closing !== undefined) segments.push(closing)
   return {
      segments,
      interactions: turns.flatMap((t) => t.pkg.interactions),
      memory: last.pkg.memory,
   }
}

export function dedupeKey(
   sessionId: string,
   promptId: string | undefined,
   text: string,
   hash: (text: string) => string,
): string {
   return `${sessionId}|${promptId ?? ""}|${hash(text)}`
}

/** B's answer as the human reads it: the text of its last assistant message that has any. */
export function bAnswerText(messages: readonly unknown[]): string {
   for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (
         !isRecord(message) ||
         message.role !== "assistant" ||
         !Array.isArray(message.content)
      ) {
         continue
      }
      const text = message.content
         .flatMap((b) =>
            isRecord(b) && b.type === "text" && typeof b.text === "string"
               ? [b.text]
               : [],
         )
         .join("\n\n")
      if (text.trim() !== "") return text
   }
   return ""
}

export function bOutcome(
   messages: readonly unknown[],
): "completed" | "error" | "aborted" {
   const last = [...messages].reverse().find((m) => isRecord(m) && m.role === "assistant")
   const reason = isRecord(last) ? last.stopReason : undefined
   return reason === "error" ? "error" : reason === "aborted" ? "aborted" : "completed"
}

export function displayChunks(
   rendered: string,
   options: {
      readonly maxChunks: number
      readonly fullPath: string
      readonly note?: string
   },
): string[] {
   const head = `[peer answer] full text: ${options.fullPath}${options.note ? ` (${options.note})` : ""}`
   const segments: Segment[] = [
      { kind: "frame", text: head },
      ...splitBlocks(rendered).map((b): Segment => ({ kind: "prose", text: b.raw })),
   ]
   return chunkPackage(
      { segments, interactions: [] },
      { maxChunks: options.maxChunks, maxChars: CHUNK_CHARS, fullPath: options.fullPath },
   )
}
