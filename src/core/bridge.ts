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

/**
 * Drops what B already has: text, prompts, calls and results it was sent before, so a cut that
 * lands early (a lagging transcript at Stop, a queued prompt) never repeats A to B.
 */
export function withoutDelivered(
   trail: Trail,
   delivered: Set<string>,
   hash: (text: string) => string,
): Trail {
   const key = (item: TrailItem): string | undefined => {
      switch (item.kind) {
         case "text":
            return `t:${hash(item.text.trim())}`
         case "prompt":
            return `p:${hash(item.text.trim())}`
         case "call":
            return item.id === undefined ? undefined : `c:${item.id}`
         case "result":
            return item.id === undefined ? undefined : `r:${item.id}`
         case "report":
            return `R:${item.id ?? hash(item.text)}`
         default:
            return undefined
      }
   }
   const keys = trail.items.map(key)
   const items = trail.items.filter((_, i) => {
      const k = keys[i]
      return k === undefined || !delivered.has(k)
   })
   for (const k of keys) if (k !== undefined) delivered.add(k)
   return { ...trail, items }
}

export function promptKey(prompt: string, hash: (text: string) => string): string {
   return `p:${hash(prompt.trim())}`
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
