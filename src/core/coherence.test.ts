import assert from "node:assert/strict"
import { test } from "node:test"
import { ccView } from "./cc-trail.ts"
import {
   type Anchor,
   type Delivery,
   ledgerFromLines,
   ledgerLine,
   nextSlice,
   type SideView,
   settle,
   syncPoint,
} from "./coherence.ts"
import { sha256Hex } from "./store.ts"
import type { TrailItem } from "./trail.ts"

// The scenario table of the ledger's "Coherence across rewinds and asides", derived on synthetic
// trees: each side appends entries under its leaf and rewinds by moving the leaf back.

interface Node {
   readonly id: string
   readonly parent: string | null
   readonly item?: TrailItem
   readonly carries: readonly string[]
}

class Side {
   readonly #nodes = new Map<string, Node>()
   leaf: string | null = null
   #n = 0

   readonly name: string

   constructor(name: string) {
      this.name = name
   }

   add(item: TrailItem | undefined, carries: readonly string[] = []): string {
      const id = `${this.name}${++this.#n}`
      this.#nodes.set(id, {
         id,
         parent: this.leaf,
         ...(item === undefined ? {} : { item }),
         carries,
      })
      this.leaf = id
      return id
   }

   prompt(text: string) {
      return this.add({ kind: "prompt", text })
   }

   answer(text: string) {
      return this.add({ kind: "text", text })
   }

   rewind(to: string | null) {
      this.leaf = to
   }

   view(): SideView {
      const path: Node[] = []
      for (let id = this.leaf; id !== null; ) {
         const node = this.#nodes.get(id)
         if (node === undefined) break
         path.unshift(node)
         id = node.parent
      }
      const live = path.map((n) => ({
         id: n.id,
         content: n.item !== undefined,
         startsTurn: n.item?.kind === "prompt" || n.carries.length > 0,
         ...(n.item?.kind === "prompt" ? { prompt: n.item.text } : {}),
         ...(n.item?.kind === "text" ? { text: n.item.text } : {}),
         carries: n.carries,
      }))
      return {
         live,
         parent: (id) => this.#nodes.get(id)?.parent,
         trail: (after, through) => {
            const from = after === undefined ? -1 : live.findIndex((e) => e.id === after)
            const to =
               through === undefined
                  ? live.length - 1
                  : live.findIndex((e) => e.id === through)
            const items = path
               .slice(from + 1, to + 1)
               .flatMap((n) => (n.item ? [n.item] : []))
            return { items, issues: [] }
         },
      }
   }
}

const said = (items: readonly TrailItem[]) =>
   items.map((i) => (i.kind === "prompt" || i.kind === "text" ? i.text : i.kind))

/** Spiderman's moves, as the runtime makes them: deliveries recorded, carriers written. */
class Pair {
   readonly a = new Side("a")
   readonly b = new Side("b")
   ledger: Delivery[] = []
   #n = 0

   /** A shared prompt: A's hook gets B's news first, then B gets A's news and the prompt. */
   prompt(text: string): { toA: string[]; toB: string[] } {
      const toA = this.#deliver("a", this.b.leaf ?? undefined)
      const before = this.a.leaf ?? undefined
      const entry = this.a.prompt(text)
      if (toA.hash !== undefined) this.a.add(undefined, [toA.hash])
      const toB = this.#deliver("b", before, { covers: entry, prompts: [text] })
      this.b.add(undefined, toB.hash === undefined ? [] : [toB.hash])
      return { toA: said(toA.items), toB: said(toB.items) }
   }

   #deliver(
      to: "a" | "b",
      through: string | undefined,
      shared?: { covers: string; prompts: string[] },
   ): { items: TrailItem[]; hash?: string } {
      const [receiver, peer] = to === "a" ? [this.a, this.b] : [this.b, this.a]
      for (const [x, y, name] of [
         [this.a, this.b, "a"],
         [this.b, this.a, "b"],
      ] as const)
         for (const { id, change } of settle(this.ledger, name, x.view(), y.view()))
            this.ledger = this.ledger.map((d) => (d.id === id ? { ...d, ...change } : d))
      const slice =
         through === undefined && peer.leaf !== null
            ? { after: undefined, trail: { items: [], issues: [] }, covers: undefined }
            : nextSlice(this.ledger, to, receiver.view(), peer.view(), through)
      const items = [...slice.trail.items]
      if (items.length === 0 && shared === undefined) return { items }
      const covers = shared?.covers ?? slice.covers
      const hash = sha256Hex(`${to}${++this.#n}`)
      this.ledger.push({
         id: `d${this.#n}`,
         to,
         hashes: [hash],
         ...(receiver.leaf === null ? {} : { sentAfter: receiver.leaf }),
         ...(slice.after === undefined ? {} : { from: slice.after }),
         ...(covers === undefined ? {} : { covers }),
         pending: [],
         prompts: shared?.prompts ?? [],
      })
      return { items, hash }
   }
}

test("1: a normal prompt carries each side's news since its sync point", () => {
   const pair = new Pair()
   assert.deepEqual(pair.prompt("U1"), { toA: [], toB: [] })
   pair.a.answer("A1")
   pair.b.answer("B1")
   assert.deepEqual(pair.prompt("U2"), { toA: ["B1"], toB: ["A1"] })
   pair.a.answer("A2")
   pair.b.answer("B2")
   assert.deepEqual(pair.prompt("U3"), { toA: ["B2"], toB: ["A2"] })
})

test("2: an aside in A reaches B as trail at the next shared prompt", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   pair.b.answer("B1")
   pair.a.prompt("~ quick one")
   pair.a.answer("aside answer")
   assert.deepEqual(pair.prompt("U2").toB, ["A1", "~ quick one", "aside answer"])
})

test("3: typing in B's pane reaches A as trail at A's next prompt", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   pair.b.answer("B1")
   pair.b.prompt("debug this")
   pair.b.answer("debugged")
   assert.deepEqual(pair.prompt("U2").toA, ["B1", "debug this", "debugged"])
})

test("4: rewinding A past an aside not yet sent: it's never sent", () => {
   const pair = new Pair()
   pair.prompt("U1")
   const a1 = pair.a.answer("A1")
   pair.b.answer("B1")
   pair.a.prompt("~ aside")
   pair.a.answer("aside answer")
   pair.a.rewind(a1)
   assert.deepEqual(pair.prompt("U2").toB, ["A1"])
})

test("5: an edit in A past a shared prompt re-sends what A lost; B just gets the new prompt", () => {
   const pair = new Pair()
   pair.prompt("U1")
   const a1 = pair.a.answer("A1")
   pair.b.answer("B1")
   pair.prompt("U2")
   pair.a.answer("A2")
   pair.b.answer("B2")
   pair.a.rewind(a1)
   const edited = pair.prompt("U2, edited")
   assert.deepEqual(edited.toB, [], "B already has A1; A2 was abandoned")
   assert.deepEqual(
      edited.toA,
      ["B1", "B2"],
      "B1 rode on the abandoned prompt, so A gets it again, with B's answer to that prompt",
   )
})

test("6: a debug chat in B, rewound away, never reaches A", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   const b1 = pair.b.answer("B1")
   pair.b.prompt("why did you say that?")
   pair.b.answer("because")
   pair.b.rewind(b1)
   assert.deepEqual(pair.prompt("U2").toA, ["B1"])
})

test("7: B rewound past shared prompts gets A's live items again; A keeps B's stale answers", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   const b1 = pair.b.answer("B1")
   pair.prompt("U2")
   pair.a.answer("A2")
   pair.b.answer("B2")
   assert.deepEqual(pair.prompt("U3").toA, ["B2"])
   pair.a.answer("A3")
   pair.b.answer("B3")
   pair.b.rewind(b1)
   assert.deepEqual(pair.prompt("U4"), {
      toA: [],
      toB: ["A1", "U2", "A2", "U3", "A3"],
   })
})

test("8: an elision turn rewound away carries nothing either way", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   const b1 = pair.b.answer("B1")
   pair.b.prompt("[elision request …]")
   pair.b.answer("1,3")
   pair.b.rewind(b1)
   assert.deepEqual(pair.prompt("U2"), { toA: ["B1"], toB: ["A1"] })
})

test("9: a new pairing starts from the peer's last turn, not its whole history", () => {
   const pair = new Pair()
   pair.a.prompt("ancient")
   pair.a.answer("ancient answer")
   pair.a.prompt("U1")
   pair.a.answer("A1")
   assert.deepEqual(pair.prompt("U2").toB, ["U1", "A1"])
})

test("10: deliveries before a compaction boundary still count as held", () => {
   const line = (e: object) => JSON.stringify(e)
   const sent = "[peer 1/1] B1"
   const transcript = [
      line({
         type: "user",
         uuid: "u1",
         parentUuid: null,
         message: { role: "user", content: "U1" },
      }),
      line({
         type: "attachment",
         uuid: "h1",
         parentUuid: "u1",
         attachment: { type: "hook_additional_context", content: [sent] },
      }),
      line({
         type: "system",
         subtype: "compact_boundary",
         uuid: "cb",
         parentUuid: null,
         logicalParentUuid: "h1",
      }),
      line({
         type: "user",
         uuid: "u2",
         parentUuid: "cb",
         message: { role: "user", content: "U2" },
      }),
   ].join("\n")
   const a = ccView(transcript, { hash: sha256Hex })
   const b = new Side("b")
   const b1 = b.answer("B1")
   b.answer("B2")
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "a",
         hashes: [sha256Hex(sent)],
         covers: b1,
         pending: [],
         prompts: [],
      },
   ]
   assert.deepEqual(syncPoint(ledger, "a", a, b.view()), { after: b1 })
})

test("Stop lag: A's final text and a queued prompt sent ahead of the transcript count once", () => {
   const a = new Side("a")
   const b = new Side("b")
   a.prompt("U1")
   const call = a.add({ kind: "call", id: "t1", name: "Read", input: {} })
   const pending: Anchor[] = [{ text: "A1 final." }, { prompt: "U2" }]
   const ledger: Delivery[] = [
      { id: "d1", to: "b", hashes: ["h"], covers: call, pending, prompts: ["U2"] },
   ]
   b.add(undefined, ["h"])
   b.answer("B2")
   a.answer("A1 final.")
   a.prompt("U2")
   a.answer("A2")
   const slice = nextSlice(ledger, "b", b.view(), a.view())
   assert.deepEqual(said(slice.trail.items), ["A2"])
})

test("Stop lag: when A went another way, nothing it sent ahead is skipped", () => {
   const a = new Side("a")
   const b = new Side("b")
   a.prompt("U1")
   const call = a.add({ kind: "call", id: "t1", name: "Read", input: {} })
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "b",
         hashes: ["h"],
         covers: call,
         pending: [{ text: "A1 final." }],
         prompts: [],
      },
   ]
   b.add(undefined, ["h"])
   a.answer("a different ending")
   assert.deepEqual(said(nextSlice(ledger, "b", b.view(), a.view()).trail.items), [
      "a different ending",
   ])
})

test("a delivery not yet written by the receiver is in flight; once the receiver moves on without it, it's lost", () => {
   const a = new Side("a")
   const b = new Side("b")
   const b1 = b.answer("B1")
   b.answer("B2")
   const tail = a.answer("A0")
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "a",
         hashes: ["h"],
         sentAfter: tail,
         covers: b1,
         pending: [],
         prompts: [],
      },
   ]
   assert.deepEqual(
      syncPoint(ledger, "a", a.view(), b.view()),
      { after: b1 },
      "in flight",
   )
   a.prompt("U1")
   assert.deepEqual(
      syncPoint(ledger, "a", a.view(), b.view()),
      { after: undefined },
      "dropped: A holds nothing since the pairing began",
   )
})

test("the ledger rebuilds from its sidecar lines; malformed lines are skipped", () => {
   const d1: Delivery = {
      id: "d1",
      to: "b",
      hashes: ["h1"],
      pending: [{ prompt: "U1" }],
      prompts: ["U1"],
   }
   const d2: Delivery = { id: "d2", to: "a", hashes: ["h2"], pending: [], prompts: [] }
   const lines = [
      ledgerLine.delivered(d1),
      { what: "display", turn: 1 },
      ledgerLine.delivered(d2),
      ledgerLine.settled("d1", { carrier: "e7", covers: "a3", pending: [] }),
      ledgerLine.lost("d2"),
      { what: "delivered", delivery: { id: 3 } },
   ]
   assert.deepEqual(ledgerFromLines(JSON.parse(JSON.stringify(lines))), [
      { ...d1, carrier: "e7", covers: "a3", pending: [] },
   ])
})
