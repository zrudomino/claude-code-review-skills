---
name: codex-agent:dispatch
description: Dispatch a coding task to Codex subagent
argument-hint: <task description>
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# Codex Agent — Dispatch

You are dispatching a coding task to the Codex CLI as a subagent. Follow these steps precisely.

## Input

The task to dispatch: `$ARGUMENTS`

## Step 0: Preflight Check

Verify that Codex CLI is installed before doing any budget or routing work:

```bash
codex --version
```

If this fails with "not found", "not recognized", or similar error, stop immediately with:

> **Codex CLI not found.** Please install it first:
> ```
> npm install -g @openai/codex
> ```
> Then run `codex auth` to authenticate.

Do not proceed to any subsequent steps.

## Step 1: Validate Input

If `$ARGUMENTS` is empty or missing, respond with:
> Please provide a task description. Usage: `/codex-agent:dispatch <task description>`
Then stop.

## Step 2: Load Configuration

Read the config file at `~/.claude/codex-agent/config.json`.

If the file does not exist, create the directory structure and write default config:
```
mkdir -p ~/.claude/codex-agent/lib
```
Then write the default config.json with these values:
- budgets.codex: maxTokensPerSession=500000, maxCostPerSession=5.00, maxTokensTotal=5000000, maxCostTotal=50.00
- defaults: approvalPolicy=full-auto, timeout=300000, codexModel=null
- routing.budgetWarningPercent=80

Also extract the `defaults.codexModel` value for use in Step 6.

## Step 3: Budget Check

Run this budget check (use forward slashes in the path, no backticks in the string):

```bash
node -e "var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var ledger = ut.loadLedger('C:/Users/RJ/.claude/codex-agent/usage-ledger.json'); var result = ut.checkBudget(ledger, config, 'codex'); console.log(JSON.stringify(result));"
```

- If `allowed` is `false`: Report the budget reason to the user and stop. Suggest running `/codex-agent:usage` to check spend or editing config to raise limits.
- If `sessionPercent` or `lifetimePercent` is > 80: Warn the user that budget is running high but proceed.

## Step 3b: Cache Check

If the config has `cache.enabled` set to `true`, check the cache before routing:

```bash
node -e "var c = require('C:/Users/RJ/.claude/codex-agent/lib/cache.js'); var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var cacheDir = 'C:/Users/RJ/.claude/codex-agent/cache'; var key = c.computeKey(process.argv[1], process.argv[2]); var result = c.lookup(cacheDir, key, config.cache ? config.cache.ttlMs : 3600000); result.key = key; console.log(JSON.stringify(result));" "$ARGUMENTS" "<current-working-directory>"
```

If `hit` is `true`:
- Calculate how long ago the result was cached: `Date.now() - entry.cachedAt`
- Present the result with a note: "**Cached result** (from [X minutes/hours] ago)"
- Include the cached usage and files changed
- Still create and save a session log noting it was a cache hit
- **Skip Steps 4-8 entirely** and proceed to Step 9 for usage recording (use the cached usage values)

If `hit` is `false`, save the `key` value for use in Step 9 (to store the result in cache after dispatch).

## Step 4: Smart Routing

Run the router to evaluate whether this task is best suited for Codex or Claude subagent:

```bash
node -e "var r = require('C:/Users/RJ/.claude/codex-agent/lib/router.js'); var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var ledger = ut.loadLedger('C:/Users/RJ/.claude/codex-agent/usage-ledger.json'); var result = r.routeTask(process.argv[1], ledger, config); console.log(JSON.stringify(result));" "$ARGUMENTS"
```

Parse the JSON result and act based on the `agent` field:

- **`"codex"`**: Note briefly "Routing: Codex selected ([reason])" and proceed to Step 5.
- **`"claudeSubagent"`**: Show a suggestion: "Routing note: This task may be better suited for a Claude subagent — [reason]. Proceeding with Codex since you invoked dispatch explicitly." Then proceed to Step 5.
- **`"either"`**: Note "Routing: Ambiguous — [reason]. Defaulting to Codex." and proceed to Step 5.
- **`"escalate"`**: Use AskUserQuestion to present three options:
  1. **Proceed with Codex anyway** — Continue the dispatch despite budget/routing concerns
  2. **Use Claude subagent instead** — Stop this dispatch and suggest the user use the Task tool directly for this task
  3. **Cancel** — Abort the dispatch entirely

  If the user chooses "Proceed with Codex anyway", continue to Step 5.
  If the user chooses "Use Claude subagent instead", tell them to use the Task tool with the same task description and stop.
  If the user chooses "Cancel", stop.

## Step 4b: Review Detection

Run review detection to determine if this task is a code review request:

```bash
node -e "var r = require('C:/Users/RJ/.claude/codex-agent/lib/router.js'); var result = r.detectReviewTask(process.argv[1]); console.log(JSON.stringify(result));" "$ARGUMENTS"
```

Parse the JSON result to get `isReview`, `isFocused`, `confidence`, and `signals`.

**If `isReview` is `true` and `isFocused` is `false`**:
- This is a **pure diff review** — will use `codex exec review` in Step 6b.
- Read the review config from `config.json` (the `review` section).
- Determine review flags:
  - If `review.defaultMode` is `"uncommitted"` (default): use `--uncommitted`
  - If `review.defaultMode` is `"base"`: use `--base <review.baseBranch>` (default: `main`)
- Note briefly: "Review detected (pure diff review) — [signals]. Using `codex exec review`."
- Set `IS_REVIEW=true`, `IS_FOCUSED=false`.

**If `isReview` is `true` and `isFocused` is `true`**:
- This is a **focused review** — will use standard exec with a review prompt template in Step 6c.
- Note briefly: "Focused review detected — [signals]. Using standard exec with review prompt."
- Set `IS_REVIEW=true`, `IS_FOCUSED=true`.

**If `isReview` is `false`**:
- Normal dispatch. Proceed as usual.
- Set `IS_REVIEW=false`, `IS_FOCUSED=false`.

## Step 5: Prepare Temp Files & Session

Generate temp file paths for capturing output. Use this command to get the temp dir and create unique filenames:

```bash
node -e "var os = require('os'); var path = require('path'); var dir = path.join(os.tmpdir(), 'codex-agent'); require('fs').mkdirSync(dir, { recursive: true }); var id = Date.now() + '-' + Math.random().toString(16).slice(2); console.log(JSON.stringify({ lastMsg: path.join(dir, 'last-msg-' + id + '.txt'), stdout: path.join(dir, 'stdout-' + id + '.txt') }));"
```

Save the two paths from the output for use in subsequent steps.

Also create a session object for logging:

```bash
node -e "var sl = require('C:/Users/RJ/.claude/codex-agent/lib/session-logger.js'); var session = sl.createSession('dispatch', process.argv[1]); console.log(JSON.stringify(session));" "$ARGUMENTS"
```

Save the session object (particularly the `id`) for use in Steps 9 and 10. You will populate it with routing info, usage, and result data later.

## Step 6: Run Codex

**Branch based on `IS_REVIEW` and `IS_FOCUSED` from Step 4b.** Use the current working directory as `-C` value for Steps 6a and 6c (standard exec). Step 6b (`codex exec review`) does not support `-C` — it uses the process's CWD automatically.

**Timeout**: Use 300 seconds (5 minutes) as the Bash timeout. If the config specifies a different timeout, use that instead (the config value is in milliseconds; divide by 1000 for seconds).

**Capture stdout**: Redirect or capture the full stdout — you will need it for parsing.

### Step 6a: Standard Dispatch (`IS_REVIEW` is false)

This is the default path — unchanged from before.

**If `codexModel` from config is not null**, include the `-m` flag:
```bash
codex exec --sandbox workspace-write --json -m "<codexModel>" -C "<current-working-directory>" --output-last-message "<lastMsg-temp-path>" "$ARGUMENTS"
```

**If `codexModel` is null** (default), omit `-m` entirely:
```bash
codex exec --sandbox workspace-write --json -C "<current-working-directory>" --output-last-message "<lastMsg-temp-path>" "$ARGUMENTS"
```

### Step 6b: Pure Diff Review (`IS_REVIEW` is true, `IS_FOCUSED` is false)

Use `codex exec review` with minimal safe flags. Note: `codex exec review` does **NOT** support `-C` or `--output-schema` flags, but **DOES** support `-o, --output-last-message <FILE>` on modern Codex CLI versions. Codex reviews the repo at the process's current working directory (which is already the project dir). The user's `$ARGUMENTS` are **not** passed as the prompt — however, `codex exec review` does accept an optional trailing `[PROMPT]` argument for formatting instructions. Structured output is prompt-instructed (best-effort) — `parseReviewOutput()` handles parse failures gracefully.

**Base commands** — always include `--json` and the review mode flag:

**If `review.defaultMode` is `"uncommitted"` (default)**:
```bash
codex exec review --json --output-last-message "<lastMsg-temp-path>" --uncommitted
```

**If `review.defaultMode` is `"base"`**:
```bash
codex exec review --json --output-last-message "<lastMsg-temp-path>" --base "<review.baseBranch>"
```

**If `config.review.useOutputSchema` is `true`**, append a schema-instructing prompt to the command to request structured JSON output:
```bash
codex exec review --json --output-last-message "<lastMsg-temp-path>" --uncommitted "Output your review as JSON matching this schema: { summary: string, overall_severity: 'none'|'low'|'medium'|'high'|'critical', findings: [{ id: string, title: string, severity: 'low'|'medium'|'high'|'critical', category: 'bug'|'security'|'performance'|'style'|'maintainability'|'correctness'|'error-handling'|'other', confidence: 'low'|'medium'|'high', file_path: string, line_start: integer, line_end: integer, description: string, evidence: string, suggested_fix: string }], stats: { files_reviewed: integer, findings_count: integer, diff_scope: string }, limitations: string[] }"
```

**If `config.review.useOutputSchema` is `false`** (or not set), omit the prompt — let Codex use its default review format.

Include `-m "<codexModel>"` if `codexModel` from config is not null.

**Fallback**: If `codex exec review` fails with an "unknown command", "unknown flag", or similar error indicating the review subcommand is not supported, **fall through to Step 6c** (focused review fallback) using the original `$ARGUMENTS` as the prompt.

### Step 6c: Focused Review (`IS_REVIEW` is true, `IS_FOCUSED` is true — or fallback from 6b)

Use standard `codex exec` with a review prompt template. Construct the prompt by wrapping `$ARGUMENTS` in a review-focused template:

```
You are performing a focused code review. Focus: <$ARGUMENTS>. Instructions: - Prioritize reviewing diff/changed files if available. - Report only issues relevant to the requested focus. - For each issue provide: severity (low/medium/high/critical), category, file path, line numbers, description, evidence, and suggested fix. - If no issues are found, state that explicitly. - Output your findings as JSON with keys: summary (string), overall_severity (none/low/medium/high/critical), findings (array of objects), stats (object with files_reviewed count, findings_count, and diff_scope string).
```

Then run:

**If `config.review.useOutputSchema` is `true`**, include `--output-schema` to enforce structured JSON output via the API:
```bash
codex exec --sandbox workspace-write --json --output-schema "C:/Users/RJ/.claude/codex-agent/lib/review-schema.json" -C "<current-working-directory>" --output-last-message "<lastMsg-temp-path>" "<review-prompt>"
```

**If `config.review.useOutputSchema` is `false`** (or not set), omit `--output-schema`:
```bash
codex exec --sandbox workspace-write --json -C "<current-working-directory>" --output-last-message "<lastMsg-temp-path>" "<review-prompt>"
```

Include `-m "<codexModel>"` if `codexModel` from config is not null.

---

**Enhanced error handling** — classify errors into 7 categories (applies to all Step 6 paths):

1. **Not installed** (fallback for Step 0): If output contains "codex: not found", "not recognized as", or "'codex' is not recognized":
   - Error code: `NOT_INSTALLED`
   - Tell the user to install Codex CLI (`npm install -g @openai/codex`) and stop.

2. **Auth expired**: If output contains "unauthorized", "auth", "token expired", "API key", "401", or "api_key":
   - Error code: `AUTH_EXPIRED`
   - Tell the user: "Authentication failed. Please run `codex auth` to re-authenticate."
   - Stop.

3. **Rate limited**: If output contains "rate limit", "429", "too many requests", or "rate_limit":
   - Error code: `RATE_LIMITED`
   - Tell the user: "Rate limited by the API. Wait a moment and try again, or reduce the task scope."
   - Stop.

4. **Model not found**: If output contains "model not found", "invalid model", "does not exist", or "model_not_found":
   - Error code: `MODEL_NOT_FOUND`
   - Tell the user: "The configured model was not found. Check your `codexModel` setting: `/codex-agent:config defaults.codexModel=null` to reset to default."
   - Stop.

5. **Network error**: If output contains "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", or "network":
   - Error code: `NETWORK_ERROR`
   - Tell the user: "Network error — check your internet connection and try again."
   - Stop.

6. **Timeout**: If the Bash command exceeded its timeout:
   - Error code: `TIMEOUT`
   - Tell the user: "The task timed out after [N] seconds. Consider increasing `defaults.timeout` via `/codex-agent:config defaults.timeout=600000`, or break the task into smaller pieces."
   - Stop.

7. **Other**: For any other error:
   - Error code: `UNKNOWN`
   - Report the error text but continue to parse whatever output was captured.

For error cases 1-6, record the error in the session log (see Step 9) before stopping.

## Step 6e: Resolve Actual Model Name

Determine the actual model that was used for this dispatch. This is needed for accurate reporting — agents must NEVER fabricate model names.

**If `codexModel` from config is not null**: The model name is that value.

**If `codexModel` is null** (default — Codex CLI uses its own configured default): Read the Codex CLI config to discover the actual model:

```bash
node -e "var fs = require('fs'); var os = require('os'); var path = require('path'); var tomlPath = path.join(os.homedir(), '.codex', 'config.toml'); try { var text = fs.readFileSync(tomlPath, 'utf-8'); var match = text.match(/^model\s*=\s*\"([^\"]+)\"/m); console.log(JSON.stringify({ model: match ? match[1] : 'unknown (not in config.toml)', source: 'codex-config' })); } catch(e) { console.log(JSON.stringify({ model: 'unknown (config.toml not found)', source: 'fallback' })); }"
```

Save the resolved model name as `RESOLVED_MODEL` for use in Step 10.

**Also set `ACTUAL_AGENT`**: Based on Step 4 routing result:
- If routing agent was `"codex"` or `"either"`: `ACTUAL_AGENT = "Codex CLI (model: <RESOLVED_MODEL>)"`
- If routing agent was `"claudeSubagent"`: `ACTUAL_AGENT = "Codex CLI (model: <RESOLVED_MODEL>)"` — dispatch always uses Codex CLI regardless of routing suggestion

## Step 7: Read Results

1. Read the last-message temp file (the `lastMsg` path from Step 5). This contains Codex's final response text.
2. Save the stdout from Step 6 to the `stdout` temp file path.

## Step 8: Parse Output

Run the parser on both pieces of output:

```bash
node -e "var p = require('C:/Users/RJ/.claude/codex-agent/lib/parse-output.js'); var fs = require('fs'); var lastMsg = ''; try { lastMsg = fs.readFileSync('<lastMsg-temp-path>', 'utf-8'); } catch(e) {} var stdout = ''; try { stdout = fs.readFileSync('<stdout-temp-path>', 'utf-8'); } catch(e) {} var result = p.parseCodexOutput(stdout, lastMsg); console.log(JSON.stringify(result));"
```

Parse the JSON output to get: `result`, `usage`, `filesChanged`, `status`, `sessionId`.

Save the `sessionId` value (may be null) — it can be used by `/codex-agent:discuss` for session resume.

## Step 9: Record Usage & Save Session

Record the token usage from this dispatch:

```bash
node -e "var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); ut.recordUsage('C:/Users/RJ/.claude/codex-agent/usage-ledger.json', 'codex', { inputTokens: <INPUT_TOKENS>, outputTokens: <OUTPUT_TOKENS>, estimatedCost: <COST> }); console.log('recorded');"
```

Replace `<INPUT_TOKENS>`, `<OUTPUT_TOKENS>`, and `<COST>` with the actual values from Step 8.

### Step 9b: Dashboard Bridge

If the config has `dashboard.enabled` set to `true` and `dashboard.conversationsDir` is set (not null):

```bash
node -e "var db = require('C:/Users/RJ/.claude/codex-agent/lib/dashboard-bridge.js'); var convId = db.getConversationId(); db.ensureConversation(process.argv[1], convId); db.writeDispatchMessages(process.argv[1], convId, { task: process.argv[2], result: process.argv[3], usage: JSON.parse(process.argv[4]) }); console.log('dashboard: written to ' + convId);" "<conversationsDir>" "$ARGUMENTS" "<result-text>" "<usage-json>"
```

Replace `<conversationsDir>` with the value from config, `<result-text>` with the Codex response, and `<usage-json>` with a JSON string of `{ inputTokens, outputTokens, estimatedCost }`.

If this step fails, log the error but do not stop — dashboard integration is optional.

### Step 9c: History Recording

If the config has `routing.historyEnabled` set to `true` (or not explicitly `false`):

```bash
node -e "var rh = require('C:/Users/RJ/.claude/codex-agent/lib/routing-history.js'); rh.recordOutcome('C:/Users/RJ/.claude/codex-agent/routing-history.json', JSON.parse(process.argv[1])); console.log('history: recorded');" "<outcome-json>"
```

Where `<outcome-json>` is a JSON string containing:
- `timestamp`: current ISO timestamp
- `taskDescription`: the original `$ARGUMENTS` (truncated to 200 chars)
- `complexityScore`: from Step 4 routing result (or 0 if not available)
- `agent`: "codex"
- `routedTo`: the agent from Step 4 routing result
- `outcome`: "success" if status is "completed", "error" otherwise
- `tokensUsed`: total tokens from Step 8
- `durationMs`: elapsed time of the Codex execution
- `filesChanged`: count of files changed from Step 8

If this step fails, log the error but do not stop — history recording is optional.

### Step 9d: Cache Store

If the config has `cache.enabled` set to `true` and the dispatch was successful (status is "completed"), store the result in cache using the key from Step 3b:

```bash
node -e "var c = require('C:/Users/RJ/.claude/codex-agent/lib/cache.js'); var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var maxEntries = config.cache ? config.cache.maxEntries : 100; c.store('C:/Users/RJ/.claude/codex-agent/cache', process.argv[1], JSON.parse(process.argv[2]), maxEntries); console.log('cache: stored');" "<cache-key>" "<entry-json>"
```

Where `<entry-json>` is a JSON string with the cache entry shape:
- `key`: the cache key from Step 3b
- `taskDescription`: the original `$ARGUMENTS`
- `workingDir`: the current working directory
- `result`: the Codex response text
- `usage`: `{ inputTokens, outputTokens, estimatedCost }` from Step 8
- `filesChanged`: array of files changed from Step 8
- `status`: "completed"
- `cachedAt`: `Date.now()` epoch milliseconds
- `model`: the RESOLVED_MODEL from Step 6e (the actual model, not null)

If this step fails, log the error but do not stop — caching is optional.

### Step 9e: Save Session

Then save the session log with all collected data. Build the session JSON with:
- `routing`: the routing result from Step 4 (agent, confidence, reason)
- `model`: the RESOLVED_MODEL from Step 6e (the actual model, not null)
- `rounds`: a single round with the task prompt, Codex response (truncated to 2000 chars), usage, and timestamp
- `result`: `{ status, filesChanged, usage }` from Step 8
- `error`: `{ code, message }` if an error occurred, or `null`

```bash
node -e "var sl = require('C:/Users/RJ/.claude/codex-agent/lib/session-logger.js'); var session = JSON.parse(process.argv[1]); sl.saveSession('C:/Users/RJ/.claude/codex-agent/sessions', session); console.log('session saved: ' + session.id);" "<SESSION_JSON>"
```

Where `<SESSION_JSON>` is the complete session object serialized as a JSON string. Build this from the session created in Step 5, populated with:
- `session.model` = the RESOLVED_MODEL from Step 6e (the actual model, not null)
- `session.routing` = `{ agent, confidence, reason }` from Step 4
- `session.rounds` = one entry with `{ prompt: "$ARGUMENTS", response: "<result text truncated to 2000>", usage: <usage from Step 8>, timestamp: "<ISO>" }`
- `session.result` = `{ status: "<status>", filesChanged: [<files>], usage: <usage> }`
- `session.error` = `null` (or `{ code: "<ERROR_CODE>", message: "<error text>" }` if an error occurred)
- `session.sessionId` = the Codex session ID from Step 8 parse result (may be null)

**Note**: If the session JSON is large, you can alternatively save it by writing to a temp file and having session-logger read it:

```bash
node -e "var sl = require('C:/Users/RJ/.claude/codex-agent/lib/session-logger.js'); var fs = require('fs'); var session = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); sl.saveSession('C:/Users/RJ/.claude/codex-agent/sessions', session); console.log('session saved: ' + session.id);" "<TEMP_FILE_WITH_SESSION_JSON>"
```

## Step 10: Return Summary

Present the results to the user. **Use a review-specific format if `IS_REVIEW` is `true`**, otherwise use the standard format.

### Standard Format (IS_REVIEW is false)

---

### Codex Dispatch Result

**Status**: [completed/error/unknown]
**Reviewed by**: [ACTUAL_AGENT from Step 6e — e.g. "Codex CLI (model: gpt-5.2)"]

**Response**:
[The result text from Codex]

**Files Changed**: [list of files, or "none"]

**Token Usage**:
- Input: [N] tokens
- Output: [N] tokens
- Total: [N] tokens
- Estimated Cost: $[X.XX]

**Budget**: Session [X]% | Lifetime [X]%

**Session ID**: [Codex session ID from Step 8, or session log ID from Step 5 if Codex session ID is null]

---

### Review Format (IS_REVIEW is true)

**Schema enforcement note**: Step 6c output (with `--output-schema`) is API-enforced JSON — the parse is guaranteed to succeed. Step 6b output is prompt-instructed (best-effort) — the JSON may be malformed or missing. `parseReviewOutput()` handles both cases gracefully, filling defaults for any missing fields.

First, attempt to parse the result as structured review JSON. Try the last-message file first, then fall back to the captured stdout (the stdout fallback handles cases where `--output-last-message` is empty or unavailable, e.g. older Codex CLI versions):

```bash
node -e "var p = require('C:/Users/RJ/.claude/codex-agent/lib/parse-output.js'); var fs = require('fs'); var resultText = ''; try { resultText = fs.readFileSync('<lastMsg-temp-path>', 'utf-8'); } catch(e) {} if (!resultText || !resultText.trim()) { try { resultText = fs.readFileSync('<stdout-temp-path>', 'utf-8'); } catch(e2) {} } var review = p.parseReviewOutput(resultText); console.log(JSON.stringify({ parsed: review !== null, review: review }));"
```

**If structured JSON was parsed successfully**, present:

---

### Codex Review Result

**Status**: [completed/error/unknown] | **Severity**: [overall_severity]
**Reviewed by**: [ACTUAL_AGENT from Step 6e — e.g. "Codex CLI (model: gpt-5.2)"]

**Summary**: [summary text]

**Findings** ([N] issues):

| # | Severity | Category | File | Description |
|---|----------|----------|------|-------------|
| [id] | [severity] | [category] | [file_path]:[line_start] | [title] |

[For each finding, show a brief expandable detail if needed]

**Stats**: [files_reviewed] files reviewed | [diff_scope]

**Token Usage**: Input: [N] | Output: [N] | Total: [N] | Cost: $[X.XX]
Note: `codex exec review` may report 0 tokens (upstream bug) — the review result is still valid.

**Budget**: Session [X]% | Lifetime [X]%

---

**If structured JSON was NOT parsed**, fall back to the standard format above but add a note:
> Review output was not in structured JSON format. Showing raw result.

Then show the raw result text with the standard format fields.

---

## Important Notes

- Always use forward slashes in file paths passed to `node -e`, even on Windows.
- Never use backtick characters inside `node -e` command strings — they cause shell escaping issues on Windows.
- Use `/\r?\n/` for line splitting to handle both Unix and Windows line endings.
- Use `os.tmpdir()` for temp files — never hardcode temp paths.
- If parse-output returns zero tokens but Codex clearly ran, note that some Codex versions may not emit usage in JSONL. The result text is still valid.
