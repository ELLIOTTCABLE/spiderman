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
     }

export interface Trail {
   readonly items: readonly TrailItem[]
   /** non-empty = degraded: source partly unreadable, trail may be incomplete */
   readonly issues: readonly string[]
}
