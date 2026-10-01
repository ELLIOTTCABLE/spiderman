# Dual-model design harness + native Astra subagents: feasibility report

Research session: 2026-09-30, Claude Code (Opus 5.5) in `C:\Users\ec\System`.
Purpose: a self-contained handoff for an implementation session that starts with a cleared context. Nothing was built, installed, or committed during research.

Certainty markers (from the human's global prompt):
- **+SURE**: verified against a primary source during research.
- **~SUSPECT**: well-supported, but not verified directly.
- **-GUESS**: reasoning, no direct evidence.
- **--WONDER**: open question.

---

## 0. TL;DR

- **Two separate goals.** They share no infrastructure and can be built in either order.
  - **G1, the design harness.** A dual-model conversation for gnarly design work. A = Fable/Opus in plain interactive Claude Code: subscription, Remote Control, 1h cache, no proxy. B = Astra in an interactive **pi** session. A pi extension acts as the orchestrator, and Claude Code hooks feed A.
  - **G2, native Astra subagents.** Astra as real Claude Code subagents inside Fable's session. The recommended route is transparent TLS interception: [ccmproxy](https://github.com/jclab-joseph/claude-code-model-proxy) via `HTTPS_PROXY`, or a hosts/DNS redirect. This leaves `ANTHROPIC_BASE_URL` unset, so Remote Control and the other features Claude Code only enables when talking directly to Anthropic keep working. The fallback is a forward proxy plus [shunt](https://github.com/pleaseai/shunt).
- **G1 protocol, decided:** staggered-symmetric turns plus a "Bx" self-elision step. A is the human's primary reading target. B elides its own redundant paragraphs against A's answer. Each model always receives the other's full previous answer, plus tool-call *inputs* and pointers to the outputs.
- **Meridian cache-busting (the old pi attempt):** ~SUSPECT the cause is a missing session-affinity header extension (meridian#820), plus a pi ≥0.85 bug that is now fixed (#1047, PR #1057). See §7.

---

## 1. Goals and constraints (from the human)

- **G1.** For extremely gnarly design problems, get cross-lineage input from two models in a *live, continuing* conversation, not post-hoc adversarial review. Post-hoc review has costs: expense, hyperbole and overstated claims, and plan drift caused by the reviewer's own logical fallacies.
- **G2.** Let Fable/Opus use harness-native OpenAI subagents (Astra = GPT-6-Astra) instead of the current separate-harness one-shot wrappers (the `codex-reviewer`/`codex-worker` agents and the `kimi-review` scripts).
- **Hard constraint:** prompt-cache preservation on every platform. Anything that busts the cache is a non-starter.
- **Human reading time is the scarcest resource.** Hard turns can take 30+ minutes to read and 10+ minutes to type, which already outlasts a 5-minute cache TTL.
- **Entry must be in-harness.** The human relies on fancy vi input in Claude Code and tabbing between subagents. Remote Control (claude.ai/code and the phone app) is used *heavily*.
- **Excluded harnesses:** the human considers Codex and OpenCode "terrible". Claude Code and pi are fine.
- The human prefers single-purpose, self-hosted, configuration-in-code tools.

---

## 2. G1 design (as decided)

### 2.1 Turn protocol

```
U1 ─▶ A(U1) ∥ B(U1) ─▶ A1, B1
A1 ─▶ Bx turn on B: "here is A1; list paragraphs of B1 redundant with it" ─▶ elision anchors
human reads A1 (primary) + Bx1 (B1 with redundant paragraphs collapsed) ─▶ U2
U2 ─▶ A(B1 full + B's tool trail + U2) ∥ B(U2)        # A1 already sits in B's context from the Bx turn
… repeat
```

- **Staggered-symmetric.** Neither model ever sees the other's *current-turn* answer before producing its own. Each sees the other's *previous* answer together with the human's reply. Both runs happen in parallel.
- **A is the fixed primary reading target.** Do *not* let a mediator choose the primary: choosing is a judgment, and it turns the mediator back into a judge. Optionally swap A/B roles per session, never per turn.
- **A always receives B's full previous answer**, not Bx1. That bounds Bx's failure mode to the human's reading. As a free side effect, if A responds to a B point the human never saw, that is a visible sign of over-elision.
- Optional and cheap: tell A which of B's paragraphs the human was shown, for common ground ("the human saw ¶1, ¶3, ¶4; others were collapsed").

### 2.2 Why this shape (evidence)

- [Choi et al., NeurIPS 2025, "Debate or Vote"](https://arxiv.org/abs/2508.17536): majority voting over *independent* answers accounts for most of multi-agent debate's gains. The debate exchange itself is a martingale and does not improve expected correctness without a correction-biased update. +SURE (abstract).
- [Wynn et al. 2025, "Talk Isn't Always Cheap"](https://arxiv.org/abs/2509.05396): models flip from correct to incorrect answers in response to peer reasoning, "favoring agreement over challenging flawed reasoning", even when stronger models outnumber weaker ones. +SURE (abstract).
- [Bertalanič & Fortuna, CAIS 2026](https://www.caisconf.org/program/2026/papers/decomposing-sycophancy-fragility-consensus-collapse-and-cost-in-homogeneous-mult/): homogeneous debate among 7–8B models amplifies errors (up to 85.5% adoption of the majority answer) and loses to isolated self-correction. Note these are small models of one kind. +SURE (abstract).
- [Choi et al., ACL 2026, "When Identity Skews Debate"](https://arxiv.org/abs/2510.07517): identity bias is widespread, and "sycophancy [is] far more common than self-bias". Anonymising responses reduces it. +SURE (abstract). **Implication:** Bx will tend to *over*-elide B's own divergent points after reading A1.
- Khan et al. 2024, "Debating with More Persuasive LLMs Leads to More Truthful Answers": debate helps a *judge*, including human judges. ~SUSPECT, from memory and not re-read. The human is the judge here.
- **Caveat:** nearly all of this literature uses QA benchmarks with checkable answers and no human judge. Transfer to frontier models in open-ended design dialogue is -GUESS.

### 2.3 Peer-block framing

- Deliver peer content as a delimited, *anonymised* block in user-role text: "independent answer to the previous turn from a peer model; not endorsed by the human". The human's text takes precedence.
- Do **not** frame peer content as a tool result. -GUESS: tool output tends to get the credence of an observation (file contents, search results), and a peer's opinion shouldn't borrow that.
- Add a standing instruction for both models: weigh peer points on content, don't defer, don't contradict by reflex, and verify the claims your own answer depends on.
- Have both models use the human's certainty markers (+SURE/~SUSPECT/-GUESS/--WONDER) so their disagreements are comparable.
- In Claude Code, `UserPromptSubmit` `additionalContext` arrives wrapped in a system reminder "alongside the submitted prompt". --WONDER whether it lands before or after the human's text; it can't be controlled.

### 2.4 Bx (self-elision) spec

- **B returns anchors, not text.** For each paragraph to elide, B outputs its first ~8 words, e.g. a fenced JSON `{"elide": ["first eight words of paragraph …", …]}`.
- The orchestrator splits B1 into paragraphs (blank-line separated; keep code blocks and lists intact) and fuzzy-matches the anchors after normalisation.
- **Fail-safe:** an unmatched or malformed anchor means *keep* that paragraph. Unparseable output means show B1 in full and flag it. Failures then cost reading time, never information.
- **Rendering:** kept paragraphs appear verbatim. Elided runs become a bare `[2¶ elided]` marker that expands in place. No summary text, so "adds no new semantic content" holds by construction.
- **Run Bx as a real turn in B's session, not a fork.** A1 has to enter B's context before turn 2 anyway. B's next turn is then just U2, and the output stays tiny.
  - Extra cost per human turn: one extra cached read of B's context, A1's tokens (needed anyway), and a few dozen output tokens.
- **Draft instruction:**
  > Here is the other model's answer to the same message (A1). Do not rewrite your previous answer. List the paragraphs of your previous answer that are fully redundant with A1. Elide a paragraph only if A1 makes the same claim with the same conditions and caveats. Never elide a paragraph that disagrees with A1, even in part, or that contains any observation, example, or reasoning step A1 lacks. When in doubt, keep. Output only `{"elide": [<first ~8 words of each elided paragraph, verbatim>]}`.
- **Expected bias:** over-elision, from peer sycophancy (§2.2). The mitigations are the instruction above, the fail-safe direction, A receiving the full B1, and in-place expansion.

### 2.5 Tool-call forwarding (decided: inputs only, outputs by reference)

Within the peer package, keep the peer's text and its tool calls interleaved, so the receiver can follow the trajectory.

| Peer tool call | What to forward |
|---|---|
| Read (path, range) | The input itself is the reference. **Exception:** if the file changed since the peer read it, save the peer's version to the reference store and point there. Otherwise the receiver reasons over different bytes. |
| Shell, grep, web fetch, MCP calls (non-reproducible) | The input, plus a pointer to the output saved in a content-addressed store (`.peer/<sha256>.txt`). Identical outputs dedupe for free. If the harness already saved a large output to a file, point at that file. |
| Edit | Inline. The input *is* the diff, and it changes shared state the receiver must know about. |
| Write | Reference only (it carries the whole file), plus a line count. |
| Any oversized input (long scripts) | Reference. |

- Neither model's private reasoning is forwarded: Claude's thinking, Astra's encrypted reasoning. Text and tool inputs only.
- Residual risk: the receiver trusts the peer's commentary and never looks. Hence the "verify claims your answer depends on" instruction.
- This replaces an earlier idea, a per-model line-hash dedup ledger, which is no longer needed.

### 2.6 Shared working tree hazard

A and B run in parallel on the same files. "Update your ledger" sent to both means a write race. Pick one:
- a separate ledger file per model,
- a git worktree for B, or
- a read-only B.

### 2.7 Considered and rejected (so the next session doesn't relitigate them)

- **Serial review** (B sees A's *current* answer before answering): B never gets an unanchored view, and peer-exposure risk is maximal (§2.2).
- **An extractive diff by a third model:** rejected because the output is prosodic and conversational, and the two models write very differently.
- **A separate mediator M that picks a primary and quotes the other:** replaced by Bx, which has full context at cache-read cost and no third model. Keep M only as an *offline control* (§4).
- **Feeding A through channels, or making an orchestrator web UI the primary surface:** rejected because entry must be in-harness. Channels also trigger their own turns (§5.4).
- **Codex or OpenCode as B's harness:** the human's preference.
- **A second Claude Code instance as B's harness:** rejected; see §3.3.

---

## 3. G1 architecture

Two components plus a reference store:
- Claude Code hooks on A.
- One pi extension on B, which is also the orchestrator.
- The `.peer/` reference store.

No proxy, no gateway, and A runs stock Claude Code, so Remote Control and the 1h subscription cache stay intact.

### 3.1 A: plain interactive Claude Code + hooks

Hook facts (+SURE, [hooks docs](https://code.claude.com/docs/en/hooks)):
- **Placement.** `UserPromptSubmit` → `hookSpecificOutput.additionalContext` is added "alongside the submitted prompt", wrapped in a system reminder. It is inserted where the hook fired, at the end of context, so it's cache-safe. It doesn't appear as a chat message.
- **10,000-character cap** per `additionalContext`, `systemMessage`, or `initialUserMessage` string, and on plain stdout. Each string is measured separately, even across several hooks on one event.
  - Over the cap, the content is saved to a file in the session directory and replaced with the path plus a preview of up to 2,000 characters.
  - Claude is **not** asked to read that file. No setting raises the cap.
- **Multiple hooks:** "When several hooks return `additionalContext` for the same event, Claude receives all of the values."
  - **Chunking hack:** register N identical `UserPromptSubmit` command hooks. Hook *k* emits chunk *k* of the peer package. Label every chunk `[peer B1 k/n]` because arrival order isn't guaranteed (~SUSPECT unordered).
- **Timeouts.** The default `UserPromptSubmit` timeout is lowered to **30 s**. On timeout the output, including `additionalContext`, is *discarded* and the prompt goes through without it. Raise `timeout` explicitly.
- **`Stop` hook input** includes `last_assistant_message` (use this rather than parsing the transcript at Stop time) and `transcript_path`, which every hook receives.
- **`systemMessage`** is "Warning message shown to the user". --WONDER whether it renders on claude.ai/code under Remote Control. **Test this.** If it does, a *synchronous* `Stop` hook can wait for Bx1 and print it right under A1 on the phone. -GUESS: that may block input until the hook returns.
- **Async hooks** (`"async": true`, command hooks only): `additionalContext` and `systemMessage` are delivered to Claude **on the next conversation turn**, riding with the human's next input with no extra turn. They are *not shown* to the human. `asyncRewake` would wake Claude, causing an extra turn, so avoid it.
- A `MessageDisplay` hook exists for display-only rewriting of assistant text. It isn't used here.

Wiring:
1. **`UserPromptSubmit`** (synchronous, raised timeout):
   - Send the human's raw `prompt` to the pi extension; that starts B's turn in parallel.
   - Translate `@path` mentions into "the human attached: path" for B.
   - Wait for, or read, the finished B_{N-1} package and return it as chunked `additionalContext`.
   - On turn 1 there is no package, so just forward U1.
   - If B_{N-1} isn't finished yet, wait up to a cap, then send "peer still running" rather than dropping it silently.
2. **`Stop`:** pass `last_assistant_message` and the transcript offset to the extension, which triggers Bx once B1 is also done. Optionally block and emit Bx1 as `systemMessage` (pending the Remote Control rendering test).
3. **A's tool trail:** the extension tails A's transcript JSONL (path from the hook payload). ~SUSPECT the format is stable enough but undocumented, so pin a Claude Code version while developing and keep fixture transcripts for tests.
4. **Standing instructions for A** (peer-block semantics, certainty markers): put them in a project `CLAUDE.md` or a `SessionStart` `additionalContext`. Both are loaded at session start, so they're cache-safe. Don't edit them mid-session: CLAUDE.md edits don't apply until `/clear`, `/compact`, or a restart.
5. **Solo-turn toggle**, nice to have: a prompt prefix or flag file that skips B for quick clarifications.

### 3.2 B: interactive pi + an extension that is also the orchestrator

pi API facts (+SURE: [pi extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) and `packages/coding-agent/src/core/extensions/types.ts` in earendil-works/pi):
- `pi.sendUserMessage(content, { deliverAs?: "steer" | "followUp" })` **always triggers a turn**. Use it to inject U_N and the Bx prompt.
- `pi.sendMessage({customType, content, display, details}, { triggerTurn?, deliverAs?: "steer" | "followUp" | "nextTurn" })` sends a custom message. Its `content` is converted to user-role text for the model; `details` is never sent; `display` controls rendering.
- `pi.appendEntry(customType, data)` persists data that is **not sent to the LLM**. Pair it with `pi.registerEntryRenderer(customType, …)` ("Custom entries do not participate in LLM context") to **display Bx1 in B's pane without polluting B's context**.
- `pi.registerMessageRenderer(customType, renderer)` receives `MessageRenderOptions` including `expanded`, usable for collapse/expand.
- **Lifecycle:** `session_start` (start sockets and watchers here, not in the factory), `session_shutdown`, `before_agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `message_end`, `tool_call`, `tool_result`, `before_provider_headers`.
  - The session's messages are reachable via `ctx.sessionManager` (`getBranch()`), which is the source for B's tool trail.
- **Session format** is documented (`docs/session-format.md`). Prefer append-only changes. `before_agent_start` can alter prompt sections, but replacing the system prompt busts the cache.
- **Cache knobs:**
  - `PI_CACHE_RETENTION=long` requests extended provider caching where supported.
  - In settings, `cacheWarming: "off" | "streaming" | "idle"` (global; `"idle"` keeps caches warm between runs) and `showCacheMissNotices`.
  - Both matter for 30-minute reading turns.
  - --WONDER what retention the ChatGPT-subscription Codex backend honours. The public API defaults to 24h for orgs without zero-data-retention on GPT-5.x ([OpenAI caching docs](https://developers.openai.com/api/docs/guides/prompt-caching)).
- **Model:** Astra via pi's native `openai-codex` provider (ChatGPT login). This means **no Anthropic-to-OpenAI translation layer** in G1.
- **The human's pi already has** pi-vim, subagent definitions (`luna-scout`, `sonnet-scout`, `sol-builder`, `terra-worker`, `opus-builder`), and `extensions/git-deny.ts`. `auth.json` is gitignored (+SURE).

Extension responsibilities:
1. Listen on a local socket or file for messages from A's hooks: `U_N`, `A_N done`.
2. **Turn N:** `sendUserMessage(U_N)`. A_{N-1} is already in B's context from the previous Bx turn.
3. **Bx:** once A_N and B_N are both done, build A_N's package (text + tool inputs + references) and `sendUserMessage([peer block A_N] + Bx instruction)`. Parse the anchors from B's reply, render Bx1 with `appendEntry` + `registerEntryRenderer`, and write Bx1 out for A's optional `Stop` `systemMessage`.
4. Build B_N's package for A: full text + tool inputs + references, read from `ctx.sessionManager`. Write it where A's `UserPromptSubmit` hooks read it.
5. Maintain the `.peer/` content-addressed reference store.
6. Log every turn (history position, A_N, B_N, the anchors, the rendered keep-set) for the evaluation in §4.
7. **Convention:** B's pane is view-only. Typing into it directly would desync the protocol. --WONDER whether pi exposes an input event the extension could use to intercept and forward.

### 3.3 Why pi, not a second Claude Code, for B

- **pi:**
  - Native Responses API to Astra, with no translator.
  - Programmable injection with no 10k cap.
  - Display without context pollution.
  - Cache knobs.
  - The human already uses pi-vim and pi subagents.
  - The orchestrator lives inside the extension, so there are two components in total.
- **A second Claude Code** would need:
  - a gateway or proxy for Astra (translation, and Astra running under Claude Code's system prompt), and
  - channels (behind a dev-only flag) or tmux to push input.
  - Also, ~SUSPECT: a forked `claude -p --resume … --fork-session` builds a different system prompt or tool set from the interactive session, which would mean a cold cache.
  - Its only advantages are one transcript format and identical tool names.

### 3.4 Cache analysis

| Path | Behaviour |
|---|---|
| A's main conversation | Append-only: the hook context lands at the end. Subscription main conversation gets a 1h TTL by default ([prompt-caching docs](https://code.claude.com/docs/en/prompt-caching)). Optionally pin `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. |
| B | Append-only. Two turns per human turn (main + Bx). Bx adds one cached read of B's context plus a small output. |
| `.peer/` references | Cost nothing unless the receiver chooses to read them. |
| Breakers to avoid | Model switches mid-session, editing system prompts or CLAUDE.md mid-session, compaction on either side, MCP servers connecting mid-session (only when tool search is off), and think-time longer than the TTL. |

---

## 4. Evaluating Bx (and comparing against M)

- **Only false elisions matter**: something elided that the human would have wanted. Over-keeping just costs reading time.
- For the first ~20 hard turns, show elided paragraphs *dimmed* instead of collapsed. Flag false elisions with a keybinding and log the compression ratio.
- **Same-data comparison with a mediator M:**
  - M is stateless (input: A_N + B_N + instruction; output: the same anchor format), so it can be replayed **offline** on the logged turns exactly.
  - Label only the paragraphs where Bx and M disagree.
  - Bx can't be replayed cheaply because it needs B's live context, so run Bx live and M offline.
- **Live tripwire:** A referring to a B point the human never saw.

---

## 5. G2: Astra as native Claude Code subagents

### 5.1 How Claude Code chooses models for subagents (+SURE, [sub-agents docs](https://code.claude.com/docs/en/sub-agents), [model-config](https://code.claude.com/docs/en/model-config))

- Subagent frontmatter `model:` accepts aliases (`sonnet`, `opus`, `haiku`, `fable`), a full model ID ("same values as `--model`"), or `inherit`. `CLAUDE_CODE_SUBAGENT_MODEL` sets one model for all subagents.
- The `Agent` tool's per-call `model` parameter is a fixed enum. [claude-code#34821](https://github.com/anthropics/claude-code/issues/34821), asking for custom aliases, was closed *not planned*. **So define agent types** (e.g. `astra-builder.md` with `model: gpt-6-astra`) rather than expecting Fable to pick Astra ad hoc.
- ~SUSPECT, untested: frontmatter accepts a non-`claude` ID under a plain subscription login. shunt and agw both claim it works.
- `ANTHROPIC_CUSTOM_MODEL_OPTION` adds one picker entry and skips validation for that ID. ccmproxy can also inject picker entries via a `modelPicker` block in settings.json, or an experimental rewrite of Claude Code's startup model list.
- Unrecognised model IDs are assumed to have a 200K window. Correct it with `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or `modelOverrides`.

### 5.2 Route 1: a gateway via `ANTHROPIC_BASE_URL` (documented, but it costs Remote Control)

- **Officially supported:** with `ANTHROPIC_BASE_URL` set and *no* gateway credential variable, the claude.ai login stays active and subscription limits apply. The gateway must forward `anthropic-beta` unchanged, because it carries the OAuth capability and the 1h TTL ([llm-gateway](https://code.claude.com/docs/en/llm-gateway), [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)).
- **Costs of a non-Anthropic base URL** (+SURE):
  - **Remote Control disabled** since v2.1.196. Voice dictation also needs a claude.ai identity and is unavailable while an API key or token variable is set.
  - **Tool search off by default**, so all MCP tools load up front, and MCP servers connecting mid-session then bust the cache. Override with `ENABLE_TOOL_SEARCH=true`.
  - **Gateway model discovery** only runs with a gateway credential variable, and only keeps IDs containing `claude` or `anthropic`.
  - **The 1h TTL** depends on the gateway forwarding `anthropic-beta`; pin `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`.
- **Routing hints:** Claude Code sends `x-claude-code-request-class` (main/subagent/workflow/compaction/auxiliary), `x-claude-code-agent-type`, and `x-claude-code-agent-id` (v2.1.273+).
- **[shunt](https://github.com/pleaseai/shunt)** (Rust, pre-1.0, ~151★, docs at shunt.sh with `/llms-full.txt`):
  - Routes by model ID. Unmapped `claude-*` passes through to Anthropic on the caller's own credential. The `codex` provider reuses `~/.codex/auth.json` and translates between the two APIs.
  - Its docs claim it synthesises `previous_response_id` continuation over Codex WebSocket and preserves Codex reasoning (per its own comparison, raine/claude-code-proxy drops reasoning).
  - Native `tool_search` mapping on the Codex backend.
  - Prebuilt binaries for macOS/Linux; Windows needs `cargo`.
- **Same class:** [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) (no Anthropic passthrough), [JuLius5838/agw](https://github.com/JuLius5838/agw) (a Claude Code plugin plus private LiteLLM), LiteLLM (`chatgpt/` subscription provider plus `forward_client_headers_to_llm_api` for Max OAuth), and [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) (heavyweight).

### 5.3 Route 2: transparent TLS interception (keeps Remote Control). Recommended.

- **The gate**, from a decompile posted in [headroom#1779](https://github.com/headroomlabs-ai/headroom/issues/1779) (Claude Code v2.1.205): Remote Control requires OAuth && (`ANTHROPIC_UNIX_SOCKET` set || the `ANTHROPIC_BASE_URL` host is exactly `api.anthropic.com`).
  - `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` restores tool search and the 1M window but *not* Remote Control.
  - `ANTHROPIC_UNIX_SOCKET` is undocumented (absent from env-vars docs); don't build on it.
  - The upstream feature request [claude-code#72749](https://github.com/anthropics/claude-code/issues/72749) is open, labelled stale, with no Anthropic reply. #76653 was closed as its duplicate.
- **The workaround:** leave `ANTHROPIC_BASE_URL` unset, and intercept `api.anthropic.com` with a locally trusted CA, via `HTTPS_PROXY` (per process) or a hosts/DNS redirect.
  - Claude Code officially supports TLS-inspection proxies ([network-config](https://code.claude.com/docs/en/network-config)): OS trust store by default, `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CERT_STORE`, and the `HTTPS_PROXY` family.
  - **Bonus:** with no custom base URL, Claude Code keeps every feature it reserves for direct-to-Anthropic sessions, so all the §5.2 costs disappear.
- **[ccmproxy](https://github.com/jclab-joseph/claude-code-model-proxy)** (Go, ~15★, ~3 weeks old as of 2026-09-30; static binaries for linux/darwin/windows × amd64/arm64):
  - Answers as `api.anthropic.com` with its own CA. Codex models go over ChatGPT OAuth (reusing `~/.codex/auth.json`); **everything else goes to Anthropic verbatim**, including `/v1/code/*`.
  - Three listeners: direct TLS (for a hosts or DNS redirect), CONNECT (for `HTTPS_PROXY`), and plain HTTP.
  - Its own upstream DNS resolver, so it doesn't loop on the redirect.
  - **The CA private key is generated in memory, signs once, and is discarded.** Only the leaf key for the intercepted hosts is stored. +SURE (README).
  - Picker integration via a `modelPicker` settings block (`ccmproxy models --settings-json`) or `--experimental-modify-bootstrap-models`.
  - Translation details "follow CLIProxyAPI". --WONDER about its fidelity and its Codex-side cache behaviour compared with shunt.
  - Per-process setup example from its README: settings.json `env` gets `HTTPS_PROXY=http://127.0.0.1:8080` and `NODE_EXTRA_CA_CERTS=<ca.crt>`.
- **Other prior art:** teamclaude's man-in-the-middle mode ([write-up](https://apfelbaum.io/remote-control-claude-code/)); dthinkr's `rc-proxy` in [claude-code-workarounds](https://github.com/dthinkr/claude-rc-proxy) (macOS; forwards inference to your own gateway); claude-code-cache-fix's forward-proxy mode; mitmproxy+Headroom gists; [uwence/evo-tls-proxy](https://github.com/uwence/evo-tls-proxy) (Windows).
- **Gotchas:**
  - Only intercept/rewrite `POST /v1/messages` (and `count_tokens`, `GET /v1/models`). **Pass `/v1/code/*` (Remote Control's control channel) and websockets through untouched.** Apfelbaum's 403 came from a proxy rewriting auth on `/v1/code/*`.
  - Everything dies the day Anthropic pins certificates (rc-proxy's README says so explicitly).
  - The proxy sees OAuth bearer tokens in plaintext. Disable or redact body and header logging.
  - **Network-wide DNS redirect** (homelab box + UniFi/AdGuard rewrite):
    - Every client needs the CA.
    - -GUESS: if the Claude phone app talks to `api.anthropic.com`, Remote Control from the phone on home Wi-Fi breaks.
    - Scope rewrites per client: AdGuard Home supports client-specific rules; ~SUSPECT UniFi local DNS records are network-wide only.
  - **Policy:** this deliberately routes around a gate Anthropic added. They gave no reason; "anti-distillation" and "security" explanations online are third-party speculation. Passthrough is byte-identical, so -GUESS low account risk. Unverifiable.
- **Composition fallback:** if ccmproxy's Codex translation is weak, use a forward proxy (a ~20-line mitmproxy addon, or rc-proxy pointed at a gateway) that sends only Astra-model requests to shunt, with everything else going verbatim to Anthropic.

### 5.4 Channels (relevant to both goals; rejected for A's input)

+SURE, from [channels](https://code.claude.com/docs/en/channels) and the [channels reference](https://code.claude.com/docs/en/channels-reference):
- An MCP server pushes `notifications/claude/channel` events into a running session; they appear as `<channel source=…>` tags.
- **Every event triggers a turn.** "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn." There is no option to defer an event until the next user input.
- The server's `instructions` string is delivered to Claude as context.
- Research preview: custom channels need `--dangerously-load-development-channels server:<name>` plus a confirmation prompt, and claude.ai or Console auth.
- A two-way permission-relay capability (`claude/channel/permission`) exists.

### 5.5 Official alternative (not native): [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)

- Commands: `/codex:review`, `/codex:adversarial-review`, `/codex:rescue` (via a `codex:codex-rescue` subagent that forwards to the Codex app-server), plus `--resume`/`--background`, `/codex:status`, `/codex:result`, `/codex:transfer`.
- First-party on both ends. Astra runs in its own harness with no translation. About 33.7k★.
- A reasonable replacement for the one-shot wrappers if native subagents disappoint.

---

## 6. Policy landscape (as of 2026-09-30)

- **Anthropic** ([support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), June 15 update): "For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits." +SURE.
  - The *paused* plan would move those uses to a monthly credit ($200 on Max 20x), then API rates.
  - Interactive Claude Code was explicitly excluded from that plan.
  - **Implication:** anything that runs Fable through the SDK (Meridian, `claude -p` orchestrators) sits in the bucket Anthropic already tried to meter once. G1 keeps Fable in interactive Claude Code.
- Anthropic **documents** subscription login through an `ANTHROPIC_BASE_URL` gateway as supported (§5.2). It doesn't support routing Claude Code to non-Claude models; agw says so. I found no explicit prohibition (-GUESS).
- **OpenAI:** shunt's README quotes OpenAI's Thibault Sottiaux welcoming GPT inside Claude Code ("We don't discriminate on the harness"). Not verified first-hand.
- **Google Antigravity:** its terms explicitly forbid third-party clients using Antigravity OAuth (quoted in shunt's README). Avoid it.

---

## 7. Meridian / pi diagnosis (only if Fable-in-pi is ever revisited)

- **The human's config** (+SURE): `Dotfiles/pi/agent/models.json` sets `baseUrl` to `127.0.0.1:3456` and the header `x-meridian-agent`. There is **no session-affinity extension**: `extensions/` contains only `git-deny.ts`.
- **[meridian#820](https://github.com/rynfar/meridian/issues/820)** (closed 2026-09-09): pi sends no session ID, and every agentic turn ends in a `tool_result`. So every tool round runs as a fresh Agent SDK session, the cache falls to the static-prefix floor, and the model loses its own recent turns.
  - The documented fix is a `before_provider_headers` extension that sends `x-session-affinity` per pi session. See Meridian `docs/configuration.md`, "Client-driven tool loops need a session header".
- **[meridian#1047](https://github.com/rynfar/meridian/issues/1047):** pi ≥0.85 inserts effort system messages, forcing every tool round into a full replay (~6% cache hits). Fixed by PR #1057 (closed 2026-09-18). Latest release seen: 1.79.0 (2026-09-29).
- **Structural fragility** (+SURE on mechanism, -GUESS on forecast): Meridian matches each stateless request against a stored stateful SDK session, and any mismatch means a fresh replay and a cold cache. Aug–Sep bugs of exactly this class: #767, #820, #861, #888, #1047. Expect recurrences on client upgrades.

---

## 8. Prior art for the dual-model pattern

- **pi "advisor" extensions** ([catalog](https://pi.dev/packages?name=advisor), ~20 packages), derived from oh-my-pi's built-in `advisor` role:
  - [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor): a long-lived second agent fed one turn-delta at a time. Cache-correct shape; compacts itself at 80%.
  - [@jnardiello/pi-advisor](https://pi.dev/packages/@jnardiello/pi-advisor): `deliverAs: "nextTurn"`, so no extra turns, but a stateless second model (`pi -p --no-session`).
  - All of them are watchdogs aimed at the primary agent, not a peer voice for the human.
- **Claude Code `/advisor`** ([docs](https://code.claude.com/docs/en/advisor)): Claude advising Claude only, and model-invoked. "The advisor model's own read of the conversation is not cached."
- **Councils:** [karpathy/llm-council](https://github.com/karpathy/llm-council), [roundtable-cli](https://github.com/vladagurets/roundtable), altana `council --interactive`. One-question deliberations, not continuing conversations.
- **Generic pattern names:** a round-robin group chat with a human participant (AutoGen `RoundRobinGroupChat` + `UserProxyAgent`, ~SUSPECT). Du et al. 2023 multiagent debate is the per-turn "independent answers, then cross-exposure" variant.
- **Nothing found** that matches G1 exactly: two persistent sessions, human-moderated, with a peer voice addressed to the human.

---

## 9. Verification checklist (cheapest first)

1. **Remote Control rendering:** does a synchronous `Stop` hook's `systemMessage` appear on claude.ai/code? This decides whether Bx1 can be read on the phone.
2. **Hook chunking:** do N `UserPromptSubmit` hooks each delivering ≤10k characters all arrive, and in what order? Does the raised timeout hold?
3. **pi B session:**
   - Astra via `openai-codex`; cache reads growing turn over turn (check usage and `showCacheMissNotices`).
   - `PI_CACHE_RETENTION=long` and `cacheWarming: "idle"` across a 30+ minute idle period.
4. **pi extension plumbing:**
   - `sendUserMessage` from a socket handler while idle.
   - `appendEntry` + `registerEntryRenderer` shows Bx1 *without* it entering B's context (confirm via the session file or the next request's usage).
5. **Bx quality:** anchor-match rate; false elisions over ~20 hard turns (§4).
6. **G2 / ccmproxy via `HTTPS_PROXY`** (per process, in a throwaway session first):
   - Remote Control still connects.
   - The main session's `usage.cache_creation.ephemeral_1h_input_tokens` is present (`claude -p "hello" --output-format json`) and cache reads appear on turn 2.
   - An `astra-*` subagent with `model: gpt-6-astra` routes to Codex; its cache reads grow from its second request; `SendMessage` continuation keeps the thread.
   - Tool search still deferred (`/context`).
7. **If ccmproxy's fidelity is poor:** the forward-proxy + shunt composition, re-running step 6.
8. **Optional, if Fable-in-pi is ever wanted:** Meridian session-affinity extension + a release after #1057. Watch `/telemetry/requests` for `lineage=continuation` and the cache % across tool rounds.

## 10. Open questions

- --WONDER: placement order of `additionalContext` relative to the human's prompt text.
- --WONDER: whether Claude Code validates a non-`claude` model ID when there's no custom base URL (ccmproxy's picker integration suggests it can be satisfied).
- --WONDER: cache retention on the ChatGPT-subscription Codex backend versus the public API's 24h.
- --WONDER: whether pi offers an input hook to keep B's pane from desyncing if the human types into it.
- -GUESS: how much quality Astra loses running under Claude Code's system prompt and tools in G2, compared with its native harness. Measure it before retiring the `codex-worker`/`codex-reviewer` wrappers.

## 11. Implementation hygiene

- Never read or print credential files: `~/.codex/auth.json`, `Dotfiles/pi/agent/auth.json`, ccmproxy's `tls.key`, or anything Meridian stores. Interception proxies must not log `Authorization` headers.
- Pin Claude Code and pi versions while developing against undocumented surfaces (the transcript JSONL, the Remote Control gate behaviour).
- TDD targets: anchor parsing and paragraph matching; package building from fixture transcripts (Claude Code JSONL and pi session files); content-addressed reference writing.
