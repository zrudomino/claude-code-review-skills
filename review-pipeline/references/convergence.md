# Convergence Matching Reference

Convergence matching is run BEFORE Stage 0, after lock acquisition, whenever the run has prior history (either `--resume` or a fresh re-invocation with findings in the state file from prior rounds).

## Purpose

Convergence matching links findings across rounds to:
- Detect regressions (a previously fixed finding reappearing as open)
- Determine when review rounds can stop
- Prevent duplicate findings from being created for the same underlying issue

## Three-Level Composite Key

Match findings using this priority order. Stop at the first level that produces a match.

| Level | Match Condition | Notes |
|-------|----------------|-------|
| 1 | Exact `finding_id` match | Covers `--resume` where the same finding object is carried forward. Highest confidence. |
| 2 | Same `file` + same `category` + `\|line_start_new - line_start_old\|` <= 10 | Handles line drift from unrelated edits. Both `file` and `category` must be identical strings. |
| 3 | Same `file` + same `symbol` (both non-null and identical strings) | Handles findings that moved significantly within a file. Only applies when both findings have a non-null `symbol`. |

Do NOT use string similarity, character overlap, or fuzzy description matching. These are not reliably implementable.

## Regression Detection

A regression is: a finding that matched a prior finding whose `status` was `"fixed"` and the current finding's `status` is `"open"`.

When a regression is detected:
- Warn: "Fix for [finding_id / description] regressed. The approach may need redesign."
- Do not automatically dismiss the finding. Surface it prominently in the output.

Note: if a regression is detected, Stop Condition 3 will halt the pipeline. The instructions above (warn, surface prominently) describe how to present the regression in the output when the pipeline stops.

## Stop Conditions

Note: these stop conditions are evaluated using the prior run's findings and run_history data. They determine whether a new review round is necessary. "This run" in the table below refers to the prior run's final state, not the current (not-yet-started) run.

Evaluate stop conditions in this order after convergence matching completes:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Zero open `[CONFIRM]` findings AND zero open `[CONFLICT]` findings in this run | STOP -- output clean report. Note: open `[JUDGMENT]` findings do not block a clean report but are listed. This condition requires fix-and-verify to have written `status: "fixed"` back to the state file for resolved findings. If fix-and-verify has not been run, all `[CONFIRM]` findings remain `"open"` and this condition will not trigger. |
| 2 | Any finding matched to a prior `"fixed"` finding is now `"open"` | STOP -- warn regression (see above) |
| 3 | `finding_count` this run > `finding_count` previous run | STOP and ESCALATE: "Finding count increased from N to M between runs. The fixes may be introducing new issues." Output the prior run's punch list with the escalation warning. Write state, write `latest.json`, delete lock. |
| 4 | 3 consecutive rounds where all findings are `P3` only (check `p3_only` in `run_history`) | STOP |
| 5 | Current round number (length of `run_history`) >= 5 | STOP unconditionally -- output remaining findings as punch list |

If no stop condition is met, proceed to Stage 0.

## Integration with run_history

After each completed run, append a record to `run_history`:

```json
{
  "round": <length of run_history before this append + 1>,
  "timestamp": "<ISO>",
  "finding_count": <total findings in this run>,
  "p0_p1_count": <P0+P1 count>,
  "p3_only": <true if all open findings are P3>
}
```
