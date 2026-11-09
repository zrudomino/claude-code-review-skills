---
name: codex-agent:config
description: View or update Codex agent skill configuration
argument-hint: [setting=value]
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

# Codex Agent — Configuration

View or update the Codex agent skill configuration.

## Input

Arguments: `$ARGUMENTS`

## Step 1: Load Current Config

Read the config file at `~/.claude/codex-agent/config.json`.

If the file does not exist, create the directory and write the default config:
```json
{
  "budgets": {
    "codex": {
      "maxTokensPerSession": 500000,
      "maxCostPerSession": 5.00,
      "maxTokensTotal": 5000000,
      "maxCostTotal": 50.00
    },
    "claudeSubagent": {
      "maxTokensPerSession": 200000,
      "maxCostPerSession": 3.00,
      "maxTokensTotal": 2000000,
      "maxCostTotal": 30.00
    }
  },
  "discussion": {
    "softCapRounds": 5,
    "hardCapRounds": 8
  },
  "defaults": {
    "codexModel": null,
    "approvalPolicy": "full-auto",
    "sandbox": "workspace-write",
    "preferredAgent": "auto",
    "timeout": 300000,
    "codexProfile": "lean"
  },
  "routing": {
    "largeContextThreshold": 5000,
    "budgetWarningPercent": 80,
    "historyEnabled": true,
    "historyMaxEntries": 500
  },
  "cache": {
    "enabled": true,
    "ttlMs": 3600000,
    "maxEntries": 100
  },
  "dashboard": {
    "enabled": false,
    "conversationsDir": null
  }
}
```

Then proceed based on the arguments.

## Step 2: Route by Arguments

### Case A: No arguments (show config)

If `$ARGUMENTS` is empty or missing, display the current configuration as formatted tables:

---

### Codex Agent — Configuration

**Plan-usage guard** (Codex plan quota as in Codex's `/status`; see `/codex-agent:usage`)

| Setting | Value |
|---------|-------|
| Warn at (`quota.warnPercent`) | [N, default 80]% |
| Ask before a Codex call at (`quota.askPercent`) | [N, default 95]% |

**Budgets — Codex** (recorded for history only: the budget check was removed on 2026-11-09)

| Setting | Value |
|---------|-------|
| Max Tokens Per Session | [N] |
| Max Cost Per Session | $[X.XX] |
| Max Tokens Total (Lifetime) | [N] |
| Max Cost Total (Lifetime) | $[X.XX] |

**Budgets — Claude Subagent**

| Setting | Value |
|---------|-------|
| Max Tokens Per Session | [N] |
| Max Cost Per Session | $[X.XX] |
| Max Tokens Total (Lifetime) | [N] |
| Max Cost Total (Lifetime) | $[X.XX] |

**Discussion**

| Setting | Value |
|---------|-------|
| Soft Cap Rounds | [N] |
| Hard Cap Rounds | [N] |

**Defaults**

| Setting | Value |
|---------|-------|
| Codex Model | [value or "not set"] |
| Approval Policy | [value] |
| Sandbox | [value] |
| Preferred Agent | [value] |
| Timeout | [N]ms ([N/1000]s) |

**Routing**

| Setting | Value |
|---------|-------|
| Large Context Threshold | [N] chars |
| Budget Warning Percent | [N]% |
| History Enabled | [true/false] |
| History Max Entries | [N] |

**Cache**

| Setting | Value |
|---------|-------|
| Enabled | [true/false] |
| TTL | [N]ms ([N/1000/60] minutes) |
| Max Entries | [N] |

**Dashboard**

| Setting | Value |
|---------|-------|
| Enabled | [true/false] |
| Conversations Dir | [path or "not set"] |

---

After the tables, show this help text:

> **To update a setting**: `/codex-agent:config <dotted.key>=<value>`
>
> Examples:
> - `/codex-agent:config defaults.timeout=600000`
> - `/codex-agent:config defaults.codexModel=gpt-6.1-sol` (a `slug` from `codex debug models`)
> - `/codex-agent:config quota.warnPercent=85`
> - `/codex-agent:config routing.budgetWarningPercent=90`
> - `/codex-agent:config cache.enabled=false`
> - `/codex-agent:config cache.ttlMs=7200000`
> - `/codex-agent:config dashboard.enabled=true`
> - `/codex-agent:config dashboard.conversationsDir=C:/AI-AI CONVERSATION PROJECT/conversations`
> - `/codex-agent:config routing.historyEnabled=false`
>
> **To reset all settings**: `/codex-agent:config reset`

Then stop.

### Case B: `reset` argument

If `$ARGUMENTS` is `reset`:

1. Use AskUserQuestion to confirm: "This will reset all Codex agent configuration to defaults. Are you sure?"
   - Options: "Yes, reset to defaults" / "Cancel"
2. If confirmed, write the default config (shown above) to `~/.claude/codex-agent/config.json` using an atomic write:
   ```bash
   node -e "var fs = require('fs'); var path = require('path'); var config = { budgets: { codex: { maxTokensPerSession: 500000, maxCostPerSession: 5.00, maxTokensTotal: 5000000, maxCostTotal: 50.00 }, claudeSubagent: { maxTokensPerSession: 200000, maxCostPerSession: 3.00, maxTokensTotal: 2000000, maxCostTotal: 30.00 } }, discussion: { softCapRounds: 5, hardCapRounds: 8 }, defaults: { codexModel: null, approvalPolicy: 'full-auto', sandbox: 'workspace-write', preferredAgent: 'auto', timeout: 300000, codexProfile: 'lean' }, routing: { largeContextThreshold: 5000, budgetWarningPercent: 80, historyEnabled: true, historyMaxEntries: 500 }, cache: { enabled: true, ttlMs: 3600000, maxEntries: 100 }, dashboard: { enabled: false, conversationsDir: null } }; var configPath = 'C:/Users/RJ/.claude/codex-agent/config.json'; var tmpPath = configPath + '.tmp-' + process.pid; fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8'); fs.renameSync(tmpPath, configPath); console.log('done');"
   ```
3. Respond: "Configuration reset to defaults."
4. If cancelled, respond: "Reset cancelled." and stop.

### Case C: `key=value` argument

If `$ARGUMENTS` contains `=`:

1. Parse the argument as `key=value` where the key is a dotted path (e.g., `defaults.timeout=600000`).

2. **Validate the key exists**: Run this to check:
   ```bash
   node -e "var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var key = process.argv[1]; var parts = key.split('.'); var obj = config; for (var i = 0; i < parts.length - 1; i++) { if (obj[parts[i]] === undefined || obj[parts[i]] === null || typeof obj[parts[i]] !== 'object') { console.log(JSON.stringify({ valid: false, reason: 'Unknown key: ' + key })); process.exit(0); } obj = obj[parts[i]]; } var lastKey = parts[parts.length - 1]; if (obj[lastKey] === undefined) { console.log(JSON.stringify({ valid: false, reason: 'Unknown key: ' + key })); } else { console.log(JSON.stringify({ valid: true, currentValue: obj[lastKey], type: typeof obj[lastKey] === 'number' ? 'number' : obj[lastKey] === null ? 'null' : typeof obj[lastKey] })); }" "<THE_KEY_PART>"
   ```

   If `valid` is `false`, respond with: "Unknown config key: `<key>`. Run `/codex-agent:config` to see all available settings." Then stop.

3. **Type coercion**: Convert the value based on context:
   - If `currentValue` is a number or the key name contains "token", "cost", "timeout", "threshold", "percent", "round" → parse as number (parseFloat)
   - If value is `"null"` → convert to `null`
   - If value is `"true"` → convert to `true`
   - If value is `"false"` → convert to `false`
   - Otherwise → keep as string

4. **Validation rules** (check AFTER type coercion):
   - Any budget value (keys under `budgets.`) that is a number must be > 0
   - `routing.budgetWarningPercent` must be between 1 and 100
   - `discussion.softCapRounds` must be less than `discussion.hardCapRounds` (read the other value from config to compare)
   - `discussion.hardCapRounds` must be greater than `discussion.softCapRounds`
   - `defaults.preferredAgent` must be one of: `"auto"`, `"codex"`, `"claudeSubagent"`
   - `defaults.approvalPolicy` must be one of: `"full-auto"`, `"suggest"`, `"ask"`
   - `defaults.timeout` must be an integer from 10000 to 2147483647 (Node's timer limit: a larger value fires after 1 ms and kills the Codex call)
   - `defaults.codexProfile` must be `"lean"` (use `~/.codex/lean.config.toml`, the default when the key is missing) or `"full"` (the user's normal Codex config). A single call can still override lean with a leading `--full` in its arguments.
   - `defaults.codexModel` must be `null` or a **string** model slug matching `^[A-Za-z0-9._:/-]+$` (the writer in step 5 keeps it a string even when it looks like a number) (dispatch, discuss and parallel put it on a command line or into `-m`, and refuse anything else). Also run `codex debug models` (local, no tokens) and, if the value is not one of its `slug`s with `visibility` `list`, warn "not in Codex's model catalog" but still save it.
   - `quota.warnPercent` and `quota.askPercent` must be between 1 and 100, and `quota.warnPercent` must be less than `quota.askPercent` (used by the plan-usage guard in dispatch, discuss and parallel; defaults 80 and 95 when missing)
   - `cache.ttlMs` must be >= 60000 (1 minute minimum)
   - `cache.maxEntries` must be >= 1
   - `routing.historyMaxEntries` must be >= 10
   - `dashboard.conversationsDir` must be a string or null
   - If validation fails, report the specific rule that was violated and stop.

5. **Write the updated config** using atomic write:
   ```bash
   node -e "var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var key = process.argv[1]; var value = process.argv[2]; var parts = key.split('.'); var obj = config; for (var i = 0; i < parts.length - 1; i++) { obj = obj[parts[i]]; } var lastKey = parts[parts.length - 1]; var oldValue = obj[lastKey]; var newValue = value; if (value === 'null') { newValue = null; } else if (value === 'true') { newValue = true; } else if (value === 'false') { newValue = false; } else if (key !== 'defaults.codexModel' && !isNaN(Number(value)) && value.trim() !== '') { newValue = Number(value); } obj[lastKey] = newValue; var configPath = 'C:/Users/RJ/.claude/codex-agent/config.json'; var tmpPath = configPath + '.tmp-' + process.pid; fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8'); fs.renameSync(tmpPath, configPath); console.log(JSON.stringify({ oldValue: oldValue, newValue: newValue }));" "<THE_KEY_PART>" "<THE_VALUE_PART>"
   ```

6. **Confirm the change**:
   > Updated `<key>`:
   > - Before: `<old value>`
   > - After: `<new value>`

Then stop.

### Case D: Unrecognized arguments

If `$ARGUMENTS` doesn't match any of the above patterns, respond with:

> Unrecognized arguments. Usage:
> - `/codex-agent:config` — view all settings
> - `/codex-agent:config <key>=<value>` — update a setting
> - `/codex-agent:config reset` — restore defaults
>
> Run `/codex-agent:config` to see all available setting keys.

## Important Notes

- Always use forward slashes in file paths passed to `node -e`, even on Windows.
- Never use backtick characters inside `node -e` command strings.
- Use atomic writes (temp file + rename) when modifying config.json.
- The config file path is always `~/.claude/codex-agent/config.json` (expanded: `C:/Users/RJ/.claude/codex-agent/config.json`).
