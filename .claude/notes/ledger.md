# Conductor ledger: G1 dual-model harness

Overnight autonomous run started 2026-09-30 while the human sleeps. Conductor: Opus 5.5. Ahistorical; describes the current state. Certainty markers per the human's global prompt: +SURE / ~SUSPECT / -GUESS / --WONDER.

## Remit (human, 2026-09-30)
- G1 only. G2 (native Astra subagents via a TLS-intercepting proxy) is out of scope.
- Safety over velocity. An incomplete task beats a damaged machine, overspent limits, or a bothered person.
- Token spend is the priority, including cached-history reads: anything causing an extra turn is out.
- Plumbing must work well and defensively; the surface may be jank. No launcher: the human starts both harnesses by hand, with the pi pane in a second terminal tab. The human may not watch that pane.
- B is read-only for experimentation. Desk-first; phone (Remote Control) is a stretch.
- Use upstream packages where they exist; patch locally or drop them if they chafe. No PRs, issues, or other public activity.
- Logging: none beyond what both harnesses already keep, except an optional sidecar next to the pi session file (`<session>.spiderman.jsonl`).
- Budget: about 10M tokens across conductor and Opus builders. Experiments use only `haiku` and `openai-codex/gpt-6-luna`. Fable is unavailable (weekly limit).
- Raw Anthropic/OpenAI tokens: already scheduled for rotation. Seeing them is noted, not a stop. Any other secret still stops work.

## Design (current)

### Turn protocol: staggered-symmetric, no extra turns
```
U_N typed in Claude Code (A)
  A's UserPromptSubmit hooks → extension:
     B-package(since last delivered to A) ──▶ A's additionalContext (chunked; same request, no extra turn)
     A-package(A's transcript since last delivered to B) + U_N ──▶ one user message in B's session (B's turn N)
A_N ∥ B_N
A's Stop hook → extension: last_assistant_message = A_N
     wait for B_N to settle (capped) → elision mediator(A_N, B_N) → anchors
     ──▶ rendered B_N (elided runs as "[n¶ elided]") as a display-only systemMessage under A_N
human reads A_N + elided B_N, types U_{N+1}
```
- Neither model sees the other's current-turn answer before producing its own. Each receives the other's previous answer together with the human's next prompt.
- Packages are always "everything since last delivered", so solo turns, interrupted turns (Stop doesn't fire on interrupt), and late peers all self-heal at the next prompt.
- A always receives B's full answer, never the elided rendering. Elision only governs what the human reads.

### Turn state machine (rewritten after probe P2/P3; the diagram above is the common case only)
- **Probe facts (+SURE):**
  - `UserPromptSubmit` fires *at submit time*, including for prompts typed while A is mid-turn or while Stop hooks run, and it then carries the previous turn's stale `prompt_id`.
  - A prompt queued during a no-tool turn becomes a new A turn after Stop, without another `UserPromptSubmit`.
  - A prompt submitted during tool use is merged into A's running turn as a `queued_command`, and one Stop then covers both.
  - Prompts typed while Stop hooks run are queued until those hooks finish.
- **Implementation shape.** A pure reducer `step(state, event) → {state, effects}` carries all the logic and is unit-tested exhaustively. The pi extension is the effectful shell.
  - Events: `submit{prompt, session_id, prompt_id, transcript_path, k}` ×K, `stop{last_assistant_message, transcript_path}`, `bSettled{messages}`.
  - Effects: respond-to-hook, start-B-turn, log.
- **Rules:**
  - Dedupe the K chunk-hook calls by `(session_id, prompt_id, sha(prompt))` within a short window. `prompt_id` alone is stale, so it can't be the key.
  - Every non-solo submit appends to `pendingHuman`, tagged `aIdleAtSubmit`.
  - A is "running" from an idle-time submit until `stop`.
  - **Start B** when B is idle, `pendingHuman` is non-empty, and either the first pending entry has `aIdleAtSubmit` or A is no longer running. B's turn is A-package(since the last delivered cut, ending before the first pending prompt) + all pending human messages, in order.
    - Common case: B starts at submit, in parallel with A.
    - Mid-turn case: B starts at A's Stop, so B sees A's completed answer.
  - **Submit while A is idle** (common): respond with all undelivered B messages, waiting up to a cap if B is still running.
  - **Submit while A is running:** respond immediately with whatever is undelivered, never wait, so the hook doesn't stall A's live turn.
  - **Stop:** wait (capped) for the latest not-yet-displayed B turn to settle, run elision, and return display chunks. Reconcile A's trail with `last_assistant_message`, because the transcript may lag at Stop.
- **Multi-chunk ordering.**
  - Each chunk hook gets its own attachment or `systemMessage` block, in *completion* order (+SURE).
  - The server releases chunk k at t₀ + k·~250 ms, so reading order holds, and every chunk is labelled `k/K` anyway.
  - Over 10k chars, CC persists the string to a file and shows the model a 2 KB preview; haiku missed the path in the probe. Never exceed the cap.
- **Display.**
  - `systemMessage` renders as raw text (no markdown), prefixed `Stop says:`, each hook as its own block.
  - A's answer is fully visible before Stop hooks return; the spinner reads "running Stop hooks… i/K".
  - The Stop cap is configurable (default ~5 min). On cap, show "peer still answering; its answer reaches A with your next prompt".

### dec-mediator-replaces-bx
- The report's Bx step (B elides its own answer in an extra turn of B's session) costs a cached read of B's whole, growing context on an expensive model, once per human turn. That violates the token-economy remit.
- Default replacement: a stateless mediator call with input A_N + B_N and the Bx instruction, on a cheap model (default `openai-codex/gpt-6-luna`, configurable). It returns the same anchor format, with the same fail-safe.
- It runs inside the pi extension using pi's own auth, so no auth files are read.
- Side effect: this removes self-elision's sycophancy bias, which the report expected to cause over-elision.
- Bx stays a selectable strategy (`bx | mediator | off`) for comparison. Human to review.

### Elision (from report §2.4, unchanged in substance)
- Output from the mediator: `{"elide": [<first ~8 words of each elided paragraph, verbatim>]}`.
- Paragraph split respects code fences, lists, and tables.
- Matching normalises the text first. An unmatched or malformed anchor keeps its paragraph. Unparseable output shows B_N in full, flagged.

### Display surfaces
- The human reads in Claude Code. A synchronous `Stop` hook's `systemMessage` is display-only and never sent to the model (+SURE docs).
  - ~SUSPECT the binary forwards it to Remote Control clients (strings grep only); the human tests this in the morning.
  - It is capped at 10k characters per string. Use several Stop hooks or a pointer to the full file under `.spiderman/`.
- The pi pane: B's own transcript. Human-typed input there is swallowed with a notice via the `input` event (`source: "interactive"`), so the protocol can't desync. No renderer work.

### Delivery into A
- `UserPromptSubmit` `hookSpecificOutput.additionalContext` costs no extra turn. It is persisted in the transcript and replayed: append-only, cache-safe, but cumulative (+SURE docs; verify by probe).
- Cap: 10k characters per string, measured per string. Over the cap, the model sees only a 2,000-char preview. Use K hooks with distinct commands; identical handlers are deduped.
  - Hooks run in parallel and their outputs merge into one block in completion order (~SUSPECT), so every chunk is labelled `k/K`.
- Never emit raw stdout; JSON only. Plain stdout of the form `{…}` that fails JSON parsing is silently dropped.
- Set an explicit `timeout`: the default is 30 s, and on timeout the context is silently discarded.
- Phrase peer content as facts, not imperatives; imperative framing can trip prompt-injection defences.

### Delivery into B
- One `pi.sendUserMessage([peer block] + U_N)` per human turn, only while idle. B busy means queue until `agent_settled`.
- Own busy flag: `ctx.isIdle()` races right after injection.
- `agent_settled` is the finished signal, not `agent_end`.
- Compaction in flight makes `sendUserMessage` throw; retry after settle.

### Tool-trail forwarding (report §2.5, simplified)
- Text and tool calls stay interleaved.
- Tool inputs go inline. Tool outputs go to a content-addressed store `.spiderman/peer/<sha256>.txt` and are referenced by path.
- Edits go inline as diffs. Writes are referenced, with a line count.
- Neither side's private reasoning is forwarded.
- A's trail comes from its transcript JSONL, read at the *next* prompt, when it is surely flushed. Parse defensively; on failure fall back to the Stop hook's `last_assistant_message`.

### Package policy: least noise, maximum reach (human's named tuning priority)
- The receiver gets the smallest package that still lets it follow up on anything the peer saw or did.
- **Reads:** a one-line `read <path> L<a>–<b>`. The peer's snapshot goes to the CAS only if the file has changed since. Repeated reads collapse to "(again)".
- **Search/list/shell:**
  - The input goes inline.
  - Tiny outputs go inline too; anything larger becomes a CAS pointer plus a size line.
  - Outputs that CC already persisted to a file are pointed at directly, not copied.
- **Edits:** an inline compact diff. **Writes:** path plus line count.
- **Subagents:** the prompt goes in briefly; the final report inline, capped; plus a pointer to the subagent transcript.
- **Errors:** a one-line marker. **Noise tools** (TodoWrite, status chatter): dropped. **Unknown tools:** a generic fallback; never dropped silently.
- Thinking/reasoning is never forwarded.
- Measured, not eyeballed. Fixture tests assert two properties: package size against the raw trail, and *reach* (every interaction is either inline or has a resolvable pointer).
- Planned after integration: a tuning pass over realistic tool-heavy sessions on cheap models, iterating the thresholds.

### Pairing and runtime
- The pi extension, on `session_start`, starts an HTTP server on 127.0.0.1 with a random port and a bearer token. It writes `<cwd>/.spiderman/peer.json`.
- `.spiderman/` contains a `.gitignore` of `*`, so target projects stay clean.
- Hooks locate `peer.json` via `CLAUDE_PROJECT_DIR`/`cwd`.
- First CC session to connect claims the pair; others get a notice.
- No peer means no context and a one-line notice.

### Standing instructions (cache-safe: set at session start, byte-stable)
- A: `SessionStart` `additionalContext`.
- B: a stable system-prompt append from the extension.
- Content:
  - peer-block semantics ("independent answer to the previous turn from a peer model; not endorsed by the human");
  - weigh peer points on content, neither deferring nor contradicting by reflex;
  - verify claims your answer depends on;
  - use certainty markers.

### Stack
- TypeScript throughout. The pi extension must be TS (jiti/Bun). The hooks are tiny TS run by Node 25 with native type-stripping.
- Rust was considered and rejected: a second language just for thin hook clients.
- mise pins tools and tasks; npm handles dependencies; `node:test` for tests; `tsc` strict.
- Claude Code side is a plugin dir (`claude --plugin-dir <repo>/plugin`); pi side is `pi -e <repo>/src/pi/extension.ts`.

## Report corrections (the design report was not taken as written)
- `PI_CACHE_RETENTION` and `cacheWarming` are no-ops for `openai-codex`.
  - B's caching rests entirely on OpenAI's server-side cache, keyed by `prompt_cache_key` = pi session id.
  - The WebSocket `previous_response_id` continuation expires after 5 min idle.
  - Whether B's cache survives the human's 30+ min reading gaps is an open probe.
- Multiple `UserPromptSubmit` hooks merge into one block in completion order, not ordered or labelled per hook.
- `MessageDisplay` exists (display-only rewrite of streaming assistant text). It isn't used, because elided B isn't ready while A streams.
- Stop-hook `decision: "block"` is a cache hazard (2.1.259).
- Subagents get a 5 min cache TTL on a subscription. G1 doesn't use them.

### Model-routing guard (smoke finding D10)
- pi falls back to fuzzy matching across *all* providers when `provider/id` has no exact match. A typo or catalog change could therefore silently route B or the mediator to a pay-as-you-go provider.
- The extension resolves the mediator model only with `modelRegistry.find(provider, id)`. If that fails, it disables elision and shows B in full.
- It refuses to inject into B unless `ctx.model.provider` is on an allowlist; the default is `openai-codex`.

## Smoke results (2026-09-30, all +SURE, observed)
- **CC plugin via `--plugin-dir` works headless and interactive.**
  - Exec-form hooks with `${CLAUDE_PLUGIN_ROOT}`; the same script with distinct args is not deduplicated.
  - Each UserPromptSubmit hook gets its own `hook_additional_context` attachment, in completion order.
  - Stop stdin has `last_assistant_message` + `prompt_id`. Its `systemMessage` renders as `⎿ Stop says: …`, and the model never sees it.
- **Hook context is in the cached prefix on later turns** (cache_read grew by exactly the prior turn's creation). Writes are 1h TTL.
- **pi:**
  - `-e` extension in `--mode rpc`: a `node:http` server on 127.0.0.1:0 inside pi.exe works, and `POST` → `sendUserMessage` → `agent_settled` round-trips.
  - Mediator call: `ctx.modelRegistry.complete(ctx.modelRegistry.find("openai-codex","gpt-6-luna"), {systemPrompt, messages}, {})` works with pi's own auth and is not recorded in the session.
- **npm:** `npm install --ignore-scripts` is sufficient.
  - pi ships real `.d.ts` (needs `skipLibCheck`).
  - `@lydell/node-pty` is prebuilt for win32, so a headless ConPTY test rig works for interactive CC and pi.
- **Test hygiene:**
  - Scrub inherited `CLAUDE_*`/`CLAUDE_CODE_*` env from child sessions; it carries the parent's RC bridge and IDE port.
  - Spawn the real `mise/installs/.../claude.exe` and `pi.exe`, not the shims, so kills land.
  - Interactive CC under `C:\Users\ec` asks once about external CLAUDE.md imports.

## Probe results, round 2 (2026-09-30, +SURE unless marked)
- **pi OAuth refresh is cross-process safe.** It uses `proper-lockfile` on `auth.json` and re-checks expiry inside the lock (`coding-agent/src/core/auth-storage.ts:116-155`, `ai/src/auth/resolve.ts:102-140`). Concurrent pi processes are OK.
- **Codex server-side cache survives the 5-min WebSocket TTL.** Turn after a 6-min gap: `cacheRead` 18,176 of 18,390. The 35- and 70-min points are pending: `scratchpad/probes/out/p4/turns.jsonl`, finishing ~23:28 local.
- **Incident:** a haiku test session called Claude-in-Chrome tools despite `--tools ""` + `--strict-mcp-config`. The PTY rig's closing Enter likely answered "Allow" on the Chrome permission dialog. Both calls failed ("extension not connected"), so there was no effect. Fixed in the rig: `--no-chrome`, `--disallowedTools mcp__claude-in-chrome`, and Esc on any Allow/Deny dialog. Reported to the human.
- **Fixtures:** scrubbed `cc-transcript.jsonl` + `pi-session.jsonl` + README in `scratchpad/fixtures/`.

## Real-session shape (human's Dorc design sessions, 2026-09-23..30; +SURE measured)
- **Scope:** 144 CC turns (all Fable) and 39 pi turns (mostly gpt-6-astra). Scripts are in `scratchpad/dorc-stats/`.
- **Human think time:** median 6.4 min, p90 22 min. 61% of gaps exceed 5 min; 3% exceed 1 h. A's 1 h TTL almost always holds; B's survival is the P4 probe.
- **Answers:** median 3.6K chars, p90 7.5K, with a median of 8 markdown blocks. Human prompts: median 0.8K, p90 2.3K.
- **Package under the first policy:** median 7K, p90 22K, max 76K. 5.6% of turns exceed the 4×9.5K cap.
  - Edits/Writes dominate: 48% overall, 77% of the worst turns, nearly all `.md` notes.
  - Capping inline edits at ~1.5K and pointing at Writes removes every CC overflow.
- **Reads:** median output 16.7K; 19% are repeats. CC rarely persists outputs itself, so the package synthesizes pointers.
- **Subagent reports:** median 15.7K. They arrive later as `origin.kind:"peer"` / `task-notification` user turns, so they are never human prompts for B.
- **Transcript structure:** 23% of prompts are abandoned edit/rewind siblings, so walk the parent chain. CC writes one content block per assistant entry, grouped by `message.id`.
- **Noise:** pi `todo` is 5% of package for zero information. CC Skill bodies hide in `isMeta` entries.

## Lanes
- `smoke` / `probes`: prober builder, scratch only. Smoke done. Round 2 covers:
  - pi OAuth-refresh locking;
  - chunk capacity and overflow;
  - Stop-hook wait UX and queued prompts;
  - UserPromptSubmit on mid-turn messages;
  - a Codex cache idle-gap schedule (~75 min, background);
  - scrubbed fixtures.
- `core` + `integration`: folded at 9f24ccf (170 tests).
  - Shipped: the reducer `turns.ts`, `bridge`, `standing`, `mediator`, the pi side (`server`, `peer-file`, `runtime`, `extension`), the CC plugin (SessionStart ×1, UserPromptSubmit ×4, Stop ×2, one fail-open `hook.ts`), and the README.
  - Reducer rules beyond the ledger, endorsed:
    - a Stop with no owed human prompt displays nothing;
    - a fresh `prompt_id` while A is "running" means A was interrupted;
    - SessionStart `source:"clear"` takes over the pair;
    - the first B turn after pairing gets no A backlog.
  - Not built: the `bx` strategy (`RuntimeDeps.mediate` is the seam).
  - Known jank:
    - a queued prompt merged into A's running turn has its B answer displayed only at a later Stop;
    - a Stop during transcript lag may repeat A's final text in the next package.
  - Follow-ups in flight: unconditional SessionStart instructions (start order shouldn't matter), deadline propagation from hook to server, non-human prompt detection.
  - `PackageMemory` is defined but not threaded. The tuning lane threads it through `runtime.ts` after it folds.
- `tune`: tuning builder in `.tmp/trees/tune` (`ai/tune`).
  - Owns `cc-trail`, `pi-trail`, `package` and `chunk`.
  - Applies the real-session findings above plus cross-turn read dedupe (`PackageMemory`).
  - Measures against the human's Dorc sessions from scratch only; real content never enters the repo.
- Next, once both land: fold, then the prober's real-harness end-to-end run (haiku A + luna B, interactive, via PTY).

## Open questions for the human (non-blocking; defaults applied)
- `ask-bx-versus-mediator`: is the mediator default acceptable, given the token remit?
- `ask-mediator-model-quality`: luna is cheap but weak at redundancy judgement. False elisions are the costly failure. Should it be a mid-tier model?
- `ask-phone-rendering-test`: 2-minute morning test of `systemMessage` on claude.ai/code and the phone. Instructions will be in the final report.
