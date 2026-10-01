# Claude Code hooks / RC / caching fact sheet (dual-model harness)

Researched 2026-09-30. Installed = latest = Claude Code 2.1.286 (GitHub releases/latest = v2.1.286, 2026-09-30T19:10Z; nothing newer exists).
Certainty tags: +SURE (doc quote or directly observed), ~SUSPECT (strong inference), -GUESS, --WONDER (unknown, needs a test).
Raw docs fetched as markdown are in `research/raw/` (hooks.md, remote-control.md, prompt-caching.md, changelog.md, ...) for later grep.
Doc base: https://code.claude.com/docs/en/<page>.md . "BIN" = I grepped strings of the local 2.1.286 binary (read-only, not executed); BIN claims are about minified source and weaker than docs.

---------------------------------------------------------------------------------------------------
## 0. Local install packaging (+SURE)
- `command -v claude` -> `C:\Users\ec\AppData\Local\mise\shims\claude` (a 226 KB mise shim `.exe`).
- `mise which claude` -> `C:\Users\ec\AppData\Local\mise\installs\claude-code\2.1.286\claude.exe` (install dir is a junction into `mise\http-tarballs\3f19d0...`). `metadata.json` there: `url: https://storage.googleapis.com/claude-code-dist-.../claude-code-releases/2.1.286/win32-x64/claude.exe`, size 245092000, platform windows-x64. So mise's `http` backend downloads Anthropic's single-file NATIVE binary.
- Second copy: `C:\Users\ec\.local\bin\claude.exe` + `C:\Users\ec\.local\share\claude\versions\{2.1.284,2.1.285,2.1.286}` (native installer's self-updater). SHA-256 of mise copy, `.local\bin` copy and `versions\2.1.286` are IDENTICAL (0b6ecec8...fa333). PATH (`where.exe claude`) lists mise shim first, `.local\bin` second.
- PE (`MZ`), 245 MB. Embedded module paths `B:/~BUN/root/chunk-*.js` -> ~SUSPECT a Bun `--compile` executable.
- Not npm: `AppData\Roaming\npm\node_modules` has no `@anthropic-ai`; only factorio tools.
- Consequence for network config (item 11): docs say "the native installer always has [tls.getCACertificates]" (network-config). See section 11.

---------------------------------------------------------------------------------------------------
## 1. UserPromptSubmit
Doc: https://code.claude.com/docs/en/hooks.md#userpromptsubmit , #add-context-for-claude , #json-output

### Input (+SURE)
Common fields + `prompt`; plus `session_title` when a custom title exists. Common fields: `session_id`, `prompt_id` (v2.1.196+), `transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode`, `hook_event_name` (`effort` only on tool-context events; `agent_id`/`agent_type` only inside subagents).
Quote: "In addition to the common input fields, UserPromptSubmit hooks receive the `prompt` field containing the text the user submitted. Pasted content that collapsed to a `[Pasted text #N]` placeholder arrives expanded in place."
NB: no field says where the prompt came from (typed / RC / queued). --WONDER whether BIN-internal `promptSource` is exposed (docs list none).

### Output / additionalContext semantics (+SURE)
- Quote (hooks.md #add-context-for-claude): "The `additionalContext` field passes a string from your hook into Claude's context window. Claude Code wraps the string in a system reminder and inserts it into the conversation at the point where the hook fired. Claude reads the reminder on the next model request, but it doesn't appear as a chat message in the interface."
- Placement quote: "UserPromptSubmit and UserPromptExpansion: alongside the submitted prompt".
- Nest it: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`. Quote (hooks-guide): "if you place it at the top level of the JSON, Claude Code silently ignores it."
- Plain stdout on exit 0 ALSO becomes context for this event: "The exceptions are UserPromptSubmit, UserPromptExpansion, SessionStart, and PostModelSwitch, where Claude Code adds plain-text stdout as context".
  GOTCHA (+SURE): stdout that "Starts with `{` and ends with `}`" is parsed as JSON; if that parse/validation fails (since v2.1.248): "On the events that add plain-text stdout as context, Claude Code doesn't add the text." So peer-model prose that happens to start with `{` and end with `}` silently vanishes. Emit JSON (properly escaped) instead of raw stdout.
- Other output fields: `decision:"block"`+`reason` (shown to user, NOT added to context), `sessionTitle`, `suppressOriginalPrompt`, universal `continue`/`stopReason`/`systemMessage`/`terminalSequence`. Cannot rewrite the prompt: "UserPromptSubmit: can't replace the prompt; it only injects additionalContext alongside it".
- Phrase as facts: "Write the text as factual statements rather than imperative system instructions... Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes Claude to surface the text to you instead of treating it as context."
- Rendering (BIN, ~SUSPECT): attachment `{type:"hook_additional_context", content:string[], hookName, toolUseID, hookEvent}` renders as one meta user message: `<system-reminder>` + "`<hookName> hook additional context: <content strings joined by \n>`". Plain stdout renders as "`<hookName> hook success: <stdout>`" (attachment `hook_success`, only for SessionStart/UserPromptSubmit/UserPromptExpansion). Docs agree: "each injected as a system reminder that starts with the hook's name".

### Char cap (+SURE)
hooks.md #json-output: "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters:
 - Scope: Claude Code measures each string on its own, even when several hooks run for the same event. For JSON output, each field is measured separately; plain stdout is measured whole.
 - Over the limit: Claude Code saves the output to a file in the session directory and replaces it with the file path and a preview of up to the first 2,000 characters. ... Unlike that Bash ceiling, this cap has no setting or environment variable to raise it.
 - Reading the file: Claude Code doesn't ask Claude to read the file, so keep anything Claude must always see within the cap."
(Changelog 2.1.89: "Changed hook output over 10,000 characters to be saved to disk with a file path + a 2,000-character preview instead of being injected directly into context".) 2.1.280 added hook-output sizes/oversize count to OTel `hook_execution_complete`.
=> Cap is per hook-string, not aggregate; the model sees only a 2,000-char preview + path of an oversize peer answer, and is not told to open it.

### Multiple hooks on same event (+SURE for "all delivered", -GUESS for order)
- hooks.md: "All matching hooks run in parallel. If you define the same handler in more than one settings file, it runs once. A plugin's or skill's copy of the same handler stays separate."
- hooks.md: "When several hooks return `additionalContext` for the same event, Claude receives all of the values." hooks-guide.md: "Text from `additionalContext` is kept from every hook and passed to Claude together." Also "every hook's command runs to completion before Claude Code merges the results."
- NO ordering guarantee is documented (parallel execution). BIN ~SUSPECT: contexts are collected into ONE attachment's `content[]` array in hook-completion order and rendered as ONE block under a single `hookName` label joined by newlines -> per-hook attribution is lost and order is racy. Use ONE hook (a single wrapper script) if order/attribution matters.

### Timeout (+SURE)
- hooks.md #common-fields: `timeout` = "Seconds before canceling." "Defaults: 600 for command, http, and mcp_tool; 30 for prompt; 60 for agent. Claude Code lowers the command, http, and mcp_tool default to 30 on UserPromptSubmit, PreModelSwitch, and PostModelSwitch, and to 10 on MessageDisplay."
- There is no documented maximum; set `timeout` explicitly in the hook entry ("If your hook needs more time, set the `timeout` field").
- On timeout (hooks.md #userpromptsubmit): "a UserPromptSubmit command, HTTP, or MCP tool hook that reaches its timeout is canceled and its output, including any `additionalContext`, is discarded. The prompt still reaches Claude without that context. The transcript shows a notice naming the hook, the timeout that fired, and that the output was discarded." (2.1.280 improved the notice to name the command.) It blocks model processing meanwhile: "a stuck hook stalls the session".
- `async:true` UserPromptSubmit = output arrives a turn late (section 4); not suitable for same-turn injection.
- Workspace trust: interactive sessions hold back ALL settings-file hooks (incl. `~/.claude/settings.json`) until the folder's trust dialog is accepted (hooks.md #workspace-trust). `-p`/SDK never show the dialog and treat the folder as trusted.

---------------------------------------------------------------------------------------------------
## 2. Cache stability of hook additionalContext
No single doc sentence says "re-sent verbatim on every request", but the documented pieces compose:
- +SURE persisted: hooks.md #add-context-for-claude: "Claude Code saves the injected text in the session transcript. For mid-session events like PostToolUse or UserPromptSubmit, when you resume with --continue or --resume, Claude Code replays the saved text rather than re-running the hook for past turns, so values like timestamps or commit SHAs become stale."
- +SURE whole conversation re-sent: prompt-caching.md: "Each time you send a message in Claude Code, it makes a new API request. ... Claude Code re-sends the full context: the system prompt, your project context, every prior message and tool result, and your new message. New content is appended at the end". Layer table: hook-added text is in the "Conversation" layer ("Changes: Every turn"), not system prompt/project context.
- +SURE survives compaction only as summary: context-window.md compaction table: "Context that hooks added earlier | Summarized with the rest of the conversation". (SessionStart hooks matching `compact` re-run and re-add.)
- Changelog evidence the team treats hook output as prefix-stable and persisted:
  - 2.1.277: "Fixed attachments recorded earlier in a conversation being re-rendered after a resume or relaunch, which dropped extended thinking and missed the prompt cache"
  - 2.1.277: "Fixed sessions continued after `/clear` ... missing part of their first message when a SessionStart hook printed output, causing a full prompt-cache miss"
  - 2.1.267: "Fixed resuming a session (transcript over 5 MB): parallel tool calls and their hook output are no longer dropped from the reloaded conversation"
  - 2.1.261: "Fixed resuming a session losing hook output and other context around parallel tool calls, which changed the resumed request"
  - 2.1.265: "Fixed agent teammates and resumed subagents moving SubagentStart hook context and preloaded skills out of the prompt prefix on later turns, which broke prompt-cache reuse"
  - 2.1.259: "Fixed blocking Stop hooks causing the turn after a block to lose the model's reasoning from that turn and, on some models, miss the prompt cache" (so avoid `decision:"block"` on Stop for this harness)
- Verdict: ~SUSPECT-high (+SURE for "persisted + replayed on resume, not re-run"): additionalContext is ephemeral to NOTHING; it becomes a permanent, append-only conversation entry (stable prefix, grows context every turn, summarized on compaction). Injecting a changing peer answer each turn is cache-safe (only appended after the new user prompt) but costs tokens cumulatively. Caveat -GUESS: very old turns may be trimmed by compaction/tool-result clearing; not documented for hook attachments.
- Doc says text inserted "at the point where the hook fired": for UserPromptSubmit that is right after the prompt; local transcript shows `attachment` entries written directly after the `user` entry (+SURE, observed), rendered as separate `isMeta` user messages (BIN) -> likely same API user turn as extra text block (-GUESS).
- Resume-staleness: SessionStart input gets `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` on resume (v2.1.251+).

---------------------------------------------------------------------------------------------------
## 3. Stop hook
Doc: https://code.claude.com/docs/en/hooks.md#stop (+SURE below unless marked)
- Fires: "Runs when the main Claude Code agent has finished responding. Does not run if the stoppage occurred due to a user interrupt. API errors fire StopFailure instead."
- Input: common fields + `stop_hook_active` (true if already continuing due to a stop hook), `last_assistant_message` ("the text content of Claude's final response, so hooks can access it without parsing the transcript file"; added 2.1.47), `background_tasks[]` (id,type,status,description,command,agent_type,server,tool,name), `session_crons[]` (id,schedule,recurring,prompt). `permission_mode`, `effort` also present. Also: "The transcript file is written asynchronously and may lag the in-memory conversation, so it may not yet include the current turn's most recent messages when a hook fires" -> use `last_assistant_message`, not `transcript_path`.
- `StopFailure` (separate event, output ignored except `terminalSequence`): `error` enum (rate_limit, overloaded, authentication_failed, ..., max_output_tokens, unknown), `last_assistant_message` = the API error string.
- Output: `decision:"block"` + required `reason` (exit 2 + stderr is equivalent) = Claude must continue; `hookSpecificOutput.additionalContext` = non-error feedback that also continues the conversation ("transcript labels it `Stop hook feedback`"); 8-consecutive-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 0 disables). For a pure reporting hook: exit 0, no decision.
- `systemMessage` (universal field): "Warning message shown to the user." Not discarded on Stop (docs list the events that discard it: Setup, InstructionsLoaded, MessageDisplay, Notification, SessionEnd, PreCompact, PostCompact, Elicitation*, WorktreeRemove, ConfigChange).
  - TUI rendering (BIN, ~SUSPECT): attachment `hook_system_message` rendered as the line "`<hookName> says: <content>`"; its API render is `[]` i.e. NEVER sent to the model (display-only). Agent SDK docs (agent-sdk/typescript#sdkinformationalmessage): "On Claude Code v2.1.227 or later, a hook's systemMessage can arrive as this message [`system`/`informational`], with each line prefixed by the hook's name, such as `PostToolUse:Bash says:`."
  - Sync vs async: "Unlike a synchronous hook's systemMessage, neither field is shown to you" for async hooks (their systemMessage/additionalContext go to Claude on the next turn).
  - Cap: 10,000 chars like additionalContext.
- Exit-2 behaviour table: Stop "Prevents Claude from stopping, continues the conversation"; other non-zero codes = non-blocking error notice ("hook error ... Failed with non-blocking status code").
- Default timeout for Stop command hooks = 600 s (no 30 s lowering).
- Hook output size cap, workspace trust, JSON parse rules: same as section 1.

---------------------------------------------------------------------------------------------------
## 4. Async hooks / asyncRewake (+SURE; hooks.md #run-hooks-in-the-background)
- Fields (command hooks only): `async: true`; `asyncRewake: true`. Quote: "`asyncRewake` | If true, runs in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder so it can react to a long-running background failure".
- "Async hooks can't block or control Claude's behavior: response fields like decision, permissionDecision, and continue have no effect".
- Delivery: "After the background process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields from the hook's JSON response to Claude on the next conversation turn. Unlike a synchronous hook's `systemMessage`, neither field is shown to you." Wrong-typed fields dropped (warning under `--debug`). Completion notices hidden unless verbose (Ctrl+O / `--verbose`).
- Limitations: "Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle." No dedupe across firings; each firing = new process.
- Timeout: "Once an async hook is running in the background, Claude Code doesn't enforce timeout on it. Claude Code still enforces timeout on a hook you run with asyncRewake."
- `-p`: "Claude Code kills any async hook still running at teardown and finalizes it with outcome cancelled"; to outlive `claude -p` start a fully detached process.
- Harness relevance: async Stop hook = zero-latency "report A's answer out" but nothing user-visible; sync Stop hook with `systemMessage` is the only display channel. `asyncRewake` (exit 2) = documented way for an out-of-process job to start a turn in an IDLE session with stderr as a system reminder (model-visible, will cost a turn; loop risk). --WONDER whether it works on a Stop-event hook (field is documented as generic on command hooks).
- BIN: attachment type `async_hook_response`.

---------------------------------------------------------------------------------------------------
## 5. MessageDisplay hook (exists; +SURE)
Doc: https://code.claude.com/docs/en/hooks.md#messagedisplay ; added in 2.1.152 (2026-05-27): "Added a `MessageDisplay` hook event that lets hooks transform or hide assistant message text as it is displayed".
- Fires "while an assistant message streams to the screen": per batch of newly completed lines; no matcher; only for messages with text. Default timeout 10 s; on failure/timeout "Claude Code displays the original text".
- Input: common + `turn_id`, `message_id` (UUID, not the API `msg_` id), `index`, `final`, `delta` (whole new lines, final batch may end mid-line / be empty).
- Output: `hookSpecificOutput.displayContent` replaces the delta on screen. `systemMessage` and `continue` are discarded. No decision control.
- Context effect (+SURE): none. "MessageDisplay is display-only: the replacement text changes only what is rendered on screen. The transcript and what Claude sees keep the original text, so Claude never sees the replacement, and verbose mode shows the original. The hook receives assistant message text only".
- `-p`/Agent SDK: "MessageDisplay runs once per assistant message ... `index` is 0, `final` is true, and `delta` holds the entire message".
- Does it apply to Remote Control clients? Not documented. --WONDER; ~SUSPECT it only affects the local TUI/SDK render (RC clients get transcript frames).

---------------------------------------------------------------------------------------------------
## 6. Remote Control (RC)
Doc: https://code.claude.com/docs/en/remote-control.md (+SURE quotes)

### Requirements
- "Subscription: available on Pro, Max, Team, and Enterprise plans. API keys are not supported."
- "API endpoint: not available in any of these configurations: ... You point `ANTHROPIC_BASE_URL` at a host other than `api.anthropic.com`, such as an LLM gateway or proxy. Unset the variable to use Remote Control." Also Bedrock/Vertex/Foundry and Claude apps gateway. (2.1.271: `ANTHROPIC_UNIX_SOCKET` third-party local proxies "are again treated like other custom gateways, including for Remote Control".)
- Auth: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper` all conflict ("Remote Control requires claude.ai subscription auth"); `claude setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` tokens can't ("requires a full-scope login token").
- Unavailable if `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` set; `DISABLE_TELEMETRY`/`DO_NOT_TRACK` OK since v2.1.283.
- Team/Enterprise: Owner must enable; ZDR orgs can't. Workspace trust required. `remoteControlAtStartup: true` honored only from user/managed settings (project/local can only turn it off). `--remote-control` flag per session; `/remote-control` mid-session. One remote session per interactive process.
- Transcript stored on Anthropic servers while connected. Outbound HTTPS only (443). "Remote Control requires access to the Anthropic API on port 443"; 2.1.261: "Fixed Remote Control's inbound event stream failing behind TLS-inspecting corporate proxies on native Windows" -> `HTTPS_PROXY`/MITM CA (not a base-URL change) is the only interposition compatible with RC. -GUESS that a MITM'ing local proxy also works.
- Not from RC: `/plugin`, `/resume` etc. local-only; Auto permission mode can't be chosen from RC (mobile.md: "you can't select Auto for a Remote Control session").
- Model A must therefore be stock Claude on api.anthropic.com. A subagent `model:` naming a non-Claude model would need a custom base URL for the whole process => kills RC. Keep the peer model out-of-process (hook/CLI/API).

### Do hooks fire for prompts submitted via RC?
- No explicit doc sentence for UserPromptSubmit. Supporting statements: remote-control.md: "Claude keeps running locally the entire time ... your filesystem, MCP servers, tools, and project configuration all stay available"; hooks.md: "Claude Code fires the same hook events wherever it runs: sessions in the terminal, IDE extensions, the Desktop app, and cloud sessions"; hooks.md: "Claude Code v2.1.199 and later sets `$CLAUDE_CODE_BRIDGE_SESSION_ID` to the Remote Control session ID while the local session has an active Remote Control connection" (env var provided to hook command subprocesses; env-vars.md: "Set automatically in Bash tool and hook command subprocesses while the session has an active Remote Control connection ... same identifier that appears in the session's claude.ai/code URL"); changelog 2.1.265: "Fixed `/clear` from Remote Control waiting on SessionStart hooks".
- BIN: RC inbound `user` frames go to `onInboundMessage` -> the same local message queue (~SUSPECT hooks run). => ~SUSPECT YES for normal idle-session prompts; --WONDER for messages the phone sends MID-TURN: interactive-mode.md says queued messages are passed to Claude "as soon as those tool calls finish, within the same turn", and transcripts store them as `queued_command` attachments ("The user sent a new message while you were working:"). Not documented whether UserPromptSubmit fires for those. TEST IT.
- Channel events (`mode:"prompt"`, `isMeta:true`, `origin.kind:"channel"`, BIN) -- hooks behaviour unknown.

### systemMessage / hook output on claude.ai/code & mobile
- remote-control.md and mobile.md say NOTHING about hooks, systemMessage, or hook rendering. +SURE (grepped both pages).
- BIN ~SUSPECT-high: the RC bridge forwards a transcript entry iff predicate `WJ(e)` is true; that allow-list includes `user`, `assistant`, `system/local_command|compact_boundary|model_consent_fallback`, `attachment` types `hook_system_message` and `tool_host_result_lines`, and human-origin `queued_command`; it does NOT include `hook_additional_context`/`hook_success`. The bridge also emits `{type:"system",subtype:"informational",level:"notice"}` frames to clients. => a sync hook's `systemMessage` plausibly shows on claude.ai/code and mobile; additionalContext does not (consistent with the doc: "doesn't appear as a chat message in the interface"). Format on client unknown (--WONDER). TEST IT with a Stop hook that returns `systemMessage`.
- Changelog 2.1.257: "Fixed Remote Control connecting mid-session re-sending the Bash tool definition, causing a prompt-cache miss" (so RC connect is cache-aware); 2.1.285: "Fixed Remote Control marking a message as read as soon as it arrived instead of when Claude started on it, and losing a message still queued when the terminal quit (it now arrives on the next resume)"; 2.1.286: "Fixed a Remote Control message that arrived while Claude Code was exiting being marked delivered and then never answered".

### Documented ways for an external process to put content into a session (none is "display-only into RC")
1. Hook `systemMessage` (sync): display-only, model never sees it (BIN: API render `[]`). Local TUI + SDK stream; RC unconfirmed (above).
2. Hook `terminalSequence` (OSC 0/1/2/9/99/777, BEL): terminal only; ignored in `-p`/SDK.
3. `MessageDisplay.displayContent` (rewrite what's shown; e.g. append a footer): local/SDK display only; RC unknown.
4. Channels (MCP server, `notifications/claude/channel`): model-visible `<channel>` tag; starts/affects a turn (section 12). Research preview, flags `--channels`/`--dangerously-load-development-channels`; requires claude.ai or Console API-key auth.
5. Cross-session messaging (`SendMessage`/`ListAgents`; v2.1.224+, native Windows v2.1.234+): "The receiving Claude reads the message between tool calls during an active turn... When the receiving session is idle, Claude Code starts a new turn with the message." Model-visible and costs a turn. https://code.claude.com/docs/en/cross-session-messaging.md
6. `asyncRewake` exit 2 (section 4).
7. Status line script / `Notification` hooks: local terminal only.
No documented "post inert text into the session UI from outside" API. +SURE (searched llms.txt, hooks, headless, SDK, channels, RC pages).

---------------------------------------------------------------------------------------------------
## 7. Print mode + SessionStart
- Hooks fire in `claude -p` (+SURE): headless.md: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted." `--bare` "skips auto-discovery of hooks, skills, ...". 2.1.286: "`--bare` ... send the model no system reminders". Changelog 2.1.268 "Fixed PermissionRequest hooks not firing in `--print` mode" (others already worked); 2.1.204: hook events stream in headless SessionStart. `-p` stream-json emits `hook_started`/`hook_progress`/`hook_response` for SessionStart/Setup hooks. `-p` specifics: async hooks killed at teardown; MessageDisplay once per message; `terminalSequence` ignored; Setup event only with `--init-only`/`--init`/`--maintenance`.
- SessionStart (+SURE): only `command` and `mcp_tool` types; matchers startup|resume|clear|compact|fork. `additionalContext` = "String added to Claude's context at the start of the conversation, before the first prompt"; plain stdout also added. Also returns `initialUserMessage` ("Applies in non-interactive mode with the `-p` flag, where it becomes the first turn even if no prompt is provided"), `sessionTitle`, `watchPaths`, `reloadSkills`. Runs again on resume (`source:"resume"`, `"fork"` since 2.1.214) and after `/clear`/compaction; `mcp_tool` SessionStart hooks are skipped at launch (MCP not up yet). Input may include `model`, `agent_type`, `session_title`, and the 4 staleness fields on resume (v2.1.251+). stderr on exit 2 shown to user only. 10,000-char cap applies.
- Hooks don't run before trust in interactive mode; resume appears immediately without waiting for SessionStart hooks (2.1.268).

---------------------------------------------------------------------------------------------------
## 8. Transcript JSONL format
Official docs: NO schema. Only: claude-directory.md: "`projects/<project>/<session>.jsonl` | Full conversation transcript: every message, tool call, and tool result"; sessions.md: "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`"; agent-sdk/session-storage.md: entries are "`{ type: string; ... }` ... Treat them as opaque JSON-safe values". hooks.md warns `transcript_path` lags the in-memory conversation. Transcripts are plaintext (secrets written if a tool printed them).
Observed in THIS machine's transcripts (types/keys only, +SURE for what I saw; schema unofficial and version-volatile):
- Top-level `type`: `user`, `assistant`, `attachment`, `system` (subtypes seen: `turn_duration`, `local_command`, `away_summary`, `compact_boundary`, `agents_killed`, `model_refusal_fallback`), `queue-operation`, `permission-mode`, `mode`, `bridge-session` (RC: bridgeSessionId, lastSequenceNum, owner*), `ai-title`, `last-prompt`, `file-history-snapshot`, `atis-latch`.
- `user`/`assistant` keys: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, `message{role,content}`; user adds `promptId`, `origin{kind}`, `turnOrigin`, `promptSource` ("typed"), `turnPosition`, `permissionMode`; tool results = user entries whose `message.content[]` hold `tool_result` blocks, plus `toolUseResult`, `sourceToolAssistantUUID`; assistant adds `requestId`, `effort`, `apiBlockIndex`, `wireToolInputs`. `tool_use` blocks live in assistant `message.content[]`.
- `attachment` entries: `{type:"attachment", attachment:{type:<subtype>,...}, uuid,parentUuid,timestamp,..., rendered, renderedRole}`; `rendered` = JSON string `[{"content":"<system-reminder>\n...</system-reminder>"}]`, `renderedRole` = `user`|`system`. Subtypes seen: file, environment, model, instructions, session_context, date, deferred_tools_*, skill_listing, agent_listing_delta, mcp_instructions_delta, auto_mode, credential_org, remote_session_change, prompt_snapshot, total_tokens_reminder, queued_command (`commandMode, delivery_id, origin, prompt, source_uuid, humanTurn`), nested_memory, edited_text_file, command_permissions, silent_turn_reminder, batching_reminder_sent, compact_file_reference, task_status, ...
- They are written right after the triggering `user` entry (observed order: user -> attachment* -> assistant).
- Hook-related attachment types (BIN; no hook fired locally so none present in my transcripts): `hook_additional_context` ({content:string[], hookName, toolUseID, hookEvent}), `hook_success` ({content, hookName, hookEvent,...}), `hook_system_message`, `hook_blocking_error`, `hook_non_blocking_error`, `hook_stopped_continuation`, `hook_cancelled`, `hook_error_during_execution`, `hook_permission_decision`, `hook_deferred_tool`, `async_hook_response`, `hook_progress`. Stop-hook summaries are stored too (2.1.277 fix mentions "a stop hook summary without a well-formed hook list" crashing resume).
- Parsing hook output from the transcript is therefore fragile; prefer the hook inputs (`last_assistant_message`, `prompt`) the docs guarantee.

---------------------------------------------------------------------------------------------------
## 9. Models: subagent `model:`, env vars, overrides (+SURE)
- sub-agents.md frontmatter table: "`model` | No | Model to use: `sonnet`, `opus`, `haiku`, `fable`, a full model ID such as `claude-opus-5-5`, or `inherit`." Text: "Full model ID: use a full model ID such as `claude-opus-5-5` or `claude-sonnet-5`. Accepts the same values as the `--model` flag." (https://code.claude.com/docs/en/sub-agents.md#choose-a-model)
- Resolution order (v2.1.251+): per-invocation `model` param > frontmatter `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > main model. Before 2.1.251 the env var overrode everything. `CLAUDE_CODE_SUBAGENT_MODEL` "Accepts an alias such as haiku or a full model name"; `inherit` = unset. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (2.1.257+) forces it on every subagent/teammate/workflow agent, ignoring definitions (and Claude can't pass a model).
- Allowlist (`availableModels`) is checked for all three sources; blocked values substituted.
- `ANTHROPIC_CUSTOM_MODEL_OPTION` (+ `_NAME`, `_DESCRIPTION`, `_SUPPORTED_CAPABILITIES`): adds ONE `/model` picker entry; "Claude Code skips validation for the model ID set in ANTHROPIC_CUSTOM_MODEL_OPTION, so you can use any string your API endpoint accepts." Only meaningful with a custom endpoint -> RC incompatible.
- `modelOverrides` (settings, any file): maps Anthropic model IDs -> provider-specific strings (Bedrock ARNs etc.); "Overrides also apply when you pass an Anthropic model ID directly through `--model`, the `ANTHROPIC_MODEL` environment variable, or an `ANTHROPIC_DEFAULT_*_MODEL` environment variable" (since 2.1.200). Keys that aren't Anthropic model IDs are ignored (2.1.223). Not a way to alias to non-Claude models under api.anthropic.com.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: "Override the context window size Claude Code assumes for the active model ... Use this when routing to a model through `ANTHROPIC_BASE_URL` whose context window does not match". Semantics (model-config.md#correct-the-window-for-a-gateway-or-custom-model-id): applies directly to unrecognized provider/custom IDs; for recognized models only takes effect with `DISABLE_COMPACT`. Also `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` (2.1.223+). 2.1.285: custom `ANTHROPIC_BASE_URL` sessions now assume 1M for models that have it.
- 2.1.251: default commit trailer becomes `Co-Authored-By: Claude Code` when model isn't a recognized Claude model; 2.1.284: Explore subagent inherits unrecognized custom model instead of switching to Opus; 2.1.285 added `allowedProviders` managed setting.
- Subagents can't use a different `ANTHROPIC_BASE_URL`; no per-agent endpoint/env frontmatter exists (frontmatter list: description, tools, disallowedTools, model, permissionMode, mcpServers, hooks, maxTurns, skills, initialPrompt, memory, effort, background, omitClaudeMd, isolation, color, experimental{cacheTtl}).

---------------------------------------------------------------------------------------------------
## 10. Prompt-cache TTL (+SURE; https://code.claude.com/docs/en/prompt-caching.md#cache-lifetime)
- Env: `CLAUDE_CODE_PROMPT_CACHE_TTL` = `5m`|`1h` (only values accepted), main conversation bucket ("interactive, `-p`, and SDK turns, plus the helpers that run inline"), v2.1.242+. Setting `promptCacheTtl`. Subagent/other bucket: `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` / `subagentPromptCacheTtl`; per-agent frontmatter `experimental.cacheTtl` (2.1.248+, ignored on `1h` while on usage credits). Precedence: `FORCE_PROMPT_CACHING_5M=1` > bucket env > bucket setting > agent frontmatter `cacheTtl` > `ENABLE_PROMPT_CACHING_1H=1` > bucket default.
- Default table (quote): "Unless you choose a TTL yourself, Claude Code requests the one-hour TTL only on a Claude subscription within your plan's included usage."
  | Request bucket | Subscription within plan usage | Usage credits / API key / cloud |
  | Main conversation | One hour | Five minutes |
  | Everything else (subagents, workflows, teammates, forks, compaction, titles) | Five minutes, except server-controlled helper requests which get one hour | Five minutes |
  => 1h is the subscription default for the MAIN conversation ONLY; subagents get 5m ("so they get five minutes even on a subscription until you choose a longer one"). Over plan limit -> main drops to 5m unless you set it.
- Confirm: `claude -p "hello" --output-format json` -> `usage.cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`; `/usage` "Prompt cache (main)" line (v2.1.251+, likely-miss cause from 2.1.260); status line `prompt_cache` object.
- Subagents start their own cache (separate prefix); forks (`subagent_type:"fork"`) inherit parent prefix; "Cache scope": effectively per machine+directory.
- What does NOT bust the cache: appending anything (hook context, skills, plan mode, permission-mode change, output-style change since 2.1.251, CLAUDE.md edits don't apply). What does: model switch (per-model cache), effort change on most models, MCP server connect/remove, plugin enable/disable, denying a tool, compaction, MCP/tool-definition changes.

---------------------------------------------------------------------------------------------------
## 11. Network config vs native binary (https://code.claude.com/docs/en/network-config.md)
- `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (+ lowercase, order https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY): "Claude Code respects standard proxy environment variables." No SOCKS. Not runtime-conditional in the doc -> +SURE applies to native (2.1.222 fix: startup check "now uses the same proxy-aware transport"; 2.1.243: honors both `NO_PROXY`/`no_proxy`).
- CA: "By default, Claude Code trusts both its bundled Mozilla CA certificates and your operating system's certificate store. Reading the OS store requires a runtime with `tls.getCACertificates`: the native installer always has it, and npm installs need Node 22.15 or later." `CLAUDE_CODE_CERT_STORE` = comma list of `bundled`,`system`; default `bundled,system`; no settings.json key (use `env` block). `NODE_EXTRA_CA_CERTS` = "configure Claude Code to trust it directly" (works regardless; for old Node only bundled + this apply). 2.1.273: error messages now say "`NODE_EXTRA_CA_CERTS` for an untrusted corporate CA".
- Native-specific evidence: 2.1.261 "Fixed Remote Control's inbound event stream failing behind TLS-inspecting corporate proxies on native Windows".
- Env is read at startup ("a running session doesn't pick up later changes"); put in `~/.claude/settings.json` `env` for background sessions. `ANTHROPIC_UNIX_SOCKET` counts as a custom gateway (RC off).
- -GUESS: since RC only checks `ANTHROPIC_BASE_URL` host, a TLS-intercepting forward proxy via `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` is the only way to observe/alter model-A API traffic and keep RC.

---------------------------------------------------------------------------------------------------
## 12. Channels
Docs: https://code.claude.com/docs/en/channels.md , channels-reference.md (research preview; flags `--channels`, `--dangerously-load-development-channels` not in `--help`).
- Docs quote (channels-reference#notification-format): "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group. To process independent event streams concurrently, run separate sessions." And: "Claude Code doesn't acknowledge notifications ... If the session hasn't loaded your server as a channel, or the organization policy blocks it, Claude Code drops the events silently". Payload `{content, meta}` -> `<channel source="..." k="v">content</channel>`.
- "Every event triggers a turn": NOT stated verbatim anywhere in docs. BIN ~SUSPECT-high: handler does `queue.enqueue({mode:"prompt", value:<channel tag>, priority:"next", isMeta:true, origin:{kind:"channel",server}, skipSlashCommands:true, skipAttachments:true})` i.e. identical path to a queued prompt: idle session -> new turn; busy session -> delivered after current tool calls / batched. No option to defer.
- Newer option to queue until next user input: NONE found (docs + changelog scan through 2.1.286; the only channel lines in the changelog: 2.1.128 `--channels` with API keys, 2.1.126 plan-mode fix, 2.1.105 dropped-notification fix, 2.1.187 reconnect fix, 2.1.211/2.1.234 permission-relay hardening, 2.1.281 `--channels` plugin name check, 2.1.284 VSCode channel-message reload fix, 2.1.267 `allowedChannelPlugins`). Priority `next` is hard-coded in BIN. +SURE no documented option.
- Auth: needs claude.ai login or Console API key; not Bedrock/Vertex/Foundry. Pro/Max skip org checks; Team/Enterprise need `channelsEnabled`.

---------------------------------------------------------------------------------------------------
## 13. Changelog scan v2.1.200 -> v2.1.286 (curated; source https://code.claude.com/docs/en/changelog.md == github CHANGELOG.md)
Hooks / context / cache:
- 2.1.286: "Fixed API 400 errors after a tool or hook returned an object, number or boolean instead of text, including in resumed sessions"; `/hooks` redesigned.
- 2.1.285: "Fixed synchronous hooks hanging Claude Code while a background process the hook started (for example `some-daemon &`) kept its output open; the hook now finishes shortly after its own process exits"; "Fixed a cancelled shell command or hook still starting..."; "\[VSCode] Fixed a hook's reason for blocking or stopping a prompt disappearing after a window reload"
- 2.1.284: "Fixed `{"decision":"block"}` returned by Elicitation and ElicitationResult hooks being ignored"; failed hooks now log status code + stderr.
- 2.1.281: `mcp_tool` hooks on blocking events wait for MCP server (up to connect timeout).
- 2.1.280: "Improved the UserPromptSubmit hook timeout notice and the debug log to name which hook command timed out"; "Changed PermissionRequest hooks: an agent-type hook no longer runs there"; OTel `hook_execution_complete` gets output sizes + oversize count.
- 2.1.277: "Fixed attachments recorded earlier in a conversation being re-rendered after a resume or relaunch, which dropped extended thinking and missed the prompt cache"; "Fixed sessions continued after `/clear` ... missing part of their first message when a SessionStart hook printed output, causing a full prompt-cache miss".
- 2.1.274: "Fixed Stop prompt hooks re-sending their whole prompt on every block in a conversation"; "Fixed hook-driven sessions (such as an active `/goal`) ending with "Prompt is too long" instead of compacting".
- 2.1.273: "hook progress and sub-agent activity no longer re-process the whole conversation on every update".
- 2.1.271: spinner shows running SessionStart/UserPromptSubmit/PreToolUse/SessionEnd hook with elapsed time; "Esc cancels a prompt waiting on a SessionStart hook".
- 2.1.268: "Fixed PermissionRequest hooks not firing in `--print` mode"; `--continue/--resume` no longer waits for SessionStart hooks.
- 2.1.267 / 2.1.261: resume no longer drops hook output (see section 2).
- 2.1.259: blocking Stop hooks losing reasoning / cache miss fixed.
- 2.1.257: async hook completion notices batched on one line in verbose output.
- 2.1.251: "Added `PreModelSwitch` and `PostModelSwitch` hook events"; SessionStart resume staleness fields.
- 2.1.248: "Fixed hooks silently treating a stdout `{...}` object that isn't valid JSON as plain text; it's now reported as a hook error with the parse message".
- 2.1.243: `if` conditions with `$()`/backticks fixed. 2.1.239: hooks run from project root/home if cwd deleted.
- 2.1.227: hook `systemMessage` may arrive as SDK `system/informational` "`<Hook>: says`" lines (per SDK docs; no changelog line found).
- 2.1.219: `DirectoryAdded` hook. 2.1.214: exit-2 + invalid JSON now still blocks; SessionStart `source:"fork"`; `dir/**` `if:` semantics changed. 2.1.212/210: continue:false halt + callback-timeout misreport fixes. 2.1.208: async hook output memory leak. 2.1.204: SessionStart hook events stream in headless. 2.1.199: SessionStart/Setup/SubagentStart exit-2 stderr now shown.
- 2.1.152 (older, relevant): MessageDisplay added; SessionStart `reloadSkills`/`sessionTitle`. 2.1.143: Stop-hook 8-block cap. 2.1.94: UserPromptSubmit `sessionTitle`. 2.1.89: >10,000-char hook output -> file + 2,000-char preview. 2.1.47: `last_assistant_message`. 2.1.3: tool hook default timeout 60 s -> 10 min.

Remote Control (all since 2.1.200):
- 2.1.286: policy-off disconnect; RC message queued across exit; attachment failures reported to Claude.
- 2.1.285: RC read-state/queue persistence; `/btw` sees in-progress turn; "`/claude-api` can no longer be run from Remote Control clients".
- 2.1.284: "Changed `/recap` ... typed in the terminal, the Claude apps, Remote Control, `-p` or an SDK host, it runs as before".
- 2.1.283: RC allowed with `DISABLE_TELEMETRY`/`DO_NOT_TRACK`.
- 2.1.273: forking a `--remote-control` session from the app creates a background session on your computer.
- 2.1.271: ANTHROPIC_UNIX_SOCKET proxies = custom gateways for RC. 2.1.265: `/clear` from RC no longer waits on SessionStart hooks. 2.1.261: TLS-inspecting-proxy fix on native Windows; offline RC `SendMessage` reads as queued. 2.1.259: Stop kills background agents in RC sessions. 2.1.257: RC connect no longer re-sends Bash tool def (cache miss fix). 2.1.238: mid-turn web/Desktop messages no longer disappear from transcript; 403 tolerance 3 min; per-session model pick. 2.1.232: reconnect ~30 min. 2.1.222: repo-local settings can't turn on RC auto-start. 2.1.202: RC commands "Unknown command" fix. 2.1.199: `CLAUDE_CODE_BRIDGE_SESSION_ID` (per hooks.md).
- MessageDisplay/systemMessage + RC: no changelog line.

Custom/non-Claude models, base URL, TTL:
- 2.1.285: "Changed sessions behind a custom `ANTHROPIC_BASE_URL` to use the 1M context window of models that have one (Opus 4.7+, Sonnet 5+, Fable); run `/autocompact 200k` if your gateway stops at 200K"; `allowedProviders`.
- 2.1.284: "Fixed the Explore subagent switching to Opus on the Claude API when the session runs a model ID Claude Code doesn't recognize, such as a custom model behind a proxy; Explore now inherits that model".
- 2.1.283: `x-claude-code-prompt-id` gateway hint header (opt-in `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`); 2.1.273: more `x-claude-code-*` headers.
- 2.1.282: "Fixed every request failing with a 400 error in conversations whose history holds web search results the API cannot decrypt (for example, from a turn answered through a third-party gateway)". 2.1.268: "Fixed every turn failing with HTTP 400 on third-party Anthropic-compatible endpoints (`ANTHROPIC_BASE_URL`) since 2.1.265". 2.1.246: "Fixed telemetry and metrics requests to Anthropic carrying the API key configured for a third-party gateway".
- 2.1.257: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; 2.1.251: `CLAUDE_CODE_SUBAGENT_MODEL` now only a default; default commit trailer for unrecognized models; 2.1.236: `ANTHROPIC_DEFAULT_MODEL`; 2.1.233: `[claude-code:unrecognized_model]` stderr line in print mode (map via `modelOverrides`); 2.1.223: `modelOverrides` non-Anthropic keys ignored; 2.1.259: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` honored for Vertex-style IDs.
- 2.1.237: "Fixed prompt caching for sessions using an LLM gateway or custom base URL"; 2.1.212: mid-conversation system block works behind gateways.
- TTL: 2.1.243 "Added `promptCacheTtl` and `subagentPromptCacheTtl` settings so API-key and cloud-provider users can keep a 1-hour prompt cache on the main conversation while subagents stay at 5 minutes"; 2.1.248 `experimental.cacheTtl`; 2.1.251/2.1.260 cache stats; 2.1.286 gateway spend meter priced 1h writes wrong (gateway only).
- 2.1.286: "Fixed every turn failing when the Anthropic API refuses the model your default or a model alias resolves to: Claude Code now retries once on the previous model of the same tier" (a refusal-fallback; relevant if A's model gets refused).

---------------------------------------------------------------------------------------------------
## 14. Decision-relevant takeaways for the harness
1. Peer-answer injection via sync `UserPromptSubmit` JSON `hookSpecificOutput.additionalContext`: documented, same-turn, <=10,000 chars per string (oversize -> file + 2,000-char preview, model not told to open it), default timeout 30 s (set `timeout`), timeout = silently dropped context. Persisted in transcript and replayed on resume; append-only, so cache-safe but cumulative. Frame as facts, not commands. Use JSON, never raw stdout. Use one hook, not several (parallel, unordered, merged under one label).
2. Report-out via `Stop`: use `last_assistant_message` (not the transcript); do not block. `systemMessage` is the only user-visible channel and is display-only; async variants are NOT shown to the user and arrive a turn late. Whether claude.ai/mobile render it is undocumented; BIN suggests `hook_system_message` is on the RC-forward allow-list (~SUSPECT).
3. RC constrains Model A: subscription OAuth login only, `api.anthropic.com` only (no `ANTHROPIC_BASE_URL`/gateway/API key/`apiKeyHelper`). Therefore no non-Claude subagent models in-process; peer model must be out of process. `HTTPS_PROXY`+`NODE_EXTRA_CA_CERTS` is not blocked by the RC check.
4. Cache: main conversation gets 1h on subscription within plan usage; subagents 5m unless `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`. Avoid Stop `decision:"block"`, model/effort switches, and MCP/plugin churn mid-session.
5. Unverified, must be tested by the human (cheap logging hook that appends event+timestamp+`prompt_id`/`CLAUDE_CODE_BRIDGE_SESSION_ID` to a file):
   a. `UserPromptSubmit` fires for an idle-session prompt sent from phone / claude.ai/code (~SUSPECT yes).
   b. `UserPromptSubmit` fires for a message sent from the phone MID-TURN (queued_command path) (--WONDER; if not, peer context is missed for those messages).
   c. A Stop hook's `systemMessage` appears on claude.ai/code and in the phone app, and in what format.
   d. `MessageDisplay` effect (if any) on RC clients.
   e. Channel/`asyncRewake` events and whether they trigger UserPromptSubmit.
   f. Two UserPromptSubmit hooks: order and merged label.
   g. Hook `additionalContext` on turn N is present, byte-identical, in turn N+1's cached prefix (check `/usage` "Prompt cache (main)" / statusline `prompt_cache`, or `usage.cache_read_input_tokens` growth).
6. Everything BIN-derived is from minified code of 2.1.286 and may change between releases; docs-derived items are stable contract.
