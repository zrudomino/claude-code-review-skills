# Gate 8: Security Regression Delta (Convenience Copy)

**Canonical source: `review-pipeline/references/gate-registry.md` "Gate 8: Security Regression Delta" section + `review-pipeline/references/security-corpus.md` normalization table. This file is a convenience copy that keeps fix-and-verify self-contained — a Claude that loads only fix-and-verify without loading review-pipeline can still execute Gate 8 correctly using this file alone. If divergence exists, the review-pipeline version is authoritative.**

Last synced with canonical: 2026-04-14.

---

## Purpose

Gate 8 runs between Step 4 (Codex Adversarial) and Step 5 (Commit) in the fix-and-verify red-green-commit loop. It invokes `local-security-scan` a second time inside the worktree and compares the result against `sec_baseline` (captured at Step 0 or inherited from review-pipeline Step 5A). Only findings that are *new* relative to baseline block the commit. Pre-existing security debt is WARN-only and does not block.

Gate 8 is required at all severities (P0, P1, P2, P3) — a new secret / new CVE / new SAST ERROR on any fix is intolerable regardless of the original finding's severity.

---

## Normalization Table

Used both at Step 0 baseline capture and at Step 4.5 Gate 8 delta computation. Identical to the canonical table in `review-pipeline/references/security-corpus.md`.

| Source | `severity` | `category` | `file` | `line_start` | `sec_identity_key` |
|---|---|---|---|---|---|
| Semgrep `"severity": "ERROR"` | `P1` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Semgrep `"severity": "WARNING"` | `P2` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Semgrep `"severity": "INFO"` | `P3` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Gitleaks (any leak) | `P0` | `secrets` | `File` | `StartLine` | `gitleaks:<Fingerprint>` |
| OSV `"severity": "CRITICAL"` | `P0` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "HIGH"` | `P1` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "MEDIUM"` or `"MODERATE"` | `P2` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "LOW"` | `P3` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` |

Notes:
- Gitleaks findings are always `P0`. A live secret is always critical regardless of which scanner rule matched.
- OSV `sec_identity_key` deliberately excludes `version` so that a dep bump from `pkg@1.0` to `pkg@1.1` (both in the same vulnerable range) keeps the same finding identity. A bump to a fixed version removes the identity from the current scan, which triggers two-phase tombstoning in review-pipeline's convergence layer.
- Semgrep's `match_based_id` (from `extra.fingerprint` in the JSON) is also stored in its own `match_based_id` finding field so Gate 8 can look it up directly.

---

## Delta Identity Rules

Delta computation uses scanner-native stable identity keys — **never raw file+line**. A fix that inserts lines above a pre-existing finding shifts its line number, and a `check_id + file + line` key would flag the shifted finding as "new", blocking a commit on an unrelated finding.

### Semgrep

Key: `semgrep:<match_based_id>`

`match_based_id` is Semgrep's own line-stable fingerprint (from the `extra.fingerprint` field of the JSON output). It is computed from the AST pattern of the match, not its source position, so it survives line-number shifts caused by unrelated edits above the match.

### Gitleaks

Key: `gitleaks:<Fingerprint>`

Gitleaks's `Fingerprint` field has the format `<commit>:<path>:<RuleID>:<line>`. It is stable for the same finding in the same commit, and gitleaks computes it deterministically.

### OSV-Scanner

Key: `osv:<ecosystem>:<package_name>:<advisory_id>:<manifest_path>`

**Version is deliberately excluded from the identity key.** Rationale: a dep bump from a vulnerable version to a different-but-still-vulnerable version inside the same advisory range keeps the same finding identity, preventing "trade CVE A for CVE B" churn in the delta. A dep bump to a *fixed* version removes the identity from the current scan entirely, which triggers the two-phase tombstoning logic in review-pipeline's convergence layer (absent in run N → `dismissed_reason: "sec_resolved_pending"`; absent in run N+1 → `status: "fixed"`).

The OSV JSON structure is `results[].packages[].vulnerabilities[]`. The `advisory_id` comes from `vulnerabilities[].id`; `ecosystem` and `package_name` come from `packages[].package.ecosystem` and `packages[].package.name`; `manifest_path` comes from `results[].source.path`.

---

## Matching Epoch Semantics

Before any delta comparison, Gate 8 MUST verify that `sec_scanner_versions` at scan time matches `sec_scanner_versions` recorded in `sec_baseline`. If they differ, the `matching_epoch` has advanced mid-fix — a Semgrep upgrade that renames rules, a Gitleaks update that adds new patterns, or an OSV reclassification of severities all invalidate identity-key stability.

On mismatch:

1. Emit `SEC_EPOCH_ADVANCED_MID_FIX` and escalate immediately to human.
2. Do NOT attempt to compare findings across the boundary.
3. Do NOT route back to Step 2 — a new baseline is required, and the operator decides whether to re-run the full fix-and-verify flow against the new scanner versions.

This is codified as fix-and-verify Invariant 14.

---

## Test-File Exclusion

Before delta computation, Semgrep findings whose `path` matches test-file globs (`test_*`, `*_test.*`, `*Test*`, `tests/**`) are suppressed. Rationale:

- Agent A writes a fresh failing test at Step 1 — the test file's Semgrep rules would always produce "new" findings that are not actually fix regressions.
- Agent B may add test fixtures with placeholder credentials.
- Mock credentials in test files are a known Gitleaks-entropy-filter edge case.

The test-file suppression applies to Semgrep only. Gitleaks scans the full tree, and any genuine test-file secret lands in `sec_baseline` (captured BEFORE Agent A runs), which automatically makes it WARN-only.

---

## Staged / Worktree Supplementary Check

The main `gitleaks detect` invocation is history-oriented and may miss a secret that Agent B introduced in uncommitted or staged content. Gate 8 MUST also run:

```bash
gitleaks detect --staged --no-git --source "$WORKTREE_PATH"
```

Any leak found via the staged check is merged into the delta set with identity key `gitleaks:<Fingerprint>`.

---

## Completeness Handling

If the scan returns `complete=false`, Gate 8 MUST treat this as a **hard fail** regardless of delta state:

Sources of `complete=false`:
- Scan exit code 2 (genuine setup/tool error)
- Missing report file for a non-skipped scanner
- Any scanner reported a timeout
- A required scanner was deliberately skipped via `*_SKIP` env var when this run needed it

Actions:

1. Emit `SEC_SCAN_INCOMPLETE`.
2. Escalate to human.
3. Do NOT route back to Step 2 — the fix itself may be correct; the failure is in verification infrastructure.
4. The commit is NOT made.

This is codified as fix-and-verify Invariant 13.

---

## Attempt-Counter Consumption

A Gate 8 failure (new finding detected) consumes one attempt from the fix-and-verify outer loop's attempt counter, same as Gate 6 or Gate 7 failure. The next attempt starts at Step 2 (Agent B writes a different fix) with the new security findings passed as additional Agent B context:

> Your previous fix introduced these security findings — rewrite to avoid them:
> - `<finding_1_category>` at `<file_1>:<line_1>`
> - `<finding_2_category>` at `<file_2>:<line_2>`
> - ...

If the outer loop is already at `max_attempts` when Gate 8 fails, escalate immediately with `SEC_GATE8_RETRY_EXHAUSTED`. Do NOT attempt another Step 2 iteration — the attempt cap is hard (Invariant 7).

---

## Routing Summary

| Gate 8 outcome | Routing | Notes |
|---|---|---|
| Scan complete, delta empty | Proceed to Step 5 (Commit) | Happy path. |
| Scan complete, delta has new findings, attempts remaining | Return to Step 2 with new-findings context | Consumes one attempt. |
| Scan complete, delta has new findings, at `max_attempts` | Escalate with `SEC_GATE8_RETRY_EXHAUSTED` | Invariant 7 + Gate 8 retry exhaustion. |
| Scan `complete=false` | Escalate with `SEC_SCAN_INCOMPLETE`. Do NOT retry. | Invariant 13. |
| `matching_epoch` advanced vs baseline | Escalate with `SEC_EPOCH_ADVANCED_MID_FIX`. Do NOT retry. | Invariant 14. |
