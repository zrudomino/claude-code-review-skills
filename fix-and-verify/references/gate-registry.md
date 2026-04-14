# Gate Registry (Convenience Copy)

**Canonical source: review-pipeline references/gate-registry.md. This is a convenience copy for fix-and-verify's use. If these diverge, the review-pipeline version is authoritative.**

**Note:** This copy extends the canonical source with fix-and-verify-specific sections: Severity Gate Requirements and Baseline Selection rules.
Last synced with canonical: 2026-04-08.

## Gate Definitions

| Gate | Check | Command | Timeout | Pass Criteria | Fallback if tool missing |
|------|-------|---------|---------|---------------|--------------------------|
| 1 | Specific test file passes | Detected test runner on the target test file | 60s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 2 | Full backend test suite passes | `pytest` / `./gradlew test` / `go test ./...` / `cargo test` / `jest` | 300s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 3 | Full frontend test suite passes | `vitest` / `jest` (frontend-specific config) | 180s | Exit code 0 | `[SKIP]` if no frontend stack detected |
| 4 | API fuzz (advisory) | `schemathesis run <schema> --validate-schema true` | 120s | Advisory only -- report warnings, always proceed | `[SKIP]` if no API schema or schemathesis not installed |
| 5 | Patch size (advisory) | `git diff --stat` (unstaged) or `git diff --stat HEAD~1..HEAD` (after commit) -- count changed lines | 5s | Always advisory. Warn > 50 lines. Escalate (to human) if > 200 lines for P0/P1. No hard-fail for P2/P3. | N/A (always available) |
| 6 | Lint + type check delta | Run detected lint tool + type checker (if stack has one; plain JS skips type check portion). Exit code 0 AND new_warnings <= `gate_6_baseline`. If exit code is non-zero due to errors (not warnings), gate fails unconditionally. If exit code is 0, count warnings and compare against baseline. | 120s | Exit code 0 AND new_warnings <= baseline_warnings | `TOOL_MISSING` -- escalate. If stack has no type checker, run lint only. |
| 7 | Coverage delta on changed files | Run coverage tool scoped to changed files. Compare per-file coverage against `gate_7_baseline` per-file values. | 180s | Per-file coverage >= per-file baseline | `[SKIP]` if no coverage tool detected |
| 8 | Security regression delta | `bash ~/.claude/skills/local-security-scan/scan.sh <worktree>` then compare against `sec_baseline` via scanner-native identity keys | 300s | Scan `complete=true` AND zero *new* security findings relative to `sec_baseline` via Semgrep `match_based_id` / Gitleaks `Fingerprint` / OSV tuple `(ecosystem, package, advisory_id, manifest_path)`. Pre-existing baseline findings do NOT block. | `TOOL_MISSING` -- escalate. A skipped scanner (via `*_SKIP` env var) is NOT a tool error but still sets completeness=false, which is a hard fail (Gate 8 cannot complete on an incomplete scan). See `references/security-gate-8.md` for the full procedure. |

## Gate 4: API Fuzz (Advisory Only)

Gate 4 (API fuzz smoke via schemathesis) is advisory only. It is NOT a required gate. While it appears in the Gate Table above for completeness, it is excluded from the Severity Gate Requirements table and never blocks the pipeline.

- Tool: `schemathesis run <schema> --validate-schema true`
- Timeout: 120s
- Condition: Only if an API schema file is found AND schemathesis is installed
- Behavior: Run as advisory -- report warnings but always proceed. Never hard-fail on Gate 4 results.

## Severity Gate Requirements

| Severity | Required Gates |
|----------|---------------|
| P0, P1 | 1, 2, 3, 6, 7, 8 (gate 4 and gate 5 run but advisory -- never block. Gate 5 escalates to human if > 200 lines for P0/P1.) |
| P2, P3 | 1, 2, 3, 6, 8 |

Gate 8 is required at all severities because a new secret / new CVE / new SAST ERROR on any fix is intolerable regardless of the original finding's severity. Gate 8 runs between Step 4 (Codex Adversarial) and Step 5 (Commit) -- see `references/security-gate-8.md` for the full procedure.

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
