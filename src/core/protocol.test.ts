import assert from "node:assert/strict"
import { test } from "node:test"
import {
   bearerMatches,
   hookOutput,
   hookReply,
   hookRequest,
   peerFile,
   sessionStartInput,
   stopInput,
   userPromptSubmitInput,
} from "./protocol.ts"
import { validate } from "./validate.ts"

const common = {
   session_id: "s-1",
   transcript_path: "C:/Users/x/.claude/projects/p/s-1.jsonl",
   cwd: "C:/work/proj",
   permission_mode: "default",
   scratchpad_dir: "C:/tmp/s",
}

test("UserPromptSubmit stdin keeps prompt and prompt_id, drops the rest", () => {
   const result = validate(userPromptSubmitInput, {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "why is the cache cold?",
      prompt_id: "p-9",
      session_title: "debugging",
   })
   assert.deepEqual(result, {
      ok: true,
      value: {
         session_id: "s-1",
         transcript_path: common.transcript_path,
         cwd: "C:/work/proj",
         prompt_id: "p-9",
         hook_event_name: "UserPromptSubmit",
         prompt: "why is the cache cold?",
      },
   })
})

test("UserPromptSubmit stdin from an older Claude Code without prompt_id still validates", () => {
   const result = validate(userPromptSubmitInput, {
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
   })
   assert.ok(result.ok)
})

test("a payload for a different event is rejected", () => {
   const result = validate(userPromptSubmitInput, {
      ...common,
      hook_event_name: "Stop",
      prompt: "hi",
   })
   assert.equal(result.ok, false)
})

test("Stop stdin tolerates a missing or null last_assistant_message", () => {
   const missing = validate(stopInput, {
      ...common,
      hook_event_name: "Stop",
      stop_hook_active: false,
   })
   const nulled = validate(stopInput, {
      ...common,
      hook_event_name: "Stop",
      last_assistant_message: null,
      background_tasks: [],
   })
   assert.ok(missing.ok)
   assert.ok(nulled.ok)
   if (nulled.ok) assert.equal(nulled.value.last_assistant_message, undefined)
})

test("SessionStart passes through an unknown future source", () => {
   const result = validate(sessionStartInput, {
      ...common,
      hook_event_name: "SessionStart",
      source: "teleport",
   })
   assert.ok(result.ok)
})

test("peer.json requires version 1 and a real port", () => {
   const good = { version: 1, port: 51234, token: "t", pid: 42, piSessionId: "0190-abc" }
   assert.ok(validate(peerFile, good).ok)
   assert.equal(validate(peerFile, { ...good, version: 2 }).ok, false)
   assert.equal(validate(peerFile, { ...good, port: 70000 }).ok, false)
})

test("prompt request requires a coherent part", () => {
   const base = {
      kind: "prompt",
      ccSessionId: "s-1",
      prompt: "hi",
      transcriptPath: "t.jsonl",
      cwd: "C:/work",
   }
   assert.ok(validate(hookRequest, { ...base, part: { index: 2, count: 3 } }).ok)
   assert.equal(
      validate(hookRequest, { ...base, part: { index: 4, count: 3 } }).ok,
      false,
   )
   assert.equal(
      validate(hookRequest, { ...base, part: { index: 0, count: 3 } }).ok,
      false,
   )
   assert.equal(validate(hookRequest, base).ok, false)
})

test("an unknown request kind is rejected", () => {
   assert.equal(validate(hookRequest, { kind: "compact", ccSessionId: "s" }).ok, false)
})

test("hook reply rejects a non-string context", () => {
   assert.equal(validate(hookReply, { additionalContext: ["chunk"] }).ok, false)
   assert.deepEqual(validate(hookReply, {}), { ok: true, value: {} })
})

test("UserPromptSubmit output nests additionalContext under hookSpecificOutput", () => {
   assert.deepEqual(
      hookOutput("UserPromptSubmit", { additionalContext: "[peer 1/1] …" }),
      {
         hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "[peer 1/1] …",
         },
      },
   )
})

test("Stop output never carries additionalContext, which would continue the turn", () => {
   const output = hookOutput("Stop", {
      additionalContext: "x",
      systemMessage: "peer answer",
   })
   assert.deepEqual(output, { systemMessage: "peer answer" })
})

test("an empty reply prints an empty object, not nothing", () => {
   assert.deepEqual(hookOutput("UserPromptSubmit", {}), {})
})

test("bearer check needs the exact header", () => {
   assert.equal(bearerMatches("Bearer abc", "abc"), true)
   assert.equal(bearerMatches("Bearer abd", "abc"), false)
   assert.equal(bearerMatches("abc", "abc"), false)
   assert.equal(bearerMatches(undefined, "abc"), false)
})
