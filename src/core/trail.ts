// private reasoning never enters a trail
export type TrailItem =
   /** a human prompt inside the span, e.g. one the peer never received */
   | { readonly kind: "prompt"; readonly text: string }
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
     }

export type TrailResult = Extract<TrailItem, { kind: "result" }>
export type TrailCall = Extract<TrailItem, { kind: "call" }>

export interface Trail {
   readonly items: readonly TrailItem[]
   /** non-empty = degraded: source partly unreadable, trail may be incomplete */
   readonly issues: readonly string[]
}
