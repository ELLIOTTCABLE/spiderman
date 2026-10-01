import { ELISION_TIMEOUT_MS } from "./elision.ts"
import { isHumanPrompt } from "./human.ts"

/**
 * The turn state machine (ledger: "Turn state machine"), as a pure reducer. The pi extension
 * performs the effects: answering hook requests, starting B's turns, timers.
 */

export interface TurnConfig {
   /** a prompt starting with this is A-only; B still sees the exchange later, as trail */
   readonly soloPrefix: string
   /** how long an idle-time submit waits for B's previous turn; under the hook timeout */
   readonly promptWaitMs: number
   /** how long Stop waits for B's matching turn before showing a notice */
   readonly stopWaitMs: number
   /** how long a resolved request group answers its late duplicates */
   readonly dedupeWindowMs: number
   readonly retryMs: number
   /** kept clear of a hook's budget for work after a wait: chunk release; elision */
   readonly submitReserveMs: number
   readonly stopReserveMs: number
   /** Bx: B elides in an extra turn of its own, which keeps it busy until rewound */
   readonly bx: boolean
}

export const defaultTurnConfig: TurnConfig = {
   soloPrefix: "~",
   promptWaitMs: 25_000,
   stopWaitMs: 300_000,
   dedupeWindowMs: 60_000,
   retryMs: 2_000,
   submitReserveMs: 1_500,
   stopReserveMs: ELISION_TIMEOUT_MS + 5_000,
   bx: false,
}

export interface Part {
   readonly index: number
   readonly count: number
}

export type TurnEvent =
   | {
        readonly type: "sessionStart"
        readonly requestId: string
        readonly ccSessionId: string
        readonly source: string
     }
   | {
        readonly type: "submit"
        readonly requestId: string
        readonly part: Part
        readonly ccSessionId: string
        /** (session_id, prompt_id, sha(prompt)): prompt_id alone is stale mid-turn */
        readonly key: string
        readonly prompt: string
        readonly promptId?: string
        readonly source?: string
        /** how long the hook can still wait for its answer */
        readonly budgetMs?: number
     }
   | {
        readonly type: "stop"
        readonly requestId: string
        readonly part: Part
        readonly ccSessionId: string
        readonly key: string
        readonly promptId?: string
        readonly lastAssistantMessage?: string
        readonly budgetMs?: number
     }
   | {
        readonly type: "bSettled"
        readonly turn: number
        readonly outcome: BOutcome
        readonly answered: boolean
     }
   /** Bx is over, rewound or failed: B is free */
   | { readonly type: "bxDone"; readonly turn: number }
   /** starting B's turn failed (e.g. compaction in flight, model guard); its prompts go back */
   | { readonly type: "bFailed"; readonly turn: number; readonly reason: string }
   | { readonly type: "tick" }

export type BOutcome = "completed" | "error" | "aborted"

export type Reply =
   /** B's answers for A, as context */
   | { readonly kind: "deliver"; readonly turns: readonly number[] }
   /** one B answer, elided, for the human */
   | { readonly kind: "display"; readonly turn: number }
   | { readonly kind: "empty" }

export type TurnEffect =
   | {
        readonly type: "respond"
        readonly requestId: string
        readonly part: Part
        readonly reply: Reply
        /** for the human; only ever on part 1 */
        readonly notice?: string
     }
   | {
        readonly type: "startB"
        readonly turn: number
        readonly prompts: readonly string[]
        /** where A's transcript slice for B ends: before this prompt, or at the end */
        readonly until: { readonly promptId: string } | "end"
        readonly lastAssistantMessage?: string
     }
   | { readonly type: "startBx"; readonly turn: number; readonly aText: string }
   | { readonly type: "wake"; readonly at: number }
   | { readonly type: "log"; readonly what: string; readonly detail?: unknown }

interface Pending {
   readonly prompt: string
   readonly aIdleAtSubmit: boolean
   /** a fresh prompt_id, usable as A's slice end */
   readonly promptId: string | undefined
}

interface BTurn {
   readonly turn: number
   readonly settled: boolean
   readonly delivered: boolean
   readonly displayed: boolean
   readonly outcome?: BOutcome
   readonly answered?: boolean
   /** kept so a failed start can put them back */
   readonly prompts: readonly Pending[]
}

interface Waiter {
   readonly requestId: string
   readonly part: Part
}

interface Group {
   readonly key: string
   readonly kind: "submit" | "stop"
   readonly waiters: readonly Waiter[]
   /** set once answered; late duplicates get the same answer */
   readonly answer?: {
      readonly reply: Reply
      readonly notice?: string
      readonly at: number
   }
   readonly waitFor?: { readonly turn: number; readonly deadline: number }
   /** the Stop's `last_assistant_message`, for a Bx that starts once B settles */
   readonly aText?: string
}

export interface TurnState {
   readonly pairedSession: string | undefined
   readonly aRunning: boolean
   /** prompt_id of A's latest turn; a submit carrying it again is stale (mid-turn) */
   readonly aPromptId: string | undefined
   /** human prompts A has not yet reached a Stop for; a Stop with none owed shows nothing */
   readonly aOwed: number
   readonly pending: readonly Pending[]
   readonly bTurns: readonly BTurn[]
   readonly bRunning: number | undefined
   readonly bBlockedUntil: number | undefined
   readonly bFailures: number
   /** Bx in flight: B takes no new turn until it is rewound */
   readonly bx:
      | { readonly turn: number; readonly lastAssistantMessage: string | undefined }
      | undefined
   readonly groups: readonly Group[]
   readonly nextTurn: number
}

export const initialTurnState: TurnState = {
   pairedSession: undefined,
   aRunning: false,
   aPromptId: undefined,
   aOwed: 0,
   pending: [],
   bTurns: [],
   bRunning: undefined,
   bBlockedUntil: undefined,
   bFailures: 0,
   bx: undefined,
   groups: [],
   nextTurn: 1,
}

const NOT_PAIRED =
   "spiderman: another Claude Code session is paired with this peer; this session runs alone."
const PEER_SLOW =
   "spiderman: the peer is still answering; its answer reaches Claude with your next prompt."
const MAX_TIMER_RETRIES = 5

export function step(
   state: TurnState,
   event: TurnEvent,
   now: number,
   config: TurnConfig = defaultTurnConfig,
): { state: TurnState; effects: TurnEffect[] } {
   const m = new Machine(prune(state, now, config), now, config)
   m.handle(event)
   m.settleGroups()
   m.tryStartB()
   m.scheduleWake()
   return { state: m.state, effects: m.effects }
}

function prune(state: TurnState, now: number, config: TurnConfig): TurnState {
   const groups = state.groups.filter(
      (g) => g.answer === undefined || now - g.answer.at < config.dedupeWindowMs,
   )
   return groups.length === state.groups.length ? state : { ...state, groups }
}

class Machine {
   state: TurnState
   readonly effects: TurnEffect[] = []
   readonly #now: number
   readonly #config: TurnConfig

   constructor(state: TurnState, now: number, config: TurnConfig) {
      this.state = state
      this.#now = now
      this.#config = config
   }

   handle(event: TurnEvent) {
      switch (event.type) {
         case "sessionStart":
            return this.#sessionStart(event)
         case "submit":
            return this.#request(event, () => this.#submit(event))
         case "stop":
            return this.#request(event, () => this.#stop(event))
         case "bSettled":
            return this.#bSettled(event.turn, event.outcome, event.answered)
         case "bxDone":
            return this.#bxDone(event.turn)
         case "bFailed":
            return this.#bFailed(event.turn, event.reason)
         case "tick":
            return
      }
   }

   #sessionStart(event: Extract<TurnEvent, { type: "sessionStart" }>) {
      const paired = this.state.pairedSession
      // /clear starts a new CC session in the same terminal, so it takes the pair over
      if (
         paired === undefined ||
         paired === event.ccSessionId ||
         event.source === "clear"
      ) {
         this.state = { ...this.state, pairedSession: event.ccSessionId }
         this.#respond(
            { requestId: event.requestId, part: { index: 1, count: 1 } },
            { kind: "empty" },
         )
      } else {
         this.#respond(
            { requestId: event.requestId, part: { index: 1, count: 1 } },
            { kind: "empty" },
            NOT_PAIRED,
         )
      }
   }

   /** Dedupes the K identical hook calls of one event: the first does the work. */
   #request(
      event: Extract<TurnEvent, { type: "submit" | "stop" }>,
      first: () => Omit<Group, "key" | "kind" | "waiters">,
   ) {
      const waiter = { requestId: event.requestId, part: event.part }
      if (this.state.pairedSession === undefined) {
         this.state = { ...this.state, pairedSession: event.ccSessionId }
      }
      if (this.state.pairedSession !== event.ccSessionId) {
         this.#respond(waiter, { kind: "empty" }, NOT_PAIRED)
         return
      }
      const existing = this.state.groups.find(
         (g) => g.key === event.key && g.kind === event.type,
      )
      if (existing?.answer !== undefined) {
         this.#respond(waiter, existing.answer.reply, existing.answer.notice)
         return
      }
      if (existing !== undefined) {
         this.#updateGroup(
            existing.key,
            (g) => ({ ...g, waiters: [...g.waiters, waiter] }),
            existing.kind,
         )
         return
      }
      const group: Group = {
         key: event.key,
         kind: event.type,
         waiters: [waiter],
         ...first(),
      }
      this.state = { ...this.state, groups: [...this.state.groups, group] }
   }

   #submit(
      event: Extract<TurnEvent, { type: "submit" }>,
   ): Omit<Group, "key" | "kind" | "waiters"> {
      const fresh =
         event.promptId !== undefined && event.promptId !== this.state.aPromptId
      // a fresh prompt_id while "running" means A was interrupted (no Stop) and is idle again
      const aIdle = !this.state.aRunning || fresh
      const human = isHumanPrompt(event.prompt, event.source)
      const solo = event.prompt.startsWith(this.#config.soloPrefix)
      // unusual sources are logged so real use teaches us the vocabulary
      const source =
         event.source === undefined || event.source === "user"
            ? {}
            : { source: event.source }
      this.#log("submit", { aIdle, human, solo, ...source })

      if (aIdle) {
         this.state = {
            ...this.state,
            aRunning: true,
            aPromptId: event.promptId ?? this.state.aPromptId,
         }
      }
      if (!human) return { answer: { reply: { kind: "empty" }, at: this.#now } }
      this.state = { ...this.state, aOwed: this.state.aOwed + 1 }
      if (!solo) {
         const pending: Pending = {
            prompt: event.prompt,
            aIdleAtSubmit: aIdle,
            promptId: fresh ? event.promptId : undefined,
         }
         this.state = { ...this.state, pending: [...this.state.pending, pending] }
      }
      const running = this.state.bRunning
      if (aIdle && running !== undefined && !this.#turn(running)?.settled) {
         return {
            waitFor: {
               turn: running,
               deadline: this.#deadline(
                  this.#config.promptWaitMs,
                  event.budgetMs,
                  this.#config.submitReserveMs,
               ),
            },
         }
      }
      return { answer: { reply: this.#deliverUndelivered(), at: this.#now } }
   }

   #stop(
      event: Extract<TurnEvent, { type: "stop" }>,
   ): Omit<Group, "key" | "kind" | "waiters"> {
      const owed = this.state.aOwed
      const aText = event.lastAssistantMessage
      this.state = { ...this.state, aRunning: false, aOwed: Math.max(0, owed - 1) }
      const candidate = [...this.state.bTurns].reverse().find((t) => !t.displayed)
      // prompts held back by Bx get their B turn later; wait for that
      const queued =
         candidate === undefined &&
         this.state.bx !== undefined &&
         this.state.pending.length > 0
      this.#log("stop", { owed, candidate: candidate?.turn, queued })
      const group = (): Omit<Group, "key" | "kind" | "waiters"> => {
         if (owed === 0 || (candidate === undefined && !queued))
            return { answer: { reply: { kind: "empty" }, at: this.#now } }
         if (candidate?.settled)
            return {
               answer: { reply: this.#display(candidate.turn, aText), at: this.#now },
            }
         return {
            waitFor: {
               turn: candidate?.turn ?? this.state.nextTurn,
               deadline: this.#deadline(
                  this.#config.stopWaitMs,
                  event.budgetMs,
                  this.#config.stopReserveMs,
               ),
            },
            ...(aText === undefined ? {} : { aText }),
         }
      }
      const result = group()
      this.tryStartB(aText)
      return result
   }

   #bSettled(turn: number, outcome: BOutcome, answered: boolean) {
      this.#log("bSettled", { turn, outcome, answered })
      this.#updateTurn(turn, (t) => ({ ...t, settled: true, outcome, answered }))
      if (this.state.bRunning === turn)
         this.state = { ...this.state, bRunning: undefined, bFailures: 0 }
   }

   #bxDone(turn: number) {
      const bx = this.state.bx
      this.#log("bxDone", { turn })
      if (bx?.turn !== turn) return
      this.state = { ...this.state, bx: undefined }
      this.tryStartB(bx.lastAssistantMessage)
   }

   #bFailed(turn: number, reason: string) {
      this.#log("bFailed", { turn, reason })
      const failed = this.state.bTurns.find((t) => t.turn === turn)
      if (failed === undefined || this.state.bRunning !== turn) return
      const restored = failed.prompts
      this.state = {
         ...this.state,
         bRunning: undefined,
         bTurns: this.state.bTurns.filter((t) => t.turn !== turn),
         pending: [...restored, ...this.state.pending],
         bBlockedUntil: this.#now + this.#config.retryMs,
         bFailures: this.state.bFailures + 1,
      }
   }

   settleGroups() {
      for (const group of this.state.groups) {
         if (group.answer !== undefined || group.waitFor === undefined) continue
         const turn = this.#turn(group.waitFor.turn)
         const expired = this.#now >= group.waitFor.deadline
         if (!turn?.settled && !expired) continue
         const reply =
            group.kind === "stop"
               ? turn?.settled
                  ? this.#display(group.waitFor.turn, group.aText)
                  : ({ kind: "empty" } as const)
               : this.#deliverUndelivered()
         const notice = turn?.settled ? undefined : PEER_SLOW
         this.#answer(group, reply, notice)
      }
      for (const group of this.state.groups) {
         if (group.answer !== undefined && group.waiters.length > 0)
            this.#answer(group, group.answer.reply, group.answer.notice)
      }
   }

   tryStartB(lastAssistantMessage?: string) {
      const { pending, bRunning, bBlockedUntil, aRunning } = this.state
      const first = pending[0]
      if (first === undefined || bRunning !== undefined || this.state.bx !== undefined)
         return
      if (bBlockedUntil !== undefined && this.#now < bBlockedUntil) return
      if (!first.aIdleAtSubmit && aRunning) return

      const turn = this.state.nextTurn
      const until =
         first.aIdleAtSubmit && first.promptId !== undefined
            ? { promptId: first.promptId }
            : "end"
      this.state = {
         ...this.state,
         pending: [],
         bRunning: turn,
         bBlockedUntil: undefined,
         nextTurn: turn + 1,
         bTurns: [
            ...this.state.bTurns,
            {
               turn,
               settled: false,
               delivered: false,
               displayed: false,
               prompts: pending,
            },
         ],
      }
      this.effects.push({
         type: "startB",
         turn,
         prompts: pending.map((p) => p.prompt),
         until,
         ...(until === "end" && lastAssistantMessage !== undefined
            ? { lastAssistantMessage }
            : {}),
      })
   }

   scheduleWake() {
      const deadlines = this.state.groups.flatMap((g) =>
         g.answer === undefined && g.waitFor !== undefined ? [g.waitFor.deadline] : [],
      )
      const { bBlockedUntil, pending, bFailures } = this.state
      if (
         bBlockedUntil !== undefined &&
         pending.length > 0 &&
         bFailures <= MAX_TIMER_RETRIES
      ) {
         deadlines.push(bBlockedUntil)
      }
      if (deadlines.length > 0)
         this.effects.push({ type: "wake", at: Math.min(...deadlines) })
   }

   /** The configured wait, cut short so the hook still gets its answer within its budget. */
   #deadline(wait: number, budget: number | undefined, reserve: number): number {
      const room =
         budget === undefined ? wait : Math.max(0, Math.min(wait, budget - reserve))
      return this.#now + room
   }

   #deliverUndelivered(): Reply {
      const turns = this.state.bTurns
         .filter((t) => t.settled && !t.delivered)
         .map((t) => t.turn)
      if (turns.length === 0) return { kind: "empty" }
      for (const turn of turns) this.#updateTurn(turn, (t) => ({ ...t, delivered: true }))
      return { kind: "deliver", turns }
   }

   #display(turn: number, aText: string | undefined): Reply {
      this.#updateTurn(turn, (t) => ({ ...t, displayed: true }))
      const shown = this.#turn(turn)
      if (
         this.#config.bx &&
         shown?.outcome === "completed" &&
         shown.answered === true &&
         aText !== undefined &&
         aText.trim() !== "" &&
         this.state.bRunning === undefined &&
         this.state.bx === undefined
      ) {
         this.state = { ...this.state, bx: { turn, lastAssistantMessage: aText } }
         this.effects.push({ type: "startBx", turn, aText })
      }
      return { kind: "display", turn }
   }

   #answer(group: Group, reply: Reply, notice: string | undefined) {
      for (const waiter of group.waiters) this.#respond(waiter, reply, notice)
      const answer =
         notice === undefined
            ? { reply, at: this.#now }
            : { reply, notice, at: this.#now }
      this.#updateGroup(group.key, (g) => ({ ...g, waiters: [], answer }), group.kind)
   }

   #respond(waiter: Waiter, reply: Reply, notice?: string) {
      const shown = notice !== undefined && waiter.part.index === 1 ? { notice } : {}
      this.effects.push({
         type: "respond",
         requestId: waiter.requestId,
         part: waiter.part,
         reply,
         ...shown,
      })
   }

   #turn(turn: number): BTurn | undefined {
      return this.state.bTurns.find((t) => t.turn === turn)
   }

   #updateTurn(turn: number, f: (t: BTurn) => BTurn) {
      this.state = {
         ...this.state,
         bTurns: this.state.bTurns.map((t) => (t.turn === turn ? f(t) : t)),
      }
   }

   #updateGroup(key: string, f: (g: Group) => Group, kind?: Group["kind"]) {
      this.state = {
         ...this.state,
         groups: this.state.groups.map((g) =>
            g.key === key && (kind === undefined || g.kind === kind) ? f(g) : g,
         ),
      }
   }

   #log(what: string, detail?: unknown) {
      this.effects.push(
         detail === undefined ? { type: "log", what } : { type: "log", what, detail },
      )
   }
}
