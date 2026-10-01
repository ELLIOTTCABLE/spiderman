import assert from "node:assert/strict"
import { test } from "node:test"
import { isHumanPrompt } from "./human.ts"

test("typed prompts are human, with or without a source field", () => {
   assert.equal(isHumanPrompt("why is it slow?", "user"), true)
   assert.equal(isHumanPrompt("why is it slow?", undefined), true)
})

test("any other source is not the human", () => {
   assert.equal(isHumanPrompt("continue", "system"), false)
   assert.equal(isHumanPrompt("check again", "loop_wakeup"), false)
   assert.equal(isHumanPrompt("hi", "sdk"), false)
})

test("machine-made turns are recognised by their envelope even without a source", () => {
   assert.equal(
      isHumanPrompt("<task-notification>\n<task-id>a1</task-id>", undefined),
      false,
   )
   assert.equal(
      isHumanPrompt('  <agent-message from="scout">done</agent-message>', undefined),
      false,
   )
   assert.equal(
      isHumanPrompt("<cross-session-message>hi</cross-session-message>", undefined),
      false,
   )
   assert.equal(isHumanPrompt("what does <task-notification> mean?", undefined), true)
})
