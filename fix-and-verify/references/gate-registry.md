# Gate Registry (Convenience Copy)

**Canonical source: review-pipeline references/gate-registry.md. This is a convenience copy for fix-and-verify's use. If these diverge, the review-pipeline version is authoritative.**

**Note:** This copy extends the canonical source with fix-and-verify-specific sections: Severity Gate Requirements and Baseline Selection rules.

## Gate Definitions

| Gate | Check | Command | Timeout | Pass Criteria | Fallback if tool missing |
|------|-------|---------|---------|---------------|--------------------------|
| 1 | Specific test file passes | Detected test runner on the target test file | 60s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 2 | Full backend test suite passes | `pytest` / `./gradlew test` / `go test ./...` / `cargo test` / `jest` | 300s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 3 | Full frontend test suite passes | `vitest` / `jest` (frontend-specific config) | 180s | Exit code 0 | `[SKIP]` if no frontend stack detected |
| 5 | Patch size | `git diff --stat` (unstaged) or `git diff --stat HEAD~1..HEAD` (after commit) -- count changed lines | 5s | Advisory: warn if > 50 lines. Escalate if > 200 lines for P0/P1. Never hard-fail for P2/P3. | N/A (always available) |
| 6 | Lint + type check delta | Run detected lint tool + type checker (if stack has one; plain JS skips type check portion). Compare warning count against baseline. | 120s | Exit code 0 AND new_warnings <= baseline_warnings | `TOOL_MISSING` -- escalate. If stack has no type checker, run lint only. |
| 7 | Coverage delta on changed files | Run coverage tool scoped to changed files. Compare per-file coverage against baseline per-file values. | 180s | Per-file coverage >= per-file baseline | `[SKIP]` if no coverage tool detected |

## Gate 4: API Fuzz (Advisory Only)

Gate 4 (API fuzz smoke via schemathesis) is advisory only. It is NOT a required gate and is not included in the table above.

- Tool: `schemathesis run <schema> --validate-schema true`
- Timeout: 120s
- Condition: Only if an API schema file is found AND schemathesis is installed
- Behavior: Run as advisory -- report warnings but always proceed. Never hard-fail on Gate 4 results.

## Severity Gate Requirements

| Severity | Required Gates |
|----------|---------------|
| P0, P1 | 1, 2, 3, 5, 6, 7 (gate 4 advisory only, gate 5 advisory only) |
| P2, P3 | 1, 2, 3, 6 |

## Baseline Selection for Gates 6 and 7

fix-and-verify must select the correct baseline when running gates 6 and 7. Use this priority order:

1. If state file has `gate_6_post_autofix` / `gate_7_post_autofix` that are non-null: use these. They reflect the state after review-pipeline Stage 2 auto-fixes, which is the correct "before this fix" baseline.
2. If `gate_6_post_autofix` / `gate_7_post_autofix` are null (Stage 2 did not run or did not complete): fall back to `gate_6_baseline` / `gate_7_baseline`.
3. If no state file is available: capture fresh baselines during Step 0.

## Tool Resolution

Use the same stack detection and tool resolution as the review-pipeline skill (canonical source: review-pipeline "Pre-Stage: Deterministic Checks" section). For JS/TS, detect the test runner from `package.json` scripts. If no test script exists, gates 1 and 2 report `TOOL_MISSING` and escalate.

## Tool Missing vs Skip

- `[SKIP]`: The gate does not apply to this stack. Do not run it. Do not report as failure.
- `TOOL_MISSING`: The gate applies but the tool is not installed. Escalate -- do not mark as passed.

These are distinct. A gate that applies but whose tool is missing is NOT the same as a gate that does not apply.
