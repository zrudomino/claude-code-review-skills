# Retry and Escalation Protocol

## Attempt Loop Structure

```
for attempt = 1 to max_attempts (inclusive):
  context_level = min(attempt, 3)
  run Step 1 with context_level  (or skip to Step 2 if failure routing says so)
  if Step 1 fails (construction error, not behavioral): continue to next attempt
  run Step 2 with context_level
  if green phase fails: continue to next attempt
  run Step 3 (gates) with failure routing
  if all required gates pass: break -> proceed to Step 4

if no attempt succeeded after max_attempts:
  ESCALATE TO HUMAN with all attempted artifacts
```

## Context Levels

Context levels cap at 3 regardless of `--max-attempts`. Attempts beyond 3 repeat level 3.

| Level | context_level == | Agent A receives | Agent B receives |
|-------|-----------------|-----------------|-----------------|
| 1 | 1 | Finding metadata only: `description`, `expected_behavior`, `actual_behavior`, `file` (path only -- not contents), `line_start`, `line_end`, `symbol`, `category`. No source code. | Failing test file + source file(s) under repair only. No bug description. No finding metadata. |
| 2 | 2 | All of Level 1, PLUS: failure output from the previous attempt's red-phase or green-phase check (error messages, assertion text, stack traces). | All of Level 1, PLUS: the previous attempt's fix diff and the specific gate failure output that caused the retry. |
| 3 | 3+ | All of Level 2, PLUS: public API surface of the module -- type signatures, function signatures, class definitions, callers of the affected symbol, import structure. NOT the implementation body. | All of Level 2, PLUS: public interfaces and type signatures of related modules. |

## Failure Routing (Step 3 gates)

Failure routing determines which step the NEXT iteration starts at. The attempt counter increments at each iteration regardless of routing.

| Gate failure | Routing | Notes |
|-------------|---------|-------|
| Gate 1 (test still failing) | Return to Step 2 only | Agent B produced wrong fix. Reuse existing test file. Do NOT re-run Agent A. |
| Gate 2 or 3 (regression) | Return to Step 2 | Pass regression failure output as additional context to Agent B. |
| Gate 4 (API fuzz) | Log advisory only | Gate 4 is advisory. Report warnings but always proceed. Never hard-fail. |
| Gate 5 (patch size warn) | Log advisory only; if > 200 lines for P0/P1 escalate | Does not count as a gate failure for retry purposes. |
| Gate 6 or 7 (lint/coverage regression) | Return to Step 2 | Pass specific warnings/coverage delta as context. |
| Tool timeout | Retry gate once | If still times out, report `TOOL_TIMEOUT` and escalate. |
| Tool crash / flaky | Retry gate once | If same error: count as real failure. If different error: escalate. |

## On Escalation

When all `max_attempts` are exhausted with no successful attempt, produce an escalation report containing:

- The full finding JSON (including `run_id`, `finding_id`, `severity`, all fields)
- Each attempt's test file (path and content)
- Each attempt's fix diff (if Agent B produced one)
- The specific step and failure type on each attempt
- A clear recommended next action for the human

Then write `status: "escalated"`, `escalated_at: <ISO timestamp>`, and `escalation_reason: "Exhausted <N> attempts. Last failure: <step> -- <failure_type>."` back to the state file immediately.
