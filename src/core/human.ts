// Turns CC starts without the human: task notifications, subagent hand-backs, cross-session
// messages. They fire UserPromptSubmit like any prompt, but are not B's business. Anything
// unrecognised counts as human: dropping a real prompt silently removes B from the conversation.
const MACHINE_PREFIXES = [
   "<task-notification>",
   "<agent-message",
   "<cross-session-message",
]

export function isHumanPrompt(prompt: string, source: string | undefined): boolean {
   if (source === "system") return false
   const start = prompt.trimStart()
   return !MACHINE_PREFIXES.some((prefix) => start.startsWith(prefix))
}
