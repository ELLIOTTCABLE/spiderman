import {
   type Trail,
   type TrailItem,
   type TrailReport,
   type TrailResult,
   withoutSupersededNotices,
} from "./trail.ts"
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

type Entry = Record<string, unknown>
interface Line {
   readonly line: number
   readonly entry: Entry
}

// undocumented, version-volatile format (ref-cc-hooks §8): ignore the unknown, report the malformed
// attachments are never read: they include the peer packages this harness injected
export function ccTrail(
   jsonl: string,
   span: Span = {},
   options: CcTrailOptions = {},
): Trail {
   const issues: string[] = []
   const entries = parseLines(jsonl, issues)

   const { after, until } = span
   const start =
      after === undefined ? -1 : entries.findIndex(({ entry }) => matches(entry, after))
   if (after !== undefined && start === -1)
      return { items: [], issues: [...issues, "start position not found"] }
   let end = entries.length
   if (until !== undefined) {
      const at = entries.findIndex(({ entry }, i) => i > start && matches(entry, until))
      if (at !== -1) end = at
   }
   const branch = liveBranch(entries, end)
   const subagents = new Subagents(entries, options)
   const items: TrailItem[] = []
   let from = start
   if (start !== -1 && !branch.live.has(start)) {
      const rewind = rewound(entries, start, branch)
      if (rewind !== undefined) {
         from = rewind.fork
         items.push(
            rewind.withdrawn === undefined
               ? { kind: "rewind" }
               : { kind: "rewind", withdrawn: rewind.withdrawn },
         )
      }
   }
   for (let i = from + 1; i < end; i++) {
      const at = entries[i]
      if (at === undefined || !branch.live.has(i)) continue
      const { line, entry } = at
      if (entry.isSidechain === true) continue
      const converted =
         entry.type === "assistant"
            ? assistantItems(entry)
            : entry.type === "user"
              ? userItems(entry, subagents)
              : []
      if (converted === undefined)
         issues.push(`line ${line}: unreadable ${String(entry.type)} entry`)
      else items.push(...converted)
   }
   return { items: withoutSupersededNotices(items), issues }
}

function parseLines(jsonl: string, issues: string[]): Line[] {
   const entries: Line[] = []
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
   return entries
}

function matches(entry: Entry, cursor: Cursor): boolean {
   return "uuid" in cursor
      ? entry.uuid === cursor.uuid
      : entry.promptId === cursor.promptId
}

interface Branch {
   /** the parent chain back from the newest entry before `end` */
   readonly chain: ReadonlySet<number>
   /** the chain plus the side branches of its parallel tool calls */
   readonly live: ReadonlySet<number>
   readonly parent: (index: number) => number | undefined
}

// rewinds leave abandoned branches in the file: walk the parent chain back from `end`. parallel
// tool calls hang off it as side branches; their message ids pull them and their results back in
function liveBranch(entries: readonly Line[], end: number): Branch {
   if (!entries.some(({ entry }) => typeof entry.parentUuid === "string")) {
      const all = new Set(entries.keys())
      return { chain: all, live: all, parent: (i) => (i > 0 ? i - 1 : undefined) }
   }
   const byUuid = new Map<string, number>()
   entries.forEach(({ entry }, i) => {
      if (typeof entry.uuid === "string") byUuid.set(entry.uuid, i)
   })
   const parent = (i: number) => {
      const entry = entries[i]?.entry
      const id = entry?.parentUuid ?? entry?.logicalParentUuid
      return typeof id === "string" ? byUuid.get(id) : undefined
   }

   const chain = new Set<number>()
   const messages = new Set<string>()
   const leaf = end < entries.length ? parent(end) : newestChained(entries)
   for (let i = leaf; i !== undefined && !chain.has(i); i = parent(i)) {
      chain.add(i)
      const id = messageId(entries[i]?.entry)
      if (id !== undefined) messages.add(id)
   }

   const live = new Set(chain)

   const calls = new Set<string>()
   for (let i = 0; i < end; i++) {
      const entry = entries[i]?.entry
      const id = messageId(entry)
      if (id === undefined || !messages.has(id)) continue
      live.add(i)
      for (const block of contentBlocks(entry))
         if (block.type === "tool_use" && typeof block.id === "string")
            calls.add(block.id)
   }
   for (let i = 0; i < end; i++) {
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
   return { chain, live, parent }
}

/**
 * The human rewound the conversation past `start` if the path from it back to the live chain
 * holds turns. The fork is where that path meets the chain; `withdrawn` is the first prompt after it.
 */
function rewound(
   entries: readonly Line[],
   start: number,
   branch: Branch,
): { fork: number; withdrawn: string | undefined } | undefined {
   const abandoned: Entry[] = []
   let fork: number | undefined = start
   while (fork !== undefined && !branch.chain.has(fork)) {
      const entry = entries[fork]?.entry
      if (entry !== undefined) abandoned.push(entry)
      fork = branch.parent(fork)
   }
   if (fork === undefined) return undefined
   const turns = abandoned.filter(
      (e) => (e.type === "user" || e.type === "assistant") && e.isMeta !== true,
   )
   if (turns.length === 0) return undefined
   const prompt = turns.findLast(isHumanPrompt)
   return { fork, withdrawn: prompt === undefined ? undefined : promptText(prompt) }
}

function isHumanPrompt(entry: Entry): boolean {
   if (entry.type !== "user" || entry.isMeta === true) return false
   const origin = isRecord(entry.origin) ? entry.origin.kind : undefined
   if (origin !== undefined) return origin === "human"
   return contentBlocks(entry).every((b) => b.type !== "tool_result")
}

function promptText(entry: Entry): string {
   const content = isRecord(entry.message) ? entry.message.content : undefined
   return typeof content === "string" ? content : textBlocks(contentBlocks(entry))
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
   readonly #options: CcTrailOptions

   constructor(entries: readonly Line[], options: CcTrailOptions) {
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
