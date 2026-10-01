// Thin Claude Code hook: stdin → validate → POST to the pi extension → one JSON object on stdout.
// It never blocks, never exits non-zero, and never prints raw text: any failure means "no peer
// this time", and the prompt goes to Claude unchanged.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
   HOOK_MARGIN_MS,
   HOOK_PATH,
   HOOKS,
   type HookEvent,
   type HookRequest,
   hookOutput,
   hookReply,
   PEER_FILE,
   peerFile,
   STATE_DIR,
   sessionStartInput,
   stopInput,
   userPromptSubmitInput,
} from "../../src/core/protocol.ts"
import { STANDING_FOR_A } from "../../src/core/standing.ts"
import { ensureStateDir } from "../../src/core/store.ts"
import { validate } from "../../src/core/validate.ts"

const NO_PEER_EVERY_MS = 10 * 60_000
const NO_PEER =
   "spiderman: no peer is running for this project (start pi with the spiderman extension); prompts go to Claude alone."

const started = Date.now()
const [eventArg, indexArg, countArg] = process.argv.slice(2)

main()
   .catch(() => ({}))
   .then((output) => {
      process.stdout.write(`${JSON.stringify(output)}\n`)
      process.exitCode = 0
   })

async function main(): Promise<Record<string, unknown>> {
   const event = parseEvent(eventArg)
   if (event === undefined) return {}
   // static, so they reach Claude whether or not pi is up yet: start order doesn't matter
   const standing =
      event === "SessionStart"
         ? hookOutput(event, { additionalContext: STANDING_FOR_A })
         : {}
   return { ...standing, ...(await exchange(event).catch(() => ({}))) }
}

async function exchange(event: HookEvent): Promise<Record<string, unknown>> {
   const index = Number(indexArg ?? 1)
   const count = Number(countArg ?? 1)
   if (!(index >= 1 && index <= count)) return {}

   const input: unknown = JSON.parse(await readStdin())
   const request = toRequest(event, input, { index, count })
   if (request === undefined) return {}

   const projectDir = process.env.CLAUDE_PROJECT_DIR || request.cwd
   const stateDir = join(projectDir, STATE_DIR)
   const peer = readPeer(stateDir)
   if (peer === undefined) return noPeer(event, index, stateDir)

   // the server clamps its waits to this, so hooks.json and pi's flags can't drift apart
   const budgetMs = Math.max(
      0,
      HOOKS[event].timeoutS * 1_000 - HOOK_MARGIN_MS - (Date.now() - started),
   )
   const body =
      request.body.kind === "session-start" ? request.body : { ...request.body, budgetMs }
   try {
      const res = await fetch(`http://127.0.0.1:${peer.port}${HOOK_PATH}`, {
         method: "POST",
         headers: {
            authorization: `Bearer ${peer.token}`,
            "content-type": "application/json",
         },
         body: JSON.stringify(body),
         signal: AbortSignal.timeout(budgetMs),
      })
      const reply = validate(hookReply, await res.json())
      return reply.ok ? hookOutput(event, reply.value) : {}
   } catch {
      return noPeer(event, index, stateDir)
   }
}

function parseEvent(arg: string | undefined): HookEvent | undefined {
   return arg === "SessionStart" || arg === "UserPromptSubmit" || arg === "Stop"
      ? arg
      : undefined
}

function toRequest(
   event: HookEvent,
   input: unknown,
   part: { index: number; count: number },
): { body: HookRequest; cwd: string } | undefined {
   if (event === "SessionStart") {
      const v = validate(sessionStartInput, input)
      if (!v.ok) return undefined
      const { session_id, source, transcript_path, cwd } = v.value
      return {
         cwd,
         body: {
            kind: "session-start",
            ccSessionId: session_id,
            source,
            transcriptPath: transcript_path,
            cwd,
         },
      }
   }
   if (event === "UserPromptSubmit") {
      const v = validate(userPromptSubmitInput, input)
      if (!v.ok) return undefined
      const { session_id, prompt, prompt_id, source, transcript_path, cwd } = v.value
      return {
         cwd,
         body: {
            kind: "prompt",
            ccSessionId: session_id,
            prompt,
            transcriptPath: transcript_path,
            cwd,
            part,
            ...(prompt_id === undefined ? {} : { promptId: prompt_id }),
            ...(source === undefined ? {} : { source }),
         },
      }
   }
   const v = validate(stopInput, input)
   if (!v.ok) return undefined
   const { session_id, prompt_id, last_assistant_message, transcript_path, cwd } = v.value
   return {
      cwd,
      body: {
         kind: "stop",
         ccSessionId: session_id,
         transcriptPath: transcript_path,
         part,
         ...(prompt_id === undefined ? {} : { promptId: prompt_id }),
         ...(last_assistant_message === undefined
            ? {}
            : { lastAssistantMessage: last_assistant_message }),
      },
   }
}

function readPeer(stateDir: string) {
   try {
      const v = validate(
         peerFile,
         JSON.parse(readFileSync(join(stateDir, PEER_FILE), "utf8")),
      )
      return v.ok ? v.value : undefined
   } catch {
      return undefined
   }
}

/** One notice per project per ten minutes, from one hook only: the rest stay silent. */
function noPeer(
   event: HookEvent,
   index: number,
   stateDir: string,
): Record<string, unknown> {
   if (event === "Stop" || index !== 1) return {}
   const stamp = join(stateDir, "no-peer-notice")
   try {
      if (Date.now() - statSync(stamp).mtimeMs < NO_PEER_EVERY_MS) return {}
   } catch {}
   try {
      ensureStateDir(stateDir, { mkdirSync, writeFileSync })
      writeFileSync(stamp, "")
   } catch {}
   return { systemMessage: NO_PEER }
}

function readStdin(): Promise<string> {
   return new Promise((resolve, reject) => {
      let text = ""
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", (chunk) => {
         text += chunk
      })
      process.stdin.on("end", () => resolve(text))
      process.stdin.on("error", reject)
   })
}
