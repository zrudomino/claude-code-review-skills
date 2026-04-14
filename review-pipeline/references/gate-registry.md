# Gate Registry (Canonical)

This is the single source of truth for all gate definitions used in review-pipeline and fix-and-verify. fix-and-verify must reference this registry; it must not redefine gate semantics.

## Gate Table

| Gate | Check | Command | Timeout | Pass Criteria | Fallback if tool missing |
|------|-------|---------|---------|---------------|--------------------------|
| 1 | Specific test file passes | Detected test runner on the target test file | 60s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 2 | Full backend test suite passes | `pytest` / `./gradlew test` / `go test ./...` / `cargo test` / `jest` | 300s | Exit code 0 | `TOOL_MISSING` -- escalate |
| 3 | Full frontend test suite passes | `vitest` / `jest` (frontend-specific config) | 180s | Exit code 0 | `[SKIP]` if no frontend stack detected |
| 4 | API fuzz (advisory) | `schemathesis run <schema> --validate-schema true` | 120s | Advisory only -- report warnings, always proceed | `[SKIP]` if no API schema or schemathesis not installed |
| 5 | Patch size (advisory) | `git diff --stat` (unstaged) or `git diff --stat HEAD~1..HEAD` (after commit) -- count changed lines | 5s | Always advisory. Warn > 50 lines. Escalate (to human) if > 200 lines for P0/P1. No hard-fail for P2/P3. | N/A (always available) |
| 6 | Lint + type check delta | Run detected lint tool + type checker (if stack has one; plain JS skips type check portion). Exit code 0 AND new_warnings <= `gate_6_baseline`. If exit code is non-zero due to errors (not warnings), gate fails unconditionally. If exit code is 0, count warnings and compare against baseline. | 120s | Exit code 0 AND new_warnings <= baseline_warnings | `TOOL_MISSING` -- escalate. If stack has no type checker, run lint only. |
| 7 | Coverage delta on changed files | Run coverage tool scoped to changed files. Compare per-file coverage against `gate_7_baseline` per-file values. | 180s | Per-file coverage >= per-file baseline | `[SKIP]` if no coverage tool detected |
| 8 | Security regression delta | `bash ~/.claude/skills/local-security-scan/scan.sh <project>` then compare against `sec_baseline` via identity keys | 300s | Scan `complete=true` AND zero *new* security findings relative to `sec_baseline` via the identity-key rules in the Gate 8 section below. Pre-existing baseline findings do NOT block. | `TOOL_MISSING` -- escalate. Skipped scanner (via `*_SKIP` env var) is NOT a tool error but still sets completeness=false, which is a hard fail for Gate 8 (a consumer that needs Gate 8 cannot complete it with an incomplete scan). |

## Severity Gate Requirements

| Context | Required Gates |
|---------|---------------|
| review-pipeline auto-fix verification (Stage 2) | 2, 3, 6 |
| fix-and-verify P0/P1 | 1, 2, 3, 6, 7, 8 (gates 4 and 5 run but advisory -- never block. Gate 5 escalates to human if > 200 lines for P0/P1.) |
| fix-and-verify P2/P3 | 1, 2, 3, 6, 8 |

Gate 8 is required at all severities because a new secret / new CVE / new SAST ERROR on any fix is intolerable regardless of the original finding's severity. See the "Gate 8: Security Regression Delta" section below for the full procedure.

## Gate 4: API Fuzz (Advisory Only)

Gate 4 (API fuzz smoke via schemathesis) is advisory only. It is NOT a required gate. While it appears in the Gate Table above for completeness, it is excluded from the Severity Gate Requirements table and never blocks the pipeline.

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

---

## Gate 8: Security Regression Delta

Gate 8 is the canonical security-regression gate used by fix-and-verify between Step 4 (Codex Adversarial) and Step 5 (Commit). It runs `local-security-scan` a second time inside the worktree and compares the result against `sec_baseline` (captured earlier at review-pipeline Step 5A or at fix-and-verify Step 0). Only findings that are *new* relative to baseline — by stable identity keys, never raw line numbers — block the commit loop. Pre-existing security debt is WARN-only.

### Identity keys (never raw file+line)

Delta logic uses scanner-native stable identities so that a fix which inserts lines above a pre-existing finding does not erroneously flag the shifted finding as "new":

- **Semgrep:** `semgrep:<extra.fingerprint>` — Semgrep emits its own line-stable fingerprint as `match_based_id` / `extra.fingerprint`. Use it directly.
- **Gitleaks:** `gitleaks:<Fingerprint>` — Gitleaks's own `Fingerprint` field is `<commit>:<path>:<RuleID>:<line>`, and is stable across runs for the same finding in the same commit. Use it directly.
- **OSV:** `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` — note the **deliberate absence of `version`**. A dep bump from a vulnerable version to a different-but-still-vulnerable version inside the same advisory keeps the same finding identity, preventing churn in the delta. A dep bump to a fixed version removes the identity from the new scan, which is correctly tracked via tombstoning (see `convergence.md`).

### Matching epoch semantics

Before any delta comparison, Gate 8 MUST verify that `sec_scanner_versions` at scan time matches `sec_scanner_versions` in `sec_baseline`. If they differ, the `matching_epoch` has advanced mid-fix — a Semgrep upgrade that renames rules, a Gitleaks upgrade that adds new patterns, or an OSV upgrade that reclassifies severities all invalidate identity-key stability. On mismatch:

1. Escalate immediately with `SEC_EPOCH_ADVANCED_MID_FIX`.
2. Do NOT attempt to compare findings across the boundary.
3. Do NOT route back to Step 2 — a new baseline is required, and the human operator must decide whether to re-run the full fix-and-verify flow against the new scanner versions.

### Test-file exclusion

Before delta computation, Semgrep findings whose `path` matches test-file globs (`test_*`, `*_test.*`, `*Test*`, `tests/**`) are suppressed. Rationale: Agent A writes a fresh failing test at Step 1, Agent B may add additional test fixtures, and mock credentials in test files are a known Gitleaks-entropy-filter edge case. The test-file suppression applies to Semgrep only — Gitleaks scans the full tree, and any genuine test-file secret lands in `sec_baseline` (captured before Agent A runs), which means it is automatically WARN-only and never blocks.

### Staged / worktree supplementary check

The main `gitleaks detect` invocation is history-oriented and may miss a secret that Agent B introduced in uncommitted or staged content. Gate 8 MUST also run `gitleaks detect --staged --no-git` inside the worktree as a supplementary check. Any leak found via the staged check is merged into the delta set with identity key `gitleaks:<Fingerprint>`.

### Completeness handling

If the scan returns `complete=false` (timeout, tool error, missing scanner, or a required scanner was deliberately skipped via `*_SKIP` env var), Gate 8 MUST treat this as a **hard fail**:

1. Emit `SEC_SCAN_INCOMPLETE`.
2. Escalate to human — do NOT route back to Step 2. The fix itself may be correct; the failure is in verification infrastructure.
3. The commit is NOT made.

This behavior is codified as a fix-and-verify invariant and is the single most important anti-silent-failure rule for this gate.

### Attempt-counter consumption

A Gate 8 failure (new finding detected) consumes one attempt from the fix-and-verify outer loop's attempt counter, same as Gate 6 or Gate 7. The next attempt starts at Step 2 (Agent B writes a different fix), with the new security findings passed as additional Agent B context: *"Your previous fix introduced these security findings — rewrite to avoid them: ..."*.

If the outer loop is already at `max_attempts` when Gate 8 fails, escalate immediately with `SEC_GATE8_RETRY_EXHAUSTED`. Do NOT attempt another Step 2 iteration — the attempt cap is hard.

### Routing summary

| Gate 8 outcome | Routing |
|---|---|
| Scan complete, delta empty | Proceed to Step 5 (Commit) |
| Scan complete, delta has new findings, attempts remaining | Return to Step 2 with new-findings context; consumes one attempt |
| Scan complete, delta has new findings, at `max_attempts` | Escalate with `SEC_GATE8_RETRY_EXHAUSTED` |
| Scan `complete=false` | Escalate with `SEC_SCAN_INCOMPLETE`. Do NOT retry. |
| `matching_epoch` advanced vs baseline | Escalate with `SEC_EPOCH_ADVANCED_MID_FIX`. Do NOT retry. |
