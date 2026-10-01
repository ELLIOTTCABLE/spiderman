import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"
import {
   boolean,
   integer,
   literal,
   object,
   optional,
   refine,
   string,
   tagged,
} from "./validate.ts"

export const STATE_DIR = ".spiderman"
export const PEER_FILE = "peer.json"
export const HOOK_PATH = "/v1/hook"

const hookCommon = {
   session_id: string,
   transcript_path: string,
   cwd: string,
   prompt_id: optional(string),
}

// source: startup | resume | clear | compact | fork, but unknown values pass
export const sessionStartInput = object({
   ...hookCommon,
   hook_event_name: literal("SessionStart"),
   source: string,
})
export type SessionStartInput = ReturnType<typeof sessionStartInput>

export const userPromptSubmitInput = object({
   ...hookCommon,
   hook_event_name: literal("UserPromptSubmit"),
   prompt: string,
   /** user | sdk | system | …; "system" is task notifications and auto-continuation, not the human */
   source: optional(string),
})
export type UserPromptSubmitInput = ReturnType<typeof userPromptSubmitInput>

export const stopInput = object({
   ...hookCommon,
   hook_event_name: literal("Stop"),
   stop_hook_active: optional(boolean),
   last_assistant_message: optional(string),
})
export type StopInput = ReturnType<typeof stopInput>

const port = refine(integer, (n) => n > 0 && n < 65536, "a TCP port")

export const peerFile = object({
   version: literal(1),
   port,
   token: string,
   pid: integer,
   piSessionId: string,
})
export type PeerFile = ReturnType<typeof peerFile>

// which of K identical hooks asks (1-based); each gets only its own chunk
const part = refine(
   object({ index: integer, count: integer }),
   ({ index, count }) => count >= 1 && index >= 1 && index <= count,
   "1 <= index <= count",
)
export type Part = ReturnType<typeof part>

export const hookRequest = tagged("kind", {
   "session-start": object({
      ccSessionId: string,
      source: string,
      transcriptPath: string,
      cwd: string,
   }),
   prompt: object({
      ccSessionId: string,
      promptId: optional(string),
      prompt: string,
      source: optional(string),
      transcriptPath: string,
      cwd: string,
      part,
   }),
   stop: object({
      ccSessionId: string,
      promptId: optional(string),
      lastAssistantMessage: optional(string),
      transcriptPath: string,
      part,
   }),
})
export type HookRequest = ReturnType<typeof hookRequest>

export const hookReply = object({
   additionalContext: optional(string),
   systemMessage: optional(string),
})
export type HookReply = ReturnType<typeof hookReply>

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "Stop"

// never additionalContext on Stop: it continues the conversation, an unasked-for model turn
export function hookOutput(event: HookEvent, reply: HookReply): Record<string, unknown> {
   const output: Record<string, unknown> = {}
   if (reply.systemMessage !== undefined) output.systemMessage = reply.systemMessage
   if (event !== "Stop" && reply.additionalContext !== undefined) {
      output.hookSpecificOutput = {
         hookEventName: event,
         additionalContext: reply.additionalContext,
      }
   }
   return output
}

export function bearerMatches(header: string | undefined, token: string): boolean {
   if (header === undefined) return false
   const given = Buffer.from(header)
   const expected = Buffer.from(`Bearer ${token}`)
   return given.length === expected.length && timingSafeEqual(given, expected)
}
