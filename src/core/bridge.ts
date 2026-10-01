import { isAbsolute, relative, resolve } from "node:path"
import { splitBlocks } from "./blocks.ts"
import { CHUNK_CHARS, chunkPackage } from "./chunk.ts"
import type { Segment } from "./package.ts"
import type { Trail } from "./trail.ts"
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

export function plainPaths(
   prompt: string,
   cwd: string,
   exists: (path: string) => boolean,
): string {
   return prompt.replace(/(^|\s)@(\S+)/g, (whole, space: string, token: string) => {
      for (const candidate of [token, token.replace(/[.,;:!?)\]}'"]+$/, "")]) {
         const path = candidate.replace(/#L\d+(?:-\d+)?$/, "")
         if (path === "") continue
         const full = resolve(cwd, path)
         const inside = relative(cwd, full)
         if (inside.startsWith("..") || isAbsolute(inside) || !exists(full)) continue
         return `${space}${candidate}${token.slice(candidate.length)}`
      }
      return whole
   })
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
