---
name: codex-agent:usage
description: Show Codex plan usage (5-hour, weekly and monthly %, as in Codex's /status) and recorded dispatch history
allowed-tools:
  - Bash
  - Read
---

# Codex Agent — Usage

Show the Codex plan usage that Codex's `/status` shows, plus the token history codex-agent has recorded.

## Step 1: Plan Usage (live)

```bash
node "C:/Users/RJ/.claude/codex-agent/lib/plan-usage.js" live
```

This asks a short-lived `codex app-server` for `account/rateLimits/read`: about 1.5-2 s, **no model turn and no tokens** (verified on Codex CLI 0.167.0, 2026-11-09: no session record is created and the percentages do not move). It returns the 5-hour and weekly windows, the team plan's monthly per-user limit (`monthly`) and the number of free rate-limit resets.

If the result has `error` (for example the experimental app-server protocol changed), fall back to the newest snapshot from any session record (free, 5-hour + weekly only) and say how old it is:

```bash
node "C:/Users/RJ/.claude/codex-agent/lib/plan-usage.js" latest
```

## Step 2: Recorded History

If `~/.claude/codex-agent/usage-ledger.json` exists, load it:

```bash
node -e "var ut = require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js'); console.log(JSON.stringify(ut.loadLedger('C:/Users/RJ/.claude/codex-agent/usage-ledger.json')));"
```

If it does not exist, show "No dispatches recorded yet" in the history section.

## Step 3: Format Output

Show reset times in local time. Never show the account id.

---

### Codex Plan Usage ([live | session record, N min old] · plan: [planType])

| Window | Used | Resets |
|--------|------|--------|
| 5 hours | [N]% | [local time] |
| Weekly | [N]% | [local date + time] |
| Monthly (per-user limit) | [N]% ([used] of [limit]) | [local date] |

Free rate-limit resets available: [N]. [If `limitReached` is not null: **Limit reached: [type]**]

Quota guard: warns at [quota.warnPercent, default 80]%, asks before a Codex call at [quota.askPercent, default 95]%.

**Recorded history** (since [session startedAt])

| | Dispatches | Input tokens | Output tokens |
|-|-----------|-------------|--------------|
| Session | [N] | [N] | [N] |
| Lifetime | [N] | [N] | [N] |

---

## Notes

- The plan percentages come from OpenAI and include usage from every Codex client on the account (your interactive terminal, the Desktop app and codex-agent). The recorded history is codex-agent's own estimate and counts only its calls.
- The old token-budget limits (`budgets.*` in config.json) are no longer checked (removed 2026-11-09; they were set to 5 billion tokens / 10,000 USD and never triggered). The quota guard in dispatch, discuss and parallel uses the plan percentages instead.
- To reset the recorded session counters: `node -e "require('C:/Users/RJ/.claude/codex-agent/lib/usage-tracker.js').resetSession('C:/Users/RJ/.claude/codex-agent/usage-ledger.json')"`
