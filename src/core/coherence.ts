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

// state is derived from both live branches at each event, never kept as cursors, so either
// side can be rewound freely: a receiver "has" the peer entries carried by deliveries whose
// chunks are on its live branch now

export interface SideView {
   readonly live: readonly ViewEntry[]
   /** any entry's parent, live or abandoned: null at a root, undefined for an unknown entry */
   parent(id: string): string | null | undefined
   trail(ids: readonly string[]): Trail
}

export interface ViewEntry {
   readonly id: string
   readonly content: boolean
   readonly startsTurn: boolean
   readonly prompt?: string
   readonly text?: string
   readonly carries: readonly string[]
}

export interface Delivery {
   readonly id: string
   readonly to: string
   readonly chunks: readonly string[]
   readonly ids: readonly string[]
   /** content carried before the peer's record held it, matched to the first entries after `ids` */
   readonly ahead: readonly Anchor[]
   readonly prompts: readonly string[]
   readonly sentAfter?: string
   readonly ridesWith?: string
   readonly floor?: string | null
}

export type Anchor = { readonly prompt: string } | { readonly text: string }

export type Ledger = readonly Delivery[]

export type Status = "had" | "pending" | "failed" | "gone"

export function carrierHash(hash: (text: string) => string, text: string): string {
   return hash(text.replace(/\r\n?/g, "\n").trimEnd())
}

export function status(delivery: Delivery, receiver: SideView): Status {
   const held = (h: string) => receiver.live.some((e) => e.carries.includes(h))
   if (delivery.chunks.length > 0 && delivery.chunks.every(held)) return "had"
   if (delivery.chunks.some(held)) return "failed"
   const prompt = delivery.ridesWith
   if (prompt === undefined) return "gone"
   const at =
      delivery.sentAfter === undefined
         ? -1
         : receiver.live.findIndex((e) => e.id === delivery.sentAfter)
   if (delivery.sentAfter !== undefined && at === -1) return "gone"
   // lands with the prompt it rode on, so the next prompt entry shows whether it did
   const next = receiver.live.slice(at + 1).find((e) => e.prompt !== undefined)
   if (next === undefined) return "pending"
   return same(next.prompt, prompt) ? "failed" : "gone"
}

export function have(
   ledger: Ledger,
   to: string,
   receiver: SideView,
   peer: SideView,
): Set<string> {
   const held = new Set<string>()
   for (const delivery of ledger) {
      if (delivery.to !== to) continue
      const s = status(delivery, receiver)
      if (s !== "had" && s !== "pending") continue
      for (const id of delivery.ids) held.add(id)
      let at = Math.max(-1, ...delivery.ids.map((id) => position(peer, id)))
      for (const anchor of delivery.ahead) {
         const next = peer.live.findIndex(
            (e, i) => i > at && !held.has(e.id) && matches(e, anchor),
         )
         const entry = peer.live[next]
         if (entry === undefined) break
         held.add(entry.id)
         at = next
      }
   }
   return held
}

function matches(entry: ViewEntry, anchor: Anchor): boolean {
   return "prompt" in anchor
      ? same(entry.prompt, anchor.prompt)
      : same(entry.text, anchor.text)
}

function same(a: string | undefined, b: string): boolean {
   const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim()
   return a !== undefined && norm(a) === norm(b)
}

export interface Owed {
   readonly ids: readonly string[]
   readonly floor?: string | null
}

export function owed(
   ledger: Ledger,
   to: string,
   receiver: SideView,
   peer: SideView,
   through?: string | null,
): Owed {
   const end =
      through === undefined
         ? peer.live.length - 1
         : through === null
           ? -1
           : position(peer, through)
   const recorded = ledger.find((d) => d.to === to && d.floor !== undefined)?.floor
   const floor =
      recorded === undefined ? firstFloor(ledger, to, peer, end) : clipped(recorded, peer)
   if (floor === "unknown") return { ids: [] }
   const held = have(ledger, to, receiver, peer)
   const from = floor === null ? -1 : position(peer, floor)
   const ids = peer.live
      .slice(from + 1, end + 1)
      .filter((e) => e.content && !held.has(e.id))
      .map((e) => e.id)
   return recorded === undefined ? { ids, floor } : { ids }
}

function clipped(id: string | null, peer: SideView): string | null | "unknown" {
   const live = new Set(peer.live.map((e) => e.id))
   for (let at: string | null | undefined = id; ; at = peer.parent(at)) {
      if (at === undefined) return "unknown"
      if (at === null || live.has(at)) return at
   }
}

function firstFloor(
   ledger: Ledger,
   to: string,
   peer: SideView,
   end: number,
): string | null {
   const ours = new Set(ledger.flatMap((d) => (d.to === to ? [] : d.chunks)))
   const first = peer.live.findIndex((e) => e.carries.some((h) => ours.has(h)))
   if (first !== -1) return peer.live[first - 1]?.id ?? null
   for (let i = end; i >= 0; i--)
      if (peer.live[i]?.startsTurn) return peer.live[i - 1]?.id ?? null
   return peer.live[end]?.id ?? null
}

function position(view: SideView, id: string): number {
   return view.live.findIndex((e) => e.id === id)
}

/** three straight failures: matching itself is broken, so stop re-sending */
export function matchBroken(ledger: Ledger, to: string, receiver: SideView): boolean {
   const recent = ledger.filter((d) => d.to === to).slice(-3)
   return recent.length === 3 && recent.every((d) => status(d, receiver) === "failed")
}

const anchor: Validator<Anchor> = (input, at) =>
   isRecord(input) && typeof input.prompt === "string"
      ? { prompt: input.prompt }
      : object({ text: string })(input, at)

const deliveryShape = object({
   id: string,
   to: string,
   chunks: array(string),
   ids: array(string),
   ahead: array(anchor),
   prompts: array(string),
   sentAfter: optional(string),
   ridesWith: optional(string),
   floor: optional(string),
})

export const ledgerLine = {
   delivered: (d: Delivery) => ({ what: "delivered", delivery: d }),
   /** carried nothing after all: B never started the turn it rode on */
   lost: (id: string) => ({ what: "lost", id }),
}

export function ledgerFromLines(lines: readonly unknown[]): Delivery[] {
   const deliveries: Delivery[] = []
   for (const line of lines) {
      if (!isRecord(line)) continue
      if (line.what === "delivered" && isRecord(line.delivery)) {
         const parsed = validate(deliveryShape, line.delivery)
         if (!parsed.ok) continue
         // JSON has no undefined: a null floor is "from the peer's start", absent is no floor
         const floor = line.delivery.floor === null ? { floor: null } : {}
         deliveries.push({ ...parsed.value, ...floor })
      } else if (line.what === "lost") {
         const i = deliveries.findIndex((d) => d.id === line.id)
         if (i !== -1) deliveries.splice(i, 1)
      }
   }
   return deliveries
}
