// Turns CC starts without the human: task notifications, subagent hand-backs, cross-session
// messages, wake-ups. They fire UserPromptSubmit like any prompt, but are not B's business.
const MACHINE_PREFIXES = [
   "<task-notification>",
   "<agent-message",
   "<cross-session-message",
]

export function isHumanPrompt(prompt: string, source: string | undefined): boolean {
   if (source !== undefined && source !== "user") return false
   const start = prompt.trimStart()
   return !MACHINE_PREFIXES.some((prefix) => start.startsWith(prefix))
}
