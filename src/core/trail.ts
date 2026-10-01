// private reasoning never enters a trail
export type TrailItem =
   /** a human prompt inside the span, e.g. one the peer never received */
   | {
        readonly kind: "prompt"
        readonly text: string
        /** typed in this side's own client, not shared with the peer */
        readonly direct?: true
     }
   /** where an answer to shared human messages starts */
   | { readonly kind: "turn"; readonly prompts: readonly string[] }
   | { readonly kind: "text"; readonly text: string }
   | {
        readonly kind: "call"
        readonly id: string | undefined
        readonly name: string
        readonly input: unknown
     }
   | {
        readonly kind: "result"
        readonly id: string | undefined
        readonly text: string
        readonly isError: boolean
        /** the harness saved the full output here; `text` may be only a preview */
        readonly saved?: { readonly path: string; readonly size?: string }
        /** why `text` shows only part of what was asked for, e.g. a read cut by a token cap */
        readonly partial?: string
        /** a subagent's own transcript */
        readonly transcript?: string
        /** the call only started background work; its outcome arrives later as a report */
        readonly background?: true
        /** non-text output, e.g. "3 images" */
        readonly media?: string
     }
   /** a subagent's report or outcome, arriving apart from the call that started it */
   | {
        readonly kind: "report"
        readonly id: string | undefined
        readonly agent: string | undefined
        /** what it was asked to do */
        readonly label: string | undefined
        /** "" when only the outcome is known */
        readonly text: string
        /** absent or "completed"/"done" when it finished normally */
        readonly status?: string
        readonly transcript?: string
        /** a short notice that a fuller report elsewhere in the span supersedes */
        readonly notice?: true
     }
   /** the turn stopped early */
   | {
        readonly kind: "halt"
        readonly why: "interrupted" | "error" | "aborted"
        readonly detail?: string
     }

export type TrailResult = Extract<TrailItem, { kind: "result" }>
export type TrailCall = Extract<TrailItem, { kind: "call" }>
export type TrailReport = Extract<TrailItem, { kind: "report" }>

export interface Trail {
   readonly items: readonly TrailItem[]
   /** non-empty = degraded: source partly unreadable, trail may be incomplete */
   readonly issues: readonly string[]
}

export function withoutSupersededNotices(items: readonly TrailItem[]): TrailItem[] {
   const reported = new Set(
      items.flatMap((i) =>
         i.kind === "report" && i.notice !== true && i.text !== "" ? subagentKeys(i) : [],
      ),
   )
   return items.filter(
      (i) =>
         i.kind !== "report" ||
         i.notice !== true ||
         !subagentKeys(i).some((key) => reported.has(key)),
   )
}

function subagentKeys(report: TrailReport): string[] {
   return [
      ...(report.id === undefined ? [] : [`call:${report.id}`]),
      ...(report.agent === undefined ? [] : [`agent:${report.agent}`]),
   ]
}
