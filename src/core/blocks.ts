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

/** One display unit of a markdown answer: the unit of elision and of chunk packing. */
export interface Block {
   readonly kind: BlockKind
   /** Source text, verbatim except for trailing newlines and CRLF → LF. */
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
   // The lexer is upstream code; if its raw spans ever stop tiling the input, losing text
   // would be worse than losing elision.
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
