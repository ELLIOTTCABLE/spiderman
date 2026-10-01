# pi 0.99.1 extension/harness fact sheet (for the "peer model B" orchestrator extension)

Markers: +SURE = verified in source/docs (citation given); ~SUSPECT = well-supported, not directly verified; -GUESS; --WONDER = open.

## 0. Provenance, and what "installed source" means here

- +SURE The installed package (`C:\Users\ec\AppData\Local\mise\installs\pi\0.99.1`) ships only `pi.exe` (111 MB Bun-compiled binary), `docs/`, `examples/`, `CHANGELOG.md`, `package.json`, `theme/`, `native/`. No `dist/`, no `.d.ts`. `package.json` `files` lists `dist`, but the mise/binary install does not carry it.
- +SURE `docs/*`, `examples/*`, `CHANGELOG.md`, `package.json` of the install are byte-identical to GitHub tag `v0.99.1` (`diff -rq` empty). I shallow-cloned that tag to `<scratchpad>/pi-src` (`https://github.com/earendil-works/pi`, `packages/coding-agent`). All `file:line` citations below are against that tree. Shorthand: `types.ts` = `packages/coding-agent/src/core/extensions/types.ts`; `agent-session.ts` = `packages/coding-agent/src/core/agent-session.ts`; `agent-loop.ts` = `packages/agent/src/agent-loop.ts`.
- ~SUSPECT tag source == binary's compiled JS: the binary contains the exact source constants/strings I spot-checked (`"Agent is already processing. Specify streamingBehavior"`, `IDLE_CONTINUATION_PROBABILITY = 0.15`, `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05`, `SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000`, `_deferredSettledActions`, `"30-minute idle safety limit reached"`, `"cache lifetime unavailable"`, `responses_websockets=2026-02-06`) via `grep -a -F pi.exe`. Not byte-verified beyond that.
- +SURE Divergence vs GitHub `main` (2026-10-01): `types.ts` differs by 7 lines (`ToolNamespace.instructions` added), `agent-session.ts` by 28 lines (MCP `defaultTools`-on-reload plumbing). `cache-warmer.ts` and `openai-codex-responses.ts` are identical to main. v0.99.2 / `[Unreleased]` changelog entries are MCP/codemode only. No divergence relevant to the APIs below.
- +SURE Type-authoring skew: `C:\Users\ec\.pi\node_modules\@earendil-works\pi-coding-agent` is **0.84.3** (has `.d.ts`). It lacks `agent_before_settle`, and its `on()` returns `void` (0.99.1 returns an unsubscribe fn; `types.ts:1540-1607`). Don't author against those typings if you use 0.99.1-only surface.
- +SURE The compiled binary embeds Bun v1.3.14 (`grep -a 'Bun v' pi.exe`). Extensions run in-process under Bun, loaded by jiti with `virtualModules` (`loader.ts:551-561`, `virtual-modules.ts:14-37`): `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`, `typebox` resolve to bundled copies; `node:*` builtins are Bun's.
- **Security note for the human**: while probing for secret-ish words (counts/names only, never values) in `~/.pi/agent/` I got hits: `settings.json:13` matches `sk-` and `models.json:5` contains the key name `apiKey`. I did NOT read values (a masked-print attempt was denied by the permission classifier; I did not retry). `sk-` may be a harmless substring (e.g. `task-...`) and the `apiKey` value may be a `$ENV`/`!command` reference, but please check those two lines yourself. I never touched `auth.json`.

---

## 1. Extension API: signatures and semantics

Factory: `export default function (pi: ExtensionAPI) {...}` (may be async). +SURE `types.ts:1985` (`ExtensionFactory = (pi) => void | Promise<void>`).

### 1.1 Verbatim signatures (+SURE, `types.ts`)
```ts
// 1671-1674
sendMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): void;
// 1681-1684  ("Always triggers a turn.")
sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
): void;
// 1687
appendEntry<T = unknown>(customType: string, data?: T): void;        // "(not sent to LLM)"
// 1658, 1664
registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void; // "Custom entries do not participate in LLM context."
// 1496-1506
type MessageRenderer<T> = (message: CustomMessage<T>, options: { expanded: boolean; outputPad: number }, theme: Theme) => Component | undefined;
type EntryRenderer<T>   = (entry: CustomEntry<T>,     options: { expanded: boolean },                      theme: Theme) => Component | undefined;
// CustomMessage (messages.ts:42-50): { role:"custom"; customType; content: string|(Text|Image)[]; display: boolean; details?: T; timestamp }
// CustomEntry (session-manager.ts:128-132): { type:"custom"; customType; data?: T } + {id,parentId,timestamp}
```
All of `sendMessage`/`sendUserMessage`/`appendEntry` return `void` (fire-and-forget). Errors are not thrown to the caller; they are routed to `runner.emitError` with `event: "send_message"` / `"send_user_message"` (`agent-session.ts:3303-3320`). +SURE
Pre-bind (during factory) these throw `"Extension runtime not initialized. Action methods cannot be called during extension loading."` (`loader.ts:157-158,169-171`). +SURE After `/new`, `/resume`, fork, `/reload` the old `pi` and ctx are *stale* and throw (`loader.ts:160-199`). +SURE

### 1.2 `pi.sendUserMessage` semantics (+SURE `agent-session.ts:2280-2310`, `prompt()` 1883-2026)
- It is a thin wrapper over `session.prompt(text, {expandPromptTemplates: opts.expandPromptTemplates ?? false, streamingBehavior: opts.deliverAs, images, source: "extension"})`. Image blocks are split out of the content array; text parts are joined with `\n`.
- **Idle**: runs the *full* prompt path: input handlers (`input` event with `source:"extension"`), `before_agent_start`, pre-prompt compaction check, model/auth validation, user message appended, run started. Extension commands (`/foo`) and `/skill:`/prompt templates are only expanded if `expandPromptTemplates: true` (default false).
- **Streaming, no `deliverAs`**: throws inside the promise (`"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."`, `agent-session.ts:1928-1933`) -> swallowed into an extension error event; the message is NOT queued.
- **Streaming + `deliverAs`**: `"steer"` -> delivered after current assistant turn's tool calls, before next LLM call; `"followUp"` -> delivered only when the agent would otherwise stop (`agent-session.ts:2117-2178`).
- **Compacting** (`isCompacting`): `prompt()` throws `"Cannot submit a prompt while compaction is in progress..."` (`1901-1905`) for both idle and streaming states.
- **Called from inside an `agent_settled` handler**: deferred until after that event finishes (`_isEmittingAgentSettled` -> `_deferredSettledActions`, `1884-1887`, `1037-1058`), so it is safe and starts a fresh run afterwards. +SURE
- **Called from inside an `agent_end` handler**: `isStreaming` is still true there (`_isAgentRunActive` only clears at `1039`), so it needs `deliverAs:"followUp"`; that continues the same session-level run (`_handlePostAgentRun` returns `agent.hasQueuedMessages()`, `1803-1805`). +SURE
- Errors in a deferred settled action propagate out of `_emitAgentSettled` and reject the *earlier* caller of `prompt()` (`1048-1055`). ~SUSPECT low impact; noting because it is surprising.
- **RACE (+SURE by reading)**: after `pi.sendUserMessage(x)` returns, `ctx.isIdle()` can still be `true` for a few awaits, because `_isAgentRunActive = true` is set inside `_runAgentPrompt` (`1745`), after `await emitBeforeAgentStart(...)` (`1977`) (and possibly `checkAuth`). Therefore: keep your own `busy` flag set synchronously at injection and cleared on `agent_settled`; do not use `ctx.isIdle()` / `waitForIdle()` immediately after `sendUserMessage` (`waitForIdle` returns immediately if `isIdle`, `2361-2366`).
- `isIdle` = `!_isAgentRunActive && !isCompacting` (`1422-1424`); `_isAgentRunActive` stays true across auto-retry sleeps, compaction-recovery and queued continuations within the run (`_runAgentPrompt` loop, `1740-1766`). +SURE

### 1.3 `pi.sendMessage` semantics (+SURE `agent-session.ts:2208-2244`)
Branch order (first match wins):
1. `deliverAs:"nextTurn"` -> pushed to `_pendingNextTurnMessages`; attached to the *next* `prompt()` after the user message (`2003-2007`); never triggers a turn.
2. `isStreaming && triggerTurn !== false` -> `deliverAs:"followUp"` ? `agent.followUp(msg)` : `agent.steer(msg)` (default steer).
3. `triggerTurn` truthy (idle) -> `_runAgentPrompt(msg)` directly (deferred if inside `agent_settled`). **This bypasses `prompt()`**: no `input` event, no `before_agent_start`, no compaction check, no auth precheck.
4. streaming && `triggerTurn:false` -> held in `_pendingCustomMessages`, appended at the next `turn_end` (`1150-1153`, `2235-2240`).
5. idle, no trigger -> appended to session + `message_start`/`message_end` emitted, no turn (`2246-2256`).
- **Custom messages DO enter LLM context**: `convertToLlm` maps `role:"custom"` -> `{role:"user", content}` (`messages.ts:162-168`); the session projection includes `custom_message` entries (`session-manager.ts:453-457`). `display` only controls TUI visibility (`session-manager.ts:147-165`). Docs agree: "Custom content stored and sent to the model" (`docs/extensions.md:226`). +SURE
- A `before_agent_start` handler may return `{message: {customType, content, display, details}}`; it is appended after the user message (and after nextTurn messages) in the same run (`agent-session.ts:2009-2019`, `types.ts:1439-1443`). Also enters context.

### 1.4 `pi.appendEntry` / entry renderer (+SURE)
- `appendEntry` -> `sessionManager.appendCustomEntry(customType, data)` (child of current leaf, advances leaf; `session-manager.ts:1290-1301`) then emits session event `entry_appended` (`agent-session.ts:3321-3327`).
- **Excluded from LLM context**: `sessionEntryToContextMessages` returns `[]` for any type other than message/custom_message/branch_summary/compaction (`session-manager.ts:439-466`; comment 435-438 "Plain custom entries are display/state entries"; `CustomEntry` doc 118-127).
- Persisted to the JSONL (lazily: the file isn't created until the first user/assistant message exists, `session-manager.ts:1172-1187`).
- TUI rendering: `entry_appended` with `type==="custom"` -> `addCustomEntryToChat` (`interactive-mode.ts:3340-3345,3739-3761`) -> `getEntryRenderer(customType)` (`runner.ts:788-796`; first extension to register wins) -> `new CustomEntryComponent(entry, renderer)`; it calls `renderer(entry, {expanded}, theme)` inside try/catch (`components/custom-entry.ts:41-65`): exception -> red "renderer failed" box; `undefined` -> nothing shown; **no renderer registered -> nothing shown at all**. Re-rendered on `invalidate()` (theme change) and `setExpanded`. Also re-rendered when the session is rebuilt/resumed (`interactive-mode.ts:3889,3974`). Inserted before the live streaming component if one is active.
- `registerMessageRenderer`: used only for `role:"custom"` messages with `display:true` (`interactive-mode.ts:3777-3791`); returning `undefined`/throwing falls back to a default box labelled `[customType]` with the content as Markdown (`custom-message.ts:68-117`). Remember those messages are in LLM context.
- **Outside the TUI (RPC/JSON/print) renderers are stored but never invoked.** `appendEntry` still persists; RPC/JSON emit `{"type":"entry_appended","entry":...}` (`docs/json.md:122`); custom messages with display emit `message_start/end` role `custom`. +SURE (renderers only referenced from `interactive-mode.ts`).
- Example: `examples/extensions/entry-renderer.ts` (identical to what's above). Other no-context TUI surfaces: `ctx.ui.setWidget(key, string[] | factory, {placement:"aboveEditor"|"belowEditor"})`, `ctx.ui.setStatus(key, text)`, `ctx.ui.notify(msg, level)`, `ctx.ui.custom(factory, {overlay:true,...})` (`types.ts:149-300`). All ephemeral (not persisted).

---

## 2. Events (+SURE `types.ts:1348-1380` union; `on()` overloads 1540-1607)

Handler type: `(event, ctx: ExtensionContext) => Promise<R|void> | R | void`. Handlers run in load/registration order, **awaited sequentially**; a slow handler delays the pipeline (`docs/extensions.md:97,111`; `runner.ts:1080-1109`). Handler exceptions are caught and reported (`emitError`) and don't stop other handlers; a `tool_call` handler failure blocks the tool (`docs/extensions.md:256`).

Full list: `project_trust, resources_discover, mcp_servers_change, session_start, session_info_changed, session_before_switch, session_before_fork, session_before_compact, session_compact, session_compact_failed, session_shutdown, session_before_tree, session_tree, context, context_with_system, cache_warming_decision, before_provider_request, before_provider_headers, after_provider_response, provider_stream_event, before_agent_start, agent_start, agent_end, agent_before_settle, agent_settled, ui_prompt_start, ui_prompt_end, turn_start, turn_end, message_start, message_update, message_end, tool_execution_start|update|end, model_select, thinking_level_select, user_bash, input, tool_call, tool_result`.

Key payloads:
```ts
session_start      { reason: "startup"|"reload"|"new"|"resume"|"fork"; previousSessionFile?: string }        // 716-722
session_shutdown   { reason: "quit"|"reload"|"new"|"resume"|"fork"; targetSessionFile?: string }              // 785-790
before_agent_start { prompt: string; images?; readonly systemPrompt: string; systemPromptOptions }            // 894-904 -> result {message?, systemPrompt?}
agent_start        { }                                                                                          // 907
agent_end          { messages: AgentMessage[] }                                                               // 912-915  (NO willRetry for extensions)
agent_before_settle{ entries, continue, context, outcome: "completed"|"aborted"|"error" }  (BoundaryState)    // 962-977 -> result {entries?: drafts, continue?: boolean}
agent_settled      { }                                                                                         // 980-982 notification-only
turn_start         { turnIndex; timestamp }                                                                    // 1003-1007
turn_end           { turnIndex; message: AgentMessage; toolResults: ToolResultMessage[]; messageEntryId: string; toolResultEntryIds: string[] } & BoundaryState  // 1010-1017 -> result BoundaryResult
message_start|end  { message: AgentMessage }   message_end result {message?} (replace; role must be preserved)  // 1020-1036,1434-1437
message_update     { message; assistantMessageEvent }                                                          // 1026-1030
tool_execution_*   { toolCallId; toolName; args | partialResult | result+isError; parentToolCallId? }          // 1039-1068
tool_call          { toolCallId; toolName; input (MUTABLE, no revalidation); parentToolCallId? } -> {block?, reason?, terminate?}   // 1136-1208, 1397-1406
tool_result        { toolCallId; toolName; input; content; structuredContent?; isError; usage?; details } -> {content?,details?,structuredContent?,isError?,usage?}  // 1210-1283, 1426-1432
input              { text; images?; source: "interactive"|"rpc"|"extension"; streamingBehavior?: "steer"|"followUp" } -> {action:"continue"} | {action:"transform", text, images?} | {action:"handled"}  // 1111-1130
before_provider_headers { headers: Record<string,string|null> }  mutate in place; return ignored; null deletes   // 872-875
before_provider_request { payload: unknown } -> return non-undefined to replace payload                          // 862-865, runner.ts:1352-1381
user_bash          { command; excludeFromContext (true for "!!"); cwd } -> {operations} | {result}               // 1096-1104
```
Findings:
- +SURE **`agent_end` carries the run's messages**: `messages` = `newMessages` of one low-level `agent.prompt()`/`agent.continue()` invocation: the prompt message(s) + every assistant message + tool results produced, including queued steer/followUp messages consumed (`agent-loop.ts:102-126,143-151,243-255,289-291,320`). A retry / overflow-recovery / compaction-continue is a *separate* `agent.continue()` -> its own `agent_start`/`agent_end` whose `messages` hold only the new messages (continue starts with `newMessages = []`, `agent-loop.ts:143`). So one injected prompt can yield several `agent_end`s.
- +SURE **"Turn fully finished" signal = `agent_settled`** (fires exactly once per session-level `_runAgentPrompt`, after retries/compaction/queued work, `agent-session.ts:1037-1058,1764`). `docs/extensions.md:62-67`, `docs/json.md:48`. It does not fire if `prompt()` was "handled" by an input handler or an extension command (no run). `agent_end` alone is NOT final (docs/rpc.md:69).
- +SURE `agent_before_settle` (only dispatched if some extension has a handler, `agent-session.ts:1808-1809`) can append entries and return `continue:true` for one more model request (`1808-1830`); continuation requires a runnable context ending in a non-assistant message (`_buildBoundaryContext`, `958-981`), e.g. return `{entries:[{type:"custom_message",customType,content,display:true}], continue:true}`. This is an in-run way to inject the "Bx" follow-up without a new idle `prompt()`; the injected content is a `custom_message` (-> user-role content in context, no `input`/`before_agent_start` events). ~SUSPECT usable for Bx (not executed).
- +SURE `turn_end` = one assistant response + its tool results (docs/json.md:60). Its handler may also return `{entries, continue}` (same boundary semantics). The final `turn_end` of a normal run has `message.stopReason==="stop"` and `toolResults:[]`.
- +SURE Order for each message: extension `message_end` handlers run first, then public listeners, then **persistence** (`agent-session.ts:1098-1122`). So inside a `message_end` handler the message is not yet in `getBranch()`; by `turn_end`/`agent_end`/`agent_settled` it is.
- +SURE `session_start` is emitted from `bindExtensions()` after the UI context is bound (`agent-session.ts:3173-3197`), in every mode (print/json: `print-mode.ts:76`; rpc: `rpc-mode.ts:319`). `session_shutdown` precedes teardown on quit/reload/new/resume/fork (`agent-session-runtime.ts:166-178,405`); session replacement first `await session.abort()` (`171`), i.e. an active run is aborted.
- +SURE **Intercepting human-typed input** = `input` event, `source==="interactive"`. Path: editor submit (editor clears its own text *before* calling `onSubmit`, `tui/src/components/editor.ts:1363-1376`) -> `interactive-mode.ts:3097-3294` -> `session.prompt(text)` (idle: main loop `1206-1208`; streaming: `prompt(text,{streamingBehavior:"steer"})` `3275-3278`; Alt+Enter: `"followUp"` `4365`) -> `_runInputHandlers` (`agent-session.ts:1908`). `{action:"handled"}` swallows it (no user message is rendered, nothing sent; you must echo it yourself); `{action:"transform", text}` rewrites; chain semantic: transforms chain, first `handled` short-circuits (`runner.ts:1511-1550`). **Bypasses**: built-in slash commands (`/model`, `/new`, `/tree`, ... `interactive-mode.ts:3102-3241`), *extension* slash commands (executed before `input`, `agent-session.ts:1892-1899`), and `!`/`!!` bash (`user_bash`, `3244-3258`). Filter on `event.source` (RPC prompts arrive as `"rpc"` `rpc-mode.ts:402`; your own `sendUserMessage` as `"extension"`) to avoid self-interception (see `examples/extensions/input-transform.ts`). Lower-level alternatives: `ctx.ui.onTerminalInput((data)=>({consume?,data?}))` (raw, TUI only), `ctx.ui.setEditorComponent(factory)` with a `CustomEditor` subclass (`types.ts:130-131,278`), `ctx.ui.getEditorText()/setEditorText()`.
- +SURE `before_provider_headers` caveat: it receives the *request-level extra headers* (auth headers + `options.headers` + attribution, `ai/src/models.ts:860-861`, `sdk.ts:331-340`), not the final wire headers. For `openai-codex-responses` the provider applies those first, then force-sets `Authorization`, `chatgpt-account-id`, `originator:pi`, `User-Agent`, and (after) `session-id` / `x-client-request-id` (`openai-codex-responses.ts:1640-1697`), so a hook cannot override those. To change `prompt_cache_key` use `before_provider_request` (body; `openai-codex-responses.ts:277-281` shows the `onPayload` result replaces the body). The docstring "after request headers are assembled" (`types.ts:867-871`) is misleading for this provider.
- ~SUSPECT `before_provider_request` mutating `prompt_cache_key` works for both SSE and WS paths since both use the same `body` variable (`openai-codex-responses.ts:277-291`), but the WS continuation logic compares request bodies minus `input` (`1425-1477`) so changing it mid-session forces a full-context request. Not tested.

### 2.1 `ExtensionContext` (+SURE `types.ts:325-365`)
`ui, mode ("tui"|"rpc"|"json"|"print"), hasUI, cwd, sessionManager (read-only), modelRegistry, model, scopedModels, thinkingLevel?, isIdle(), isProjectTrusted(), signal (undefined when not streaming), abort(), hasPendingMessages(), shutdown(), getContextUsage(), compact(opts), getSystemPrompt()`. Command handlers additionally get `ExtensionCommandContext` (`waitForIdle, newSession, fork, navigateTree, switchSession, reload, getSystemPromptOptions`, `types.ts:401-435`); these are command-only because calling them from lifecycle handlers "can deadlock" (`docs/extensions.md:210-211`).
- ~SUSPECT trick to obtain a command ctx from a socket callback: `pi.sendUserMessage("/mycmd payload", {expandPromptTemplates:true})` -> `prompt()` -> `_tryExecuteExtensionCommand` -> handler gets `createCommandContext()` (`agent-session.ts:1892-1899,2031-2054`, `runner.ts:981-1018`). Subject to the `isIdle` race above; I have not run it.
- `ctx.signal`: abort signal of the current run (undefined when idle). `pi.exec(cmd,args,opts)` available. `pi.events` is an inter-extension bus.
- Stale ctx: every ctx getter calls `assertActive()` (`runner.ts:868-946`); using a captured ctx/`pi` after session replacement/reload throws (`loader.ts:194-196`). The extension module is re-run per runtime (`moduleCache:false` for jiti, but a factory cache exists, `loader.ts:539-570`) -> -GUESS module-level state may or may not survive `/new`; don't rely on it.

---

## 3. `ctx.sessionManager` (`ReadonlySessionManager`, +SURE `session-manager.ts:245-262`)
Available: `getCwd, getSessionDir, getSessionId, getSessionFile, getLeafId, getLeafEntry, getEntry(id), getLabel, getBranch(fromId?), buildContextEntries, buildSessionProjection, getHeader, getEntries, getTree, getSessionName`. **Not** available on the readonly view: `buildSessionContext`, `appendX`.
- `getBranch(fromId?)`: root -> leaf path, ALL entry types (`1469-1479`). `buildSessionProjection()` -> `{entries: {sourceEntry, messages}[], messages: AgentMessage[], thinkingLevel, model}` (what the LLM sees after compaction/context edits, `543-573`). `getEntries()` includes abandoned branches (don't use for state, `docs/extensions.md:229`).
- Entry shapes (`57-197`): `{type:"message", id, parentId, timestamp, message: AgentMessage}`; also `thinking_level_change, model_change, usage{kind,provider,model,usage,note?} (kind "cache_warm" = warm-up request usage), compaction, branch_summary, custom, custom_message, context_edit, label, session_info`.
- Practical recipe: record `getLeafId()` at injection time; at `agent_settled` slice `getBranch()` after that id; filter `type==="message"`. Or accumulate `agent_end.messages`.
- Messages (`ai/src/types.ts`): 
```ts
AssistantMessage { role:"assistant"; content:(TextContent|ThinkingContent|ToolCall)[]; api; provider; model; responseModel?; responseId?;
  thinkingLevel?; usage: Usage; stopReason: "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"; errorMessage?; endTurn?; timestamp }   // 546-570
TextContent { type:"text"; text; textSignature? }      // 395
ThinkingContent { type:"thinking"; thinking; thinkingSignature?; redacted? }   // 401
ToolCall { type:"toolCall"; id; name; arguments: JsonObject; thoughtSignature?; namespace? }   // 417-425
ToolResultMessage { role:"toolResult"; toolCallId; toolName; content:(Text|Image)[]; details?; usage?; nestedCalls?; isError; timestamp }   // 594-608
UserMessage { role:"user"; content: string | (Text|Image)[]; timestamp }   // 540
Usage { input; output; cacheRead; cacheWrite; cacheWrite1h?; reasoning?; totalTokens; cost:{input,output,cacheRead,cacheWrite,total} }   // 427-448
```
- Tool calls of a turn = `assistantMessage.content.filter(b => b.type==="toolCall")` -> `{name, arguments}` (names+inputs); correlate results through `toolCallId`. Final assistant text = concatenated `type==="text"` blocks of the last assistant message with `stopReason==="stop"` (check `stopReason`/`errorMessage` for `error`/`aborted`). Alternatively `tool_call` events give `{toolName, input}` (pre-execution; includes calls later blocked; `input` mutable).
- +SURE **`usage.input` excludes cached tokens** for Responses-API providers incl. Codex: `input = max(0, input_tokens - cached_tokens - cache_write_tokens)`, `cacheRead = cached_tokens`, `cacheWrite = cache_write_tokens` (`ai/src/api/openai-responses-shared.ts:562-575`). Prompt size = `input+cacheRead+cacheWrite` (same formula pi uses, `cache-warmer.ts:~78-85`). Cache hit rate = `cacheRead / (input+cacheRead+cacheWrite)`.

---

## 4. Loading an extension from a path / isolation flags (+SURE `docs/cli.md:194-215,227-246`)
- `pi -e ./path/ext.ts` (`--extension`, repeatable; file or directory; also `builtin:<name>`, `npm:`/`git:` package sources, `docs/packages.md:~25`). TypeScript is loaded via jiti, no build step (`docs/extensions.md:32-38`).
- `-ne/--no-extensions`: disables discovered, configured and built-in extensions; **explicit `-e` still loads**. `-ns/--no-skills`, `-np/--no-prompt-templates`, `--no-themes`, `-nc/--no-context-files` (disables `AGENTS.md`/`CLAUDE.md` discovery). `-na/--no-approve` ignores project-local config/resources; `-a/--approve` trusts them. `--offline` (= `PI_OFFLINE=1`) disables catalog refresh and other automatic network. `--no-session`, `--session-dir <dir>`, `--session-id <id>`, `-n/--name`.
- Isolation recipe (read-only-ish test run): `pi -ne -ns -np -nc --no-themes --offline --no-session -e ./ext.ts --tools read,grep,find,ls --model openai-codex/gpt-6-luna:low`. ~SUSPECT `-ne` also skips extensions from `settings.json` `packages`.
- `PI_CODING_AGENT_DIR` overrides the config dir (default `~/.pi/agent`; `docs/environment-variables.md`) and would give a fully clean `settings.json` (e.g. to pin `cacheWarming`), but it would also hide OAuth creds in `auth.json`, so a real-model run needs the human to provision auth there. I did not do this. `--api-key <key>` is a non-persistent override but "requires a model selected through `--model`" and OAuth/subscription providers like `openai-codex` need OAuth creds, ~SUSPECT it doesn't apply.
- Extension discovery otherwise: `./.pi/extensions/*.ts|*/index.ts` and `~/.pi/agent/extensions` (`loader.ts:765-834`). The user's `~/.pi/agent/extensions/` contains `git-deny.ts` + `quotas.json` (names only), and `~/.pi/agent/agents/*.md`, `AGENTS.md`, `settings.json` exist, hence the `-ne -nc` flags.
- Extension may register CLI flags: `pi.registerFlag(name,{type:"boolean"|"string",default?,description?})`, `pi.getFlag(name)` (`types.ts:1635-1651`).

---

## 5. Headless modes (+SURE docs/cli-integration.md, rpc.md, rpc-commands.md, json.md, rpc-extension-ui.md; code `print-mode.ts`, `rpc-mode.ts`)

- **Print** `-p/--print` (also automatic when stdin or stdout is not a TTY): runs prompts, prints final assistant text, exits; non-zero exit if final stop reason is `error`/`aborted`. `bindExtensions({mode:"print"})` with **no uiContext** => `ctx.hasUI=false`, `ctx.ui.*` are no-ops (`select`->undefined, `confirm`->false, `notify` no-op; `runner.ts:323-354`). Extension errors -> stderr (`print-mode.ts:101-103`). `prompt()` awaits the whole `_runAgentPrompt` incl. `agent_settled` and deferred actions, so an `agent_settled`->`sendUserMessage` chain completes before exit. Process exits after the last prompt: no long-lived server lifetime.
- **JSON** `--mode json`: same, `mode:"json"`, no uiContext; stdout = JSONL: session header then events; process exits after the supplied prompts; accepts no later commands. `agent_end` is `{messages, willRetry}` on the wire (public listener form); `agent_settled` marks the end.
- **RPC** `--mode rpc` (long-lived, JSONL over stdin/stdout, LF-framed; do not use Node `readline`: U+2028/2029). `ctx.mode==="rpc"`, `ctx.hasUI===true` (dialogs forwarded). Extensions load in all four modes (`docs/extensions.md:244-249`).
  - Commands (all accept optional `id`; `rpc-types.ts:22-74`): `prompt{message,images?,streamingBehavior?}`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session{parentSession?}`, `get_state`, `get_messages`, `set_model{provider,modelId}`, `cycle_model`, `get_available_models`, `set_thinking_level{level}`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `compact{customInstructions?}`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash{command,excludeFromContext?}`, `abort_bash`, `get_session_stats`, `export_html{outputPath?}`, `switch_session`, `fork{entryId}`, `clone`, `get_fork_messages`, `get_entries{since?}` (durable cursor, includes pre-compaction and abandoned branches), `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
  - `prompt` response = accepted/queued/handled only: `data.disposition ∈ "started"|"queued"|"handled"`; "handled" means an extension command or `input` handler consumed it, and **no `agent_settled` will follow** (`docs/rpc.md:60-71`; `rpc-mode.ts:394-410`). Streaming w/o `streamingBehavior` -> error response. RPC input arrives with `source:"rpc"`.
  - Events on stdout: all JSON-mode events (`agent_start/end/settled`, `turn_*`, `message_start/update/end` (update is delta-only), `tool_execution_*`, `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `compaction_start/end`, `auto_retry_start/end`, `summarization_retry_*`) plus `bash_execution_update` and `extension_error` (`docs/json.md`).
  - Extension UI over RPC: dialogs `select/confirm/input/editor` -> `extension_ui_request`, answered with `extension_ui_response{id,value|confirmed|cancelled}`; fire-and-forget `notify, setStatus, setWidget (string[] only), setTitle, set_editor_text`. Degraded/no-op: `custom()` (returns undefined), `onTerminalInput`, `setWorking*`, `setFooter/Header`, `setEditorComponent`, `getEditorText` ("" ), `setTheme` (error result), `getAllThemes` ([]) (`docs/rpc-extension-ui.md:14-25`, `rpc-mode.ts:136-311`). Renderers never invoked.
  - Shutdown: close stdin; or `ctx.shutdown()` -> completes after current command / `agent_settled` (`rpc-mode.ts:345-359`).
  - TypeScript client: `RpcClient` exported from `@earendil-works/pi-coding-agent` (`examples/rpc-client.ts`, `promptAndWait()`); subagent example spawns `pi --mode json -p --no-session [--model] [--tools a,b]` (`examples/extensions/subagent/index.ts:300-307`).
- Practical consequence: print/json can verify "does my extension load and does `ctx.hasUI` degrade" but cannot exercise an *idle-injection from an external socket* flow (process exits). RPC can (the socket handler runs while RPC waits on stdin), but its `ctx.mode` is `"rpc"`, not `"tui"`, so TUI-only paths (renderers, widgets-as-components, `input` from the real editor) are untested there.

---

## 6. CLI model / provider / thinking / tools / session flags (+SURE `docs/cli.md:55-146`)
- `--model <pattern>`: exact id or fuzzy id/name; accepts `provider/id` and an optional `:<thinking>` suffix, e.g. `--model openai-codex/gpt-6-luna:high`. `--provider <name>` restricts lookup. `--thinking <off|minimal|low|medium|high|xhigh|max>` overrides a suffix; clamped to model capabilities. `--models <patterns>` scopes cycling. `--list-models [search]`.
- +SURE The bundled catalog in `pi.exe` has `openai-codex/gpt-6-luna` (`api:"openai-codex-responses"`, baseUrl `https://chatgpt.com/backend-api`, `reasoning:true`, input text+image, cost $/M `{input 0.1, output 0.5, cacheRead 0.01, cacheWrite 0.125}` with a >272k tier, `contextWindow 272000`, `maxTokens 128000`, `thinkingLevelMap {off:"none", minimal:"low", low:"low", medium, high, xhigh, max}`, compat `supportsOpenAIGrammarTools/AdditionalTools/ToolSearch/MidConvoSystemMessages: true`, **no `promptCache` field**). Also present for openai-codex: `gpt-6-sol`, `gpt-6.1-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.3-codex-spark`, (+ `-fast`/`-pro` variants exist in the binary under other providers). Catalog may be overlaid at runtime from pi.dev (`docs/models.md:15`); `--offline` suppresses that. (Extracted via `grep -a` on the binary; the generated `packages/ai/src/providers/data/*.json` is gitignored so isn't in the clone.)
- Tools: `-t/--tools a,b,c` replaces the whole allowlist (built-in, extension, custom names; no `+/-` syntax); `-xt/--exclude-tools`; `-nbt/--no-builtin-tools`; `-nt/--no-tools`. Built-ins: `read, bash, powershell (Windows only), edit, write, grep, find, ls`. Read-only set: `--tools read,grep,find,ls`. Defaults `read,bash,edit,write` (+`defaultTools` setting). `codemode`/`tool_search` are built-in extension tools, off by default. Extension-registered tools must be named in `--tools` too if you use it (-GUESS: applies to your extension's tools; allowlist semantics say "built-in, extension, or custom tools").
- Sessions: `--no-session` (in-memory; still has a session id), `--session-dir <dir>` (beats `PI_CODING_AGENT_SESSION_DIR` and `sessionDir` setting), `--session-id <id>` (opens or creates exact id; id chars `[A-Za-z0-9._-]`, must start/end alnum, `session-manager.ts:268-274`), `-c`, `-r`, `--session`, `--fork`, `-n/--name`.
- `--system-prompt <text|path>`, `--append-system-prompt <text|path>` (repeatable), `--verbose`, `--tui-mode regular|fullscreen`.

---

## 7. Prompt caching on `openai-codex`

### 7.1 What affinity pi sends (+SURE `openai-codex-responses.ts`)
- Cache id = **the pi session id**: `Agent.sessionId = sessionManager.getSessionId()` (`sdk.ts:411`; uuidv7, `session-manager.ts:264-266`) -> `options.sessionId` (`agent.ts:472`). `cacheSessionId = options.cacheRetention === "none" ? undefined : options.sessionId` (`275`); clamped to 64 chars (`openai-prompt-cache.ts:1-8`).
- Request body: `{model, store:false, stream:true, instructions, input, text:{verbosity:"low"}, include:["reasoning.encrypted_content"], prompt_cache_key: <session id>, tool_choice:"auto", parallel_tool_calls:true, [reasoning:{effort,summary:"auto"}], [service_tier], [temperature]}` (`527-600`). **No `prompt_cache_retention`, no `prompt_cache_options`, no `conversation`/`previous_response_id` in the REST body**.
- Headers (SSE): `Authorization: Bearer`, `chatgpt-account-id` (from JWT claim), `originator: pi`, `User-Agent`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`, `session-id: <id>`, `x-client-request-id: <id>` (`1640-1679`). WebSocket: `OpenAI-Beta: responses_websockets=2026-02-06`, `session-id` and `x-client-request-id` = same id (`1681-1697`).
- **Transport default `auto` = WebSocket first, SSE fallback** (`294-301`; setting `transport` `auto|sse|websocket|websocket-cached`, `docs/settings.md:119`). WS connection is cached per `(sessionId, accountId)`; with `auto`/`websocket-cached`, subsequent requests send `previous_response_id` + only the input delta when the new request body equals the last one except `input` and its input extends the previous input + response items (`1425-1477,1518-1583`). Idle WS closes after **5 min** (`SESSION_WEBSOCKET_CACHE_TTL_MS`, reset on every release `1062-1072,1202,1245`), max connection age **55 min** (`867`). After a WS failure the session sticks to SSE (`recordWebSocketFailure`, `966-986`). Consequence: `previous_response_id` continuation is connection-scoped; > 5 min idle falls back to full-context requests (server-side prompt-cache by `prompt_cache_key` may still hit). -GUESS on server-side TTL for Codex backend (not sent/declared anywhere).
- Different pi sessions (new `--session-id`, `/new`, fork) get different keys; two peer sessions A/B in separate pi processes have separate cache pools unless you force the same `--session-id` (-GUESS: that would share `prompt_cache_key` but not WS state).
- `usage.cacheRead` of each assistant message is the observable hit signal.

### 7.2 `PI_CACHE_RETENTION` (+SURE)
`docs/environment-variables.md`: "Set to `long` for extended provider prompt caching where supported". Only the literal `long` is recognized. It is read by `anthropic-messages`, `bedrock`, `openai-completions`, `openai-responses`, `pi-messages` (`resolveCacheRetention`, e.g. `openai-responses.ts:72-81` -> `prompt_cache_retention:"24h"` or `prompt_cache_options:{ttl:"30m"}`), and by `cache-warmer.ts:39-45` to pick the `promptCache.long` TTL tier. **`openai-codex-responses.ts` never reads it** (grep: only `cacheRetention === "none"` at line 275), and pi never sets `options.cacheRetention` for the main agent (grep over `coding-agent/src`: none; compaction passes `"none"`, `agent/src/harness/compaction/compaction.ts:122`). => `PI_CACHE_RETENTION=long` has **no effect on codex requests**.

### 7.3 `cacheWarming` (+SURE `cache-warmer.ts`, `settings.md:19-21`)
- Setting: `"off" | "streaming" | "idle"`, default `"streaming"`, **global settings only** (`settings-manager.ts:1021-1024`; project settings can't set it). 
- Mechanism: on every real session request `CacheWarmer.start()` is called (`sdk.ts:403-405`); it replays the same request `{...options, maxTokens: 1, maxRetries: 0}` (`cache-warmer.ts:335`) at `delay = min(0.9*TTL, TTL-10s)` where TTL = `model.promptCache[short|long]` seconds (`29-45`); usage is persisted as a `usage` entry `kind:"cache_warm"` (counts toward session totals, not in LLM context; `refresh()` ~`300-345`); rescheduled after each success.
- `streaming`: refreshes only while the run is active; `onAgentSettled()` stops it ("agent run settled", `245-250`); hard cap 60 min after the real request (`16`).
- `idle`: after `agent_settled` the run switches to phase "idle" and keeps refreshing between runs until 30 min after the last real request ("30-minute idle safety limit", `18,251-258,291`). For a 300 s TTL that is every 270 s => about 6 refreshes max; each is a full-prompt cache read + 1 output token.
- Economic gate (every refresh): warm only if `p * missCost - warmCost >= $0.05`, with `p = 1` while streaming and `p = 0.15` idle (`IDLE_CONTINUATION_PROBABILITY`, `26,388`), `missCost = cacheMissCost - cacheHitCost` for `lastPromptTokens` (`~370-398`); needs known prices.
- Extension hook `cache_warming_decision {warmCost, missCost, continuationProbability, action}` -> `{action:"warm"|"stop"}`, last handler wins (`runner.ts:1112-1133`). It is consulted only inside `refresh()`, so **it cannot enable warming for a model that has no TTL**.
- **For `openai-codex/*` in the bundled catalog nothing is warmed in any mode**: `start()` calls `stop("cache lifetime unavailable")` when `getPromptCacheTtlMs()` is undefined (`205-225`), and no codex catalog entry carries `promptCache` (checked `gpt-5.3-codex-spark, gpt-5.6-luna, gpt-5.6-terra, gpt-6-luna, gpt-6.1-sol`; the only `promptCache:{short:300,long:3600}` blocks in the binary are Anthropic-like entries). So `cacheWarming:"idle"` is a no-op for Codex unless the catalog (pi.dev overlay) or a `modelOverrides` entry in `models.json` supplies `promptCache` (`docs/models.md:91-99`; I did not read the user's `models.json`). The idle-pause cost for peer model B therefore is: cache miss on the first request after >N min idle, with no mitigation from pi. An extension-owned keepalive would have to send its own request (outside pi's warmer).
- `/session` shows the next warm decision (`formatCacheWarmingStatus`).

### 7.4 `showCacheMissNotices` (+SURE `settings.md:18`, `interactive-mode.ts:4055-4083`, `cache-stats.ts`)
Default `false`. TUI only. When true: after each assistant message, `detectCacheMiss()` compares with the previous request; a notice prints if `missedTokens >= 20_000 || missedCost >= $0.10` (otherwise silent; per-turn noise floor 1024 tokens, `cache-stats.ts:~13`), labelled "Cache miss", "Cache miss after model switch", or "Cache miss after Nm idle" when idle gap >= 5 min (`CACHE_TTL_MS`); also prints "Cache warmed: $x" for warm usage entries, compaction usage, provider recovery. Not shown in RPC/JSON/print. A miss on a provider that has never reported cache activity is not counted (`detectMiss`: `usage.cacheRead+cacheWrite===0 && !prev.reportedCache`).

---

## 8. Windows / local-server notes for the extension
- +SURE `docs/extensions.md:58-60`: don't start sockets/processes/timers in the factory ("some invocations load extensions without starting a session"); start from `session_start`, close in an **idempotent** `session_shutdown` (cancel/reload/session replacement/exit converge there, `:258-259`). Session replacement tears down the old runtime and re-runs the factory + `session_start` => the server must be re-created per session (port/pipe reuse: close first; `session_shutdown` precedes `session.dispose()`, `agent-session-runtime.ts:171-176`). Interactive quit calls `process.exit(0)` (`interactive-mode.ts:4186,4205`) so stray handles won't hang exit, but close anyway.
- +SURE Bun 1.3.14 (the same version embedded in `pi.exe`) on this Windows 11 host, standalone `bun -e` probe: `node:net` `createServer().listen("\\\\.\\pipe\\name")` + `createConnection(pipe)` echo works; TCP `listen(0,"127.0.0.1")` + client echo works. ~SUSPECT identical inside `pi.exe` (same Bun version; not run inside pi, I deliberately did not run `pi`). Shell gotcha: `\\.\pipe\x` literals get mangled by Git Bash argument handling (build the path from `String.fromCharCode(92)` in tests; within a `.ts` file normal escapes work).
- ~SUSPECT TCP is the lower-friction choice (curl/any client; bind explicitly to `127.0.0.1` to avoid Windows Firewall prompts and LAN exposure); a named pipe avoids port collisions and needs no auth surface beyond ACLs but is harder to hit from curl. pi's own experimental server code treats win32 specially only for `chmod`/stale-socket cleanup (`experimental/coordinator.ts:571,599`), i.e. gives no extension-facing guidance. --WONDER whether pi.exe's Bun has any Windows pipe quirks with `unref()`-ed servers; set `server.unref()` is -GUESS-optional.
- +SURE Windows tool surface: native Windows uses Git Bash for `bash` and `!` commands, optional `powershell` tool (`docs/windows.md`); bash tool env gets `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (`docs/environment-variables.md`), handy for letting a spawned peer process learn the session.

---

## 9. Design-relevant gotchas (collected)
1. +SURE External message -> turn: use `pi.sendUserMessage(text)` while idle (full `prompt()` path, shows as a real user message, fires `input`/`before_agent_start`); use `pi.sendMessage(..., {triggerTurn:true})` only if you want a `custom` message and are fine bypassing `input`/`before_agent_start`. Both enter LLM context.
2. +SURE Maintain an explicit state machine (`idle | A-running | Bx-running`) driven by your own flag + `agent_settled`; do not trust `ctx.isIdle()` right after injecting (race 1.2); reject/queue socket messages while busy (a second `sendUserMessage` while running throws unless `deliverAs`).
3. +SURE To chain Bx: call `pi.sendUserMessage(bx)` from the `agent_settled` handler (deferred safely) or return a `custom_message` draft + `continue:true` from `agent_before_settle` (same run, one settle).
4. +SURE Collect the turn's results at `agent_settled` from `getBranch()` (after recorded leaf id) or accumulate `agent_end.messages` across multiple `agent_end`s (retries!). Check `stopReason` for `error`/`aborted`.
5. +SURE Not in context: `appendEntry`, `ctx.ui.*` widgets/status/notify. In context: `sendMessage` (any `display`), `before_agent_start.message`, `agent_before_settle`/`turn_end` `custom_message` drafts. (`custom` drafts and `context_edit` don't add content.)
6. +SURE Human-input interception covers only plain text submitted from the editor (+ steer/follow-up variants); slash commands, extension commands and `!bash` bypass `input`. The editor is already cleared; a `handled` swallow shows nothing, so echo via `appendEntry` + renderer or `ctx.ui.notify`.
7. +SURE Compaction in flight blocks `sendUserMessage` (throws) and `isIdle()` is false; handle `session_compact`/`session_compact_failed` or retry after `agent_settled`/idle.
8. +SURE Codex cache: `prompt_cache_key`/`session-id`/`x-client-request-id` all = pi session id; `PI_CACHE_RETENTION` and pi's cache warmer do nothing for Codex models (no `promptCache` in catalog). WS continuation has a 5 min idle TTL.
9. +SURE Header hook can't change the Codex `session-id`; payload hook can change `prompt_cache_key` only.

## 10. Open questions (--WONDER)
- Whether `-ne` also suppresses extensions from `settings.json` `packages` (docs say "configured").
- Whether module-level state survives `/new` (factory cache, `loader.ts:539-570`).
- Server-side Codex prompt-cache lifetime (no retention param sent; `models.json` `modelOverrides.promptCache` could enable pi's warmer if the human decides a TTL, e.g. `{short: 300}`; value unknown to me).
- Whether pi.exe's embedded Bun behaves identically to the standalone Bun for named pipes (same version string only).
- Behavior of `agent_before_settle` continuation with an injected `custom_message` against Codex (provider-side: user-role content after an assistant message; should be fine, untested).
