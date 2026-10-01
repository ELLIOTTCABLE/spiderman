import type { SideView, ViewEntry } from "./coherence.ts"
import { BX_MARK } from "./elision.ts"
import {
   type Trail,
   type TrailItem,
   type TrailReport,
   type TrailResult,
   withoutSupersededNotices,
} from "./trail.ts"
import { isRecord } from "./validate.ts"

interface Started {
   readonly call: string
   readonly label: string | undefined
}

export interface PiViewOptions {
   readonly parent: (id: string) => string | null | undefined
   readonly carrier: (text: string) => string
   readonly delivered: (hash: string) => Delivered | undefined
   /** entries never to deliver, e.g. an elision exchange a failed rewind left behind */
   readonly never: ReadonlySet<string>
}

export interface Delivered {
   readonly prompts: readonly string[]
   readonly asked: boolean
}

interface Classified {
   readonly entry: ViewEntry
   readonly as:
      | { readonly kind: "message"; readonly message: unknown }
      | { readonly kind: "delivery"; readonly delivered: Delivered }
      | { readonly kind: "bx" }
      | { readonly kind: "none" }
}

export function piView(branch: readonly unknown[], options: PiViewOptions): SideView {
   const classified = branch.flatMap((raw): Classified[] => {
      if (!isRecord(raw) || typeof raw.id !== "string") return []
      const id = raw.id
      const none = (entry: Partial<ViewEntry> = {}): Classified => ({
         entry: { id, content: false, startsTurn: false, carries: [], ...entry },
         as: { kind: "none" },
      })
      const message = sessionMessage(raw)
      if (message === undefined || options.never.has(id)) return [none()]
      if (message.role === "user") {
         const text = messageText(message.content)
         const hash = options.carrier(text)
         const delivered = options.delivered(hash)
         if (delivered !== undefined)
            return [
               {
                  entry: { id, content: false, startsTurn: true, carries: [hash] },
                  as: { kind: "delivery", delivered },
               },
            ]
         if (text.startsWith(BX_MARK)) return [{ ...none(), as: { kind: "bx" } }]
         return [
            {
               entry: { id, content: true, startsTurn: true, prompt: text, carries: [] },
               as: { kind: "message", message },
            },
         ]
      }
      const text =
         message.role === "assistant" && Array.isArray(message.content)
            ? message.content
                 .flatMap((b) =>
                    isRecord(b) && b.type === "text" && typeof b.text === "string"
                       ? [b.text]
                       : [],
                 )
                 .join("\n")
            : ""
      return [
         {
            entry: {
               id,
               content: true,
               startsTurn: false,
               ...(text === "" ? {} : { text }),
               carries: [],
            },
            as: { kind: "message", message },
         },
      ]
   })
   const live = classified.map((c) => c.entry)

   return {
      live,
      parent: options.parent,
      trail(ids) {
         const wanted = new Set(ids)
         const items: TrailItem[] = []
         const issues: string[] = []
         let segment: unknown[] = []
         let turn: TrailItem | undefined
         let inBx = false
         const flush = () => {
            const read = piTrail(segment)
            if (read.items.length > 0 && turn !== undefined) items.push(turn)
            items.push(...read.items)
            issues.push(...read.issues)
            segment = []
            turn = undefined
         }
         for (const { entry, as } of classified) {
            if (as.kind === "delivery" || as.kind === "bx") {
               flush()
               inBx = as.kind === "bx"
               if (as.kind === "delivery")
                  turn = {
                     kind: "turn",
                     prompts: as.delivered.prompts,
                     ...(as.delivered.asked ? { asked: true } : {}),
                  }
            } else if (as.kind === "message") {
               const user = isRecord(as.message) && as.message.role === "user"
               if (user) inBx = false
               if (!inBx && wanted.has(entry.id)) segment.push(as.message)
            }
         }
         flush()
         return { items, issues }
      },
   }
}

function sessionMessage(
   entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
   if (entry.type === "message" && isRecord(entry.message)) return entry.message
   // pi-side subagent reports arrive as custom messages
   if (entry.type === "custom_message" && entry.customType === "subagent-notification")
      return {
         role: "custom",
         customType: entry.customType,
         content: entry.content,
         details: entry.details,
      }
   return undefined
}

export function messageText(content: unknown): string {
   if (typeof content === "string") return content
   return Array.isArray(content)
      ? content
           .flatMap((b) =>
              isRecord(b) && b.type === "text" && typeof b.text === "string"
                 ? [b.text]
                 : [],
           )
           .join("\n")
      : ""
}

// `unknown`: other extensions add message roles
export function piTrail(messages: readonly unknown[]): Trail {
   const items: TrailItem[] = []
   const issues: string[] = []
   const agents = new Map<string, Started>()
   const becameReports = new Set<string>()
   messages.forEach((message, i) => {
      if (!isRecord(message) || typeof message.role !== "string") {
         issues.push(`message ${i}: not a message`)
         return
      }
      if (message.role === "user") {
         items.push({ kind: "prompt", text: messageText(message.content), direct: true })
      } else if (message.role === "assistant") {
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
         const halt = halted(message)
         if (halt !== undefined) items.push(halt)
      } else if (message.role === "toolResult") {
         const id = message.toolCallId
         if (typeof id !== "string" || !Array.isArray(message.content)) {
            issues.push(`message ${i}: unreadable tool result`)
            return
         }
         const details = isRecord(message.details) ? message.details : {}
         const blocks = message.content.filter(isRecord)
         const images = blocks.filter((b) => b.type === "image").length
         const text = (images > 0 ? blocks.filter((b) => b.type !== "image") : blocks)
            .map(resultText)
            .join("\n")

         if (typeof details.agentId === "string" && details.status === "background") {
            agents.set(details.agentId, {
               call: id,
               label:
                  typeof details.description === "string"
                     ? details.description
                     : undefined,
            })
            items.push({ kind: "result", id, text: "", isError: false, background: true })
            return
         }
         const report =
            message.toolName === "get_subagent_result" && message.isError !== true
               ? fetchedReport(text, agents)
               : undefined
         if (report !== undefined) {
            becameReports.add(id)
            items.push(report)
            return
         }
         const result: TrailResult = {
            kind: "result",
            id,
            text,
            isError: message.isError === true,
            ...(images > 0
               ? { media: images === 1 ? "1 image" : `${images} images` }
               : {}),
         }
         items.push(withSavedOutput(result, details))
      } else if (
         message.role === "custom" &&
         message.customType === "subagent-notification"
      ) {
         items.push(notification(message, agents))
      }
   })
   const kept = items.filter(
      (item) =>
         item.kind !== "call" || item.id === undefined || !becameReports.has(item.id),
   )
   return { items: withoutSupersededNotices(kept), issues }
}

function halted(message: Record<string, unknown>): TrailItem | undefined {
   if (message.stopReason === "aborted") return { kind: "halt", why: "aborted" }
   if (message.stopReason !== "error") return undefined
   return typeof message.errorMessage === "string" && message.errorMessage !== ""
      ? { kind: "halt", why: "error", detail: message.errorMessage }
      : { kind: "halt", why: "error" }
}

// pi's bash keeps only the tail in the result; the full output is in a temp file
function withSavedOutput(
   result: TrailResult,
   details: Record<string, unknown>,
): TrailResult {
   if (typeof details.fullOutputPath !== "string") return result
   const path = details.fullOutputPath
   const total = isRecord(details.truncation) ? details.truncation.totalLines : undefined
   return {
      ...result,
      saved: typeof total === "number" ? { path, size: `${total} lines` } : { path },
   }
}

// pi-subagents: "Agent: <id>\nType: … | Status: <s> | …\nDescription: <d>\n\n<report>"
function fetchedReport(
   text: string,
   agents: ReadonlyMap<string, Started>,
): TrailReport | undefined {
   const split = text.indexOf("\n\n")
   const header = split === -1 ? text : text.slice(0, split)
   const agent = /^Agent: (\S+)/.exec(header)?.[1]
   if (agent === undefined) return undefined
   const status = /\bStatus: ([^|\n]+)/.exec(header)?.[1]?.trim()
   const started = agents.get(agent)
   return {
      kind: "report",
      id: started?.call,
      agent,
      label: started?.label ?? /^Description: (.*)$/m.exec(header)?.[1]?.trim(),
      text: split === -1 ? "" : text.slice(split + 2).trim(),
      ...(status === undefined ? {} : { status }),
   }
}

function notification(
   message: Record<string, unknown>,
   agents: ReadonlyMap<string, Started>,
): TrailReport {
   const content =
      typeof message.content === "string"
         ? message.content
         : Array.isArray(message.content)
           ? message.content.map(resultText).join("\n")
           : ""
   const details = isRecord(message.details) ? message.details : {}
   const tag = (name: string) => {
      const raw = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)?.[1]?.trim()
      return raw === undefined ? undefined : unescapeXml(raw)
   }
   const agent =
      tag("task-id") ?? (typeof details.id === "string" ? details.id : undefined)
   const started = agent === undefined ? undefined : agents.get(agent)
   const transcript =
      /Full transcript available at: (.+)$/m.exec(content)?.[1]?.trim() ??
      (typeof details.outputFile === "string" ? details.outputFile : undefined)
   const status = tag("status")
   return {
      kind: "report",
      id: tag("tool-use-id") ?? started?.call,
      agent,
      label:
         started?.label ??
         (typeof details.description === "string" ? details.description : tag("summary")),
      text: tag("result") ?? "",
      notice: true,
      ...(status === undefined ? {} : { status }),
      ...(transcript === undefined ? {} : { transcript }),
   }
}

// pi-subagents escapes the report it wraps in tags
function unescapeXml(text: string): string {
   return text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&")
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
