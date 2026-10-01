import { isRecord } from "./validate.ts"

export type ToolKind =
   | "read"
   | "search"
   | "edit"
   | "write"
   | "subagent"
   | "remote"
   | "noise"
   | "generic"

/** What a read tool showed the peer: lines `start…` of the file. */
export interface ReadView {
   readonly start: number
   readonly lines: readonly string[]
   /** what the tool said about the rest of the file */
   readonly note?: string
}

type ViewParser = (output: string, input: Record<string, unknown>) => ReadView | undefined

export interface ToolSpec {
   readonly kind: ToolKind
   readonly view?: ViewParser
}

// CC Read: `cat -n` style, "<n>\t<line>" ("<n>→<line>" on older builds), sometimes with a
// trailing system reminder
export const numberedView: ViewParser = (output) => {
   const body = output
      .replace(/\r\n/g, "\n")
      .replace(/\n*<system-reminder>[\s\S]*<\/system-reminder>\s*$/, "")
   const lines: string[] = []
   let start: number | undefined
   for (const [i, line] of body.split("\n").entries()) {
      const match = /^\s*(\d+)(?:\t|→)(.*)$/.exec(line)
      if (match === null) return undefined
      const n = Number(match[1])
      start ??= n
      if (n !== start + i) return undefined
      lines.push(match[2] ?? "")
   }
   return start === undefined ? undefined : { start, lines }
}

// pi read: the lines verbatim, maybe followed by a "[Showing lines …]" or "[k more lines …]" notice
export const plainView: ViewParser = (output, input) => {
   const text = output.replace(/\r\n/g, "\n")
   if (/^\[Line \d+ is .* exceeds /.test(text)) return undefined
   const notice =
      /\n\n\[(?:Showing lines \d+-\d+ of (\d+)|(\d+) more lines in file)[^\]\n]*\]$/.exec(
         text,
      )
   const lines = (notice === null ? text : text.slice(0, notice.index)).split("\n")
   const offset = input.offset
   const start = typeof offset === "number" && offset >= 1 ? Math.floor(offset) : 1
   if (notice?.[1] !== undefined)
      return { start, lines, note: `${notice[1]} lines in file` }
   if (notice?.[2] !== undefined)
      return { start, lines, note: `${notice[2]} more lines in file` }
   return { start, lines }
}

const read = (view: ViewParser): ToolSpec => ({ kind: "read", view })
const kind = (k: ToolKind): ToolSpec => ({ kind: k })

/** Tool names are exact: Claude Code's are capitalised, pi's are lowercase. */
const TOOLS: Readonly<Record<string, ToolSpec>> = {
   Read: read(numberedView),
   Grep: kind("search"),
   Glob: kind("search"),
   LS: kind("search"),
   Bash: kind("search"),
   BashOutput: kind("search"),
   PowerShell: kind("search"),
   Edit: kind("edit"),
   MultiEdit: kind("edit"),
   Write: kind("write"),
   Agent: kind("subagent"),
   Task: kind("subagent"),
   WebFetch: kind("remote"),
   WebSearch: kind("remote"),
   TodoWrite: kind("noise"),
   TodoRead: kind("noise"),
   TaskCreate: kind("noise"),
   TaskUpdate: kind("noise"),
   TaskList: kind("noise"),
   TaskGet: kind("noise"),
   ToolSearch: kind("noise"),

   read: read(plainView),
   grep: kind("search"),
   find: kind("search"),
   ls: kind("search"),
   bash: kind("search"),
   powershell: kind("search"),
   edit: kind("edit"),
   write: kind("write"),
   subagent: kind("subagent"),
}

export function classify(name: string): ToolSpec {
   const known = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
   if (known !== undefined) return known
   return name.startsWith("mcp__") ? kind("remote") : kind("generic")
}

export function inputPath(input: unknown): string | undefined {
   if (!isRecord(input)) return undefined
   const path = input.file_path ?? input.path
   return typeof path === "string" && path !== "" ? path : undefined
}

export interface Hunk {
   readonly old: string
   readonly new: string
}

// CC: `old_string`/`new_string`, optionally under `edits[]` (MultiEdit). pi: `edits[].oldText`
export function editHunks(input: unknown): Hunk[] | undefined {
   if (!isRecord(input)) return undefined
   const raw = Array.isArray(input.edits) ? input.edits : [input]
   const hunks: Hunk[] = []
   for (const edit of raw) {
      if (!isRecord(edit)) return undefined
      const old = edit.old_string ?? edit.oldText
      const replacement = edit.new_string ?? edit.newText
      if (typeof old !== "string" || typeof replacement !== "string") return undefined
      hunks.push({ old, new: replacement })
   }
   return hunks.length > 0 ? hunks : undefined
}

export interface SubagentBrief {
   readonly who: string | undefined
   readonly what: string
   /** whether `what` is the whole instruction, rather than a label for a longer prompt */
   readonly complete: boolean
}

// CC Agent: {description, prompt, subagent_type}. pi subagent: {agent, task} | {tasks[]} | {chain[]}
export function subagentBrief(input: unknown): SubagentBrief | undefined {
   if (!isRecord(input)) return undefined
   const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined)
   const many = Array.isArray(input.tasks)
      ? input.tasks
      : Array.isArray(input.chain)
        ? input.chain
        : []
   const first = many.find(isRecord)
   const who =
      str(input.subagent_type) ??
      str(input.agent) ??
      (first ? str(first.agent) : undefined)
   const what =
      str(input.description) ??
      str(input.task) ??
      str(input.prompt) ??
      (first ? str(first.task) : undefined)
   if (what === undefined) return undefined
   const count = many.length > 1 ? ` (+${many.length - 1} more)` : ""
   const labelOnly =
      str(input.description) !== undefined && str(input.prompt) !== undefined
   return { who, what: `${what}${count}`, complete: !labelOnly && many.length <= 1 }
}
