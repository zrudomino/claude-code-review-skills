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

**Level 3 limitation:** Level 3 will miss matches when one side has a null `symbol`. Agents should consistently populate `symbol` to improve match quality.

**File rename handling:** Before running Level 2/3 matching, check for renames in the diff: `git diff --name-status HEAD | grep ^R`. If renames exist, build a rename map and apply it to prior finding file paths before matching.

## Regression Detection

A regression is: a finding that matched a prior finding whose `status` was `"fixed"` and the current finding's `status` is `"open"`.

When a regression is detected:
- Warn: "Fix for [finding_id / description] regressed. The approach may need redesign."
- Do not automatically dismiss the finding. Surface it prominently in the output.

Note: if a regression is detected, Stop Condition 2 (Priority 2 in the stop conditions table) will halt the pipeline. The instructions above (warn, surface prominently) describe how to present the regression in the output when the pipeline stops.

## Stop Conditions

Note: these stop conditions are evaluated using the prior run's findings and run_history data. They determine whether a new review round is necessary. "This run" in the table below refers to the prior run's final state, not the current (not-yet-started) run.

Evaluate stop conditions in this order after convergence matching completes:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Zero open `[CONFIRM]` findings AND zero open `[CONFLICT]` findings in this run | STOP -- output clean report. Note: open `[JUDGMENT]` findings do not block a clean report but are listed. This condition requires fix-and-verify to have written `status: "fixed"` back to the state file for resolved findings. If fix-and-verify has not been run, all `[CONFIRM]` findings remain `"open"` and this condition will not trigger. |
| 2 | **Regression detection.** Not evaluated at the pre-Stage-0 checkpoint (requires current-run findings). Deferred to Step 2.1b in SKILL.md, where current findings exist. At Step 2.1b: if any current finding matches a prior finding whose `status` was `"fixed"` (via Level 1/2/3 matching), warn regression prominently. Do NOT stop the pipeline -- continue processing. Also check and report any Condition 3 violation as an advisory note. |
| 3 | `p0_p1_count` in the most recent `run_history` entry > `p0_p1_count` in the second-most-recent entry. Requires at least 2 entries in `run_history`; skip if fewer than 2. If `finding_count` (total open) also increased but `p0_p1_count` did not, report as advisory (P2/P3 noise) but do NOT stop. | STOP and ESCALATE: "P0/P1 count increased from N to M between runs. The fixes may be introducing new high-severity issues." Output the prior run's punch list with the escalation warning. Write state, write `latest.json`, delete lock. |
| 4 | 3 consecutive rounds where `p3_only == true` AND `escalated_count == 0` (check `run_history`) | STOP |
| 5 | Length of `run_history` >= 5 | STOP unconditionally -- output remaining findings as punch list |

If no stop condition is met, proceed to Stage 0.

## Integration with run_history

After each completed run, append a record to `run_history`:

```json
{
  "timestamp": "<ISO UTC>",
  "finding_count": <count of findings with status "open" in this run>,
  "p0_p1_count": <count of open P0+P1 findings>,
  "p3_only": <true if all open findings are P3>,
  "escalated_count": <count of escalated findings>
}
```

Stop Condition 4 requires `p3_only == true` AND `escalated_count == 0` in all 3 consecutive rounds.
