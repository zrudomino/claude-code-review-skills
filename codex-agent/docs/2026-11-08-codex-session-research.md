<!-- Preserved 2026-11-09 from the session scratchpad. Sonnet web-researcher output (retrieved 2026-11-08), NOT line-by-line reviewed.
Claims checked locally on Codex CLI 0.167.0 and corrections found since:
- CONFIRMED: `codex mcp-server` removed (`codex help mcp-server` -> "unrecognized subcommand", exit 2).
- CONFIRMED: `--full-auto` rejected by `codex exec` ("unexpected argument").
- CONFIRMED: parse-output.js missed `thread_id` (fixed in acc72f3); `exec resume` has no -s/-p.
- CORRECTION: "45 of 47 sessions have null sessionId" -> 45 of 223; every session after 2026-10-31 was null.
- CORRECTION: test 2's `--ephemeral:$false` is a typo; just omit `--ephemeral` so the thread is saved.
- CORRECTION: `exec resume` turn.completed usage is THREAD-CUMULATIVE; per-round cache rate is ~98-99%, not the 66-79% quoted in the discussion topic.
- NEW: `web_search="disabled"` removes only the native tool; Codex still browsed via codex_apps.search_service.web_run and node_repl.js. -->

# Claude Code <-> Codex CLI: persistent-session mechanisms (research note)

Retrieval date for all web sources: 2026-11-08. Target: Codex CLI 0.167.0, Windows 10, Claude Code orchestrator.
Labels: VERIFIED = local 0.167 help text, local file, or fetched doc says so. INFERRED = my reasoning. UNCONFIRMED = could not confirm.
Note on sources: developers.openai.com/codex/* now answers with HTTP 308 to learn.chatgpt.com/docs/* (server-supplied redirect; the content is clearly the Codex docs, but I did not independently verify domain ownership). WebFetch summaries come from a small model; quotes below are as returned by the tool. No command was run and nothing was installed.

LOCAL (checked before web):
- 0.167 help text: C:\Users\RJ\AppData\Local\Temp\claude\9919beaa12ed540b\5db2c4c3-f74e-4fbd-90d5-35b2664efdf7\scratchpad\codex-0.167-cli-help.txt
- Skill files: C:\Users\RJ\.claude\commands\codex-agent\{discuss,mcp-setup,dispatch,parallel}.md ; C:\Users\RJ\.claude\codex-agent\lib\{parse-output,parallel,router}.js ; saved sessions in C:\Users\RJ\.claude\codex-agent\sessions\*.json
- User Codex config: C:\Users\RJ\.codex\config.toml

---------------------------------------------------------------------
## 0. Executive summary

1. `codex mcp-server` is DEAD for your setup. Official docs say the command and the standalone binary "have been removed"; deprecated 2026-08 (PR #39657). In 0.167 help it is not a subcommand: `codex mcp-server --help` printed the TOP-LEVEL help with exit 0, i.e. clap treated "mcp-server" as the `[PROMPT]` positional. INFERRED consequence: registering `codex mcp-server` as an MCP server in Claude Code would start the interactive TUI with prompt "mcp-server", not an MCP server. `codex mcp serve` exits 2 (VERIFIED, help file). The local mcp-setup skill is therefore obsolete (details in section 8).
2. The replacement is `codex app-server` (JSON-RPC 2.0, stdio default; threads; turn/start; streaming events). It is the only mechanism that gives a genuinely warm local process + in-memory threads. It is documented as experimental.
3. Official wrappers over app-server exist: Python SDK `openai-codex` (controls local app-server over JSON-RPC; `Codex()` context manager, `thread_start/thread_resume/thread_fork`, `thread.run`), TypeScript `@openai/codex-sdk` (`startThread/resumeThread/run`), and the OpenAI-published Claude Code plugin `openai/codex-plugin-cc` (slash commands incl. `/codex:rescue --resume`).
4. `codex exec resume <id>` works on 0.167 (VERIFIED in help) and is the cheapest fix, but it is NOT a warm connection: each call cold-starts a process (loads config/plugins/MCP servers/AGENTS.md), then reloads the thread from disk. What it saves is Claude-side prompt re-sending and (probably) model-side tokens via prompt-cache hits while the cache is still alive.
5. Important framing: "warm" has two independent layers. (a) Local process warm: skips startup cost (config parse, plugin load, MCP server spawn - your node_repl has startup_timeout_sec = 120). (b) Server-side prompt cache: prefix-based, time-limited (see 2.3), independent of whether your process is alive. A persistent app-server gives (a) fully; (b) only within the cache TTL. In both cases the full conversation prefix is re-sent to the API every turn (INFERRED from the Responses-API design and the documented "entire rendered prefix must match" rule), billed at the cached rate if hit.
6. Local skill has a real bug: parse-output.js never reads `thread_id` (the field `thread.started` uses), so session ids are almost never captured. 45 of 47 saved codex-agent session logs have `"sessionId": null` (local grep). Discuss mode therefore falls back to `resume --last`.

---------------------------------------------------------------------
## 1. `codex exec` one-shot - what is loaded at every start

VERIFIED (local help + docs):
- Reads `$CODEX_HOME/config.toml` unless `--ignore-user-config` (exec help). Loads user/project execpolicy `.rules` unless `--ignore-rules`.
- Project `.codex/config.toml` layers load only for trusted projects (config-advanced). Your config marks C:\PROJECTS trusted.
- AGENTS.md is read up to `project_doc_max_bytes` per file (config-reference). Default value not given on the page.
- Plugins "can bundle skills, MCP servers, browser extensions, and hooks"; bundled skills become available in a new chat/CLI session (docs/plugins).
- Your config (VERIFIED, local file): `web_search = "live"`; `notify = [codex-computer-use.exe, "turn-ended"]`; 10 plugins enabled (codex-app-tools, browser, unified-computer-use, visualize, computer-use @openai-bundled; documents, pdf, spreadsheets, presentations, template-creator @openai-primary-runtime); MCP servers `node_repl` (stdio, startup_timeout_sec=120, big env block) and `openaiDeveloperDocs` (HTTP https://developers.openai.com/mcp); `sandbox_mode = "danger-full-access"`; `approval_policy = "on-request"`; `model_reasoning_effort = "high"`; `[features]` table is empty.
INFERRED: each of those plugins/MCP servers contributes tool schemas and/or skill-index text to the prompt, and each stdio MCP server is spawned per `codex exec`. The `notify` program probably fires at the end of every turn including exec turns (UNCONFIRMED). The magnitude is unknown until measured (section 9, tests 4-5).
INFERRED: because default sandbox in your config is danger-full-access, an exec call without `-s` runs with full access.

Per-run documented defaults: "By default, `codex exec` runs in a read-only sandbox." (non-interactive docs) - but that is the built-in default; your config.toml overrides it. `--full-auto` "is no longer supported" (same page).

Sources:
- https://learn.chatgpt.com/docs/non-interactive-mode.md (retrieved 2026-11-08; reached via 308 from https://developers.openai.com/codex/noninteractive.md)
- https://learn.chatgpt.com/docs/config-file/config-advanced (2026-11-08)
- https://learn.chatgpt.com/docs/config-file/config-reference (2026-11-08; page truncated at 100k chars, last ~67k chars not read)
- https://learn.chatgpt.com/docs/plugins.md (2026-11-08)

---------------------------------------------------------------------
## 2. `codex exec resume`

### 2.1 What the 0.167 help says (VERIFIED)
`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`. SESSION_ID = UUID or thread name ("UUIDs take precedence if it parses"); `--last` picks newest; `--all` disables cwd filtering. PROMPT may be `-` (stdin).
Options present on resume: `-c`, `--enable/--disable`, `-i`, `--strict-config`, `-m`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--worktree`, `--thread-source`, `--cyber-access-program`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, `-o/--output-last-message`.
Options ABSENT on resume (compare with `exec`): `-C/--cd`, `-s/--sandbox`, `-p/--profile`, `--add-dir`, `--approve-for-me`, `--color`.
Consequences: (1) profile cannot be selected on resume - use `-c` overrides or `--ignore-user-config`; (2) sandbox cannot be set with `-s` on resume - use `-c sandbox_mode="read-only"` (INFERRED that it works; test 6); (3) cwd cannot be set - inherited (matches discuss.md). Docs: `--worktree` cannot be combined with `resume`, `review`, `--ephemeral`, `--ignore-user-config`.
Also: `codex exec fork <SESSION_ID> [PROMPT]` exists (copies a saved session into a new one; fork requires a prompt). Useful for "branch a warm review thread without polluting it".

### 2.2 Does resume re-send full history?
- UNCONFIRMED by any doc I found. INFERRED: yes. Codex uses the Responses API; each turn sends the rendered prefix (base instructions + tools + history + new input). Prompt caching docs: "Cache reuse requires the entire rendered prefix to match."
- The only official usage example: `{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}` (non-interactive docs). That shows ~99 % of input served from cache on some turn; it does not say which turn/resume state.
- Changelog 0.164.0 (2026-10-23): "Allow callers to control prompt cache keys independently of session IDs" (#55587). Which surface exposes this (app-server field? config?) is UNCONFIRMED. Implication: by default the cache key is probably tied to the session/thread id, so separate cold `exec` calls (different thread ids) get no key-based routing benefit, while resume of the same thread does (INFERRED).
- Resume thread id continuity: the community JSONL reference does not say whether a resumed run emits `thread.started` or the same id. UNCONFIRMED -> test 2.

### 2.3 Prompt cache facts (primary: OpenAI API docs)
- Minimum cacheable prefix: 1,024 visible input tokens for GPT-5.6 and later (earlier models vary).
- Lifetime: older models in-memory "typically remain active for around 5 to 10 minutes of inactivity, up to one hour"; extended 24h option; GPT-5.6 and later use `prompt_cache_options.ttl` with a 30-minute default or 12-hour option.
- `prompt_cache_key`: "Keys influence routing; they do not pin requests to a machine or guarantee a cache hit." On GPT-5.6+ it is optional.
- Cached input is "discounted up to 95%".
- Whether your default `gpt-6-sol` follows the GPT-5.6+ rules, and whether Codex sets TTL options, is UNCONFIRMED.
Source: https://developers.openai.com/api/docs/guides/prompt-caching (retrieved 2026-11-08; redirect from platform.openai.com/docs/guides/prompt-caching).
Practical consequence: a "warm" discussion that pauses >30 min (or >5-10 min on older cache rules) pays full price on the next turn regardless of mechanism. A persistent process does not keep the server cache alive.

### 2.4 JSONL events (for session-id capture)
Docs: "Event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`." (non-interactive docs). Third-party reference (https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/, 2026-11-08; SECONDARY) gives `{"type":"thread.started","thread_id":"<uuid>"}`. That `thread_id` is the value `exec resume` takes (INFERRED from help: "Conversation/session id (UUID)"; test 2 confirms).

---------------------------------------------------------------------
## 3. Codex as an MCP server (`codex mcp-server`)

VERIFIED removal/deprecation:
- Official docs page https://learn.chatgpt.com/docs/mcp-server (2026-11-08): "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed." Integrations must move to the Codex app server before upgrading Codex; the old MCP tool reference and Agents-SDK examples are no longer supported. Codex remains an MCP CLIENT (`codex mcp ...`).
- PR #39657 "Warn when launching the deprecated MCP server", merged 2026-08-20: prints a stderr warning, "will be removed in a future release". https://github.com/openai/codex/pull/39657 (2026-11-08)
- Version of removal: SECONDARY only - labmemo.com (title: "Codex 0.154.0 ... mcp-server removal") and a developersdigest.tech post say removed in 0.154.0 via PR #42993; deprecation notice in v0.149.1 (daniel vaughan blog). [METADATA-UNVERIFIED: no primary release note fetched]. Irrelevant for you: 0.167 > 0.154 and local help confirms it is not a subcommand.
- Local evidence (VERIFIED, help file): `codex --help` command list has no `mcp-server`; `codex mcp --help` lists only list/get/add/remove/login/logout; `codex mcp serve` -> exit 2 "unrecognized subcommand 'serve'"; `codex mcp-server --help` -> exit 0 with TOP-LEVEL help. INFERRED explanation: root command takes `[PROMPT]`, so the unknown word became the prompt and `--help` printed root help. Safe check: `codex help mcp-server` (should error). DO NOT run `codex mcp-server` without `--help` - it would likely open the TUI.

What it used to expose (historical, SECONDARY, for context only): two tools `codex` (start, args incl. prompt/cwd/sandbox/model/approval-policy) and `codex-reply` (continue by thread id). Known bug history: `codex()` did not return the conversation id (issues #3712, #4651, #5660, #8388, #8580 per https://codex.danielvaughan.com/2026/03/27/claude-code-codex-mcp-in-practice/, 2026-11-08); later fixed by returning `structuredContent.threadId`. Moot for 0.167.

Third-party MCP wrappers that still work because they shell out to `codex exec` (they do NOT keep Codex warm): tuannvm/codex-mcp-server (tools codex/review/websearch/listSessions/ping/help; per-instance in-memory sessions; requires CLI >= v0.75.0; README states compatibility with 0.87; compatibility with 0.167 UNCONFIRMED) https://github.com/tuannvm/codex-mcp-server (2026-11-08). Note the README does not say whether it spawns per call; INFERRED from "wraps the Codex CLI" - treat as one-shot/resume under the hood.

Claude Code side, if you ever build your own MCP bridge (VERIFIED, https://code.claude.com/docs/en/mcp, 2026-11-08):
- Register: `claude mcp add --transport stdio [--scope local|project|user] [--env K=V] <name> -- <command> [args...]`
- Tool-call timeout: default ~28 hours unless `MCP_TOOL_TIMEOUT` set; per-server `timeout` (ms) in `.mcp.json` is a hard wall clock limit; stdio idle timeout 30 min with no response/progress notification (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); startup timeout `MCP_TIMEOUT`.
- A stdio MCP server is launched by Claude Code once and stays up for the session (INFERRED from stdio MCP semantics; this is what makes it a warm host for an app-server child).
- Servers can push messages using the `claude/channel` capability (opt-in via `--channels`) - a possible async path for long Codex turns.

---------------------------------------------------------------------
## 4. `codex app-server` (and daemon / remote-control / queue / exec-server)

### 4.1 Local 0.167 help (VERIFIED)
`codex app-server [OPTIONS] [COMMAND]`, experimental. Subcommands: `daemon` ("Manage the local app-server daemon"), `proxy` ("Proxy stdio bytes to the running app-server control socket"), `generate-ts`, `generate-json-schema`. Options: `--listen <URL>` with `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`; `--stdio`; WebSocket auth `--ws-auth capability-token|signed-bearer-token` with `--ws-token-file/--ws-token-sha256/--ws-shared-secret-file/--ws-issuer/--ws-audience/--ws-max-clock-skew-seconds`; `--print-startup-config` ("Validate configuration and print requirements as JSON without starting the app server"); `-c`, `--enable/--disable`, `--strict-config`.
`codex remote-control [start|stop|pair]`, `--no-daemon` (foreground embedded server). `codex agents` / `codex resume` / `codex fork` / TUI accept `--remote <ADDR>` (ws/wss/unix) and `--no-daemon`.
`codex queue --thread <UUID|name> --message <TEXT> [--resume] [--remote ADDR] [-C DIR]` ("Queue a message for an existing session"; text only; `--resume` needs a running local daemon or `--remote`; per CLI reference).
`codex exec-server` = standalone "exec-server" service (`--listen ws://IP:PORT` default or stdio) for REMOTE COMMAND EXECUTION environments (register/forward remote environments). INFERRED: unrelated to chat sessions; not a bridge for Claude -> Codex conversation. UNCONFIRMED detail.

### 4.2 Protocol (VERIFIED from https://learn.chatgpt.com/docs/app-server, first 100k of 147k chars read)
- Transports: stdio JSONL (default); `ws://` "experimental and unsupported"; unix socket (WebSocket over a Unix socket); `off`. "Use plain WebSockets only for localhost or an SSH port-forwarded connection."
- Handshake: client sends `initialize` (with `clientInfo` name/title/version, optional `capabilities`), then `initialized` notification. Requests before that -> "Not initialized".
- Methods named in docs: `thread/start` (params model, cwd, approvalPolicy, sandbox, serviceName; emits `thread/started`), `thread/resume` (by threadId; `excludeTurns: true` returns metadata only), `thread/fork`, `thread/list`, `thread/loaded/list` ("returns thread IDs currently in memory"), `thread/unsubscribe`, `turn/start` (threadId + `input` items such as `{"type":"text","text":...}`; per-turn overrides cwd/approvalPolicy/sandboxPolicy/model/effort/summary/outputSchema; returns turn with status inProgress), `turn/steer` (needs `expectedTurnId`), `turn/interrupt`.
- Events: `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/status/changed`, `thread/closed`.
- Approvals are server->client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`; client answers accept / acceptForSession / decline / cancel; `serverRequest/resolved` follows. A bridge must answer these or use a non-prompting approval policy.
- Thread lifetime: "After the last subscriber leaves, app-server unloads the thread once it has been idle for 60 seconds by default" (`thread_unload_delay_secs` changes it). Unloaded threads are still resumable from disk with `thread/resume`. => for a warm in-memory thread keep the connection subscribed. (A third-party post says 30 minutes; the official page says 60 s - prefer official.)
- Schema generation (ground truth for your exact build): `codex app-server generate-json-schema --out DIR` and `generate-ts --out DIR` (docs: output matches the version that generated it).
- Page says: "If you are automating jobs or running Codex in CI, use the Codex SDK instead." Includes a Node.js stdio example (not fully read).
- Not documented anywhere I could fetch: `codex app-server daemon` subcommands/lifecycle, `proxy` usage, default control-socket path, idle shutdown of the shared background server. [UNCONFIRMED] -> run `codex app-server daemon --help` (test 9).
- Changelog: 0.163.0 (2026-10-15) "Restart a managed background server from /daemon"; 0.166.0 (2026-10-29) `codex queue --resume`; 0.167.0 (2026-11-06) `codex agents --no-daemon`. https://learn.chatgpt.com/docs/changelog (2026-11-08; page truncated, ~125k chars unread). 0.167 release: https://github.com/openai/codex/releases/tag/rust-v0.167.0 (2026-11-08) - nothing relevant to exec/resume in its notes.
- README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (2026-11-08) - the fetch returned only fragments (thread/start daybreakEnabled, thread/resume saved provider, turn/start disabledPluginIds, approval flow). `turn/start` accepting `disabledPluginIds` is notable for lean calls (UNCONFIRMED semantics) - exactly the per-turn plugin switch the exec CLI lacks.

### 4.3 How Claude could drive a long-lived app-server (INFERRED designs)
A. Claude-registered MCP stdio bridge (best fit): small Node or Python MCP server started by Claude Code once; it spawns `codex app-server` (or uses the Python SDK, which does that), does `initialize`, keeps a map {name -> threadId}; exposes tools e.g. `codex_open(name, cwd, sandbox, model)`, `codex_say(name, text)`, `codex_close(name)`. Each `codex_say` = `turn/start` + collect `item/agentMessage/delta` until `turn/completed`; auto-answer or deny approvals. Process lives as long as the Claude Code session; threads in memory as long as the bridge stays subscribed.
B. Detached daemon + thin CLI: run `codex app-server --listen unix://...` (or `ws://127.0.0.1:PORT` with `--ws-auth capability-token`) in the background; Claude invokes a tiny client script via Bash per round. Survives Claude restarts; needs lifecycle management and token handling; WS is "experimental and unsupported"; unix sockets on Windows UNCONFIRMED.
C. Official daemon + `codex queue`/`codex resume --remote`: the "shared background server" backs Desktop/TUI; `codex queue --thread X --message M --resume` can inject a message into an existing session, but it is fire-and-forget text queueing, not a request/response API (INFERRED); no documented way to read the reply except via the session store/UI.

---------------------------------------------------------------------
## 5. Codex SDKs

VERIFIED (https://learn.chatgpt.com/docs/codex-sdk and .md, 2026-11-08):
- TypeScript: `npm install @openai/codex-sdk`; Node 18+. `const codex = new Codex(); const thread = codex.startThread(); await thread.run("..."); thread.run(...)` again continues the same thread; `codex.resumeThread(threadId, { sandboxMode: "workspace-write" })`; `startThread({ threadSource: "ci" })`; constructor documents `config` and `configOverrides`. `runStreamed` is NOT mentioned on the page [UNCONFIRMED].
- Python: `pip install openai-codex` (Python 3.10+). `with Codex() as codex: thread = codex.thread_start(model=..., sandbox=Sandbox.workspace_write); result = thread.run(...); result.final_response`; `codex.thread_resume(...)`, `codex.thread_fork(...)` (`include_turns=False` skips loading old turns), `thread.turn(...)`, `thread.read(include_turns=True)`, `AsyncCodex`. "The Python SDK controls the local Codex app-server over JSON-RPC." "Published builds include a pinned Codex CLI runtime"; with your own executable, CLI >= 0.151.0 for some features. Package/module names have changed over time (older: `codex_app_server`; one article mentions `openai-codex-app-server-sdk`) - use the current docs, verify `pip index versions openai-codex`.
Feasibility as persistent bridge: HIGH for Python (a `Codex()` context object = one warm app-server child; threads in memory while the context lives). TypeScript docs do not state the process model; UNCONFIRMED whether each `run` spawns a process. Either SDK is the shortest route to bridge design A in section 4.3. Caveat: SDK is beta/experimental (Python docs say so, via search summary).
Pinned runtime caveat: a pinned CLI inside the pip package may differ from your 0.167 standalone and from the Desktop app's CLI; config in `~/.codex` is still shared (INFERRED).

---------------------------------------------------------------------
## 6. Official Claude Code plugin: openai/codex-plugin-cc

VERIFIED from README (https://raw.githubusercontent.com/openai/codex-plugin-cc/HEAD/README.md, 2026-11-08):
- Install in Claude Code: `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex` (install lines from the blog https://codex.danielvaughan.com/2026/08/25/codex-mcp-server-deprecated-app-server-migration-claude-code-plugin-v0149/ - SECONDARY; README fetch did not echo them).
- Commands: `/codex:review` (read-only; `--base <ref>`; `--wait`/`--background`), `/codex:adversarial-review` (steerable, takes focus text), `/codex:rescue` (`--background|--wait|--resume|--fresh|--model|--effort`; subagent `codex:codex-rescue`), `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:transfer` (creates a persistent Codex thread from the current Claude session; prints `codex resume <session-id>`), `/codex:setup` (`--enable-review-gate` adds a Stop hook that runs a Codex review of Claude's reply, warned as a possible usage-draining loop).
- "wraps the local Codex app server", uses the same CLI, auth, config.toml, repo checkout. Node >= 18.18. `--resume` continues the latest rescue thread for the repo.
- README does not describe a broker or whether the app-server process stays warm. Third-party analysis (instagit.com, SECONDARY) says it uses `thread/resume` with tracked thread ids and optionally a unix-socket broker shared across Claude sessions - UNCONFIRMED.
- Known issue (SECONDARY via search summary): plugin v1.0.5 "no rollout found for thread id" on fresh delegated tasks (openai/codex issue #31158); fixed status unknown.
Fit: designed for review/rescue/delegation jobs, not free-form multi-turn "discussion"; but `/codex:rescue --resume` gives a persistent thread per repo with zero code written. Windows behaviour UNCONFIRMED.
It inherits your ~/.codex/config.toml, so the 10 plugins/2 MCP servers also load there unless you change config.

---------------------------------------------------------------------
## 7. Lean prompt knobs for headless calls

VERIFIED flags (0.167 help): on `exec` and `exec resume`: `--ignore-user-config` (skip `$CODEX_HOME/config.toml`; "auth still uses CODEX_HOME"), `--ignore-rules`, `--ephemeral` (no rollout files on disk), `--skip-git-repo-check`, `-c key=value` (TOML-parsed, dotted), `--enable/--disable <FEATURE>` (= `-c features.<name>=true/false`), `--output-schema`, `-o`, `-m`. On `exec` only: `-p/--profile`, `-s`, `-C`, `--add-dir`. `-i` for images.

VERIFIED config keys (config-reference, 2026-11-08; page partly truncated):
- `plugins.<plugin>.enabled` (boolean; key form `plugin-name@marketplace-name`) and `plugins._default.enabled`.
- `mcp_servers.<id>.enabled` (boolean: "Disables an MCP server without removing its configuration"); the only doc example of an override: `mcp_servers.context7.enabled=false`.
- `skills.config` array with `.enabled/.name/.path` (last matching rule wins).
- `features.*` names listed: apps, code_mode.*, context_management.experimental_mode, enable_request_compression, fast_mode, goals, hooks, memories, multi_agent, network_proxy, prefer_mxc, prevent_idle_sleep, remote_plugin, rollout_budget.*, shell_snapshot, shell_tool, skill_mcp_dependency_install, ultrafast_mode, unified_exec, view_image, web_search, web_search_cached. (`features.skills` and `features.plugins` do NOT exist.)
- `project_doc_max_bytes`, `developer_instructions`, `model_instructions_file` (replacement for built-in instructions - risky), `tool_output_token_limit`, `history.persistence` (`save-all|none`).
- Profiles: `--profile NAME` layers `~/.codex/NAME.config.toml` above `config.toml`; profile files use top-level keys (not `[profiles.x]`); since 0.134.0 `[profiles.x]` tables and top-level `profile =` are not read. Precedence: user config < profile file < project config < CLI. Matches the 0.167 help ("Layer $CODEX_HOME/<name>.config.toml on top of the base user config"). A profile can OVERRIDE keys but cannot delete the base file's `[plugins...]` tables - so the profile must set `enabled = false` explicitly (INFERRED; plugin-level `enabled=false` in a profile is not shown in docs; test 4).
- Not on the visible page (UNCONFIRMED): `include_apps_instructions`, `include_environment_context`, `include_permissions_instructions`, `base_instructions`, `prompt_cache_key`. Do not use them without `codex debug` verification.

Candidate lean invocations (INFERRED to work; each needs test 4/5):
 (L1, nuclear) `codex exec --ephemeral --ignore-user-config --skip-git-repo-check -m gpt-6-sol -c model_reasoning_effort="medium" -s read-only -C <dir> --json -o <file> -`  
     Pros: zero plugins/MCP/notify/web_search from user config. Cons: loses trust_level (project .codex layers ignored), loses your model/effort defaults (so pass them), loses `[windows] sandbox="elevated"` (sandbox may behave differently on Windows - TEST that a read-only sandbox still functions), still AGENTS.md. Default-on built-in features (apps etc.) may still add tools.
 (L2, profile) create `C:\Users\RJ\.codex\lean.config.toml` containing `plugins."browser@openai-bundled".enabled=false` ... for all 10, `mcp_servers.node_repl.enabled=false`, `mcp_servers.openaiDeveloperDocs.enabled=false`, `web_search="disabled"` (value UNCONFIRMED), `notify=[]` (UNCONFIRMED), `sandbox_mode="read-only"`, `approval_policy="never"`; call `codex exec -p lean ...`. Not available on `exec resume` - for resume put the same keys as `-c` flags, or accept `--ignore-user-config` there.
 (L3, inline) append to any call: `-c 'plugins._default.enabled=false'` (semantics UNCONFIRMED), `-c mcp_servers.node_repl.enabled=false -c mcp_servers.openaiDeveloperDocs.enabled=false`, one `-c 'plugins."browser@openai-bundled".enabled=false'` per plugin (PowerShell quoting is painful; prefer L2).
 Measuring: `codex debug prompt-input [PROMPT]` ("Render the exact model-visible prompt input list as JSON"; `-i` images) - VERIFIED in CLI reference (https://learn.chatgpt.com/docs/cli/reference.md). Caveat INFERRED: it renders the INPUT list (instructions, context, user message) and probably NOT the `tools` array, so tool-schema weight (plugins/MCP) is better measured from `turn.completed.usage.input_tokens` of a trivial prompt under each config. Whether `-c`/`--ignore-user-config` are honoured by `debug prompt-input` is UNCONFIRMED (put them before `debug`).
 Narrow work should also use `--output-schema` (stable, short replies) and `-o` to avoid parsing the event stream, and pass the prompt on stdin (`-`) to dodge Windows quoting.

Also relevant: AGENTS.md scoping - docs fetch for the AGENTS.md guide 404'd (https://learn.chatgpt.com/docs/agents-md.md); only `project_doc_max_bytes` is confirmed. Run codex with `-C` in a small scratch directory to avoid parent AGENTS.md chains (INFERRED; discovery walks from project root to cwd).

---------------------------------------------------------------------
## 8. Gaps in the current codex-agent skill vs 0.167

1. mcp-setup.md: (a) premise obsolete - `codex mcp-server` removed; (b) its availability probe `codex mcp-server --help` returns exit 0 on 0.167 (prints root help) -> FALSE POSITIVE "available"; (c) the config it writes (`"command":"codex","args":["mcp-server"]`) would launch the TUI with prompt "mcp-server" at Claude start; (d) note "experimental as of v0.98.0" is stale; (e) it writes to settings.json `mcpServers`, while Claude Code's documented route is `claude mcp add` / `.mcp.json` (VERIFIED docs; settings.json mcpServers location is UNCONFIRMED).
2. parse-output.js: session id extraction looks for `session_id`, `conversation_id`, `session.created`, `conversation.created`; never `thread_id` from `thread.started`. Local evidence: 45/47 saved sessions have `"sessionId": null`, 2 non-null. So discuss.md "resume <sessionId>" path rarely runs; it uses `resume --last`, which is cwd-scoped and can grab the wrong thread (parallel dispatches, Desktop app sessions in same cwd). UNCONFIRMED whether `exec resume --last` considers GUI/TUI sessions.
3. extractUsage ignores `cached_input_tokens` (and `reasoning_output_tokens`): cost/budget accounting overstates cost and gives no cache-hit telemetry.
4. parallel.js builds `exec --full-auto --json ...`; `--full-auto` is absent from 0.167 `exec --help` and the docs say it is "no longer supported" -> parallel dispatch likely fails (test 8).
5. Safety/config: discuss/dispatch use `--sandbox workspace-write` for "do not modify code" consultations; they should be `read-only`. On the resume path no sandbox flag is passed and `-s` does not exist on resume, so the run inherits whatever config/rollout says - with your config.toml that is `danger-full-access` (INFERRED; test 6). Add `-c sandbox_mode="read-only"` to consult resumes.
6. No lean-call mechanism: no `--ephemeral`, `--ignore-user-config`, `-p`, plugin/MCP disables, `--output-schema` (except the review template) -> every call pays for the 10 plugins + 2 MCP servers + live web search + notify hook (INFERRED).
7. No persistence of Codex thread id/name across Claude sessions (session JSON stores no thread id) -> cannot reopen a review conversation later. `exec resume` accepts thread names too ("UUID or thread name"), but nothing sets names (`codex-plugin-cc` uses `thread/name/set`; exec has no documented naming flag [UNCONFIRMED]).
8. Unused 0.167 capabilities: `exec fork` (branch a warm thread), app-server/SDK, `codex queue`, `codex debug prompt-input`, `--thread-source` (label threads so Claude-initiated ones can be filtered; `--thread-source <SOURCE>` is in exec help, value semantics UNCONFIRMED).
9. discuss.md flow is already structurally right (short follow-up prompts over resume, full-context fallback); the failure is the id capture.

---------------------------------------------------------------------
## 9. Open questions needing local tests (PowerShell; none have been run)

1. Is `mcp-server` really not a subcommand? `codex help mcp-server; "exit=$LASTEXITCODE"` (expect error). Do NOT run bare `codex mcp-server`.
2. Thread id + resume continuity:
   `codex exec --json --ephemeral:$false --skip-git-repo-check -s read-only "Reply with the word ONE" | Tee-Object C:\Temp\t1.jsonl` then read `thread_id` from the first `thread.started` line; then `codex exec resume <thread_id> --json "What word did you just reply with?" | Tee-Object C:\Temp\t2.jsonl`. Check: same thread_id in t2? Does the answer show memory? (Remove nothing; `--ephemeral` must NOT be used here, a resumable thread must be persisted.)
3. Cache behaviour on resume: from t1/t2 compare `usage.cached_input_tokens` / `input_tokens` on `turn.completed`; repeat a third resume after ~2 min and after ~35 min. Also run a second cold `exec` with the identical prompt right after t1 to see whether cold calls share the cache (system prefix only).
4. Lean vs default token and time cost: 
   `Measure-Command { codex exec --json --ephemeral --skip-git-repo-check -s read-only "Reply OK" | Tee-Object C:\Temp\d.jsonl }` (default config)
   `Measure-Command { codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config -m gpt-6-sol -s read-only "Reply OK" | Tee-Object C:\Temp\l1.jsonl }`
   After creating `C:\Users\RJ\.codex\lean.config.toml`: `... codex exec -p lean --json --ephemeral --skip-git-repo-check "Reply OK"`.
   Compare `turn.completed.usage.input_tokens` and wall time; the delta is the plugin/MCP/web-search/notify overhead.
5. What debug prompt-input shows: `codex debug prompt-input --help`; `codex debug prompt-input "hi" | Measure-Object -Character`; then `codex --ignore-user-config debug prompt-input "hi" | Measure-Object -Character` (tests whether root flags apply and whether skills/plugin text is in the input list).
6. Sandbox inheritance on resume: `codex exec resume <id> -c sandbox_mode='"read-only"' --json "Create file C:\Temp\should_fail.txt with text x"` vs the same without the `-c`; see whether the write succeeds (your config default is danger-full-access).
7. Profile on resume: `codex exec resume <id> -p lean "x"` (expect "unexpected argument" per help). And confirm `-p lean` works on plain exec.
8. `codex exec --full-auto --json "Reply OK"` (expect error on 0.167).
9. Daemon/app-server ground truth: `codex app-server daemon --help`; `codex app-server proxy --help`; `codex app-server --print-startup-config`; `codex app-server generate-json-schema --out C:\Temp\appschema` (then list method names - this settles `thread/*`/`turn/*` names exactly for 0.167).
10. Does exec use/need the daemon? `codex exec --help` has no `--no-daemon`. `Get-Process codex*` before/after an exec; `codex doctor` output.
11. MCP spawn cost per exec: `Measure-Command { codex exec ... -c mcp_servers.node_repl.enabled=false "Reply OK" }` vs without the override; also `-c notify=[]` effect (check whether the computer-use `turn-ended` exe is launched, e.g. Process Monitor or `Get-Process` polling).
12. Python bridge latency (only if you choose design A): in a venv outside the project, `pip install openai-codex`; script with `with Codex() as c: t=c.thread_start(model="gpt-6-sol", sandbox=Sandbox.read_only); t.run("Reply OK"); t.run("Reply OK again")`; time turn 1 vs turn 2 and print the usage cached tokens. Confirms warm-process benefit and whether the SDK-pinned runtime honours your ~/.codex config.
13. thread naming for later resume by name: `codex exec --help | Select-String name`; `codex resume --help | Select-String name` (0.167 help shows "thread name" only on resume arguments).

---------------------------------------------------------------------
## 10. Recommendation sketch (decision belongs to the user)

(a) Multi-turn discussion/verification (many rounds, same context):
  - Option 1 (no new code, accept cold start): fix id capture (`thread.started.thread_id`) in parse-output.js, always `exec resume <thread_id>`, always add `-c sandbox_mode="read-only"` and lean overrides. Gains: Claude stops re-sending context; model-side prefix cached while within TTL. Loses: process cold start every round.
  - Option 2 (warm): MCP stdio bridge over the Python SDK or raw app-server (section 4.3 A). One long-lived app-server child, threads kept in memory, rounds are `turn/start`. Highest fit for "keep a warm Codex"; needs ~100-250 lines + approval handling + tests; experimental API surface.
  - Option 3 (zero build): try `openai/codex-plugin-cc` (`/codex:rescue --resume`, `/codex:adversarial-review`), but it is job-shaped and inherits your heavy config.
  Do not use `codex mcp-server` (removed).
(b) Focused narrow one-shot: `codex exec --ephemeral` with lean config (profile or `--ignore-user-config`), `-s read-only` (or workspace-write only when edits are intended), `--output-schema`, `-o`, prompt on stdin. No history to keep, so no resume.

Sources list (all retrieved 2026-11-08):
- https://learn.chatgpt.com/docs/mcp-server (official; removal notice)
- https://github.com/openai/codex/pull/39657 (official; deprecation warning)
- https://learn.chatgpt.com/docs/app-server (official; protocol; first 100k chars read)
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (official; fragments)
- https://learn.chatgpt.com/docs/codex-sdk and /codex-sdk.md (official)
- https://learn.chatgpt.com/docs/non-interactive-mode.md (official)
- https://learn.chatgpt.com/docs/cli/reference.md (official)
- https://learn.chatgpt.com/docs/config-file/config-advanced and /config-reference (official)
- https://learn.chatgpt.com/docs/plugins.md (official)
- https://learn.chatgpt.com/docs/changelog (official; partial)
- https://github.com/openai/codex/releases/tag/rust-v0.167.0 (official)
- https://developers.openai.com/api/docs/guides/prompt-caching (official)
- https://raw.githubusercontent.com/openai/codex-plugin-cc/HEAD/README.md (official)
- https://code.claude.com/docs/en/mcp (Anthropic official)
- SECONDARY: https://codex.danielvaughan.com/2026/03/27/claude-code-codex-mcp-in-practice/ ; https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/ ; https://codex.danielvaughan.com/2026/08/25/codex-mcp-server-deprecated-app-server-migration-claude-code-plugin-v0149/ ; https://codex.danielvaughan.com/2026/08/30/codex-mcp-server-deprecated-migration-app-server-agents-sdk/ ; https://instagit.com/openai/codex-plugin-cc/how-thread-persistence-and-resume-works/ ; https://github.com/tuannvm/codex-mcp-server ; search-result summaries for labmemo.com 0.154.0 and developersdigest.tech (removal version) ; https://codex.danielvaughan.com/2026/03/30/codex-python-sdk-embedding-agents/ (search listing only)
