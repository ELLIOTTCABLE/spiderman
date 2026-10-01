import { Lexer, type Token } from "marked"

export type BlockKind =
   | "paragraph"
   | "heading"
   | "code"
   | "list"
   | "table"
   | "blockquote"
   | "html"
   | "hr"
   | "other"

export interface Block {
   readonly kind: BlockKind
   /** verbatim, minus trailing newlines; CRLF → LF */
   readonly raw: string
}

const knownKinds: ReadonlySet<string> = new Set<BlockKind>([
   "paragraph",
   "heading",
   "code",
   "list",
   "table",
   "blockquote",
   "html",
   "hr",
])

export function splitBlocks(markdown: string): Block[] {
   const source = markdown.replace(/\r\n?/g, "\n")
   let tokens: Token[]
   try {
      tokens = new Lexer({ gfm: true }).lex(source)
   } catch {
      return wholeAnswer(source)
   }
   // if upstream raw spans ever stop tiling the input, lose elision rather than text
   if (tokens.map((t) => t.raw).join("") !== source) return wholeAnswer(source)

   return tokens.flatMap((token): Block[] => {
      const raw = token.raw.replace(/\n+$/, "")
      if (token.type === "space" || raw.trim() === "") return []
      const kind = knownKinds.has(token.type) ? (token.type as BlockKind) : "other"
      return [{ kind, raw }]
   })
}

function wholeAnswer(source: string): Block[] {
   const raw = source.replace(/\n+$/, "")
   return raw.trim() === "" ? [] : [{ kind: "other", raw }]
}

/** A block's opening words, as a one-line reference to it; a code block's fence is skipped. */
export function leadWords(block: Block, count: number): string {
   const source =
      block.kind === "code" ? block.raw.split("\n").slice(1).join("\n") : block.raw
   const words = source
      .split(/\s+/)
      .filter((w) => w !== "" && !/^(?:`{3,}|~{3,})$/.test(w))
   const head = words.slice(0, count).join(" ")
   return words.length > count ? `${head}…` : head
}
