import { isAbsolute, join } from "node:path"
import { splitBlocks } from "../core/blocks.ts"
import {
   type BLedger,
   bAnswerText,
   bMessage,
   bOutcome,
   dedupeKey,
   displayChunks,
   emptyLedger,
   lastMessageUuid,
   lastTurnStart,
   reconcileWithLast,
   sectioned,
   withoutDelivered,
} from "../core/bridge.ts"
import { type Cursor, ccTrail } from "../core/cc-trail.ts"
import { CHUNK_CHARS, chunkPackage } from "../core/chunk.ts"
import {
   bxPrompt,
   ELISION_TIMEOUT_MS,
   type IndexParse,
   parseIndices,
} from "../core/elision.ts"
import {
   formatPeerPackage,
   type PackageEnv,
   type PackageMemory,
   packageText,
} from "../core/package.ts"
import { piTrail } from "../core/pi-trail.ts"
import { type HookReply, type HookRequest, STATE_DIR } from "../core/protocol.ts"
import { renderElided } from "../core/render.ts"
import { peerStore, type StoreFs } from "../core/store.ts"
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
}

export interface BSide {
   /** refuses (busy, compacting, model not allowed) rather than throwing */
   send(text: string): { ok: true } | { ok: false; reason: string }
   leafId(): string | undefined
   /** B's leaf, if a rewind can land exactly on it */
   rewindPoint(): string | undefined
   messagesSince(leafId: string | undefined): readonly unknown[]
   /** moves B's leaf back to `entryId`: what followed stays in the file, out of B's context */
   rewind(entryId: string): Promise<Outcome>
   /** stops B's current run, which still settles */
   abort(): void
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
   /** B elides its own answer in an extra turn of its session, then is rewound over it */
   | { readonly strategy: "bx" }

export interface RuntimeConfig extends TurnConfig {
   /** chunk k is released (k-1)·this after the first, so completion order is reading order */
   readonly chunkDelayMs: number
   /** a B turn that hasn't started by then is treated as a failed start */
   readonly startTimeoutMs: number
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
}

interface BTurnData {
   readonly leaf: string | undefined
   readonly messages?: readonly unknown[]
   readonly outcome?: BOutcome
   /** the human messages this turn answered */
   readonly prompts?: readonly string[]
}

interface BxRun {
   readonly turn: number
   /** the entry before the elision prompt, where B's leaf goes back to */
   readonly leaf: string
   readonly sentAt: number
   started: boolean
   readonly answer: Deferred<string>
}

const REWIND_TIMEOUT_MS = 15_000
const LOGGED_REPLY_CHARS = 200

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
   readonly #deliveries = new Map<string, string[]>()
   readonly #displays = new Map<number, Promise<string[]>>()
   #aSession: string | undefined
   #aTranscript: string | undefined
   #aCut: Cursor | undefined
   /** per receiver: files it was already pointed at */
   #toA: PackageMemory | undefined
   #toB: PackageMemory | undefined
   /** keys of A's trail items and the human messages B already has */
   #bLedger: BLedger = emptyLedger
   #bRunning: { turn: number; started: boolean } | undefined
   #bx: BxRun | undefined
   /** per B turn: the elision turn's reply text */
   readonly #bxAnswers = new Map<number, Promise<string>>()
   #cancelWake: (() => void) | undefined
   #nextId = 0
   #disposed = false

   constructor(deps: RuntimeDeps) {
      this.#deps = deps
      this.#stateDir = `${deps.projectDir}/${STATE_DIR}`
   }

   handle(request: HookRequest): Promise<HookReply> {
      const requestId = `q${++this.#nextId}`
      return new Promise((resolve) => {
         this.#requests.set(requestId, { request, resolve })
         this.#dispatch(this.#event(requestId, request), request)
      })
   }

   bStarted(): void {
      if (this.#bx !== undefined) this.#bx.started = true
      else if (this.#bRunning !== undefined)
         this.#bRunning = { ...this.#bRunning, started: true }
   }

   /** pi's `agent_settled`: the end of a run, including retries and compaction. */
   bSettled(): void {
      const bx = this.#bx
      if (bx !== undefined) {
         this.#bx = undefined
         this.#bxSettled(bx)
         return
      }
      const running = this.#bRunning
      if (running === undefined) return
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
         this.#trackA(request)
      for (const effect of effects) this.#run(effect)
   }

   #trackA(request: HookRequest) {
      // a new CC session (e.g. /clear) has a new transcript file: its history isn't the peer's news
      if (request.ccSessionId !== this.#aSession) {
         this.#aSession = request.ccSessionId
         this.#aCut = undefined
      }
      this.#aTranscript = request.transcriptPath
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
            const chunk = this.#deliverChunks(reply.turns, part.count)[part.index - 1]
            return chunk === undefined ? {} : { additionalContext: chunk }
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

   #deliverChunks(turns: readonly number[], count: number): string[] {
      const key = `${turns.join(",")}/${count}`
      const cached = this.#deliveries.get(key)
      if (cached !== undefined) return cached
      const sections = turns.flatMap((turn) => {
         const data = this.#turns.get(turn)
         const trail = piTrail(data?.messages ?? [])
         // an empty peer block still costs A tokens on every later request
         if (trail.items.length === 0 && trail.issues.length === 0) return []
         const pkg = formatPeerPackage(trail, this.#packageEnv(), this.#toA)
         this.#toA = pkg.memory
         return [{ pkg, prompt: (data?.prompts ?? []).join(" / ") }]
      })
      if (sections.length === 0) return []
      const pkg = sectioned(sections)
      const fullPath = this.#writeState(
         `turns/${this.#deps.sessionId}/b-${turns.join("-")}.package.md`,
         packageText(pkg),
      )
      const chunks = chunkPackage(pkg, {
         maxChunks: count,
         maxChars: CHUNK_CHARS,
         fullPath,
      })
      this.#deliveries.set(key, chunks)
      return chunks
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
               // the reducer skips Bx for these on purpose; anything else found B occupied
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
      const leaf = b.rewindPoint()
      if (leaf === undefined) {
         answer.reject(new Error("B's last entry is no point to rewind to"))
         this.#bxDone(effect.turn, { sent: false, reason: "no rewind point" })
         return
      }
      const sent = b.send(bxPrompt(effect.aText, splitBlocks(bText)))
      if (!sent.ok) {
         answer.reject(new Error(`not sent: ${sent.reason}`))
         this.#bxDone(effect.turn, { sent: false, reason: sent.reason })
         return
      }
      const run: BxRun = {
         turn: effect.turn,
         leaf,
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
      // the display gives up here; the turn is stopped, and its settle still rewinds it
      setTimer(ELISION_TIMEOUT_MS, () => {
         if (this.#bx !== run) return
         answer.reject(new Error("timed out"))
         b.abort()
      })
   }

   /** Runs inside pi's `agent_settled`, so pi defers the rewind until the settle is done. */
   #bxSettled(run: BxRun) {
      const { b, now, setTimer } = this.#deps
      const messages = b.messagesSince(run.leaf)
      const outcome = bOutcome(messages)
      const reply = bAnswerText(messages)
      if (outcome === "completed") run.answer.resolve(reply)
      else run.answer.reject(new Error(`B's turn ${outcome}`))
      const rewound = new Promise<Outcome>((resolve) => {
         setTimer(REWIND_TIMEOUT_MS, () => resolve({ ok: false, reason: "timed out" }))
         b.rewind(run.leaf).then(resolve, (error: unknown) =>
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
      queueMicrotask(() => this.#dispatch({ type: "bxDone", turn }))
   }

   #startB(effect: Extract<TurnEffect, { type: "startB" }>) {
      const { fs, b, config } = this.#deps
      const transcriptPath = this.#aTranscript
      const transcript =
         transcriptPath === undefined ? undefined : fs.readText(transcriptPath)
      const until = effect.until === "end" ? undefined : effect.until
      // committed only once B accepts the message: a refused start is retried from the same place
      let ledger = this.#bLedger
      let toB = this.#toB
      let cut: Cursor | undefined = this.#aCut ?? until
      let aPackage: string | undefined

      if (transcript !== undefined && transcriptPath !== undefined) {
         // first B turn after pairing: A's last completed turn, not its whole history
         const after = this.#aCut ?? lastTurnStart(transcript, until?.promptId)
         if (after !== undefined) {
            const span = {
               ...(after === "top" ? {} : { after }),
               ...(until === undefined ? {} : { until }),
            }
            const sliced = ccTrail(transcript, span, {
               transcriptPath,
               exists: (p) => fs.exists(p),
            })
            const whole =
               until === undefined
                  ? reconcileWithLast(sliced, effect.lastAssistantMessage)
                  : sliced
            const fresh = withoutDelivered(whole, ledger)
            const trail = fresh.trail
            const appended = whole.items.length > sliced.items.length
            ledger = appended
               ? { ...fresh.ledger, reconciled: effect.lastAssistantMessage }
               : fresh.ledger
            if (trail.issues.length > 0) {
               this.#deps.log({
                  what: "aTrailIssues",
                  issues: trail.issues,
                  at: this.#deps.now(),
               })
            }
            if (trail.items.length > 0) {
               const pkg = formatPeerPackage(trail, this.#packageEnv(), toB)
               toB = pkg.memory
               aPackage = packageText(pkg)
            }
         }
         const uuid = lastMessageUuid(transcript)
         cut = until ?? (uuid === undefined ? cut : { uuid })
      }
      ledger = {
         ...ledger,
         prompts: [...ledger.prompts, ...effect.prompts.map((p) => p.trim())],
      }

      const leaf = b.leafId()
      const sent = b.send(bMessage(aPackage, effect.prompts))
      this.#deps.log({
         what: "startB",
         turn: effect.turn,
         sent,
         aPackageChars: aPackage?.length ?? 0,
         at: this.#deps.now(),
      })
      if (!sent.ok) {
         queueMicrotask(() =>
            this.#dispatch({ type: "bFailed", turn: effect.turn, reason: sent.reason }),
         )
         return
      }
      this.#aCut = cut
      this.#toB = toB
      this.#bLedger = ledger
      this.#turns.set(effect.turn, { leaf, prompts: effect.prompts })
      this.#bRunning = { turn: effect.turn, started: false }
      this.#deps.setTimer(config.startTimeoutMs, () => {
         if (this.#bRunning?.turn !== effect.turn || this.#bRunning.started) return
         this.#bRunning = undefined
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
   // a turn nobody displays may still fail; that is no unhandled rejection
   promise.catch(() => {})
   return { promise, resolve, reject }
}

/** Token counts across a turn's assistant messages, as the provider reported them. */
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
