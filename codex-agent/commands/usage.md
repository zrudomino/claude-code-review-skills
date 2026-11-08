---
name: codex-agent:usage
description: Show token usage and budget status for all agents
allowed-tools:
  - Bash
  - Read
---

# Codex Agent — Usage Dashboard

Display current token usage, cost tracking, and budget status for all agents (Codex and Claude subagent).

## Step 1: Load Data

Read the config file at `~/.claude/codex-agent/config.json`.

Then check if the usage ledger exists at `~/.claude/codex-agent/usage-ledger.json`. If it does not exist, report:

> **No usage data yet.** No dispatches have been recorded. Run `/codex-agent:dispatch <task>` to get started.

Then stop.

## Step 2: Gather Budget Status

Run a single node command to load ledger, config, and check budget for both agents:

```bash
node -e "var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); var fs = require('fs'); var config = JSON.parse(fs.readFileSync('C:/Users/RJ/.claude/codex-agent/config.json', 'utf-8')); var ledger = ut.loadLedger('C:/Users/RJ/.claude/codex-agent/usage-ledger.json'); var codex = ut.checkBudget(ledger, config, 'codex'); var claude = ut.checkBudget(ledger, config, 'claudeSubagent'); console.log(JSON.stringify({ ledger: ledger, codex: codex, claude: claude, config: config }));"
```

Parse the JSON output to get all data needed for display.

## Step 3: Format Output

Present the data in this format:

---

### Codex Agent — Usage Dashboard

**Session** (started: [session startedAt timestamp])

| Agent | Dispatches | Input Tokens | Output Tokens | Total Tokens | Est. Cost | Budget Used | Status |
|-------|-----------|-------------|--------------|-------------|----------|------------|--------|
| Codex | [N] | [N] | [N] | [N] | $[X.XX] | [X.X]% | [status] |
| Claude Subagent | [N] | [N] | [N] | [N] | $[X.XX] | [X.X]% | [status] |

**Lifetime**

| Agent | Dispatches | Input Tokens | Output Tokens | Total Tokens | Est. Cost | Budget Used | Status |
|-------|-----------|-------------|--------------|-------------|----------|------------|--------|
| Codex | [N] | [N] | [N] | [N] | $[X.XX] | [X.X]% | [status] |
| Claude Subagent | [N] | [N] | [N] | [N] | $[X.XX] | [X.X]% | [status] |

**Configuration**

| Setting | Value |
|---------|-------|
| Preferred Agent | [auto/codex/claudeSubagent] |
| Budget Warning Threshold | [N]% |
| Large Context Threshold | [N] chars |
| Codex Session Limit | [N] tokens / $[X.XX] |
| Codex Lifetime Limit | [N] tokens / $[X.XX] |
| Claude Session Limit | [N] tokens / $[X.XX] |
| Claude Lifetime Limit | [N] tokens / $[X.XX] |
| Discussion Soft Cap | [N] rounds |
| Discussion Hard Cap | [N] rounds |

---

## Status Rules

Determine the status column value for each agent using the **higher** of sessionPercent and lifetimePercent:
- **OK** — below the `budgetWarningPercent` threshold (default 80%)
- **Warning** — at or above the warning threshold but still `allowed: true`
- **Exhausted** — `allowed: false`

## Notes

Include these notes at the bottom:

> **Note on Claude subagent tracking**: Claude subagent usage is not yet tracked automatically. The counters shown above reflect only manually recorded usage. Automatic tracking will be added in a future phase.
>
> **To reset session counters**: Run `node -e "require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js').resetSession('C:/Users/RJ/.claude/codex-agent/usage-ledger.json')"`
>
> **To adjust budget limits**: Edit `~/.claude/codex-agent/config.json` and modify the values under `budgets`.
