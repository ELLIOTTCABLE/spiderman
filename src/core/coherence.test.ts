import assert from "node:assert/strict"
import { test } from "node:test"
import { ccView } from "./cc-trail.ts"
import {
   type Anchor,
   carrierHash,
   type Delivery,
   have,
   ledgerFromLines,
   ledgerLine,
   matchBroken,
   owed,
   type SideView,
   status,
} from "./coherence.ts"
import { sha256Hex } from "./store.ts"
import type { TrailItem } from "./trail.ts"

interface Node {
   readonly id: string
   readonly parent: string | null
   readonly item?: TrailItem
   readonly carries: readonly string[]
}

class Side {
   readonly name: string
   readonly #nodes = new Map<string, Node>()
   leaf: string | null = null
   #seen: string | null = null
   #n = 0

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
      this.#seen = id
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
      this.#seen = to
   }

   /** Esc-Esc in CC: nothing written until the next prompt */
   edit(to: string | null) {
      this.leaf = to
   }

   view(): SideView {
      const path: Node[] = []
      for (let id = this.#seen; id !== null; ) {
         const node = this.#nodes.get(id)
         if (node === undefined) break
         path.unshift(node)
         id = node.parent
      }
      return {
         live: path.map((n) => ({
            id: n.id,
            content: n.item !== undefined,
            startsTurn: n.item?.kind === "prompt" || n.carries.length > 0,
            ...(n.item?.kind === "prompt" ? { prompt: n.item.text } : {}),
            ...(n.item?.kind === "text" ? { text: n.item.text } : {}),
            carries: n.carries,
         })),
         parent: (id) => this.#nodes.get(id)?.parent,
         trail: (ids) => ({
            items: path.flatMap((n) => (n.item && ids.includes(n.id) ? [n.item] : [])),
            issues: [],
         }),
      }
   }
}

const said = (view: SideView, ids: readonly string[]) =>
   view
      .trail(ids)
      .items.map((i) => (i.kind === "prompt" || i.kind === "text" ? i.text : i.kind))

class Pair {
   readonly a = new Side("a")
   readonly b = new Side("b")
   ledger: Delivery[] = []
   #n = 0

   prompt(text: string): { toA: string[]; toB: string[] } {
      const toA = this.#deliver("a", this.b.leaf, { ridesWith: text })
      const before = this.a.leaf
      const entry = this.a.prompt(text)
      if (toA.chunk !== undefined) this.a.add(undefined, [toA.chunk])
      const toB = this.#deliver("b", before, { paired: entry, prompts: [text] })
      this.b.add(undefined, toB.chunk === undefined ? [] : [toB.chunk])
      return { toA: toA.said, toB: toB.said }
   }

   #deliver(
      to: "a" | "b",
      through: string | null,
      extra: { ridesWith?: string; paired?: string; prompts?: string[] },
   ): { said: string[]; chunk?: string } {
      const [receiver, peer] = to === "a" ? [this.a, this.b] : [this.b, this.a]
      const view = peer.view()
      const due = owed(this.ledger, to, receiver.view(), view, through)
      const told = said(view, due.ids)
      if (due.ids.length === 0 && extra.paired === undefined) return { said: told }
      const chunk = sha256Hex(`${to}${++this.#n}`)
      this.ledger.push({
         id: `d${this.#n}`,
         to,
         chunks: [chunk],
         ids: extra.paired === undefined ? due.ids : [...due.ids, extra.paired],
         ahead: [],
         prompts: extra.prompts ?? [],
         ...(receiver.leaf === null ? {} : { sentAfter: receiver.leaf }),
         ...(extra.ridesWith === undefined ? {} : { ridesWith: extra.ridesWith }),
         ...(due.floor === undefined ? {} : { floor: due.floor }),
      })
      return { said: told, chunk }
   }
}

test("1: a normal prompt carries each side's news; the shared prompt is never re-sent", () => {
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

test("5: Esc-Esc in A past a shared prompt: what rode on it reaches A within one prompt", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   pair.b.answer("B1")
   pair.prompt("U2")
   const a2 = pair.a.answer("A2")
   pair.b.answer("B2")
   assert.deepEqual(pair.prompt("U3"), { toA: ["B2"], toB: ["A2"] })
   pair.a.answer("A3")
   pair.b.answer("B3")
   pair.a.edit(a2)
   assert.deepEqual(
      pair.prompt("U3, edited"),
      { toA: ["B3"], toB: [] },
      "the hook still sees the old branch",
   )
   pair.a.answer("A3'")
   pair.b.answer("B3'")
   assert.deepEqual(pair.prompt("U4").toA, ["B2", "B3'"], "B2 rode on the abandoned U3")
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
   assert.deepEqual(pair.prompt("U4"), { toA: [], toB: ["A1", "U2", "A2", "U3", "A3"] })
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

test("8b: a message typed during Bx, resubmitted after the rewind, reaches A as a pane turn", () => {
   const pair = new Pair()
   pair.prompt("U1")
   pair.a.answer("A1")
   const b1 = pair.b.answer("B1")
   pair.b.prompt("[elision request …]")
   pair.b.answer("1,3")
   pair.b.rewind(b1)
   pair.b.prompt("typed during Bx")
   pair.b.answer("answer to it")
   assert.deepEqual(pair.prompt("U2").toA, ["B1", "typed during Bx", "answer to it"])
})

test("9: a new pairing starts from the peer's last turn, never earlier", () => {
   const pair = new Pair()
   pair.a.prompt("ancient")
   pair.a.answer("ancient answer")
   pair.a.prompt("U1")
   const a1 = pair.a.answer("A1")
   assert.deepEqual(pair.prompt("U2").toB, ["U1", "A1"])
   pair.b.rewind(null)
   pair.a.rewind(a1)
   assert.deepEqual(
      pair.prompt("U2 again").toB,
      ["U1", "A1"],
      "B lost everything: everything since the floor, nothing before it",
   )
})

test("10: deliveries before a compaction boundary still count as had", () => {
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
         attachment: { type: "hook_additional_context", content: [`${sent}\r\n`] },
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
   const carrier = (text: string) => carrierHash(sha256Hex, text)
   const a = ccView(transcript, { carrier })
   const b = new Side("b")
   const b1 = b.answer("B1")
   b.answer("B2")
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "a",
         chunks: [carrier(sent)],
         ids: [b1],
         ahead: [],
         prompts: [],
         floor: null,
      },
   ]
   assert.deepEqual(owed(ledger, "a", a, b.view()).ids, ["b2"])
})

test("Stop lag: A's final text and a queued prompt sent ahead of the transcript count once", () => {
   const a = new Side("a")
   const b = new Side("b")
   a.prompt("U1")
   const call = a.add({ kind: "call", id: "t1", name: "Read", input: {} })
   const ahead: Anchor[] = [{ text: "A1 final." }, { prompt: "U2" }]
   b.add(undefined, ["h"])
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "b",
         chunks: ["h"],
         ids: [call],
         ahead,
         prompts: ["U2"],
         floor: null,
      },
   ]
   b.answer("B2")
   a.answer("A1 final.")
   a.prompt("U2")
   a.answer("A2")
   assert.deepEqual(said(a.view(), owed(ledger, "b", b.view(), a.view()).ids), [
      "U1",
      "A2",
   ])
})

test("Stop lag: a later sentence repeating A's final text is still sent", () => {
   const a = new Side("a")
   const b = new Side("b")
   const p1 = a.prompt("U1")
   b.add(undefined, ["h"])
   const ledger: Delivery[] = [
      {
         id: "d1",
         to: "b",
         chunks: ["h"],
         ids: [p1],
         ahead: [{ text: "Done." }],
         prompts: [],
         floor: null,
      },
   ]
   a.answer("Done.")
   a.prompt("U2")
   a.answer("Done.")
   assert.deepEqual(said(a.view(), owed(ledger, "b", b.view(), a.view()).ids), [
      "U2",
      "Done.",
   ])
})

test("a delivery is had while pending; once its prompt lands without it, it failed", () => {
   const a = new Side("a")
   const b = new Side("b")
   const b1 = b.answer("B1")
   const tail = a.answer("A0")
   const d: Delivery = {
      id: "d1",
      to: "a",
      chunks: ["h"],
      ids: [b1],
      ahead: [],
      prompts: [],
      sentAfter: tail,
      ridesWith: "U1",
      floor: null,
   }
   assert.equal(status(d, a.view()), "pending")
   assert.deepEqual([...have([d], "a", a.view(), b.view())], [b1])
   a.add({ kind: "text", text: "tool chatter mid-turn" })
   assert.equal(status(d, a.view()), "pending", "a mid-turn prompt's entry comes later")
   a.prompt("U1")
   assert.equal(status(d, a.view()), "failed")
   assert.deepEqual(owed([d], "a", a.view(), b.view()).ids, [b1])
})

test("a delivery missing one of its chunks is not had at all", () => {
   const a = new Side("a")
   const b = new Side("b")
   const b1 = b.answer("B1")
   a.prompt("U1")
   a.add(undefined, ["c1"])
   const d: Delivery = {
      id: "d1",
      to: "a",
      chunks: ["c1", "c2"],
      ids: [b1],
      ahead: [],
      prompts: [],
      floor: null,
   }
   assert.equal(status(d, a.view()), "failed")
   assert.deepEqual(owed([d], "a", a.view(), b.view()).ids, [b1])
})

test("three failed deliveries in a row mean matching is broken", () => {
   const a = new Side("a")
   const ledger: Delivery[] = []
   const submit = (prompt: string) => {
      ledger.push({
         id: prompt,
         to: "a",
         chunks: [prompt],
         ids: [],
         ahead: [],
         prompts: [],
         ridesWith: prompt,
         ...(a.leaf === null ? {} : { sentAfter: a.leaf }),
      })
      a.prompt(prompt)
   }
   submit("U1")
   submit("U2")
   assert.equal(matchBroken(ledger, "a", a.view()), false)
   submit("U3")
   assert.equal(matchBroken(ledger, "a", a.view()), true)
})

test("the ledger rebuilds from its sidecar lines; malformed lines are skipped", () => {
   const d1: Delivery = {
      id: "d1",
      to: "b",
      chunks: ["h1"],
      ids: ["a1"],
      ahead: [{ prompt: "U1" }],
      prompts: ["U1"],
      floor: null,
   }
   const d2: Delivery = {
      id: "d2",
      to: "a",
      chunks: ["h2"],
      ids: [],
      ahead: [],
      prompts: [],
   }
   const lines = [
      ledgerLine.delivered(d1),
      { what: "display", turn: 1 },
      ledgerLine.delivered(d2),
      ledgerLine.lost("d2"),
      { what: "delivered", delivery: { id: 3 } },
   ]
   assert.deepEqual(ledgerFromLines(JSON.parse(JSON.stringify(lines))), [d1])
})
