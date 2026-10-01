import type { SideView, ViewEntry } from "./coherence.ts"
import {
   type TrailItem,
   type TrailReport,
   type TrailResult,
   withoutSupersededNotices,
} from "./trail.ts"
import { isRecord } from "./validate.ts"

export interface CcViewOptions {
   /** the main transcript's own path, to find subagent transcripts beside it */
   readonly transcriptPath?: string
   readonly exists?: (path: string) => boolean
   /** the live branch runs back from here, e.g. a prompt CC just wrote; default: the newest entry */
   readonly leaf?: string
   /** to recognise the attachments holding texts we delivered */
   readonly hash?: (text: string) => string
}

type Entry = Record<string, unknown>
interface Line {
   readonly line: number
   readonly entry: Entry
}

// undocumented, version-volatile format (ref-cc-hooks §8): ignore the unknown, report the malformed.
// attachments never become items: they include the peer packages this harness injected
export function ccView(jsonl: string, options: CcViewOptions = {}): SideView {
   const parseIssues: { line: number; issue: string }[] = []
   const entries = parseLines(jsonl, parseIssues)
   const byUuid = new Map<string, number>()
   entries.forEach(({ entry }, i) => {
      if (typeof entry.uuid === "string") byUuid.set(entry.uuid, i)
   })
   const leaf = options.leaf === undefined ? undefined : byUuid.get(options.leaf)
   const branch = liveBranch(entries, byUuid, leaf)
   const subagents = new Subagents(entries, options)

   const converted = new Map<number, TrailItem[] | undefined>()
   const itemsAt = (i: number) => {
      if (!converted.has(i)) {
         const entry = entries[i]?.entry ?? {}
         converted.set(
            i,
            entry.type === "assistant"
               ? assistantItems(entry)
               : entry.type === "user"
                 ? userItems(entry, subagents)
                 : [],
         )
      }
      return converted.get(i)
   }

   const indices = [...branch.live]
      .sort((a, b) => a - b)
      .filter((i) => {
         const entry = entries[i]?.entry
         return typeof entry?.uuid === "string" && entry.isSidechain !== true
      })
   const live = indices.map((i): ViewEntry => {
      const entry = entries[i]?.entry ?? {}
      const items = itemsAt(i) ?? []
      const first = items[0]
      const texts = items.flatMap((item) => (item.kind === "text" ? [item.text] : []))
      return {
         id: entry.uuid as string,
         content: items.length > 0 || itemsAt(i) === undefined,
         startsTurn: first?.kind === "prompt",
         ...(first?.kind === "prompt" ? { prompt: first.text } : {}),
         ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
         carries: carried(entry, options.hash),
      }
   })

   return {
      live,
      parent(id) {
         const i = byUuid.get(id)
         if (i === undefined) return undefined
         const parent =
            entries[i]?.entry.parentUuid ?? entries[i]?.entry.logicalParentUuid
         return typeof parent === "string" ? parent : null
      },
      trail(after, through) {
         const from = after === undefined ? -1 : live.findIndex((e) => e.id === after)
         const to =
            through === undefined
               ? live.length - 1
               : live.findIndex((e) => e.id === through)
         const items: TrailItem[] = []
         const issues: string[] = []
         const span = indices.slice(from + 1, to + 1)
         for (const i of span) {
            const found = itemsAt(i)
            if (found === undefined)
               issues.push(
                  `line ${entries[i]?.line}: unreadable ${String(entries[i]?.entry.type)} entry`,
               )
            else items.push(...found)
         }
         const first = entries[span[0] ?? -1]?.line ?? Number.POSITIVE_INFINITY
         const last = entries[span.at(-1) ?? -1]?.line ?? Number.NEGATIVE_INFINITY
         for (const { line, issue } of parseIssues)
            if (line > first && line < last) issues.push(`line ${line}: ${issue}`)
         return { items: withoutSupersededNotices(items), issues }
      },
   }
}

function carried(entry: Entry, hash: ((text: string) => string) | undefined): string[] {
   const attachment = isRecord(entry.attachment) ? entry.attachment : {}
   if (hash === undefined || attachment.type !== "hook_additional_context") return []
   const content = Array.isArray(attachment.content) ? attachment.content : []
   return content.flatMap((c) => (typeof c === "string" ? [hash(c)] : []))
}

function parseLines(jsonl: string, issues: { line: number; issue: string }[]): Line[] {
   const entries: Line[] = []
   jsonl.split("\n").forEach((raw, i) => {
      const line = raw.trim()
      if (line === "") return
      try {
         const entry: unknown = JSON.parse(line)
         if (isRecord(entry)) entries.push({ line: i + 1, entry })
         else issues.push({ line: i + 1, issue: "not an object" })
      } catch {
         issues.push({ line: i + 1, issue: "not JSON" })
      }
   })
   return entries
}

interface Branch {
   /** the parent chain back from the leaf, plus the side branches of its parallel tool calls */
   readonly live: ReadonlySet<number>
}

// rewinds leave abandoned branches in the file: walk the parent chain back from the leaf. parallel
// tool calls hang off it as side branches; their message ids pull them and their results back in
function liveBranch(
   entries: readonly Line[],
   byUuid: ReadonlyMap<string, number>,
   leaf: number | undefined,
): Branch {
   if (!entries.some(({ entry }) => typeof entry.parentUuid === "string")) {
      const end = leaf ?? entries.length - 1
      return { live: new Set([...entries.keys()].filter((i) => i <= end)) }
   }
   const parent = (i: number) => {
      const entry = entries[i]?.entry
      const id = entry?.parentUuid ?? entry?.logicalParentUuid
      return typeof id === "string" ? byUuid.get(id) : undefined
   }

   const chain = new Set<number>()
   const messages = new Set<string>()
   for (
      let i = leaf ?? newestChained(entries);
      i !== undefined && !chain.has(i);
      i = parent(i)
   ) {
      chain.add(i)
      const id = messageId(entries[i]?.entry)
      if (id !== undefined) messages.add(id)
   }
   const end = Math.max(-1, ...chain)

   const live = new Set(chain)
   const calls = new Set<string>()
   for (let i = 0; i <= end; i++) {
      const entry = entries[i]?.entry
      const id = messageId(entry)
      if (id === undefined || !messages.has(id)) continue
      live.add(i)
      for (const block of contentBlocks(entry))
         if (block.type === "tool_use" && typeof block.id === "string")
            calls.add(block.id)
   }
   for (let i = 0; i <= end; i++) {
      const entry = entries[i]?.entry
      if (live.has(i) || entry?.type !== "user") continue
      const results = contentBlocks(entry).filter((b) => b.type === "tool_result")
      if (
         results.length > 0 &&
         results.every(
            (b) => typeof b.tool_use_id === "string" && calls.has(b.tool_use_id),
         )
      )
         live.add(i)
   }
   return { live }
}

function newestChained(entries: readonly Line[]): number | undefined {
   for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]?.entry
      if (
         typeof entry?.uuid === "string" &&
         entry.isSidechain !== true &&
         ["user", "assistant", "system", "attachment"].includes(String(entry.type))
      )
         return i
   }
   return undefined
}

function messageId(entry: Entry | undefined): string | undefined {
   if (entry?.type !== "assistant" || !isRecord(entry.message)) return undefined
   return typeof entry.message.id === "string" ? entry.message.id : undefined
}

function contentBlocks(entry: Entry | undefined): Record<string, unknown>[] {
   const content = isRecord(entry?.message) ? entry.message.content : undefined
   return Array.isArray(content) ? content.filter(isRecord) : []
}

function assistantItems(entry: Entry): TrailItem[] | undefined {
   const message = isRecord(entry.message) ? entry.message : {}
   const content = message.content
   if (message.model === "<synthetic>") {
      if (entry.isApiErrorMessage !== true) return []
      const detail = Array.isArray(content) ? contentText(content) : String(content ?? "")
      return [{ kind: "halt", why: "error", detail }]
   }
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

const INTERRUPTED = /^\[Request interrupted by user/

function userItems(entry: Entry, subagents: Subagents): TrailItem[] | undefined {
   const content = isRecord(entry.message) ? entry.message.content : undefined
   const origin = isRecord(entry.origin) ? entry.origin : {}
   if (entry.isCompactSummary === true) return []
   // hand-backs are meta too; every other meta entry (skill bodies, reminders) is the harness's
   if (origin.kind === "peer") return handBack(origin, content, subagents)
   if (entry.isMeta === true) return []
   if (
      typeof content === "string" &&
      (origin.kind === "task-notification" ||
         content.trimStart().startsWith("<task-notification>"))
   )
      return [taskNotification(content, subagents)]
   if (typeof content === "string")
      return [
         INTERRUPTED.test(content)
            ? { kind: "halt", why: "interrupted" }
            : { kind: "prompt", text: content },
      ]
   if (!Array.isArray(content)) return undefined

   const meta = isRecord(entry.toolUseResult) ? entry.toolUseResult : {}
   const items: TrailItem[] = []
   const promptParts: string[] = []
   for (const block of content) {
      if (!isRecord(block)) return undefined
      if (block.type === "tool_result") {
         if (typeof block.tool_use_id !== "string") return undefined
         items.push(toolResult(block.tool_use_id, block, meta, subagents))
      } else if (block.type === "text" && typeof block.text === "string") {
         if (INTERRUPTED.test(block.text))
            items.push({ kind: "halt", why: "interrupted" })
         else promptParts.push(block.text)
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
   subagents: Subagents,
): TrailResult {
   const blocks = Array.isArray(block.content) ? block.content.filter(isRecord) : []
   const images = blocks.filter((b) => b.type === "image").length
   if (meta.isAsync === true || meta.status === "async_launched") {
      const transcript = subagents.transcriptForCall(id)
      const started: TrailResult = {
         kind: "result",
         id,
         text: "",
         isError: false,
         background: true,
      }
      return transcript === undefined ? started : { ...started, transcript }
   }

   const text = images > 0 ? textBlocks(blocks) : contentText(block.content)
   let result: TrailResult = {
      kind: "result",
      id,
      text,
      isError: block.is_error === true,
   }
   if (images > 0)
      result = { ...result, media: images === 1 ? "1 image" : `${images} images` }

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
   return result
}

// "…<agent-message from=…>\n<frame>\n  <report>…": report lines are indented, framing isn't
function handBack(
   origin: Record<string, unknown>,
   content: unknown,
   subagents: Subagents,
): TrailItem[] {
   const raw = typeof content === "string" ? content : contentText(content)
   const agent = typeof origin.from === "string" ? origin.from : undefined
   const inner =
      /<agent-message\b[^>]*>\n?([\s\S]*)\n?<\/agent-message>/.exec(raw)?.[1] ?? raw
   const lines = inner.split("\n")
   const first = lines.findIndex((l) => l.trim() !== "" && /^\s/.test(l))
   const body =
      first >= 0 && lines.slice(first).every((l) => l.trim() === "" || /^\s/.test(l))
         ? dedent(lines.slice(first))
         : inner.trim()
   return [subagents.report(agent, undefined, { text: body })]
}

// task-id is an agent id, or a background shell's task id
function taskNotification(content: string, subagents: Subagents): TrailItem {
   const tag = (name: string) =>
      new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)?.[1]?.trim()
   const status = tag("status")
   const summary = tag("summary")
   const task = tag("task-id")
   const shell = subagents.shellCall(task)
   if (shell !== undefined) {
      const said = [summary, tag("result")].filter((t) => t !== undefined)
      return {
         kind: "result",
         id: tag("tool-use-id") ?? shell,
         text: said.join("\n"),
         isError: status !== undefined && status !== "completed",
      }
   }
   return subagents.report(task, tag("tool-use-id"), {
      text: tag("result") ?? "",
      notice: true,
      ...(status === undefined ? {} : { status }),
      ...(summary === undefined ? {} : { summary }),
   })
}

interface Started {
   readonly call: string
   readonly label: string | undefined
   readonly shell: boolean
}

// scans the whole file: reports arrive spans after their spawn
class Subagents {
   readonly #byAgent = new Map<string, Started>()
   readonly #agentByCall = new Map<string, string>()
   readonly #options: CcViewOptions

   constructor(entries: readonly Line[], options: CcViewOptions) {
      this.#options = options
      const labels = new Map<string, string | undefined>()
      for (const { entry } of entries) {
         if (entry.isSidechain === true) continue
         for (const block of contentBlocks(entry)) {
            if (block.type === "tool_use" && typeof block.id === "string")
               labels.set(block.id, label(block.input))
            if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
               continue
            const meta = isRecord(entry.toolUseResult) ? entry.toolUseResult : {}
            const agent = meta.agentId ?? meta.backgroundTaskId
            if (typeof agent !== "string") continue
            this.#byAgent.set(agent, {
               call: block.tool_use_id,
               label: labels.get(block.tool_use_id),
               shell: typeof meta.agentId !== "string",
            })
            this.#agentByCall.set(block.tool_use_id, agent)
         }
      }
   }

   report(
      agent: string | undefined,
      call: string | undefined,
      found: { text: string; status?: string; summary?: string; notice?: true },
   ): TrailReport {
      const started = agent === undefined ? undefined : this.#byAgent.get(agent)
      const id = call ?? started?.call
      const transcript = agent === undefined ? undefined : this.#transcript(agent)
      return {
         kind: "report",
         id,
         agent,
         label: started?.label ?? found.summary,
         text: found.text,
         ...(found.status === undefined ? {} : { status: found.status }),
         ...(transcript === undefined ? {} : { transcript }),
         ...(found.notice === undefined ? {} : { notice: found.notice }),
      }
   }

   shellCall(task: string | undefined): string | undefined {
      const started = task === undefined ? undefined : this.#byAgent.get(task)
      return started?.shell === true ? started.call : undefined
   }

   transcriptForCall(call: string): string | undefined {
      const agent = this.#agentByCall.get(call)
      return agent === undefined ? undefined : this.#transcript(agent)
   }

   // <session>.jsonl → <session>/subagents/agent-<agentId>.jsonl (observed on 2.1.286)
   #transcript(agent: string): string | undefined {
      const main = this.#options.transcriptPath
      if (main === undefined || !main.endsWith(".jsonl")) return undefined
      const path = `${main.slice(0, -".jsonl".length)}/subagents/agent-${agent}.jsonl`
      return (this.#options.exists?.(path) ?? true) ? path : undefined
   }
}

function label(input: unknown): string | undefined {
   if (!isRecord(input)) return undefined
   const text = input.description ?? input.command
   return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined
}

function dedent(lines: readonly string[]): string {
   const indents = lines
      .filter((l) => l.trim() !== "")
      .map((l) => /^\s*/.exec(l)?.[0].length ?? 0)
   const cut = Math.min(...indents)
   return lines
      .map((l) => l.slice(Math.min(cut, l.length)))
      .join("\n")
      .trim()
}

function textBlocks(blocks: readonly Record<string, unknown>[]): string {
   return blocks
      .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
      .join("\n")
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
