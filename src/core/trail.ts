/** A harness-neutral record of what one model did since its peer last heard from it. Private
 * reasoning never enters a trail. */
export type TrailItem =
   /** A human prompt inside the span, e.g. from a turn the peer never received. */
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
   /** Non-empty when the source was only partly readable, so the trail may be incomplete. */
   readonly issues: readonly string[]
}
