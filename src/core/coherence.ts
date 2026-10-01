import type { Trail } from "./trail.ts"
import {
   array,
   isRecord,
   object,
   optional,
   string,
   type Validator,
   validate,
} from "./validate.ts"

// Ledger notes: "Coherence across rewinds and asides". Delivery state is derived from both live
// branches at each event, never kept as cursors, so either side may be rewound freely. Nothing
// here knows which harness a side runs in.

/** One side's record, as its harness adapter presents it. */
export interface SideView {
   /** the live branch, oldest first */
   readonly live: readonly ViewEntry[]
   /** any entry's parent, live or abandoned: null at a root, undefined for an unknown entry */
   parent(id: string): string | null | undefined
   /** the live trail after `after` (absent: from the start) through `through` (absent: the leaf) */
   trail(after: string | undefined, through: string | undefined): Trail
}

export interface ViewEntry {
   readonly id: string
   /** adds to a trail */
   readonly content: boolean
   /** a human prompt, or one of our deliveries, starts a turn here */
   readonly startsTurn: boolean
   /** a human prompt's text */
   readonly prompt?: string
   /** an answer's text */
   readonly text?: string
   /** hashes of delivered texts this entry holds */
   readonly carries: readonly string[]
}

export interface Delivery {
   readonly id: string
   /** the receiving side's name */
   readonly to: string
   /** of each text handed to the receiver's harness */
   readonly hashes: readonly string[]
   /** the receiver's entry holding it, once seen */
   readonly carrier?: string
   /** the receiver's newest entry when sent; an unseen delivery is in flight until it moves on */
   readonly sentAfter?: string
   /** the peer entry its slice started after; absent: the peer's first entry */
   readonly from?: string
   /** the newest peer entry it carried */
   readonly covers?: string
   /** carried after `covers` before the peer's own record held it, oldest first */
   readonly pending: readonly Anchor[]
   /** the human messages it carried */
   readonly prompts: readonly string[]
}

export type Anchor = { readonly prompt: string } | { readonly text: string }

export type Ledger = readonly Delivery[]

export type Sync = { readonly after: string | undefined } | "none"

export function carrierOf(delivery: Delivery, receiver: SideView): string | undefined {
   if (delivery.carrier !== undefined)
      return receiver.live.some((e) => e.id === delivery.carrier)
         ? delivery.carrier
         : undefined
   return receiver.live.find((e) => e.carries.some((h) => delivery.hashes.includes(h)))
      ?.id
}

/** On the receiver's live branch, or sent so recently the receiver hasn't written it yet. */
export function isLive(delivery: Delivery, receiver: SideView): boolean {
   if (carrierOf(delivery, receiver) !== undefined) return true
   if (delivery.carrier !== undefined) return false
   const at =
      delivery.sentAfter === undefined
         ? -1
         : receiver.live.findIndex((e) => e.id === delivery.sentAfter)
   if (delivery.sentAfter !== undefined && at === -1) return false
   return !receiver.live.slice(at + 1).some((e) => e.content)
}

/**
 * Resolves pending anchors to the peer entries that now hold them. Each must be the next entry
 * with content; anything else there means the peer's record went another way.
 */
export function settledCover(
   delivery: Delivery,
   peer: SideView,
): { readonly covers: string | undefined; readonly pending: readonly Anchor[] } {
   let at =
      delivery.covers === undefined
         ? -1
         : peer.live.findIndex((e) => e.id === delivery.covers)
   if (delivery.covers !== undefined && at === -1)
      return { covers: delivery.covers, pending: delivery.pending }
   let resolved = 0
   for (const anchor of delivery.pending) {
      const next = peer.live.findIndex((e, i) => i > at && e.content)
      const entry = peer.live[next]
      if (entry === undefined || !holds(entry, anchor)) break
      at = next
      resolved++
   }
   return {
      covers: peer.live[at]?.id ?? delivery.covers,
      pending: delivery.pending.slice(resolved),
   }
}

function holds(entry: ViewEntry, anchor: Anchor): boolean {
   return "prompt" in anchor
      ? entry.prompt?.trim() === anchor.prompt.trim()
      : entry.text?.trim() === anchor.text.trim()
}

/**
 * What the ledger has learned from both live branches: carriers seen, anchors resolved. Callers
 * record these, so a delivery is still recognised once the receiver moves away from it.
 */
export function settle(
   ledger: Ledger,
   to: string,
   receiver: SideView,
   peer: SideView,
): { readonly id: string; readonly change: Partial<Delivery> }[] {
   return ledger.flatMap((d) => {
      if (d.to !== to) return []
      const change: { carrier?: string; covers?: string; pending?: readonly Anchor[] } =
         {}
      const carrier = d.carrier === undefined ? carrierOf(d, receiver) : undefined
      if (carrier !== undefined) change.carrier = carrier
      if (d.pending.length > 0) {
         const settled = settledCover(d, peer)
         if (settled.pending.length < d.pending.length) {
            if (settled.covers !== undefined) change.covers = settled.covers
            change.pending = settled.pending
         }
      }
      return Object.keys(change).length === 0 ? [] : [{ id: d.id, change }]
   })
}

/**
 * The newest peer entry the receiver still holds: covered by its newest live delivery, clipped
 * back to the fork point when the peer has since abandoned it. "none" when it holds nothing.
 */
export function syncPoint(
   ledger: Ledger,
   to: string,
   receiver: SideView,
   peer: SideView,
): Sync {
   const delivery = ledger.findLast((d) => d.to === to && isLive(d, receiver))
   if (delivery !== undefined) return clipped(settledCover(delivery, peer).covers, peer)
   // rewound past all it held: everything since the pairing began
   const first = ledger.find((d) => d.to === to)
   return first === undefined ? "none" : clipped(first.from, peer)
}

/** The entry itself if live, else where the peer's live branch forked from it. */
function clipped(id: string | undefined, peer: SideView): Sync {
   if (id === undefined) return { after: undefined }
   const live = new Set(peer.live.map((e) => e.id))
   for (let at: string | null | undefined = id; ; at = peer.parent(at)) {
      if (at === undefined) return "none"
      if (at === null) return { after: undefined }
      if (live.has(at)) return { after: at }
   }
}

/**
 * Where a receiver that was never sent anything starts: just before the peer's first delivery
 * from it, or for a new pairing, the peer's last turn.
 */
function startWithout(
   ledger: Ledger,
   to: string,
   peer: SideView,
   through: string | undefined,
): string | undefined {
   const carriers = new Set(ledger.flatMap((d) => (d.to === to ? [] : d.hashes)))
   const first = peer.live.findIndex((e) => e.carries.some((h) => carriers.has(h)))
   if (first !== -1) return peer.live[first - 1]?.id
   return backlogStart(peer, through)
}

function backlogStart(peer: SideView, through: string | undefined): string | undefined {
   if (through === undefined) return undefined
   const end = position(peer, through)
   for (let i = end; i >= 0; i--) {
      if (peer.live[i]?.startsTurn) return peer.live[i - 1]?.id
   }
   return peer.live[end]?.id
}

export interface Slice {
   readonly after: string | undefined
   readonly trail: Trail
   /** the last peer entry with content in the slice, else where it started */
   readonly covers: string | undefined
}

/** The delivery rule: the peer's live items after the receiver's sync point, nothing else. */
export function nextSlice(
   ledger: Ledger,
   to: string,
   receiver: SideView,
   peer: SideView,
   through?: string,
): Slice {
   const end = through === undefined ? peer.live.length - 1 : position(peer, through)
   const sync = syncPoint(ledger, to, receiver, peer)
   const after =
      sync === "none" ? startWithout(ledger, to, peer, peer.live[end]?.id) : sync.after
   const from = after === undefined ? -1 : position(peer, after)
   const lastContent = peer.live.slice(from + 1, end + 1).findLast((e) => e.content)
   return {
      after,
      trail:
         from >= end ? { items: [], issues: [] } : peer.trail(after, peer.live[end]?.id),
      covers: lastContent?.id ?? after,
   }
}

function position(view: SideView, id: string): number {
   return view.live.findIndex((e) => e.id === id)
}

// the sidecar holds the ledger as append-only lines, so a resumed session rebuilds it

const anchor: Validator<Anchor> = (input, at) =>
   isRecord(input) && typeof input.prompt === "string"
      ? { prompt: input.prompt }
      : object({ text: string })(input, at)

const delivery: Validator<Delivery> = object({
   id: string,
   to: string,
   hashes: array(string),
   carrier: optional(string),
   sentAfter: optional(string),
   from: optional(string),
   covers: optional(string),
   pending: array(anchor),
   prompts: array(string),
})

const update = object({
   id: string,
   carrier: optional(string),
   covers: optional(string),
   pending: optional(array(anchor)),
})

/** Sidecar lines that record the ledger. */
export const ledgerLine = {
   delivered: (d: Delivery) => ({ what: "delivered", delivery: d }),
   /** a carrier seen, or anchors resolved */
   settled: (
      id: string,
      change: Partial<Pick<Delivery, "carrier" | "covers" | "pending">>,
   ) => ({
      what: "settled",
      id,
      ...change,
   }),
   /** never reached the receiver */
   lost: (id: string) => ({ what: "lost", id }),
}

export function ledgerFromLines(lines: readonly unknown[]): Delivery[] {
   const deliveries: Delivery[] = []
   for (const line of lines) {
      if (!isRecord(line)) continue
      if (line.what === "delivered") {
         const parsed = validate(delivery, line.delivery)
         if (parsed.ok) deliveries.push(parsed.value)
      } else if (line.what === "settled") {
         const parsed = validate(update, line)
         if (!parsed.ok) continue
         const { id, ...change } = parsed.value
         const i = deliveries.findIndex((d) => d.id === id)
         const found = deliveries[i]
         if (found !== undefined) deliveries[i] = { ...found, ...change }
      } else if (line.what === "lost") {
         const i = deliveries.findIndex((d) => d.id === line.id)
         if (i !== -1) deliveries.splice(i, 1)
      }
   }
   return deliveries
}
