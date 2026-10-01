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
     wait for B_N to settle (capped) → elider(A_N, B_N) → paragraph numbers → veto
     ──▶ rendered B_N (each elided paragraph as `[elided: "first words…"]`) as a display-only systemMessage under A_N
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

### Elision strategies (human's directives, 2026-10-01; supersede dec-mediator-replaces-bx)
- `--spiderman-strategy mediator | bx | off`, default `mediator`.
- **mediator:** a stateless single-message call with A's final answer and B's answer, numbered `[¶k]`. Default model: B's own (`ctx.model`) at B's thinking level, via `modelRegistry.streamSimple`. `--spiderman-mediator provider/id` overrides, by exact `find` only. Either way the provider must be on `--spiderman-providers`.
- **bx:** B decides, in a real turn of its own session with full history. The extra turn is accepted by the human for this mode. Its prompt carries A's final text (not the package) and a one-line index of B's blocks, `k: "first six words…"`. Afterwards B's leaf is moved back to the entry before the Bx prompt, so the exchange leaves B's context; A's answer still reaches B with the next prompt as a normal package.
- Both answer with one line: `none` or comma-separated paragraph numbers. Paragraph = our `blocks.ts` split. The conservative criteria text is shared, byte-identical, by both prompts.
- Parsing (`parseIndices`): only a line that is wholly a list, or `none`, counts, after stripping fences, decoration and a `label:`. Digits inside prose never count. Two different answer lines, or none, are unparseable: B shown in full, flagged. Out-of-range and repeated numbers are ignored; out-of-range ones are named in a header.
- The keep-only veto and the previews apply to both. The anchor format is gone.

### Bx and the rewind (verified in pi-src v0.99.1, 2026-10-01; +SURE by reading unless marked)
- **Mechanism.** Tree navigation is command-only (`ExtensionCommandContext.navigateTree`, `types.ts:401-435`). The extension registers `/spiderman-rewind` and, from its `agent_settled` handler, calls `pi.sendUserMessage("/spiderman-rewind <nonce>", { expandPromptTemplates: true })`. The `sendUserMessage` doc comment names this as the way to dispatch extension commands (`types.ts:1675-1683`).
  - Inside `agent_settled`, `prompt()` is deferred until the settle emission ends (`agent-session.ts:1883-1887, 1037-1058`). `_isAgentRunActive` is already false then, so `navigateTree`'s `isStreaming` check passes. No emit is nested, which is what the "can deadlock" warning is about.
  - An extension command runs before `input` handlers, appends no message, and starts no run (`agent-session.ts:1892-1899, 2031-2054`). No visible user message, no turn, no `agent_settled`.
  - `navigateTree(target)` with no `summarize` writes no `branch_summary`. For a target that isn't a user message or `custom_message`, it calls `sessionManager.branch(target)`, which only moves the in-memory leaf (`session-manager.ts:1579-1584`). Then it rebuilds `agent.state.messages` from the branch (`agent-session.ts:897-903, 4030-4040`). A user-message target would land on its parent and fill the editor, so Bx is skipped unless B's leaf is a plain entry.
  - **The leaf isn't persisted**: on reload the leaf is the file's last entry (`session-manager.ts:1103-1112`). So after navigating, the extension appends a custom entry `spiderman-rewind {from, to}`. Custom entries never enter context (`session-manager.ts:435-466`).
  - Our `session_before_tree` guard lets through only the target our own command set, for the duration of the call. The command does nothing without the current nonce, and nothing if B's leaf moved since the request.
  - Codex WebSocket continuation (`previous_response_id`) is used only when the new input extends the last request plus response byte-for-byte (`openai-codex-responses.ts:1438-1478`). After a rewind it falls back to a full request, so the Bx exchange can't leak server-side; the prompt cache (`prompt_cache_key` = session id) should still cover the pre-Bx prefix. ~SUSPECT until the real check.
- **State machine:** a display in bx mode starts Bx (`startBx`) when B's turn completed with text, A's text is non-empty, and B is free. B is busy until `bxDone`: queued human prompts wait, a Stop for one of them waits for its later B turn, and a Stop takes Bx before any pending B turn. Bx failure (refused, never started, errored, unparseable, 90 s timeout → `abort()`) shows B in full, flagged. The rewind happens whenever the Bx prompt was appended, and B is freed even if the rewind fails or hangs (15 s).
- **Sidecar:** `display` has `strategy`, `indices`, `elided`, `vetoed`. `bx` has `outcome`, `reply`, `usage {input, cacheRead, output}`, `rewind` (`ok` or a reason), `bxMs`.
- **Known edges:** auto-compaction during a Bx turn lands on the abandoned branch, so B may compact again later. In the TUI, each rewind re-renders the pi pane with "Navigated to selected point" (`interactive-mode.ts:1944-1961`, ~SUSPECT, not seen).

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

## End-to-end on real harnesses (2026-09-30 ~23:30; haiku A + luna B, interactive via ConPTY; +SURE)
- **All 7 scenarios pass:** parallel start; packages carry pointers, not content; mid-turn submit doesn't stall; solo; pi-pane input swallowed; peer loss and re-pair; hand-back capture.
- **Hook stdin has no `source` field**, for human or notification turns alike. Detection relies on the `<task-notification>` prefix. Notification turns get a fresh `prompt_id`.
- **A's cache grows monotonically.**
- **B's Codex cache: a false alarm, resolved (+SURE).** The Codex backend extends cached prefixes in blocks: 1,024 tokens on luna (offset 768), 128 on astra. P4 and the e2e turns added under one block, so `cacheRead` looked frozen.
  - Real evidence: the human's own astra sessions hit 97.6% cache, with `cacheRead` growing turn over turn (33k → 709k in one session). Codex CLI rollouts behave identically.
  - Luna experiments with ~2k added per turn: `cacheRead` 0/3,840/5,888/7,936.
  - Changing nothing helped:
    - SSE vs WebSocket: identical;
    - Codex's `thread-id` header: identical;
    - `prompt_cache_retention`: HTTP 400 unsupported.
  - The first prefix survived a 35-min gap (P4). B's cache requirement holds.
  - To measure caching, use turns that add ≥1,024 tokens, or read `usage.attribution` in the raw `response.completed`.
- **Bugs being fixed:**
  - duplicate A-trail after a mid-turn + solo sequence;
  - `turns/b-N.md` collides across pi sessions;
  - A→B paths absolute (fixed by threading `cwd`).
- **Also landing:**
  - per-turn sections when several answers arrive together;
  - backlog at pairing = the last completed A turn;
  - `/tree` in B's pane cancelled.

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
- `tune`: merged at def838b; branch deleted.
  - Measured on 155 CC + 38 pi real turns: packages −12% (CC) and −13% (pi) vs the first policy; median ~5.4K/3.8K chars, max 23K/26K. Nothing over the cap, 100% reach.
  - Edit cap 1,500 (chosen by data); 8K diff budget; rewinds deliver from the fork point with a "withdrawn" line; 16-hex CAS names; relative paths.
  - Cross-turn memory saves only 0.1%.
  - The ~280-char frame repeats per package (4–5%). Kept, for prompt-injection robustness.
- `post-merge`, `b-cache`, `elide`: done and folded; see "Final state".

## Elision safety (2026-10-01 ~00:30)
- Mediator check (anchor format, luna): 4 synthetic pairs. One FALSE elision: it collapsed a paragraph with numbers A lacked, against its own prompt. Otherwise it caught most redundancy, and elided nothing where there was none.
- Response, landed:
  - a deterministic keep-only veto (`veto.ts`): a B block containing a number or code token that A's text lacks is never elided;
  - per-block previews `[elided: "first eight words…"]`, so the human can spot a wrong collapse;
  - `vetoed: n` in the sidecar.
- Across 11 real e2e turns luna elided nothing. With small, dissimilar haiku/luna answers that's plausible. Untested with Opus + Astra.

## Final state (overnight run end, 2026-10-01)
- **Branch:** `ai/main`, gate green. No worktrees, no other branches. Untested on macOS.
- **Verified on real harnesses** (haiku A + luna B, interactive ConPTY):
  - parallel turns;
  - packages with pointers, not content;
  - mid-turn prompts;
  - solo `~`;
  - pi-pane input swallowed;
  - peer loss and re-pair;
  - no duplicate A-trail after a mid-turn + solo sequence;
  - relative paths;
  - per-answer sections;
  - pairing backlog;
  - both caches growing.
- **Untested or known jank:**
  - **Remote Control rendering of `Stop says:`.** The binary suggests it's forwarded; the human tests this.
  - **`/tree` in B's pane.** The selector opens without a notice; cancelling at selection is untested.
  - **pi restart.** That turn files survive it is verified by code only.
  - **A merged mid-turn prompt.** B's answer to it displays only at a later Stop.
  - **Stop and the next prompt.** The Stop hook holds the spinner, and queues the next prompt, until B is done plus the mediator. Capped at 300 s.
  - **Mediator quality on frontier models** is unmeasured.
  - **Stale `peer.json` after a hard pi kill** falls back to the "no peer" notice (by code).
- **Spend:** about 3.3M tokens across conductor, builders and scouts, against a ~10M budget. About 75 haiku and 75 luna requests for experiments.
- **Incident:** a haiku test session called Claude-in-Chrome tools. No browser was connected, so there was no effect. The rig is fixed.
- **Machine:** memory got low late in the run (~4.6 GB free of 32 GB, with about 20 of the human's own `claude.exe` sessions open). Real-harness runs stopped there.

## Open questions for the human (defaults applied; none blocking)
- `ask-phone-rendering-test`: 2-minute test of whether `Stop says:` blocks appear on claude.ai/code and the phone.
- `ask-peer-frame-trim`: the ~280-char frame repeats per package (4–5% of size). Kept for prompt-injection robustness; trimmable.
- `ask-hk-hook-install`: the hk pre-commit hook is configured but not installed. `hk run` hung for 120 s+ in a scratch repo without `hk.pkl`.
