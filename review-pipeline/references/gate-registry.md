# Gate Registry (Canonical)

This is the single source of truth for all gate definitions used in review-pipeline and fix-and-verify. fix-and-verify must reference this registry; it must not redefine gate semantics.

## Gate Table

| Gate | Check | Command | Timeout | Pass Criteria | Fallback if tool missing |
|------|-------|---------|---------|---------------|--------------------------|
| 1 | Specific test file passes | Detected test runner on the target test file | 60s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 2 | Full backend test suite passes | `pytest` / `./gradlew test` / `go test ./...` / `cargo test` / `jest` | 300s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 3 | Full frontend test suite passes | `vitest` / `jest` (frontend-specific config) | 180s | Exit code 0 | `[SKIP]` if no frontend stack detected |
| 5 | Patch size | `git diff --stat` (unstaged) or `git diff --stat HEAD~1..HEAD` (after commit) -- count changed lines | 5s | Advisory: warn if > 50 lines. Escalate if > 200 lines for P0/P1. Never hard-fail for P2/P3. | N/A (always available) |
| 6 | Lint + type check delta | Run detected lint tool + type checker (if stack has one; plain JS skips type check portion). Compare warning count against `gate_6_baseline`. | 120s | Exit code 0 AND new_warnings <= baseline_warnings | `TOOL_MISSING` -- escalate. If stack has no type checker, run lint only. |
| 7 | Coverage delta on changed files | Run coverage tool scoped to changed files. Compare per-file coverage against `gate_7_baseline` per-file values. | 180s | Per-file coverage >= per-file baseline | `[SKIP]` if no coverage tool detected |

## Severity Gate Requirements

| Context | Required Gates |
|---------|---------------|
| review-pipeline auto-fix verification (Stage 2) | 2, 3, 6 |
| fix-and-verify P0/P1 | 1, 2, 3, 5, 6, 7 (gates 4 and 5 advisory only) |
| fix-and-verify P2/P3 | 1, 2, 3, 6 |

## Gate 4: API Fuzz (Advisory Only)

Gate 4 (API fuzz smoke via schemathesis) is advisory only. It is NOT a required gate and is not included in the table above.

- Tool: `schemathesis run <schema> --validate-schema true`
- Timeout: 120s
- Condition: Only if an API schema file is found AND schemathesis is installed
- Behavior: Run as advisory -- report warnings but always proceed. Never hard-fail on Gate 4 results.

## Frontend Stacks

**Frontend stacks** (for Gate 3 skip condition): Vue/TS, React/TS, Next.js/TS. All other stacks: Gate 3 is `[SKIP]`.

## Baseline Capture

Before applying any fix or auto-fix, capture baselines:

- **Gate 6 baseline:** Run lint + type check, count total warnings. Store as `gate_6_baseline` (integer) in the state file.
- **Gate 7 baseline:** Run coverage on changed files, store per-file coverage percentages as `gate_7_baseline` (object mapping file paths to percentages, or `null` if no coverage tool).

Both baselines are captured during the pre-stage, before any modifications.

## Post-Autofix Capture

After Stage 2 auto-fixes complete, capture:

- **Gate 6 post-autofix:** Run lint + type check again. Store as `gate_6_post_autofix` in the state file.
- **Gate 7 post-autofix:** Run coverage again. Store as `gate_7_post_autofix` in the state file.

fix-and-verify uses the `post_autofix` values (not the pre-stage baselines) when evaluating gate regressions.
