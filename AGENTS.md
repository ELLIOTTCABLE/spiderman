# spiderman

A dual-model design harness. The human converses with model A (Claude, in stock interactive Claude Code); model B (an OpenAI model, in interactive pi) answers every prompt in parallel. Each model receives the other's *previous* answer alongside the human's next prompt; the human reads A's answer plus B's answer with A-redundant paragraphs collapsed. A pi extension in B's session is the orchestrator; thin Claude Code hooks, shipped as a plugin, connect A to it.

Read first: `.claude/notes/ledger.md` (current design, decisions, status). Reference, as needed: `.claude/notes/ref-cc-hooks.md` and `.claude/notes/ref-pi-api.md` (verified fact sheets with certainty markers and citations), `.claude/notes/design-report.md` (the original feasibility report; partly superseded, the ledger says where).

## Invariants
- Token economy is the first product requirement, including cached-history reads. Never cause a model turn or request the human didn't ask for: no tool round to fetch peer content, no `asyncRewake`, no Stop-hook `decision: "block"`, no channels, no per-turn work in B's session beyond the human's own prompt. Context changes are append-only; system prompts, tool sets, and settings never change mid-session.
- Failures cost reading time, never information. Uncertain or broken elision keeps paragraphs; an unreachable peer lets the human's prompt through unchanged, and the human is told.
- Peer content reaches the human display-only (`systemMessage`; pi `appendEntry`). It reaches a model as a delimited, anonymised peer block in user-role text: never as a tool result, never as system-prompt instruction.
- Nothing writes to `~/.claude`, `~/.pi`, or a target project's tracked files. Runtime state lives under `<project>/.spiderman/`, which ignores itself.
- Hooks are thin clients. Logic lives in `src/core` (pure and runtime-agnostic: it runs under Node in hooks and under Bun inside pi) and in the pi extension.

## Code
- TypeScript, strict, erasable syntax only: Node runs `.ts` directly, and pi loads the extension through jiti on Bun. 3-space indentation.
- Validate at every process boundary: hook stdin, HTTP bodies, transcript lines, model output. Parse undocumented formats (the CC transcript JSONL) defensively, tolerating unknown entries.
- Inject clock, filesystem, network, and model calls, so core logic is testable without either harness.
- Comments explain why, never what.
- `mise run gate` is the completion check; never pipe gates through `head`/`tail`.

## Agents working here
- Commits: load the `commit` skill; labels come from `.gitlabels`; commit granularly; never push.
- Real-harness experiments use only the cheapest models: `claude --model haiku`, and `pi --model openai-codex/gpt-6-luna`, always provider-qualified, because the bare id also resolves to a pay-as-you-go provider.
- Test sessions run in scratch directories outside this repo.
   - `claude`: tools restricted, `--no-chrome --strict-mcp-config --disallowedTools mcp__claude-in-chrome`, `--setting-sources project,local`, and Remote Control and push notifications off (`--settings '{"remoteControlAtStartup":false,"agentPushNotifEnabled":false,"inputNeededNotifEnabled":false}'`).
   - `pi`: isolated (`-ne -ns -np -nc --offline`, own session dir, explicit `--mode`).
   - Scrub inherited `CLAUDE_*`/`CLAUDE_CODE_*` env from children. Spawn the real `claude.exe`/`pi.exe` from `mise/installs`, not the shims, so kills land.
   - Kill every process you start.
   - In a PTY, never send a blind Enter: permission dialogs default to Allow. Answer them with Esc.
- Never read credential files (`auth.json`, `.credentials*`); never log `Authorization` headers.
