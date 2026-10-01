import type { Trail, TrailItem } from "./trail.ts"
import { isRecord } from "./validate.ts"

/**
 * Builds a trail from pi `AgentMessage`s (ref-pi-api §3). Typed as `unknown` because other
 * extensions can add message roles, and a trail is worth more partial than not at all.
 *
 * User messages are skipped: in B's session every one is the extension's own injection of A's
 * package and the human's prompt, which A already has.
 */
export function piTrail(messages: readonly unknown[]): Trail {
   const items: TrailItem[] = []
   const issues: string[] = []
   messages.forEach((message, i) => {
      if (!isRecord(message) || typeof message.role !== "string") {
         issues.push(`message ${i}: not a message`)
         return
      }
      if (message.role === "assistant") {
         if (!Array.isArray(message.content)) {
            issues.push(`message ${i}: assistant content is not an array`)
            return
         }
         message.content.forEach((block, j) => {
            const item = assistantBlock(block)
            if (item === "skip") return
            if (item === undefined) issues.push(`message ${i} block ${j}: unreadable`)
            else items.push(item)
         })
      } else if (message.role === "toolResult") {
         const id = message.toolCallId
         if (typeof id !== "string" || !Array.isArray(message.content)) {
            issues.push(`message ${i}: unreadable tool result`)
            return
         }
         items.push({
            kind: "result",
            id,
            text: message.content.map(resultText).join("\n"),
            isError: message.isError === true,
         })
      }
   })
   return { items, issues }
}

function assistantBlock(block: unknown): TrailItem | "skip" | undefined {
   if (!isRecord(block)) return undefined
   switch (block.type) {
      case "text":
         return typeof block.text === "string"
            ? { kind: "text", text: block.text }
            : undefined
      case "toolCall":
         return typeof block.id === "string" && typeof block.name === "string"
            ? { kind: "call", id: block.id, name: block.name, input: block.arguments }
            : undefined
      default:
         return "skip"
   }
}

function resultText(block: unknown): string {
   if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text
   }
   return isRecord(block) && block.type === "image" ? "[image]" : "[unreadable content]"
}
