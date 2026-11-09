---
name: codex-agent:parallel
description: Dispatch a task to multiple Codex models in parallel
argument-hint: <task description>
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

# Codex Agent — Parallel Dispatch

You are dispatching a coding task to multiple Codex models in parallel to compare their results. Follow these steps precisely.

## Input

The task to dispatch: `$ARGUMENTS`

## Step 0: Preflight Check

Verify that Codex CLI is installed:

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
> Please provide a task description. Usage: `/codex-agent:parallel <task description>`
Then stop.

## Step 2: Load Configuration

Read the config file at `~/.claude/codex-agent/config.json`.

Extract these values:
- `defaults.codexModel` (default: null)
- `defaults.timeout` (default: 300000)
- `defaults.codexProfile` (default: `"lean"`)

## Step 2b: Select Codex Profile

Same rule as `/codex-agent:dispatch` Step 2b: if the task text starts with `--full`, set `PROFILE="full"` and use the task text without that prefix from here on; otherwise `PROFILE` = `defaults.codexProfile`. If `PROFILE` is `"lean"` and `test -f "${CODEX_HOME:-$HOME/.codex}/lean.config.toml"` (Codex reads profiles from `$CODEX_HOME`, default `~/.codex`) fails, warn the user and use `"full"`. Both tasks get the same `profile`, so the comparison is between models only.

## Step 2c: Write the Task File

**Never put the task text on a shell command line or into a JavaScript string literal.** Write it to a file:

```bash
node -e "var os = require('os'); var path = require('path'); var dir = path.join(os.tmpdir(), 'codex-agent'); require('fs').mkdirSync(dir, { recursive: true }); console.log(path.join(dir, 'task-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt'));"
```

Write the task text to that path (`<TASK_FILE>`) with the **Write** tool: exactly the text given to this command, minus a `--full` prefix (Step 2b). Use the original text you passed in, **not** the copy shown at the top of this file: the harness that loads this command shows every `!` in the arguments as `\!`. The original text is the `args` of your Skill call. If you only have that escaped copy (for example the command was typed by the user and their raw text is not in the conversation), undo the escaping by replacing every `\!` with `!`, and tell the user you did; this changes only a literal `\!` in the original, which is rare.

Why: pasted code with `"`, a backtick or `$(...)` would break a command line or run part of it, and a task with quotes, backslashes or newlines turns into broken JavaScript when pasted into the Step 5 script. The Step 5 script and Step 8 read `<TASK_FILE>`; `parallel.js` sends the text to each Codex process on stdin.

## Step 3: Plan-Usage Guard

Same guard as `/codex-agent:dispatch` Step 3:

```bash
node "C:/Users/RJ/.claude/codex-agent/lib/plan-usage.js" guard
```

- `"ok"`: proceed. `"unknown"`: note that plan usage is unavailable and proceed.
- `"warn"`: warn that plan usage is high ([reasons]) and that a parallel dispatch runs two Codex calls; ask the user whether to proceed.
- `"ask"`: use AskUserQuestion ("Codex plan usage is high: [reasons]. Run two Codex calls anyway?") with **Proceed** / **Cancel**; stop unless Proceed.

(The old token-budget check was removed on 2026-11-09; its limits never triggered.)

## Step 4: Select Models

Determine which models to run in parallel:

**If `defaults.codexModel` is set to a non-null value**:
- Model A = the configured model
- Model B = default (no `-m` flag — Codex's built-in default)
- Tell the user: "Running parallel dispatch: **[configured model]** vs **Codex default**"

**If `defaults.codexModel` is null** (no model configured):
- Use AskUserQuestion to ask which models to compare:
  - Question: "Which models should we compare in parallel?"
  - Options:
    1. **o3-mini + o4-mini** — Compare two mini models
    2. **o4-mini + gpt-4.1** — Compare mini vs full model
    3. **o3-mini + gpt-4.1** — Compare mini vs full model
  - If the user chooses "Other", parse their custom input for model names. Accept a name only if it matches `^[A-Za-z0-9._:/-]+$` (e.g. `gpt-5.2`, `o4-mini`); otherwise say why and ask again. The names are written into the Step 5 script, so nothing else may get through.

Save the two model names (use `null` for "Codex default" / no `-m` flag).

## Step 5: Write and Run Parallel Script

Write a temporary Node.js script that uses `parallel.js` to spawn concurrent Codex processes:

```bash
node -e "var os = require('os'); var path = require('path'); var dir = path.join(os.tmpdir(), 'codex-agent'); require('fs').mkdirSync(dir, { recursive: true }); console.log(path.join(dir, 'parallel-' + Date.now() + '.js'));"
```

Save the temp script path. Then write the script using the Write tool:

```javascript
var p = require('C:/Users/RJ/.claude/codex-agent/lib/parallel.js');
var parser = require('C:/Users/RJ/.claude/codex-agent/lib/parse-output.js');
var fs = require('fs');

// The task text comes from the Step 2c file, never from a string literal in this script.
var taskPrompt = fs.readFileSync(<TASK_FILE_PATH>, 'utf-8');

var tasks = [
  { prompt: taskPrompt, model: <MODEL_A_OR_NULL>, workingDir: <CWD>, timeout: <TIMEOUT_MS>, profile: <PROFILE> },
  { prompt: taskPrompt, model: <MODEL_B_OR_NULL>, workingDir: <CWD>, timeout: <TIMEOUT_MS>, profile: <PROFILE> }
];

p.dispatchParallel(tasks, {}, function(err, results) {
  if (err) {
    console.log(JSON.stringify({ error: err.message || String(err) }));
    process.exit(1);
  }
  // Parse each result's stdout through parse-output
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.stdout) {
      var parsed = parser.parseCodexOutput(r.stdout, r.result);
      r.parsedResult = parsed.result;
      r.parsedUsage = parsed.usage;
      r.parsedFilesChanged = parsed.filesChanged;
      r.parsedStatus = parsed.status || r.status;
      r.parsedSessionId = parsed.sessionId; // Codex thread id, for the plan-usage line in Step 9
    } else {
      r.parsedResult = r.result || '';
      r.parsedUsage = r.usage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      r.parsedFilesChanged = r.filesChanged || [];
      r.parsedStatus = r.status || 'unknown';
    }
    // Clean up stdout to reduce output size
    delete r.stdout;
  }
  console.log(JSON.stringify(results));
});
```

Replace `<TASK_FILE_PATH>` (the Step 2c path as a quoted string with forward slashes, e.g. `'C:/Users/RJ/AppData/Local/Temp/codex-agent/task-1762650000000-3f2a.txt'`), `<MODEL_A_OR_NULL>`, `<MODEL_B_OR_NULL>`, `<CWD>` (quoted, forward slashes), `<TIMEOUT_MS>` and `<PROFILE>` (quoted, e.g. `'lean'`) with actual values. Write each model as a quoted string (`'o4-mini'`) or `null` (not a string) for Codex's default; only names that passed the Step 4 check go in. The task text itself never appears in the script.

Both tasks run `workspace-write` (and `parallel.js` passes `--skip-git-repo-check`, so they also run outside a git repository). If `git -C "<current-working-directory>" rev-parse --is-inside-work-tree` does not print `true` (it fails outside a repository, and prints `false` inside a `.git` folder), tell the user in one line before running: "Not in a git worktree: Codex can write here, and its changes can't be undone with git."

Run the script:

```bash
node "<temp-script-path>"
```

**Timeout**: Use the configured timeout + 30 seconds (to allow for startup overhead) as the Bash timeout.

## Step 6: Parse Results

Parse the JSON output from the script. Each element in the array corresponds to a model.

For each result, extract:
- `parsedResult` — the response text
- `parsedUsage` — `{ inputTokens, cachedInputTokens, outputTokens, estimatedCost }`
- `parsedFilesChanged` — array of changed files
- `parsedStatus` — "completed", "error", "timeout"
- `durationMs` — execution time
- `model` — which model was used
- `error` — error message if any

## Step 7: Record Usage

Record the **combined** usage from all parallel runs:

```bash
node -e "var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); ut.recordUsage('C:/Users/RJ/.claude/codex-agent/usage-ledger.json', 'codex', { inputTokens: <TOTAL_INPUT>, cachedInputTokens: <TOTAL_CACHED_INPUT>, outputTokens: <TOTAL_OUTPUT>, estimatedCost: <TOTAL_COST> }); console.log('recorded');"
```

Sum `inputTokens`, `cachedInputTokens`, `outputTokens`, and `estimatedCost` across all parallel results.

## Step 8: Create and Save Session

Create a session and save it:

```bash
node -e "var sl = require('C:/Users/RJ/.claude/codex-agent/lib/session-logger.js'); var task = require('fs').readFileSync(process.argv[1], 'utf-8'); var session = sl.createSession('parallel', task); console.log(JSON.stringify(session));" "<TASK_FILE>"
```

Populate the session with:
- `session.type` = "parallel"
- `session.model` = comma-separated list of models used
- `session.rounds` = one entry per model with `{ prompt, response (truncated to 2000), usage, timestamp }`
- `session.result` = combined result with status and total usage
- `session.error` = null (or error if all models failed)

Save the session using the same pattern as dispatch.md Step 9e.

## Step 9: Present Results

Present a side-by-side comparison:

---

### Parallel Dispatch Results

**Task**: [the original task description]

#### Model A: [model-name or "Codex default"]
- **Status**: [completed/error/timeout]
- **Response**: [response text]
- **Files Changed**: [list or "none"]
- **Tokens**: [N] | **Cost**: $[X.XX] | **Time**: [N]s

#### Model B: [model-name or "Codex default"]
- **Status**: [completed/error/timeout]
- **Response**: [response text]
- **Files Changed**: [list or "none"]
- **Tokens**: [N] | **Cost**: $[X.XX] | **Time**: [N]s

**Comparison**:
- **Faster**: [model] ([N]s vs [N]s)
- **Cheaper**: [model] ($[X.XX] vs $[X.XX])
- **More Complete**: [your assessment based on response quality]

**Combined Token Usage**:
- Input: [N] tokens
- Output: [N] tokens
- Total: [N] tokens
- Estimated Cost: $[X.XX]

**Codex plan**: [the `line` printed by `node "C:/Users/RJ/.claude/codex-agent/lib/plan-usage.js" line <thread id of the call that finished last>` (the thread id is in each result's parsed output); free, read from that call's session record, e.g. "5h 12% (resets 06:37) · week 23% (resets Wed 11 Nov 09:40)"]

**Session ID**: [session id]

---

## Important Notes

- The task travels in `<TASK_FILE>` (Step 2c): never paste it into a command line or the Step 5 script.
- Always use forward slashes in file paths passed to `node -e`, even on Windows.
- Never use backtick characters inside `node -e` command strings.
- Parallel dispatch uses more tokens than a single dispatch — it counts twice against the Codex plan's 5-hour and weekly windows.
- The temp script file can be cleaned up after execution but is left for debugging if needed.
- If one model fails but the other succeeds, still present both results — the user can see which model performed better.
