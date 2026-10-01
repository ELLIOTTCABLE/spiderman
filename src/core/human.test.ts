import assert from "node:assert/strict"
import { test } from "node:test"
import { isHumanPrompt } from "./human.ts"

test("typed prompts are human, with or without a source field", () => {
   assert.equal(isHumanPrompt("why is it slow?", "user"), true)
   assert.equal(isHumanPrompt("why is it slow?", undefined), true)
})

test("only a system source marks a prompt as not the human", () => {
   assert.equal(isHumanPrompt("continue", "system"), false)
   assert.equal(isHumanPrompt("hi", "sdk"), true)
})

test("an unknown source counts as human, so a real prompt is never dropped", () => {
   assert.equal(isHumanPrompt("from my phone", "remote_control"), true)
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
