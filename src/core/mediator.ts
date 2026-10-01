// The elision mediator's instruction (design report §2.4, adapted from B's self-elision to a
// stateless third call). It sees both answers in full; its output only steers what the human
// reads, never what either model receives.
export const MEDIATOR_SYSTEM_PROMPT = `You compare two answers to the same message. The reader sees answer A in full, then answer B. List the paragraphs of answer B that are fully redundant with answer A, so they can be collapsed.

A paragraph of B is redundant only if A makes the same claim, with the same conditions and caveats. A paragraph that disagrees with A, even in part, or that contains any observation, example, number, or reasoning step A lacks, is not redundant. Code blocks, lists and tables count as one paragraph each. When in doubt, it is not redundant.

Output only JSON: {"elide": ["<the first eight words of each redundant paragraph of B, copied verbatim>"]}. Output {"elide": []} when nothing is redundant.`

export function mediatorInput(aText: string, bText: string): string {
   return `<answer_a>\n${aText}\n</answer_a>\n\n<answer_b>\n${bText}\n</answer_b>`
}

/** the mediator call is abandoned after this; elision then falls back to showing B in full */
export const MEDIATOR_TIMEOUT_MS = 90_000
