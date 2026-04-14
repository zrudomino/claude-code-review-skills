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

## Security finding convergence

Findings sourced from `local-security-scan` (Step 5A and fix-and-verify Gate 8) use a different identity scheme from agent-discovered findings. They are still stored in the same `findings[]` array with the same schema, but they carry an additional `sec_identity_key` field and their `finding_id` is a deterministic UUID v5 keyed on that value, making identity stable across fresh-state runs.

### Identity key formats

| Source | `sec_identity_key` format | Why |
|---|---|---|
| Semgrep | `semgrep:<extra.fingerprint>` | Semgrep's own line-stable `match_based_id`. Survives line shifts from unrelated edits above the match. |
| Gitleaks | `gitleaks:<Fingerprint>` | Gitleaks emits `<commit>:<path>:<RuleID>:<line>`, stable for the same finding in the same commit. |
| OSV-Scanner | `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` | **Version deliberately excluded.** Dep bumps inside a vulnerable range keep the same identity, preventing "trade CVE A for CVE B" churn in the delta. |

The `finding_id` for scan-sourced findings is computed as `uuid5(sec_identity_key)`. This means Level 1 convergence matching works deterministically even for fresh state files: the same underlying security finding always produces the same `finding_id` as long as the `matching_epoch` has not advanced.

### Level mapping for security findings

| Level | Applies to security findings? | Notes |
|---|---|---|
| 1 (exact `finding_id`) | Yes, always | Works because `finding_id = uuid5(sec_identity_key)`. |
| 2 (`file + category + line_drift <= 10`) | Yes for Semgrep and Gitleaks | Degrades to Level 1 for OSV findings, which have no line number. |
| 3 (`file + symbol`) | Not recommended | Security findings rarely populate `symbol`. Do not rely on Level 3 for security finding matching. |

### Matching epoch scope

Security finding matches are scoped within a single `matching_epoch`. An epoch bump (any change in `sec_scanner_versions` between consecutive runs) invalidates identity-key stability — a Semgrep rule rename, a Gitleaks pattern update, or an OSV severity reclassification can cause the same underlying finding to produce a different `sec_identity_key` under the new versions.

On an epoch bump:
1. Append `SEC_EPOCH_ADVANCED` to `errors[]` with the before/after version details.
2. Re-ingest all security findings as fresh (status `dismissed`, `dismissed_reason: "sec_baseline"`).
3. Security findings from the previous epoch are dropped from the convergence match set — they do not count against regression detection or stop conditions.
4. Agent-discovered findings are unaffected by epoch bumps.

### Tombstoning for absent security findings

A scan-sourced finding that was present in the baseline but is absent from the current scan is NOT immediately marked `fixed`. Two-phase promotion prevents "dep-bump trades one CVE for another" from looking like a resolve in round N and a fresh finding in round N+1:

1. **First absence** (round N): The finding's `status` stays `dismissed` but `dismissed_reason` flips from `"sec_baseline"` to `"sec_resolved_pending"`. Record an updated `dismissed_at`.
2. **Second absence** (round N+1, consecutive): If still absent, promote to `status: "fixed"`, set `fixed_at`, clear `dismissed_reason`. Now the finding is truly resolved.
3. **Reappearance between N and N+1:** If the finding reappears in round N+1 (e.g., a dep was bumped and then reverted), reset `dismissed_reason` back to `"sec_baseline"` and continue tracking normally.

This applies only to security findings (`sec_identity_key` non-null). Agent-discovered findings use the normal `open → fixed` transition driven by fix-and-verify.

### Stop condition interaction

Scan-sourced findings start as `dismissed` (not `open`), so they do NOT count against Stop Condition 1 (the "zero open `[CONFIRM]` / `[CONFLICT]`" condition). A project with 20 pre-existing Semgrep warnings will still converge normally as long as no NEW security findings appear and no agent-discovered findings remain open. A genuinely new security finding, however, is inserted with `status: "open"` (not dismissed) and DOES count against Stop Condition 1, so it blocks convergence until fix-and-verify addresses it.
