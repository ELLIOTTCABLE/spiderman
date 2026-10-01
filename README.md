# spiderman

You talk to Claude in Claude Code (A). A second model in pi (B) answers every prompt in parallel. Each model gets the other's previous answer with your next prompt, and under each of A's answers you see B's answer, with the paragraphs that only repeat A collapsed to `[n¶ elided]`.

Experimental. The plumbing is meant to be careful; the surface is rough.

## Install

```sh
cd <repo>
npm install --ignore-scripts
```

Hooks run `.ts` files directly, so `node` on your PATH must strip types (Node 22.18+; the repo pins 25.9 through mise).

## Launch

Two terminals, both in the project you're working on. Start pi first: it writes `.spiderman/peer.json`, which Claude Code's hooks look for.

```sh
# B: read-only peer
pi -e <repo>/src/pi/extension.ts --model openai-codex/gpt-6-astra:high --tools read,grep,find,ls

# A: you type here
claude --plugin-dir <repo>/plugin
```

If Claude Code starts first, its first prompt shows a "no peer" notice and Claude misses the one-time note explaining peer blocks. Restart Claude Code (or `/clear`) once pi is up.

## Using it

- Type only in Claude Code. Text typed into pi's pane is swallowed, with a notice.
- Start a prompt with `~` to ask Claude alone. B skips that turn, but sees the exchange later as part of Claude's record.
- Under Claude's answer, `Stop says: [peer 1/2] …` is B's answer. It is plain text, and long answers span several blocks. The full text is in `.spiderman/turns/b-<n>.md`.
- Claude gets B's full answer, never the elided one, along with B's tool calls. Tool outputs are referenced by path under `.spiderman/peer/`.
- B gets Claude's answer and tool record the same way, followed by your prompt.

## Flags (pi side)

| flag | default | meaning |
|---|---|---|
| `--spiderman-strategy` | `mediator` | `mediator`: a cheap model picks redundant paragraphs; `off`: show B in full |
| `--spiderman-mediator` | `openai-codex/gpt-6-luna` | the elision model, `provider/id`, matched exactly |
| `--spiderman-providers` | `openai-codex` | providers B may run on; on anything else your prompt isn't sent to B |
| `--spiderman-prompt-wait` | `25` | seconds a prompt waits for B's previous answer |
| `--spiderman-stop-wait` | `300` | seconds the Stop hook waits for B's answer |
| `--spiderman-solo` | `~` | prefix for Claude-only prompts |

Keep the waits under the hook timeouts in `plugin/hooks/hooks.json` (40 s and 420 s). A hook that times out loses its output silently.

## Files

Everything lives in `<project>/.spiderman/`, which ignores itself in git.

- `peer.json`: pi's port and token, while pi runs.
- `peer/<sha256>.txt`: tool outputs and snapshots that packages point at.
- `turns/`: B's full answers and full packages.
- A per-turn log sits next to pi's session file (`<session>.spiderman.jsonl`), or in `.spiderman/log.jsonl` without one.

## Troubleshooting

- **"no peer is running"**: pi isn't up in this project, or it started in another directory. The notice repeats at most every ten minutes.
- **"another Claude Code session is paired"**: one Claude Code session pairs with one pi session. `/clear` in the paired terminal keeps the pair.
- **"peer is still answering"**: B was slower than the wait. Its answer reaches Claude with your next prompt.
- **`[elision unavailable (…); shown in full]`**: the mediator failed or answered badly. Nothing is hidden.
- **"B's provider is …, not one of …"**: pi's model isn't on the allowlist, so your prompt wasn't sent to B. Switch pi's model, or extend `--spiderman-providers`.
- The Stop hook keeps Claude Code's spinner on "running Stop hooks" until B's answer is ready, up to the stop wait.

## Development

`mise run gate` typechecks, lints and runs the tests. `mise run fmt` formats. Design notes: `.claude/notes/ledger.md`.
