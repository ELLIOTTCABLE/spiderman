import {
   appendFileSync,
   existsSync,
   mkdirSync,
   readFileSync,
   renameSync,
   rmSync,
   writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
   ELISION_TIMEOUT_MS,
   MEDIATOR_SYSTEM_PROMPT,
   mediatorInput,
} from "../core/elision.ts"
import { STATE_DIR } from "../core/protocol.ts"
import { STANDING_FOR_B } from "../core/standing.ts"
import { sha256Hex } from "../core/store.ts"
import { defaultTurnConfig } from "../core/turns.ts"
import { type PeerFileFs, removePeerFile, writePeerFile } from "./peer-file.ts"
import { type BSide, Runtime, type RuntimeFs } from "./runtime.ts"
import { type HookServer, startHookServer } from "./server.ts"

const FLAGS = {
   strategy: {
      name: "spiderman-strategy",
      default: "mediator",
      help: "elision: mediator | off",
   },
   mediator: {
      name: "spiderman-mediator",
      default: "",
      help: "mediator model, provider/id, matched exactly; default: B's own model and thinking level",
   },
   providers: {
      name: "spiderman-providers",
      default: "openai-codex",
      help: "comma-separated providers B may run on; anything else is refused",
   },
   promptWait: {
      name: "spiderman-prompt-wait",
      default: "25",
      help: "seconds a prompt waits for B's previous answer (keep under the hook timeout)",
   },
   stopWait: {
      name: "spiderman-stop-wait",
      default: "300",
      help: "seconds Stop waits for B's answer before a notice",
   },
   solo: {
      name: "spiderman-solo",
      default: "~",
      help: "prompt prefix that skips B for a turn",
   },
} as const

interface Session {
   readonly server: HookServer
   readonly runtime: Runtime
   readonly stateDir: string
   ctx: ExtensionContext
}

const nodeFs: RuntimeFs & PeerFileFs = {
   mkdirSync: (path, options) => mkdirSync(path, options),
   writeFileSync: (path, data, options) => writeFileSync(path, data, options),
   renameSync: (from, to) => renameSync(from, to),
   readFileSync: (path, encoding) => readFileSync(path, encoding),
   rmSync: (path, options) => rmSync(path, options),
   readText(path) {
      try {
         return readFileSync(path, "utf8")
      } catch {
         return undefined
      }
   },
   writeText(path, data) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
   },
   appendFileSync: (path, data) => appendFileSync(path, data),
   exists: (path) => existsSync(path),
}

export default function spiderman(pi: ExtensionAPI): void {
   for (const flag of Object.values(FLAGS)) {
      pi.registerFlag(flag.name, {
         type: "string",
         default: flag.default,
         description: flag.help,
      })
   }
   const flag = (key: keyof typeof FLAGS) => {
      const value = pi.getFlag(FLAGS[key].name)
      return typeof value === "string" && value !== "" ? value : FLAGS[key].default
   }
   const seconds = (key: keyof typeof FLAGS) => {
      const n = Number(flag(key))
      return (Number.isFinite(n) && n > 0 ? n : Number(FLAGS[key].default)) * 1_000
   }

   let session: Session | undefined

   const stop = async () => {
      const current = session
      session = undefined
      if (current === undefined) return
      current.runtime.dispose()
      removePeerFile(current.stateDir, current.server.token, nodeFs)
      await current.server.close()
   }

   const start = async (ctx: ExtensionContext): Promise<Session> => {
      const stateDir = `${ctx.cwd}/${STATE_DIR}`
      const providers = flag("providers")
         .split(",")
         .map((p) => p.trim())
      const sessionFile = ctx.sessionManager.getSessionFile()
      const logPath =
         sessionFile === undefined
            ? `${stateDir}/log.jsonl`
            : `${sessionFile}.spiderman.jsonl`
      mkdirSync(dirname(logPath), { recursive: true })
      // the sidecar is best-effort: a failed log line must never fail a turn
      const log = (entry: Record<string, unknown>) => {
         try {
            appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
         } catch {}
      }
      const live = () => session?.ctx ?? ctx

      const b: BSide = {
         send(text) {
            const c = live()
            const provider = c.model?.provider
            if (provider === undefined || !providers.includes(provider)) {
               c.ui.notify(
                  `spiderman: B's provider is ${provider ?? "unset"}, not one of ${providers.join(", ")}; the human's prompt was not sent to B.`,
                  "error",
               )
               return { ok: false, reason: `model guard: ${provider}` }
            }
            if (!c.isIdle()) return { ok: false, reason: "busy" }
            pi.sendUserMessage(text)
            return { ok: true }
         },
         leafId: () => live().sessionManager.getLeafId() ?? undefined,
         messagesSince(leaf) {
            const branch = live().sessionManager.getBranch()
            const at = leaf === undefined ? -1 : branch.findIndex((e) => e.id === leaf)
            return branch.slice(at + 1).flatMap((e): unknown[] => {
               if (e.type === "message") return [e.message]
               // pi-side subagent reports arrive as custom messages
               return e.type === "custom_message" &&
                  e.customType === "subagent-notification"
                  ? [
                       {
                          role: "custom",
                          customType: e.customType,
                          content: e.content,
                          details: e.details,
                       },
                    ]
                  : []
            })
         },
      }

      const runtime = new Runtime({
         now: Date.now,
         setTimer(ms, run) {
            const timer = setTimeout(run, ms)
            timer.unref?.()
            return () => clearTimeout(timer)
         },
         hash: sha256Hex,
         fs: nodeFs,
         projectDir: ctx.cwd,
         sessionId: ctx.sessionManager.getSessionId(),
         b,
         ...(flag("strategy") === "off"
            ? {}
            : { mediate: mediator(live, flag("mediator"), providers, log) }),
         log,
         config: {
            ...defaultTurnConfig,
            soloPrefix: flag("solo"),
            promptWaitMs: seconds("promptWait"),
            stopWaitMs: seconds("stopWait"),
            chunkDelayMs: 250,
            startTimeoutMs: 15_000,
         },
      })
      const server = await startHookServer((request) => runtime.handle(request))
      writePeerFile(
         stateDir,
         {
            version: 1,
            port: server.port,
            token: server.token,
            pid: process.pid,
            piSessionId: ctx.sessionManager.getSessionId(),
         },
         nodeFs,
      )
      log({ what: "start", port: server.port, at: Date.now() })
      return { server, runtime, stateDir, ctx }
   }

   pi.on("session_start", async (_event, ctx) => {
      await stop()
      session = await start(ctx)
   })
   pi.on("session_shutdown", async () => {
      await stop()
   })
   // byte-identical every turn, so it stays in B's cached prefix
   pi.on("before_agent_start", (event) =>
      event.systemPrompt.endsWith(STANDING_FOR_B)
         ? undefined
         : { systemPrompt: event.systemPrompt + STANDING_FOR_B },
   )
   // /tree moves B's leaf under the protocol and skips the input swallow; /fork re-pairs fine
   pi.on("session_before_tree", (_event, ctx) => {
      ctx.ui.notify(
         "spiderman: type in Claude Code. /tree here would desync the peer.",
         "warning",
      )
      return { cancel: true }
   })
   pi.on("agent_start", (_event, ctx) => {
      if (session !== undefined) session.ctx = ctx
      session?.runtime.bStarted()
   })
   pi.on("agent_settled", (_event, ctx) => {
      if (session !== undefined) session.ctx = ctx
      session?.runtime.bSettled()
   })
   // typing here would desync the protocol; the human's prompts belong in Claude Code
   pi.on("input", (event, ctx) => {
      if (event.source !== "interactive") return { action: "continue" }
      ctx.ui.notify(
         "spiderman: type in Claude Code. This pane shows the peer's side.",
         "warning",
      )
      return { action: "handled" }
   })
}

function mediator(
   ctx: () => ExtensionContext,
   spec: string,
   providers: readonly string[],
   log: (entry: Record<string, unknown>) => void,
): (aText: string, bText: string) => Promise<string> {
   const slash = spec.indexOf("/")
   return async (aText, bText) => {
      const c = ctx()
      // exact lookup only: pi's fuzzy fallback can land on a pay-as-you-go provider
      const model =
         spec === ""
            ? c.model
            : slash > 0
              ? c.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))
              : undefined
      if (model === undefined)
         throw new Error(`mediator model ${spec || "(B's)"} not found`)
      if (!providers.includes(model.provider))
         throw new Error(
            `mediator provider ${model.provider} is not one of ${providers.join(", ")}`,
         )
      const thinking = c.thinkingLevel
      const response = await c.modelRegistry
         .streamSimple(
            model,
            {
               systemPrompt: MEDIATOR_SYSTEM_PROMPT,
               messages: [
                  {
                     role: "user",
                     content: [{ type: "text", text: mediatorInput(aText, bText) }],
                     timestamp: Date.now(),
                  },
               ],
            },
            {
               ...(thinking === undefined || thinking === "off"
                  ? {}
                  : { reasoning: thinking }),
               signal: AbortSignal.timeout(ELISION_TIMEOUT_MS),
            },
         )
         .result()
      log({
         what: "mediator",
         model: `${model.provider}/${model.id}`,
         thinking,
         usage: response.usage,
         stopReason: response.stopReason,
         at: Date.now(),
      })
      if (response.stopReason === "error" || response.stopReason === "aborted") {
         throw new Error(response.errorMessage ?? response.stopReason)
      }
      return response.content
         .flatMap((c) => (c.type === "text" ? [c.text] : []))
         .join("\n")
   }
}
