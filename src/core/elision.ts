import { type Block, leadWords, splitBlocks } from "./blocks.ts"

// The elision instruction (design report §2.4), shared by both elider strategies: a stateless
// mediator call, and Bx, a turn in B's own session that is rewound afterwards. Either way the
// output only steers what the human reads, never what either model receives.

const CRITERIA =
   "A paragraph of B is redundant only if A makes the same claim, with the same conditions and caveats. A paragraph that disagrees with A, even in part, or that contains any observation, example, number, or reasoning step A lacks, is not redundant. Code blocks, lists and tables count as one paragraph each. When in doubt, it is not redundant."

const OUTPUT =
   "Output one line only: the numbers of the redundant paragraphs of B, comma-separated (for example 2,5,7), or none."

export const MEDIATOR_SYSTEM_PROMPT = `You compare two answers to the same message. The reader sees answer A in full, then answer B. List the paragraphs of answer B that are fully redundant with answer A, so they can be collapsed. Each paragraph of B is preceded by its number, as [¶k].

${CRITERIA}

${OUTPUT}`

export function mediatorInput(aText: string, bText: string): string {
   const numbered = splitBlocks(bText)
      .map((block, i) => `[¶${i + 1}]\n${block.raw}`)
      .join("\n\n")
   return `<answer_a>\n${aText}\n</answer_a>\n\n<answer_b>\n${numbered}\n</answer_b>`
}

const INDEX_WORDS = 6

/**
 * B already has its own answer in context, so the prompt carries only A's final text and a
 * short index of B's paragraphs; the exchange is rewound once answered.
 */
export function bxPrompt(aText: string, bBlocks: readonly Block[]): string {
   const index = bBlocks.map((block, i) => `${i + 1}: "${leadWords(block, INDEX_WORDS)}"`)
   return [
      "[elision request from the harness, not from the human. This exchange is removed from the conversation once answered.]",
      "A peer model answered the human's last message too. The reader sees the peer's answer (answer A) in full, then your last answer (answer B). List the paragraphs of answer B that are fully redundant with answer A, so they can be collapsed.",
      CRITERIA,
      `<answer_a>\n${aText}\n</answer_a>`,
      `The paragraphs of answer B, by number and first words:\n${index.join("\n")}`,
      `Answer from this conversation alone, without tools. ${OUTPUT}`,
   ].join("\n\n")
}

/** the elider is abandoned after this; elision then falls back to showing B in full */
export const ELISION_TIMEOUT_MS = 90_000

export type IndexParse =
   /** 1-based paragraph numbers as the elider gave them, out-of-range ones included */
   | { readonly kind: "ok"; readonly indices: readonly number[] }
   | { readonly kind: "unparseable"; readonly reason: string }

const LIST = /^\d+(?:\s*(?:,|;|\band\b|\s)\s*\d+)*$/

/**
 * Finds the answer line among fences and prose. Only a line that is wholly a list (or `none`)
 * counts: digits inside prose may be anything, and a wrong guess hides a paragraph.
 */
export function parseIndices(output: string): IndexParse {
   const answers = new Set<string>()
   for (const line of output.split("\n")) {
      if (/^\s*(?:`{3,}|~{3,})/.test(line)) continue
      const bare = line
         .replace(/[`*_"'[\]()¶]/g, "")
         .replace(/^\s*[\p{L} ]{1,40}:\s*/u, "")
         .replace(/\.\s*$/, "")
         .trim()
         .toLowerCase()
      if (bare === "none") answers.add("none")
      else if (LIST.test(bare)) answers.add(bare.match(/\d+/g)?.join(",") ?? "")
   }
   const [answer, ...others] = answers
   if (answer === undefined) return unparseable("no line of paragraph numbers or none")
   if (others.length > 0) return unparseable("several different answers")
   return {
      kind: "ok",
      indices: answer === "none" ? [] : answer.split(",").map(Number),
   }
}

function unparseable(reason: string): IndexParse {
   return { kind: "unparseable", reason }
}
