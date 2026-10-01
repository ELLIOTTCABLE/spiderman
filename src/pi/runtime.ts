import { isAbsolute, join } from "node:path"
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
import { type IndexParse, parseIndices } from "../core/elision.ts"
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
   messagesSince(leafId: string | undefined): readonly unknown[]
}

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
   /** elision mediator; absent means strategy "off" (B shown in full) */
   readonly mediate?: (aText: string, bText: string) => Promise<string>
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
      if (this.#bRunning !== undefined)
         this.#bRunning = { ...this.#bRunning, started: true }
   }

   /** pi's `agent_settled`: the end of a run, including retries and compaction. */
   bSettled(): void {
      const running = this.#bRunning
      if (running === undefined) return
      this.#bRunning = undefined
      const data = this.#turns.get(running.turn)
      const messages = this.#deps.b.messagesSince(data?.leaf)
      const outcome = bOutcome(messages)
      this.#turns.set(running.turn, { ...data, leaf: data?.leaf, messages, outcome })
      this.#dispatch({ type: "bSettled", turn: running.turn, outcome })
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
      let parse: IndexParse = { kind: "ok", indices: [] }
      const started = this.#deps.now()
      if (this.#deps.mediate !== undefined && bText.trim() !== "") {
         try {
            parse = parseIndices(await this.#deps.mediate(aText, bText))
         } catch (error) {
            parse = { kind: "unparseable", reason: `mediator failed: ${String(error)}` }
         }
      }
      const shown = renderElided(bText, parse, aText)
      const rendered = shown.text
      this.#deps.log({
         what: "display",
         turn,
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
