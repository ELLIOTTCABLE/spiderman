import { isAbsolute, join } from "node:path"
import { splitBlocks } from "../core/blocks.ts"
import {
   bAnswerText,
   bMessage,
   bOutcome,
   dedupeKey,
   displayChunks,
   plainPaths,
   reconcileWithLast,
} from "../core/bridge.ts"
import { ccNewPrompt, ccView } from "../core/cc-trail.ts"
import { CHUNK_CHARS, chunkPackage, MAX_CHUNKS } from "../core/chunk.ts"
import {
   type Anchor,
   carrierHash,
   type Delivery,
   ledgerLine,
   matchBroken,
   owed,
   type SideView,
} from "../core/coherence.ts"
import {
   bxPrompt,
   ELISION_TIMEOUT_MS,
   type IndexParse,
   parseIndices,
} from "../core/elision.ts"
import { formatPeerPackage, type PackageEnv, packageText } from "../core/package.ts"
import type { Delivered } from "../core/pi-trail.ts"
import { type HookReply, type HookRequest, STATE_DIR } from "../core/protocol.ts"
import { renderElided } from "../core/render.ts"
import { peerStore, type StoreFs } from "../core/store.ts"
import type { Trail } from "../core/trail.ts"
import {
   type BOutcome,
   initialTurnState,
   type Part,
   type Reply,
   step,
   type TurnConfig,
   type TurnEffect,
   type TurnEvent,
   type TurnState,
} from "../core/turns.ts"
import { isRecord } from "../core/validate.ts"

export interface RuntimeFs extends StoreFs {
   readText(path: string): string | undefined
   /** creates parent directories; overwrites */
   writeText(path: string, data: string): void
   appendFileSync(path: string, data: string): void
   exists(path: string): boolean
   size(path: string): number | undefined
   readFrom(path: string, offset: number): string | undefined
}

export interface BSide {
   /** refuses (busy, compacting, model not allowed) rather than throwing */
   send(text: string): { ok: true } | { ok: false; reason: string }
   leafId(): string | undefined
   /** B's leaf, if a rewind can land exactly on it */
   rewindPoint(): string | undefined
   messagesSince(leafId: string | undefined): readonly unknown[]
   idsSince(leafId: string | undefined): readonly string[]
   view(options: {
      readonly delivered: (hash: string) => Delivered | undefined
      readonly never: ReadonlySet<string>
   }): SideView
   /** what followed `entryId` stays in the file but leaves B's context */
   rewind(entryId: string): Promise<Outcome>
   /** the run still settles */
   abort(): void
   bxRoom(): boolean
}

export type Outcome =
   | { readonly ok: true }
   | { readonly ok: false; readonly reason: string }

export type Elision =
   | { readonly strategy: "off" }
   | {
        readonly strategy: "mediator"
        readonly mediate: (aText: string, bText: string) => Promise<string>
     }
   | { readonly strategy: "bx" }

export interface RuntimeConfig extends TurnConfig {
   /** chunk k is released (k-1)·this after the first, so completion order is reading order */
   readonly chunkDelayMs: number
   /** a B turn that hasn't started by then is treated as a failed start */
   readonly startTimeoutMs: number
   readonly entryWaitMs: number
   readonly pollMs: number
}

export interface RuntimeDeps {
   readonly now: () => number
   /** returns a cancel function */
   readonly setTimer: (ms: number, run: () => void) => () => void
   readonly hash: (text: string) => string
   readonly fs: RuntimeFs
   readonly projectDir: string
   /** pi's session id: names turn files, so a new session never overwrites an old one */
   readonly sessionId: string
   readonly b: BSide
   readonly elision: Elision
   readonly log: (entry: Record<string, unknown>) => void
   readonly config: RuntimeConfig
   readonly restored?: {
      readonly ledger: readonly Delivery[]
      readonly never: readonly string[]
   }
   readonly bxDone?: () => void
}

interface BTurnData {
   readonly leaf: string | undefined
   readonly messages?: readonly unknown[]
   readonly outcome?: BOutcome
   readonly delivery?: string
}

interface BxRun {
   readonly turn: number
   readonly rewindTo: string
   readonly text: string
   readonly sentAt: number
   started: boolean
   readonly answer: Deferred<string>
}

const REWIND_TIMEOUT_MS = 15_000
const LOGGED_REPLY_CHARS = 200
const BUDGET = MAX_CHUNKS * CHUNK_CHARS
const OMITTED = "[earlier peer history omitted]"

/** The effectful shell around the turn reducer: hook requests in, B turns and replies out. */
export class Runtime {
   #state: TurnState = initialTurnState
   readonly #deps: RuntimeDeps
   readonly #stateDir: string
   readonly #requests = new Map<
      string,
      { request: HookRequest; resolve: (r: HookReply) => void }
   >()
   readonly #turns = new Map<number, BTurnData>()
   readonly #toA = new Map<number, string[]>()
   readonly #displays = new Map<number, Promise<string[]>>()
   readonly #submitted = new Map<string, number>()
   #ledger: Delivery[]
   readonly #never: Set<string>
   #aTranscript: string | undefined
   #bRunning: { turn: number; started: boolean; text: string } | undefined
   #bx: BxRun | undefined
   readonly #bxAnswers = new Map<number, Promise<string>>()
   #aside: { from: string | undefined } | undefined
   #runKind: { kind: "ours" | "bx" | "aside"; from: string | undefined } | undefined
   #breakerShown = false
   #cancelWake: (() => void) | undefined
   #nextId = 0
   #disposed = false

   constructor(deps: RuntimeDeps) {
      this.#deps = deps
      this.#stateDir = `${deps.projectDir}/${STATE_DIR}`
      this.#ledger = [...(deps.restored?.ledger ?? [])]
      this.#never = new Set(deps.restored?.never ?? [])
   }

   handle(request: HookRequest): Promise<HookReply> {
      const requestId = `q${++this.#nextId}`
      if (request.kind === "prompt" && request.promptId !== undefined) {
         const size = this.#deps.fs.size(request.transcriptPath)
         if (!this.#submitted.has(request.promptId) && size !== undefined)
            this.#submitted.set(request.promptId, size)
      }
      return new Promise((resolve) => {
         this.#requests.set(requestId, { request, resolve })
         this.#dispatch(this.#event(requestId, request), request)
      })
   }

   bxInFlight(): boolean {
      return this.#bx !== undefined
   }

   carriedPrompts(text: string): readonly string[] | undefined {
      const hash = this.#carrier(text)
      return this.#ledger.find((d) => d.to === "b" && d.chunks.includes(hash))?.prompts
   }

   bRunStarting(prompt: string): void {
      const from = this.#deps.b.leafId()
      if (this.#bx !== undefined && !this.#bx.started && prompt === this.#bx.text)
         this.#runKind = { kind: "bx", from }
      else if (this.#bRunning !== undefined && !this.#bRunning.started)
         this.#runKind = {
            kind: prompt === this.#bRunning.text ? "ours" : "aside",
            from,
         }
      else this.#runKind = { kind: "aside", from }
   }

   bStarted(): void {
      const run = this.#runKind ?? { kind: "aside", from: this.#deps.b.leafId() }
      this.#runKind = undefined
      if (run.kind === "bx" && this.#bx !== undefined) this.#bx.started = true
      else if (run.kind === "ours" && this.#bRunning !== undefined)
         this.#bRunning.started = true
      else {
         this.#aside = { from: run.from }
         this.#dispatch({ type: "asideStarted" })
      }
   }

   /** pi's `agent_settled`: the end of a run, including retries and compaction. */
   bSettled(): void {
      const bx = this.#bx
      if (bx?.started) {
         this.#bx = undefined
         this.#bxSettled(bx)
         return
      }
      if (this.#aside !== undefined) {
         this.#aside = undefined
         this.#dispatch({ type: "asideSettled" })
         return
      }
      const running = this.#bRunning
      if (running === undefined || !running.started) return
      this.#bRunning = undefined
      const data = this.#turns.get(running.turn)
      const messages = this.#deps.b.messagesSince(data?.leaf)
      const outcome = bOutcome(messages)
      this.#turns.set(running.turn, { ...data, leaf: data?.leaf, messages, outcome })
      this.#dispatch({
         type: "bSettled",
         turn: running.turn,
         outcome,
         answered: bAnswerText(messages).trim() !== "",
      })
   }

   dispose(): void {
      this.#disposed = true
      this.#cancelWake?.()
      for (const { resolve } of this.#requests.values()) resolve({})
      this.#requests.clear()
   }

   #event(requestId: string, request: HookRequest): TurnEvent {
      const { hash } = this.#deps
      switch (request.kind) {
         case "session-start":
            return {
               type: "sessionStart",
               requestId,
               ccSessionId: request.ccSessionId,
               source: request.source,
            }
         case "prompt":
            return {
               type: "submit",
               requestId,
               part: request.part,
               ccSessionId: request.ccSessionId,
               key: dedupeKey(
                  request.ccSessionId,
                  request.promptId,
                  request.prompt,
                  hash,
               ),
               prompt: request.prompt,
               ...(request.promptId === undefined ? {} : { promptId: request.promptId }),
               ...(request.source === undefined ? {} : { source: request.source }),
               ...(request.budgetMs === undefined ? {} : { budgetMs: request.budgetMs }),
            }
         case "stop":
            return {
               type: "stop",
               requestId,
               part: request.part,
               ccSessionId: request.ccSessionId,
               key: dedupeKey(
                  request.ccSessionId,
                  request.promptId,
                  request.lastAssistantMessage ?? "",
                  hash,
               ),
               ...(request.promptId === undefined ? {} : { promptId: request.promptId }),
               ...(request.lastAssistantMessage === undefined
                  ? {}
                  : { lastAssistantMessage: request.lastAssistantMessage }),
               ...(request.budgetMs === undefined ? {} : { budgetMs: request.budgetMs }),
            }
      }
   }

   #dispatch(event: TurnEvent, request?: HookRequest) {
      if (this.#disposed) return
      const { state, effects } = step(
         this.#state,
         event,
         this.#deps.now(),
         this.#deps.config,
      )
      this.#state = state
      if (request !== undefined && state.pairedSession === request.ccSessionId)
         this.#aTranscript = request.transcriptPath
      for (const effect of effects) this.#run(effect)
   }

   #run(effect: TurnEffect) {
      switch (effect.type) {
         case "respond":
            return this.#respond(
               effect.requestId,
               effect.part,
               effect.reply,
               effect.notice,
            )
         case "startB":
            return this.#startB(effect)
         case "startBx":
            return this.#startBx(effect)
         case "wake": {
            this.#cancelWake?.()
            const delay = Math.max(0, effect.at - this.#deps.now())
            this.#cancelWake = this.#deps.setTimer(delay, () =>
               this.#dispatch({ type: "tick" }),
            )
            return
         }
         case "log":
            return this.#deps.log({
               what: effect.what,
               detail: effect.detail,
               at: this.#deps.now(),
            })
      }
   }

   #respond(requestId: string, part: Part, reply: Reply, notice: string | undefined) {
      const pending = this.#requests.get(requestId)
      if (pending === undefined) return
      this.#requests.delete(requestId)
      const delay = (part.index - 1) * this.#deps.config.chunkDelayMs
      this.#render(reply, part, pending.request)
         .catch((error: unknown): HookReply => {
            this.#deps.log({
               what: "renderFailed",
               error: String(error),
               at: this.#deps.now(),
            })
            return {}
         })
         .then((rendered) => {
            const out = withNotice(rendered, notice)
            if (delay === 0) pending.resolve(out)
            else this.#deps.setTimer(delay, () => pending.resolve(out))
         })
   }

   async #render(reply: Reply, part: Part, request: HookRequest): Promise<HookReply> {
      switch (reply.kind) {
         case "empty":
            return {}
         case "deliver": {
            if (request.kind !== "prompt") return {}
            const chunks = this.#deliverToA(reply.delivery, part.count, request)
            const chunk = chunks[part.index - 1]
            return chunk === undefined ? {} : chunk
         }
         case "display": {
            const aText =
               request.kind === "stop" ? (request.lastAssistantMessage ?? "") : ""
            const chunk = (await this.#displayChunks(reply.turn, part.count, aText))[
               part.index - 1
            ]
            return chunk === undefined ? {} : { systemMessage: chunk }
         }
      }
   }

   #carrier = (text: string) => carrierHash(this.#deps.hash, text)

   #aView(transcriptPath: string, leaf?: string): SideView {
      const { fs } = this.#deps
      return ccView(fs.readText(transcriptPath) ?? "", {
         transcriptPath,
         exists: (p) => fs.exists(p),
         carrier: this.#carrier,
         ...(leaf === undefined ? {} : { leaf }),
      })
   }

   #bView(a: SideView): SideView {
      const aPrompts = new Set(
         a.live.flatMap((e) => (e.prompt === undefined ? [] : [e.prompt.trim()])),
      )
      const toB = new Map(
         this.#ledger
            .filter((d) => d.to === "b")
            .flatMap((d) => d.chunks.map((h) => [h, d] as const)),
      )
      return this.#deps.b.view({
         never: this.#never,
         delivered: (hash) => {
            const d = toB.get(hash)
            if (d === undefined) return undefined
            const asked =
               d.prompts.length > 0 && !d.prompts.some((p) => aPrompts.has(p.trim()))
            return { prompts: d.prompts, asked }
         },
      })
   }

   #bThrough(): string | null | undefined {
      if (this.#bx !== undefined) return this.#bx.rewindTo
      if (this.#bRunning !== undefined)
         return this.#turns.get(this.#bRunning.turn)?.leaf ?? null
      if (this.#aside !== undefined) return this.#aside.from ?? null
      return undefined
   }

   #deliverToA(
      delivery: number,
      count: number,
      request: Extract<HookRequest, { kind: "prompt" }>,
   ): HookReply[] {
      const cached = this.#toA.get(delivery)
      if (cached !== undefined)
         return cached.map((additionalContext) => ({ additionalContext }))
      this.#toA.set(delivery, [])
      const a = this.#aView(request.transcriptPath)
      if (matchBroken(this.#ledger, "a", a)) {
         if (this.#breakerShown) return []
         this.#breakerShown = true
         this.#deps.log({ what: "match-broken", to: "a", at: this.#deps.now() })
         return [
            {
               systemMessage:
                  "spiderman: Claude Code isn't keeping the peer's answers where spiderman can find them; it stopped re-sending them. Details are in pi's sidecar log.",
            },
         ]
      }
      const b = this.#bView(a)
      const due = owed(this.#ledger, "a", a, b, this.#bThrough())
      if (due.ids.length === 0) return []
      const { pkg, ids } = this.#fitted(due.ids, b)
      const tail = a.live.at(-1)?.id
      const fullPath = this.#writeState(
         `turns/${this.#deps.sessionId}/to-a-${delivery}.package.md`,
         packageText(pkg),
      )
      const chunks = chunkPackage(pkg, {
         maxChunks: count,
         maxChars: CHUNK_CHARS,
         fullPath,
      })
      this.#record({
         id: this.#deliveryId(),
         to: "a",
         chunks: chunks.map(this.#carrier),
         ids,
         ahead: [],
         prompts: [],
         ...(tail === undefined ? {} : { sentAfter: tail }),
         ridesWith: request.prompt,
         ...(due.floor === undefined ? {} : { floor: due.floor }),
      })
      this.#toA.set(delivery, chunks)
      return chunks.map((additionalContext) => ({ additionalContext }))
   }

   /** over budget: newest entries kept, oldest still count as sent; marked once */
   #fitted(
      ids: readonly string[],
      view: SideView,
      extend: (trail: Trail) => Trail = (t) => t,
   ): { pkg: ReturnType<typeof formatPeerPackage>; ids: readonly string[] } {
      const env = this.#packageEnv()
      let kept = ids
      let pkg = formatPeerPackage(extend(view.trail(kept)), env)
      while (packageText(pkg).length > BUDGET && kept.length > 1) {
         kept = kept.slice(Math.ceil(kept.length / 4))
         const trimmed = formatPeerPackage(extend(view.trail(kept)), env)
         const [opening, ...rest] = trimmed.segments
         pkg = {
            ...trimmed,
            segments:
               opening === undefined
                  ? rest
                  : [opening, { kind: "frame", text: OMITTED }, ...rest],
         }
      }
      return { pkg, ids }
   }

   #record(delivery: Delivery) {
      this.#ledger.push(delivery)
      this.#deps.log({ ...ledgerLine.delivered(delivery), at: this.#deps.now() })
   }

   #deliveryId(): string {
      return `d${this.#deps.now().toString(36)}-${++this.#nextId}`
   }

   #displayChunks(turn: number, count: number, aText: string): Promise<string[]> {
      const cached = this.#displays.get(turn)
      if (cached !== undefined) return cached
      const made = this.#makeDisplay(turn, count, aText)
      this.#displays.set(turn, made)
      return made
   }

   async #makeDisplay(turn: number, count: number, aText: string): Promise<string[]> {
      const data = this.#turns.get(turn)
      const bText = bAnswerText(data?.messages ?? [])
      const fullPath = this.#writeState(
         `turns/${this.#deps.sessionId}/b-${turn}.md`,
         bText,
      )
      const started = this.#deps.now()
      const parse =
         bText.trim() === "" ? none : await this.#elide(turn, aText, bText, data?.outcome)
      const shown = renderElided(bText, parse, aText)
      const rendered = shown.text
      this.#deps.log({
         what: "display",
         turn,
         strategy: this.#deps.elision.strategy,
         bChars: bText.length,
         shownChars: rendered.length,
         indices: parse.kind === "ok" ? parse.indices : parse.reason,
         elided: shown.elided,
         vetoed: shown.vetoed,
         elisionMs: this.#deps.now() - started,
         at: this.#deps.now(),
      })
      const outcome = data?.outcome
      const note =
         outcome === undefined || outcome === "completed"
            ? undefined
            : `peer turn ${outcome}`
      return displayChunks(
         rendered,
         note === undefined
            ? { maxChunks: count, fullPath }
            : { maxChunks: count, fullPath, note },
      )
   }

   async #elide(
      turn: number,
      aText: string,
      bText: string,
      outcome: BOutcome | undefined,
   ): Promise<IndexParse> {
      const { elision } = this.#deps
      switch (elision.strategy) {
         case "off":
            return none
         case "mediator":
            try {
               return parseIndices(await elision.mediate(aText, bText))
            } catch (error) {
               return unparseable(`mediator failed: ${String(error)}`)
            }
         case "bx": {
            const answer = this.#bxAnswers.get(turn)
            if (answer === undefined) {
               // the reducer skips these on purpose; otherwise B was occupied
               return outcome !== "completed" || aText.trim() === ""
                  ? none
                  : unparseable("B was busy, so no elision turn")
            }
            try {
               return parseIndices(await answer)
            } catch (error) {
               return unparseable(`elision turn failed: ${errorText(error)}`)
            }
         }
      }
   }

   #startBx(effect: Extract<TurnEffect, { type: "startBx" }>) {
      const { b, config, now, setTimer } = this.#deps
      const answer = deferred<string>()
      this.#bxAnswers.set(effect.turn, answer.promise)
      const bText = bAnswerText(this.#turns.get(effect.turn)?.messages ?? [])
      const rewindTo = b.rewindPoint()
      // a compaction it set off would be rewound away, and then happen again
      const refusal =
         rewindTo === undefined
            ? "B's last entry is no point to rewind to"
            : b.bxRoom()
              ? undefined
              : "B's context is near compaction"
      if (refusal !== undefined || rewindTo === undefined) {
         answer.reject(new Error(refusal ?? "no rewind point"))
         this.#bxDone(effect.turn, { sent: false, reason: refusal })
         return
      }
      const text = bxPrompt(effect.aText, splitBlocks(bText))
      const sent = b.send(text)
      if (!sent.ok) {
         answer.reject(new Error(`not sent: ${sent.reason}`))
         this.#bxDone(effect.turn, { sent: false, reason: sent.reason })
         return
      }
      const run: BxRun = {
         turn: effect.turn,
         rewindTo,
         text,
         sentAt: now(),
         started: false,
         answer,
      }
      this.#bx = run
      setTimer(config.startTimeoutMs, () => {
         if (this.#bx !== run || run.started) return
         this.#bx = undefined
         answer.reject(new Error("B did not start it"))
         this.#bxDone(run.turn, { sent: true, reason: "not started" })
      })
      // the display gives up; the aborted turn still settles, and so is rewound
      setTimer(ELISION_TIMEOUT_MS, () => {
         if (this.#bx !== run) return
         answer.reject(new Error("timed out"))
         b.abort()
      })
   }

   // synchronous inside pi's agent_settled, so pi defers the rewind command past the settle
   #bxSettled(run: BxRun) {
      const { b, now, setTimer } = this.#deps
      const messages = b.messagesSince(run.rewindTo)
      // never delivered, even if the rewind below fails
      const ids = b.idsSince(run.rewindTo)
      for (const id of ids) this.#never.add(id)
      this.#deps.log({ what: "never", ids, at: now() })
      const outcome = bOutcome(messages)
      const reply = bAnswerText(messages)
      if (outcome === "completed") run.answer.resolve(reply)
      else run.answer.reject(new Error(`B's turn ${outcome}`))
      const rewound = new Promise<Outcome>((resolve) => {
         setTimer(REWIND_TIMEOUT_MS, () => resolve({ ok: false, reason: "timed out" }))
         b.rewind(run.rewindTo).then(resolve, (error: unknown) =>
            resolve({ ok: false, reason: errorText(error) }),
         )
      })
      rewound.then((rewind) =>
         this.#bxDone(run.turn, {
            sent: true,
            outcome,
            reply: reply.slice(0, LOGGED_REPLY_CHARS),
            usage: usageOf(messages),
            rewind: rewind.ok ? "ok" : rewind.reason,
            bxMs: now() - run.sentAt,
         }),
      )
   }

   #bxDone(turn: number, detail: Record<string, unknown>) {
      this.#deps.log({ what: "bx", turn, ...detail, at: this.#deps.now() })
      queueMicrotask(() => {
         this.#dispatch({ type: "bxDone", turn })
         this.#deps.bxDone?.()
      })
   }

   #startB(effect: Extract<TurnEffect, { type: "startB" }>) {
      const transcriptPath = this.#aTranscript
      if (effect.until === "end" || transcriptPath === undefined) {
         this.#sendB(effect, undefined)
         return
      }
      const { promptId } = effect.until
      this.#awaitPrompt(transcriptPath, promptId, effect.prompts[0] ?? "").then(
         (entry) => {
            if (this.#disposed) return
            if (entry !== undefined) return this.#sendB(effect, entry)
            // another hook blocked it, or it never ran: A won't answer it, so B mustn't
            this.#deps.log({
               what: "promptNeverWritten",
               turn: effect.turn,
               at: this.#deps.now(),
            })
            this.#dispatch({ type: "bDropped", turn: effect.turn })
         },
      )
   }

   /** CC writes the prompt's entry only after its hooks return: wait, never guess */
   #awaitPrompt(
      path: string,
      promptId: string,
      prompt: string,
   ): Promise<string | undefined> {
      const { fs, now, setTimer, config } = this.#deps
      const offset = this.#submitted.get(promptId) ?? 0
      const deadline = now() + config.entryWaitMs
      return new Promise((resolve) => {
         const poll = () => {
            if (this.#disposed) return resolve(undefined)
            const tail = fs.readFrom(path, offset)
            const found =
               tail === undefined ? undefined : ccNewPrompt(tail, prompt, promptId)
            if (found !== undefined || now() >= deadline) return resolve(found)
            setTimer(config.pollMs, poll)
         }
         poll()
      })
   }

   #sendB(effect: Extract<TurnEffect, { type: "startB" }>, entry: string | undefined) {
      const { b, config, fs, projectDir } = this.#deps
      const transcriptPath = this.#aTranscript
      const a =
         transcriptPath === undefined ? undefined : this.#aView(transcriptPath, entry)
      let aPackage: string | undefined
      let ids: readonly string[] = []
      let floor: string | null | undefined
      const ahead: Anchor[] = []
      if (a !== undefined) {
         // the prompt itself goes as the human's message; its entry is how B "has" it
         const through = entry === undefined ? undefined : (a.parent(entry) ?? null)
         const due = owed(this.#ledger, "b", this.#bView(a), a, through)
         floor = due.floor
         const last = effect.lastAssistantMessage
         const extend = (trail: Trail) =>
            entry === undefined ? reconcileWithLast(trail, last) : trail
         if (entry === undefined) {
            // the transcript may lag at Stop: what we send ahead of it is matched later
            const sliced = a.trail(due.ids)
            if (reconcileWithLast(sliced, last) !== sliced && last !== undefined)
               ahead.push({ text: last })
            ahead.push(...effect.prompts.map((prompt) => ({ prompt })))
         }
         if (due.ids.length > 0 || ahead.some((x) => "text" in x)) {
            const fitted = this.#fitted(due.ids, a, extend)
            aPackage = packageText(fitted.pkg)
            ids = fitted.ids
         }
      }
      const prompts = effect.prompts.map((p) =>
         plainPaths(p, projectDir, (x) => fs.exists(x)),
      )
      const message = bMessage(aPackage, prompts)
      const leaf = b.leafId()
      const sent = b.send(message)
      this.#deps.log({
         what: "startB",
         turn: effect.turn,
         sent,
         entry: entry ?? effect.until,
         aPackageChars: aPackage?.length ?? 0,
         at: this.#deps.now(),
      })
      if (!sent.ok) {
         queueMicrotask(() =>
            this.#dispatch({ type: "bFailed", turn: effect.turn, reason: sent.reason }),
         )
         return
      }
      const delivery: Delivery = {
         id: this.#deliveryId(),
         to: "b",
         chunks: [this.#carrier(message)],
         ids: entry === undefined ? ids : [...ids, entry],
         ahead,
         prompts,
         ...(leaf === undefined ? {} : { sentAfter: leaf }),
         ...(floor === undefined ? {} : { floor }),
      }
      this.#record(delivery)
      this.#turns.set(effect.turn, { leaf, delivery: delivery.id })
      this.#bRunning = { turn: effect.turn, started: false, text: message }
      this.#deps.setTimer(config.startTimeoutMs, () => {
         if (this.#bRunning?.turn !== effect.turn || this.#bRunning.started) return
         this.#bRunning = undefined
         this.#ledger = this.#ledger.filter((d) => d.id !== delivery.id)
         this.#deps.log({ ...ledgerLine.lost(delivery.id), at: this.#deps.now() })
         this.#dispatch({ type: "bFailed", turn: effect.turn, reason: "B did not start" })
      })
   }

   #packageEnv(): PackageEnv {
      const { fs, hash, projectDir } = this.#deps
      const store = peerStore(this.#stateDir, fs, hash)
      return {
         refer: (text) => relativeState(store.put(text), this.#stateDir),
         cwd: projectDir,
         readFile: (path) =>
            fs.readText(isAbsolute(path) ? path : join(projectDir, path)),
      }
   }

   #writeState(relative: string, text: string): string {
      const path = `${this.#stateDir}/${relative}`
      this.#deps.fs.writeText(path, text)
      return relativeState(path, this.#stateDir)
   }
}

const none: IndexParse = { kind: "ok", indices: [] }

function unparseable(reason: string): IndexParse {
   return { kind: "unparseable", reason }
}

function errorText(error: unknown): string {
   return error instanceof Error ? error.message : String(error)
}

interface Deferred<T> {
   readonly promise: Promise<T>
   readonly resolve: (value: T) => void
   readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
   let resolve: (value: T) => void = () => {}
   let reject: (error: Error) => void = () => {}
   const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
   })
   // an undisplayed turn may still fail; that's no unhandled rejection
   promise.catch(() => {})
   return { promise, resolve, reject }
}

function usageOf(messages: readonly unknown[]): Record<string, number> {
   const total = { input: 0, cacheRead: 0, output: 0 }
   for (const message of messages) {
      if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage))
         continue
      for (const key of Object.keys(total) as (keyof typeof total)[]) {
         const n = message.usage[key]
         if (typeof n === "number") total[key] += n
      }
   }
   return total
}

function relativeState(path: string, stateDir: string): string {
   return path.startsWith(`${stateDir}/`)
      ? `${STATE_DIR}/${path.slice(stateDir.length + 1)}`
      : path
}

function withNotice(reply: HookReply, notice: string | undefined): HookReply {
   if (notice === undefined) return reply
   const systemMessage =
      reply.systemMessage === undefined ? notice : `${notice}\n\n${reply.systemMessage}`
   return { ...reply, systemMessage }
}
