# Codex discussion: harness / MCP options (2026-11-08)

Run with the repaired `/codex-agent:discuss` (session `1794158427973-c44c0380`, Codex thread `01a1bc2d-280d-72a2-b7f5-745fd8dcfcd6`, model gpt-6-sol, read-only). Design only, no execution phase. Topic text: options 1 lean profile, 2 warm app-server MCP bridge, 3 lean first then measure, bridge only if startup dominates.

| Round | Mode | New input | Cached | Uncached | Output | Tool items |
|---|---|---|---|---|---|---|
| 1 open-ended | fresh exec | 2,157,179 | 2,043,520 | 113,659 | 7,313 | 18 shell, 10 docs-MCP, 5 web search (~33 steps) |
| 2 asked <=3 tools | exec resume | 356,634 | 354,048 | 2,586 | 5,606 | 4 shell, 114 s |

Round 2's JSONL reported thread-cumulative usage (2,513,813 input); the row above is the delta. Correction: the topic quoted "66-79% cached on resume"; that was computed from cumulative totals. Real per-round cache rate on resume is ~98-99% (resume tests: 34,828 input / 34,176 cached; 36,058 / 35,456).

Agreed order: bounded consult prompt -> remove unused tools -> measure `tool_output_token_limit` and lean profile -> warm bridge only as a latency experiment.

---

## Round 1: Codex

## 1. Recommended approach

I agree with **option 3, with a measurement gate before the bridge**. Keep `codex exec resume` for multi-round discussions for now: your local result already shows 66–79% cached input without a persistent process. A warm app-server process may reduce startup time, but it will not remove the conversation or tool context from each model request. OpenAI Docs says a session can preserve a cacheable prefix, but does not guarantee a cache hit. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

First establish where the 8–10 seconds goes, then trial a lean profile for focused calls. Build the bridge only if process or tool startup remains a material part of latency. Keep pure diff reviews on their existing review path unless a measured change justifies moving them.

One useful correction: although `codex exec resume` and `codex exec review` do not list `-p`, **`-p` is a global CLI option**. Test `codex -p lean exec resume …` and `codex -p lean exec review …` before maintaining duplicate `-c` override lists. The installed CLI accepts the first command shape; that check did not prove the profile’s settings were applied. [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

## 2. Trade-offs and alternatives

A profile is the lowest-complexity way to reduce tool and skill context, but it cannot eliminate Codex’s core instructions. For ordinary code review, keep shell, Git access, and `AGENTS.md` guidance. None of the ten listed plugins appears necessary for that work. Explicit `plugins."<name>".enabled = false` and `mcp_servers.<id>.enabled = false` are documented controls; a profile layers over the base config, so explicit `true` plugin entries need explicit overrides. `web_search = "disabled"` removes that tool for tasks that do not need current information. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

Treat `skills.include_instructions`, `skills.max_context_tokens`, and `features.*` as measured, task-specific experiments. Avoid shrinking `project_doc_max_bytes` as a routine saving: it truncates `AGENTS.md`, which matters in this repository. Keep OpenAI Docs available in a separate profile when reviewing Codex or OpenAI behavior.

If a bridge proves worthwhile, app-server is a sound basis: OpenAI Docs confirms `initialize`, `thread/start`, `thread/resume`, `turn/start`, `review/start`, completion events, and approval requests. Its 60-second unload applies **after the last subscriber leaves**; a connected bridge can retain its subscription. [App-server protocol](https://learn.chatgpt.com/docs/app-server)

Node raw JSON-RPC fits this repo’s dependency-free wrapper, but makes you responsible for protocol events and approvals. The official Python `openai-codex` SDK is now documented as a **stable** release and can target a specific installed CLI with `CodexConfig(codex_bin=...)`; it is worth a prototype comparison if the no-dependency constraint is flexible. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

## 3. Risks and concerns

- **Warm process and warm prompt are different.** Your resumed cache result already demonstrates that process persistence is unnecessary for prompt-cache reuse. Cached tokens still count toward token-per-minute limits. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- **Safety settings can drift across turns.** The current [discuss.md](/C:/PROJECTS/skills/codex-agent/commands/discuss.md) explicitly overrides resume to `read-only` because the user config defaults to full access. A bridge should set sandbox and approval policy explicitly on each applicable thread or turn.
- **Long MCP calls may outlast Claude Code’s tool timeout.** Prefer a short `start` call plus `status`/`result` and `cancel` operations if a synchronous turn can exceed that limit. Handle app-server crashes by resuming the recorded thread ID.
- **Parallelism needs validation.** One app-server can address multiple threads, but measure concurrent turns, event correlation, cancellation, and resource contention on Windows before replacing the separate processes used by [parallel.js](/C:/PROJECTS/skills/codex-agent/lib/parallel.js). Serialize turns on the same thread.
- **`close` needs a precise meaning.** `thread/unsubscribe` releases the bridge’s subscription; archive and delete change stored history. Do not make `codex_close` delete a discussion by default. [App-server protocol](https://learn.chatgpt.com/docs/app-server)

## 4. Suggested implementation steps

1. Record a baseline using the current [dispatch.md](/C:/PROJECTS/skills/codex-agent/commands/dispatch.md) and discuss paths. Capture process start, first CLI event, first model text, completion, input tokens, cached input tokens, and output tokens. Check whether the existing shared daemon affects startup; the installed CLI exposes `--no-daemon` for that comparison.
2. Trial the lean profile with explicit plugin and MCP disables. Verify its effective behavior on fresh `exec`, top-level-profile `exec resume`, and `exec review`. Check review quality on representative tasks as well as token counts.
3. Run paired, alternating full/lean trials with the same model, effort, cwd, sandbox, prompt, and task. Separate **fresh thread versus resumed thread** from **new process versus persistent app-server**. Report median and spread for startup, first text, total wall time, uncached input, cached input, and output. Do not infer startup savings from token counts alone.
4. If startup remains significant, prototype one subscribed app-server connection with `thread/start`, `turn/start`, `thread/resume`, and `review/start`, using the schema generated by CLI **0.167.0**. Confirm approvals, timeout recovery, and two simultaneous threads before switching the wrapper. [App-server protocol](https://learn.chatgpt.com/docs/app-server)

No files were changed.

---

## Round 2: Codex

## Revised recommendation

The new data moves **prompt scope and tool use ahead of harness work**. About 95% of that turn’s input was cached, while roughly 114K tokens were uncached. The 17,140-token prefix repeated across steps is substantial total input, but cutting *steps and newly introduced tool output* is the better first target. A persistent app-server would not remove either from model requests.

### 1. Rank the levers

For consult and verification calls, I would rank them:

1. **(c) Supply the relevant facts and bound exploration.** Specify the files or questions to inspect, a small tool-call budget, and a short answer. This is most likely to cut model steps, uncached additions, and wall time.
2. **(b) Disable web search and the docs MCP when the supplied facts suffice.** Fifteen of the reported steps used those routes. Keep an explicit escape hatch for questions that genuinely require current documentation.
3. **(d) Cap individual tool output, cautiously.** Codex 0.167’s documented `tool_output_token_limit` limits what is stored for an individual tool/function output in history. It is worth measuring, but it is **not** a general promise to cap every command’s immediate stdout or the whole turn. Truncation can remove evidence needed for review. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
4. **(a) Lean static prefix.** Likely useful across repeated steps, especially for total and cached tokens, but its effect on this turn’s *uncached* input and wall time is less certain.
5. **(e) Warm bridge.** Pursue only if timing shows startup remains material after the above changes.

So yes: I would change the order to **bounded consult prompt → remove unused tools → measure targeted output caps and lean profile → consider bridge**. The existing `exec resume` cache performance makes the bridge a latency experiment, not a token-saving strategy. OpenAI Docs likewise says maintaining a session does not guarantee a cache hit. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

### 2. Profile format and what I verified

For **0.167**, the supported profile is a separate **`$CODEX_HOME/lean.config.toml`** containing top-level config keys. OpenAI Docs says `[profiles.lean]` inside `config.toml` stopped being read by `--profile` in **0.134.0**. [Advanced configuration, Profiles](https://learn.chatgpt.com/docs/config-file/config-advanced)

My local checks established only parsing:

- `codex -p definitely_missing_profile_123 exec resume --help` parsed successfully.
- `codex -p definitely_missing_profile_123 exec resume <nonexistent-id> --json "test"` reached “no rollout found,” showing that command shape parsed; it **did not prove profile settings were applied**.
- `codex -p definitely_missing_profile_123 exec review --help` also parsed. I **did not run a review with a real profile**, so I did not verify settings application there either.

Test effective settings with a real `lean.config.toml` before relying on the top-level `-p` form for either nested command. My earlier wording was too confident.

### 3. Small measurement protocol

Use the **existing 2.16M-token turn as the exploratory baseline**; do not repeat an unbounded consult. Run a **10-call pilot**: two trivial and two bounded consult calls per config, plus one review per config. Use the same model, effort, repository, and prompt in each full/lean pair. Alternate order (`full, lean, lean, full`) to reduce cache and time-of-day bias. Stop the pilot if a consult exceeds two tool calls, 90 seconds, or a preselected token/cost ceiling.

Prompts:

- **Trivial:** `Reply with exactly OK. Do not use tools.`
- **Consult:** `Facts: Codex CLI is 0.167.0; exec resume caches 66–79% of input without a persistent process; a prior consult used 33 model steps and 113,659 uncached input tokens. Read only codex-agent/commands/discuss.md and codex-agent/lib/parallel.js if needed. Use at most two read-only shell calls; do not browse or call MCP tools. Recommend the first two changes to reduce consult latency, in at most 250 words.`
- **Review:** `Review only correctness and security regressions introduced by this commit. Report at most three findings. Do not browse or call MCP tools.`

The fixed review target `46db2f9` changes two local-security-scan files (87 additions, 10 deletions), keeping the review far smaller than current `HEAD`’s 3,587-line import. Do not use `--uncommitted` here: this workspace currently has unrelated untracked files.

Suggested PowerShell invocations, run from `C:\PROJECTS\skills`; redirect each stdout stream to a distinct file under `$env:TEMP` and time the command with `Measure-Command`:

```powershell
codex exec --json --ephemeral --sandbox read-only -C 'C:\PROJECTS\skills' 'Reply with exactly OK. Do not use tools.'
codex -p lean exec --json --ephemeral --sandbox read-only -C 'C:\PROJECTS\skills' 'Reply with exactly OK. Do not use tools.'

codex exec --json --ephemeral --sandbox read-only -C 'C:\PROJECTS\skills' '<consult prompt above>'
codex -p lean exec --json --ephemeral --sandbox read-only -C 'C:\PROJECTS\skills' '<consult prompt above>'

codex exec review --json --ephemeral -c 'sandbox_mode="read-only"' --commit 46db2f9 '<review prompt above>'
codex -p lean exec review --json --ephemeral -c 'sandbox_mode="read-only"' --commit 46db2f9 '<review prompt above>'
```

For each run, record wall time and timestamps for process launch, first JSONL event, first agent text, and completion. From JSONL, record `thread.started.thread_id`, the final `turn.completed.usage.input_tokens`, `cached_input_tokens`, and `output_tokens`; count `item.started`/`item.completed` by item type and note errors. Use the **final usage event**, not a sum of repeated usage updates. Record model and effort separately so an accidental profile override cannot masquerade as a performance gain. This pilot tests full versus lean under a bounded prompt; it does **not** causally isolate the prompt change from your earlier unbounded run.

### 4. Python SDK correction

I saw “The Python SDK is available as a stable release” in the current **[Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)**. The same page says published builds bundle a pinned CLI runtime and that `CodexConfig(codex_bin=...)` can select a local executable. That supports “stable release” for the current documentation; it does not establish when the earlier beta description ceased to apply.