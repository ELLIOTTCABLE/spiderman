# spiderman

You talk to Claude in Claude Code (A). A second model in pi (B) answers every prompt in parallel. Each model gets the other's previous answer with your next prompt, and under each of A's answers you see B's answer, with the paragraphs that only repeat A collapsed to one line each, quoting their first words: `[elided: "first eight words…"]`. A model picks those paragraphs by number (see `--spiderman-strategy`); a paragraph with a number or code that A's answer lacks is never collapsed, whatever it picks.

Experimental. The plumbing is meant to be careful; the surface is rough.

## Install

```sh
cd <repo>
npm install --ignore-scripts
```

Hooks run `.ts` files directly, so `node` on your PATH must strip types (Node 22.18+; the repo pins 25.9 through mise).

## Launch

Two terminals, both in the project you're working on, started in either order. pi writes `.spiderman/peer.json`, which Claude Code's hooks look for on every prompt.

```sh
# B: read-only peer
pi -e <repo>/src/pi/extension.ts --model openai-codex/gpt-6-astra:high --tools read,grep,find,ls

# A: you type here
claude --plugin-dir <repo>/plugin
```

## Using it

- Type your shared prompts in Claude Code. You can also type in pi's pane, e.g. to ask B something directly: that turn is B's alone, and Claude sees it, marked as a direct message to the peer, with your next prompt. While B is eliding its answer (`bx`), what you type in pi's pane waits and goes in right after.
- Rewind either side freely: Esc-Esc or `/rewind` in Claude Code, `/tree` in pi. Spiderman doesn't follow a rewind to the other side. Each side's next delivery carries whatever the peer's current branch holds that this side's current branch lacks; abandoned turns are never sent. `/tree` in pi waits only while B is eliding.
- `@path` in your prompt reaches B as a plain path when it names a file or directory under the project, so B reads it itself, as Claude does. Other `@` words stay as typed.
- Start a prompt with `~` to ask Claude alone. B skips that turn, but sees the exchange later as part of Claude's record.
- Under Claude's answer, `Stop says: [peer 1/2] …` is B's answer. It is plain text, and long answers span several blocks. The full text is in `.spiderman/turns/<pi session id>/b-<n>.md`.
- Claude gets B's full answer, never the elided one, along with B's tool calls. Tool outputs are referenced by path under `.spiderman/peer/`.
- B gets Claude's answer and tool record the same way, followed by your prompt.
- Over Remote Control (claude.ai/code, the phone app), whether the `Stop says:` blocks render is untested. Claude Code's binary suggests it forwards them.

## Flags (pi side)

| flag | default | meaning |
|---|---|---|
| `--spiderman-strategy` | `mediator` | who picks B's redundant paragraphs. `mediator`: a separate call that sees only A's and B's answers. `bx`: B itself, in an extra turn of its own session that is then rewound. `off`: show B in full |
| `--spiderman-mediator` | B's model | the mediator's model, `provider/id`, matched exactly, and on an allowed provider; by default B's own model at B's thinking level |
| `--spiderman-providers` | `openai-codex` | providers B may run on; on anything else your prompt isn't sent to B |
| `--spiderman-prompt-wait` | `25` | seconds a prompt waits for B's previous answer |
| `--spiderman-stop-wait` | `300` | seconds the Stop hook waits for B's answer |
| `--spiderman-solo` | `~` | prefix for Claude-only prompts |

What elision costs, per B answer:

- `mediator`: one request on the mediator model, outside B's session, so it shares no cache with B: both answers in, one line out, plus any reasoning at B's thinking level. On B's own model that is a frontier-priced call; `--spiderman-mediator openai-codex/gpt-6-luna` makes it cheap, at some cost in judgment.
- `bx`: one extra turn in B's session. It re-reads B's whole context, mostly as cached input, which grows with the session, plus A's answer, and writes one line plus its reasoning. Afterwards pi's session is rewound to before that turn, so the exchange stays in the session file but leaves B's context: B's next turn starts from the earlier, cached prefix. Your next prompt reaches B only after the rewind.

Each hook tells pi how long it can wait (its timeout in `plugin/hooks/hooks.json`, 40 s and 420 s, minus a margin), and pi cuts its waits to fit: a wait flag set beyond the timeout is capped there.

## Files

Everything lives in `<project>/.spiderman/`, which ignores itself in git.

- `peer.json`: pi's port and token, while pi runs.
- `peer/<hash>.txt`: tool outputs and snapshots that packages point at.
- `turns/`: B's full answers and full packages.
- A per-turn log sits next to pi's session file (`<session>.spiderman.jsonl`), or in `.spiderman/log.jsonl` without one.

## Troubleshooting

- **"no peer is running"**: pi isn't up in this project, or it started in another directory. The notice repeats at most every ten minutes.
- **"another Claude Code session is paired"**: one Claude Code session pairs with one pi session. `/clear` in the paired terminal keeps the pair.
- **"peer is still answering"**: B was slower than the wait. Its answer reaches Claude with your next prompt.
- **`[elision unavailable (…); shown in full]`**: the mediator or B's elision turn failed, timed out, or answered with no clear list. Nothing is hidden.
- **`[elision: ignored paragraph numbers out of range: …]`**: the elider named paragraphs B's answer doesn't have. Its other picks still apply.
- **`/spiderman-rewind`** in pi's command list belongs to the `bx` strategy. Typed by hand, it does nothing.
- **"B's provider is …, not one of …"**: pi's model isn't on the allowlist, so your prompt wasn't sent to B. Switch pi's model, or extend `--spiderman-providers`.
- The Stop hook keeps Claude Code's spinner on "running Stop hooks" until B's answer is ready, up to the stop wait.

## Development

`mise run gate` typechecks, lints and runs the tests. `mise run fmt` formats. Design notes: `.claude/notes/ledger.md`.
