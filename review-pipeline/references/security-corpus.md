# Security Corpus Seeding (Step 5A) — Canonical Reference

Step 5A runs between Pre-Stage (Step 5) and Stage 0 Change Classification (Step 6). It invokes `local-security-scan` to seed the review's finding corpus with SAST / secret / CVE findings that review agents cannot reliably detect on their own. The full procedure and all normalization rules live here; review-pipeline `SKILL.md` carries only a short summary + pointer to this file, so this content is loaded into the orchestrator's context only when Step 5A actually runs.

This file is the **canonical source** for:
- The 8-step Step 5A procedure
- The Semgrep / Gitleaks / OSV → canonical-finding normalization table
- The dependency-manifest list that gates the OSV short-circuit
- The per-source quota enforcement rules for the 15-finding cap
- The `sec_escalate_tier` decision logic

---

## Step 5A Procedure

1. **Parse `files_scope` for dependency manifests.** Scan the diff file list (`files_scope` from Stage 0 lookahead, or `git diff HEAD --name-only` output if `files_scope` is null). If the list contains NONE of the manifest files listed in the "Dependency manifests" section below, set the environment variable `OSV_SKIP=1` for the upcoming scan invocation. Log the short-circuit decision to the orchestrator output: `"Step 5A: no dependency manifest in diff — OSV skipped"`. This avoids paying the OSV runtime cost (which can reach multiple minutes on large dep trees) for diffs that touch only source code.

2. **Probe scanner versions.** Run `semgrep --version`, `gitleaks version`, and `osv-scanner --version`. Parse the output of each to extract a version string. Build `sec_scanner_versions` as `{ "semgrep": "<v>", "gitleaks": "<v>", "osv-scanner": "<v>" }`. Compare with the `sec_scanner_versions` of the most recent `run_history` entry from a prior run (if any). If any value differs, increment `matching_epoch` by 1 and append an `errors[]` record:
   ```json
   { "timestamp": "<now>", "stage": "stage-5a", "error_code": "SEC_EPOCH_ADVANCED",
     "detail": "scanner versions changed: <before> -> <after>",
     "finding_id": null, "recovery": "continued" }
   ```

3. **Invoke scan.sh.** Run:
   ```bash
   SEMGREP_SKIP=0 GITLEAKS_SKIP=0 OSV_SKIP=${OSV_SKIP:-0} \
     bash ~/.claude/skills/local-security-scan/scan.sh "$PROJECT"
   ```
   The scan writes JSON reports to `<project>/.sec-scan/semgrep.json`, `.sec-scan/gitleaks.json`, `.sec-scan/osv.json`, and emits a composite RESULT line + exit code.

4. **Parse completeness.** Inspect scan exit code, RESULT line, and each JSON file:
   - Exit code 2 (setup/tool error) → set `sec_baseline.complete=false`, append `SEC_SCAN_INCOMPLETE` to `errors[]`.
   - Any JSON report file absent when the corresponding `*_SKIP` was NOT set → set `complete=false`, append `SEC_SCAN_INCOMPLETE`.
   - Any JSON report file contains `"skipped": true` AND that scanner was NOT skipped via env var → inconsistent state, set `complete=false`, append `SEC_SCAN_INCOMPLETE`.
   - Required scanner (Semgrep, Gitleaks) skipped via env var → set `complete=false`, append `SEC_SCAN_INCOMPLETE` with `detail: "<scanner> skipped via env var but marked required for this run"`.
   - OSV skipped via `OSV_SKIP=1` set in step 1 → this is an expected short-circuit, NOT an incompleteness. Do NOT set `complete=false` for this case alone. Semgrep and Gitleaks results still count.
   - All other cases (semgrep.json valid, gitleaks.json valid, osv.json valid-or-deliberately-skipped) → `complete=true`.
   - An incomplete baseline does NOT abort the pipeline. The pipeline continues with whatever partial results exist; downstream stages log a warning in their output: *"Step 5A baseline is incomplete — delta comparisons in fix-and-verify will be unreliable. See errors[]."* This is covered by the review-pipeline invariant: **Never treat `scan_incomplete` as a clean result.**

5. **Normalize findings.** For each finding in the three JSON files, apply the Normalization Table (below) to produce a canonical finding object. Set:
   - `reporters: ["local-security-scan"]`
   - `scan_artifact_path: <.sec-scan/<scanner>.json absolute path>`
   - `sec_identity_key: <per table>`
   - `finding_id: uuid5("local-security-scan", sec_identity_key)` — deterministic v5 UUID so identity survives fresh-state runs within the same `matching_epoch`
   - `status: "dismissed"`
   - `dismissed_reason: "sec_baseline"`
   - `dismissed_at: <ISO now>`
   - `tag: "[JUDGMENT]"` — scan findings are never auto-fixed and never conflict-checked; they are advisory to agents
   - `symbol: null` (unless the scanner emits one, which is rare)
   - `description: <scanner's own description/message>`

6. **Apply per-source quota (max 7 scan findings in the 15-finding cap).** After normalization, if scan-sourced findings exceed 7 total:
   - Sort by severity (P0 > P1 > P2 > P3).
   - Keep the top 7.
   - Discard P3 security findings entirely if they push the total above 7 (they are the least actionable class).
   - Append an `errors[]` record: `{ "error_code": "SEC_FINDING_QUOTA_EXCEEDED", "detail": "<N> scan findings truncated to 7 to preserve agent-finding capacity", "recovery": "truncated" }`.

   Reserve at least 8 slots for agent-discovered findings (Stage 1 + Stage 3 specialists). The 15-finding cap is enforced at Stage 2 consolidation; Step 5A's quota enforcement is a pre-condition that ensures agent findings cannot be starved by a noisy Semgrep ruleset.

7. **Evaluate `sec_escalate_tier`.** Set `sec_escalate_tier=true` in the state file IF AND ONLY IF the scan produced any finding with `severity: "P0"` AND `category` is one of `"secrets"` OR `"dependency-cve"`. Bulk Semgrep warnings do NOT trigger tier escalation — only confirmed P0 secrets (from Gitleaks) or critical CVEs (from OSV). Stage 0 reads this flag: if set, the classification logic upgrades the tier:
   - `Lightweight | Standard → Standard` (minimum) if triggered by a P0 secret
   - `Lightweight | Standard → Critical` if triggered by a P0 dependency-cve
   The rationale is recorded in the Stage 0 classification output.

8. **Write state file.** Persist `findings[]` (including the new scan-sourced entries), `sec_baseline`, `sec_scanner_versions`, `matching_epoch`, and `sec_escalate_tier`. Mark `"stage-5a"` in `stages_completed`. Update `updated_at` to the current ISO timestamp. Write a copy to `.review-state/latest.json`.

---

## Normalization Table

This is the canonical mapping from scanner JSON to review-pipeline's finding schema (`state-schema.md`). Fix-and-verify carries an explicitly-marked convenience copy of this table in `fix-and-verify/references/security-gate-8.md`; both copies MUST stay in sync, with this file as the source of truth.

| Source | `severity` | `category` | `file` | `line_start` | `sec_identity_key` |
|---|---|---|---|---|---|
| Semgrep `"severity": "ERROR"` | `P1` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Semgrep `"severity": "WARNING"` | `P2` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Semgrep `"severity": "INFO"` | `P3` | `semgrep/<check_id>` | `path` | `start.line` | `semgrep:<extra.fingerprint>` |
| Gitleaks (any leak) | `P0` | `secrets` | `File` | `StartLine` | `gitleaks:<Fingerprint>` |
| OSV `"severity": "CRITICAL"` | `P0` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package_name>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "HIGH"` | `P1` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package_name>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "MEDIUM"` or `"MODERATE"` | `P2` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package_name>:<advisory_id>:<manifest_path>` |
| OSV `"severity": "LOW"` | `P3` | `dependency-cve` | `<manifest_path>` | `null` | `osv:<ecosystem>:<package_name>:<advisory_id>:<manifest_path>` |

**Notes:**

- Gitleaks findings are always `P0`. A live secret is always critical regardless of which scanner rule matched.
- OSV findings use the lockfile path (`<manifest_path>`) as `file` because CVEs attach to a package declaration, not a source line. `line_start` is `null`. The OSV JSON structure is `results[].packages[].vulnerabilities[]`; the `advisory_id` comes from `vulnerabilities[].id`, and the `ecosystem` + `package_name` come from `packages[].package.ecosystem` + `package.name`.
- The `match_based_id` field on Semgrep findings is populated from `extra.fingerprint`. This is the same value used in `sec_identity_key`, but it is also stored in its own field so fix-and-verify Gate 8 delta logic can look it up directly without parsing the identity key.
- OSV finding's `sec_identity_key` deliberately excludes `version` so that a dep bump from `pkg@1.0` to `pkg@1.1` (both in the same vulnerable range) keeps the same finding identity. A bump to a fixed version removes the identity from the current scan, which is then handled by the two-phase tombstoning rule in `convergence.md`.

---

## Dependency Manifests

OSV is skipped at Step 5A when the diff touches NONE of these files:

```
package.json
package-lock.json
yarn.lock
pnpm-lock.yaml
npm-shrinkwrap.json
requirements.txt
requirements-*.txt
Pipfile
Pipfile.lock
pyproject.toml
poetry.lock
go.mod
go.sum
Cargo.toml
Cargo.lock
pom.xml
build.gradle
build.gradle.kts
Gemfile
Gemfile.lock
composer.json
composer.lock
mix.exs
mix.lock
```

Match is by basename (case-insensitive). A diff that includes any one of these files triggers a full OSV run. A diff that includes none of them short-circuits OSV with `OSV_SKIP=1`.

---

## Per-source Quotas

The review-pipeline 15-finding cap (enforced at Stage 2 consolidation) must not be dominated by scan output. Quota rules:

- **Minimum 8 slots** reserved for agent-discovered findings (Stage 1 + Stage 3 specialists).
- **Maximum 7 slots** for scan-sourced findings. Within that budget:
  - Fill from P0 downward (secrets + critical CVEs first).
  - Then P1 (Semgrep ERROR, OSV HIGH).
  - Then P2 (Semgrep WARNING, OSV MEDIUM/MODERATE).
  - P3 scan findings are dropped if they would push the total above 7.
- If the scan produces more than 7 findings, Step 5A truncates BEFORE writing to `findings[]` and records `SEC_FINDING_QUOTA_EXCEEDED` in `errors[]` with the truncation count.
- Stage 2 does NOT re-truncate scan findings; the quota is pre-enforced. Stage 2 only applies the global 15-finding cap and dedup logic.

---

## `sec_escalate_tier` Decision Logic

The `sec_escalate_tier` flag is an INPUT to Stage 0's tier classification, not an output of Stage 5A alone. Its purpose is to let genuinely critical security findings override a would-be-Lightweight or would-be-Standard classification.

### Set `sec_escalate_tier=true` when

ANY scan-sourced finding in `findings[]` has:
- `severity: "P0"` AND `category IN {"secrets", "dependency-cve"}`

### Do NOT set the flag when

- Only P1/P2/P3 scan findings exist (bulk Semgrep warnings, LOW/MEDIUM CVEs). These do not escalate the tier.
- The highest-severity scan finding is P0 but `category` is `semgrep/*` rather than `secrets` or `dependency-cve`. Semgrep ERRORs map to P1, not P0, so this case is impossible in practice — but if a future scanner maps a Semgrep rule to P0 via a custom severity override, the tier escalation still requires the specific categories.

### Stage 0 response to the flag

When Stage 0 reads `sec_escalate_tier=true`, it upgrades the would-be-classification as follows:

- Triggered by P0 `secrets` finding: `Lightweight | Standard → Standard` (a live secret in a "small diff" is serious enough to warrant standard-tier review).
- Triggered by P0 `dependency-cve` finding: `Lightweight | Standard → Critical` (introducing a critical CVE in a lockfile merits full specialist review).
- Standard or Critical stays as-is; escalation never downgrades.

The rationale is appended to the Stage 0 classification output: *"Tier escalated to X by Step 5A `sec_escalate_tier` flag — finding: `<finding_id>` (<category>)"*.
