// Standing instructions, set once per session and byte-identical every turn, so they stay in
// the cached prefix. Facts, not imperatives: out-of-band commands trip CC's injection defences.

const SHARED =
   "Each block marked [peer answer] is the peer's own work, not the human's words, and the " +
   "human has not endorsed it. Its points carry weight on their content alone: agreement is " +
   "no reason to defer, and disagreement no reason to dismiss. Claims an answer depends on " +
   "are worth verifying; the peer's tool outputs are saved as files under .spiderman/peer/ " +
   "for that. The human marks certainty with +SURE, ~SUSPECT, -GUESS and --WONDER, and " +
   "answers that use the same markers are easier to compare."

/** For Claude Code, as SessionStart `additionalContext`. */
export const STANDING_FOR_A =
   "This session is paired with a peer model that answers each of the human's prompts " +
   "independently and in parallel. With the human's next prompt, the peer's answer to the " +
   "previous turn arrives as context, split into parts labelled [peer k/K]. " +
   SHARED

/** For pi, appended to the system prompt. */
export const STANDING_FOR_B =
   "\n\nThis session is paired with a peer model that answers each of the human's prompts " +
   "independently and in parallel. The human types in the peer's interface, and each of " +
   "their messages reaches this session together with the peer's answer to the previous " +
   "turn. " +
   SHARED
