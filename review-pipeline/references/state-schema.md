# State Schema Reference

Every run persists a `.review-state/<run_id>.json` file. The canonical schema is version 2.

## Full Schema

```json
{
  "schema_version": 2,
  "run_id": "<uuid>",
  "branch_name": "<string>",
  "base_commit": "<sha>",
  "diff_fingerprint": "<sha>",
  "files_scope": null,
  "classification": "Lightweight|Standard|Critical",
  "stages_completed": [],
  "gate_6_baseline": null,
  "gate_7_baseline": null,
  "gate_6_post_autofix": null,
  "gate_7_post_autofix": null,
  "sec_baseline": null,
  "sec_scanner_versions": null,
  "matching_epoch": 1,
  "sec_escalate_tier": false,
  "findings": [
    {
      "finding_id": "<uuid>",
      "severity": "P0|P1|P2|P3",
      "tag": "[AUTO-FIX]|[CONFIRM]|[JUDGMENT]|[CONFLICT]",
      "category": "<string>",
      "file": "<path>",
      "line_start": 0,
      "line_end": 0,
      "symbol": null,
      "description": "<string>",
      "expected_behavior": null,
      "actual_behavior": null,
      "reporters": ["<agent_name>"],
      "auto_fixed": false,
      "status": "open|fixed|dismissed|escalated",
      "run_id": null,
      "fixed_at": null,
      "fixed_by_run": null,
      "escalated_at": null,
      "escalation_reason": null,
      "dismissed_at": null,
      "dismissed_reason": null,
      "scan_artifact_path": null,
      "match_based_id": null,
      "sec_identity_key": null
    }
  ],
  "run_history": [
    {
      "timestamp": "<ISO>",
      "finding_count": 0,
      "p0_p1_count": 0,
      "p3_only": false,
      "escalated_count": 0
    }
  ],
  "errors": [
    {
      "timestamp": "<ISO>",
      "stage": "<stage or step where error occurred>",
      "error_code": "<TOOL_MISSING|AGENT_SPAWN_FAILED|etc>",
      "detail": "<what specifically failed and why>",
      "finding_id": null,
      "recovery": "<what the pipeline did: skipped|retried|escalated|continued>"
    }
  ],
  "created_at": "<ISO>",
  "updated_at": "<ISO>"
}
```

**All timestamps** in the state file must be ISO 8601 UTC (e.g., `2026-04-08T14:32:00Z`). Do not use local time.

## Field Notes

### Top-level fields

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | integer | Must be `2`. Consumers must reject files with mismatched version. |
| `run_id` | string (uuid) | Unique identifier for this run. Also used as the lock file name and state file name. |
| `files_scope` | array\|null | Array of paths if `--files` was used, `null` otherwise. Used to re-scope diffs on resume. |
| `stages_completed` | array | Valid values: `"pre-stage"`, `"stage-5a"`, `"stage-0"`, `"stage-1"`, `"stage-2"`, `"stage-3"`, `"stage-4"`. Append each stage name when it completes. No duplicates allowed; use set-membership check. On resume, deduplicate if needed. `"stage-5a"` is the Security Corpus Seeding stage that runs between `"pre-stage"` and `"stage-0"` — see `security-corpus.md` for the full procedure. |
| `gate_6_baseline` | integer\|null | Lint + type check warning count captured during pre-stage, before any modifications. `null` until pre-stage runs; `0` means pre-stage ran and found zero warnings. |
| `gate_7_baseline` | object\|null | Per-file coverage map captured during pre-stage (e.g. `{"src/foo.py": 85.2}`). `null` if no coverage tool detected. |
| `gate_6_post_autofix` | integer\|null | Lint + type check warning count captured after Stage 2 auto-fixes complete. `null` until Stage 2 finishes. |
| `gate_7_post_autofix` | object\|null | Per-file coverage map captured after Stage 2 auto-fixes complete. `null` until Stage 2 finishes (or if no coverage tool). |
| `sec_baseline` | object\|null | Captured at Step 5A (Security Corpus Seeding). Structure: `{ "semgrep": [<normalized_findings>], "gitleaks": [<normalized_findings>], "osv": [<normalized_findings>], "captured_at": "<ISO>", "complete": true\|false }`. `complete: false` means at least one scanner was skipped (`*_SKIP` env var), errored, timed out, or was missing — downstream consumers MUST NOT use an incomplete baseline as the basis for a delta comparison. `null` until Step 5A runs. |
| `sec_scanner_versions` | object\|null | `{ "semgrep": "<version>", "gitleaks": "<version>", "osv-scanner": "<version>" }`. Populated at Step 5A by probing each tool. Used to detect matching-epoch bumps across runs. `null` until Step 5A runs. |
| `matching_epoch` | integer | Starts at `1`. Bumped whenever any entry in `sec_scanner_versions` changes between consecutive runs. Security-finding convergence matching is scoped within a single epoch only — across an epoch bump, all security findings are re-ingested as fresh and the previous epoch's security findings are dropped from the match set. Non-security findings are unaffected. |
| `sec_escalate_tier` | boolean | Set to `true` at Step 5A ONLY if a security finding was ingested with `severity: "P0"` AND `category IN {"secrets", "dependency-cve"}`. Stage 0 reads this flag and, if set, upgrades the tier classification. Bulk Semgrep warnings do NOT set this flag. Default `false`. |

### Errors array

The `errors` array captures structured diagnostics for every failure encountered during the run. Append an entry whenever: an agent fails to spawn, a gate tool crashes/times out, a Codex dispatch fails, a worktree creation fails, or any error code is triggered. This array is never cleared — it accumulates across the run so humans and future convergence rounds can see the full failure history, not just the final outcome.

| Field | Type | Notes |
|-------|------|-------|
| `timestamp` | ISO string | When the error occurred (UTC). |
| `stage` | string | Pipeline stage or fix-and-verify step (e.g., `"stage-1"`, `"step-3-gate-2"`, `"codex-dispatch"`). |
| `error_code` | string | Matches a code from `error-codes.md` or a pipeline-specific code (e.g., `AGENT_UNAVAILABLE`, `TOOL_MISSING`). |
| `detail` | string | What specifically failed — include tool name, agent type, exit code, error message snippet. |
| `finding_id` | string\|null | The finding this error relates to, if applicable. `null` for pipeline-level errors. |
| `recovery` | string | What the pipeline did: `"skipped"`, `"retried"`, `"escalated"`, `"continued"`, `"stopped"`. |

### Finding fields

| Field | Type | Notes |
|-------|------|-------|
| `finding_id` | string (uuid) | Stable identifier. Preserved across convergence rounds. |
| `reporters` | array of strings | Agent names that reported this finding. ALWAYS an array. Never a bare string. |
| `run_id` | string\|null | The `run_id` of the review-pipeline run that created this finding. Set when the finding is first written to the state file (during Stage 1 or Stage 2). Preserved across convergence rounds. |
| `symbol` | string\|null | Function/method/class name, if applicable. Used in Level 3 convergence matching. |
| `expected_behavior` | string\|null | Optional. Not all agents produce this. |
| `actual_behavior` | string\|null | Optional. Not all agents produce this. |
| `fixed_at` | ISO string\|null | Timestamp (UTC) when status changed to `fixed`. |
| `fixed_by_run` | string\|null | The top-level `run_id` from the review-pipeline state file that contained this finding. Written by fix-and-verify. This is the source run ID, not a fix-and-verify invocation ID. |
| `escalated_at` | ISO string\|null | Timestamp when status changed to `escalated`. |
| `escalation_reason` | string\|null | Human-readable reason for escalation. |
| `dismissed_at` | ISO string\|null | Timestamp (UTC) when status changed to `dismissed`. |
| `dismissed_reason` | string\|null | Reason for dismissal (e.g., "false positive identified by Skeptic", or `"sec_baseline"` for scan-sourced findings ingested as pre-existing debt at Step 5A, or `"sec_resolved_pending"` for security findings absent from the current scan awaiting one more confirmation round before being marked `fixed` — see security-finding tombstoning in `convergence.md`). |
| `scan_artifact_path` | string\|null | For findings originating from `local-security-scan`: path to the raw JSON report under `<project>/.sec-scan/` that produced this finding (`.sec-scan/semgrep.json`, `.sec-scan/gitleaks.json`, `.sec-scan/osv.json`). Lets Stage 1 agents and fix-and-verify trace back to the source. `null` for agent-sourced findings. |
| `match_based_id` | string\|null | Semgrep's line-stable fingerprint (from the `extra.fingerprint` field of Semgrep JSON output). Used by fix-and-verify Gate 8 delta logic so a finding's identity survives line-number shifts caused by unrelated edits above it. `null` for non-Semgrep findings. |
| `sec_identity_key` | string\|null | Stable identity key used for convergence matching of security findings. Format depends on source: `semgrep:<extra.fingerprint>`, `gitleaks:<Fingerprint>`, or `osv:<ecosystem>:<package>:<advisory_id>:<manifest_path>` (version deliberately excluded so dep-version bumps inside a vulnerable range stay the same finding). The `finding_id` for scan-sourced findings is generated as UUID v5 keyed on this value, making identity deterministic across fresh-state runs within a single `matching_epoch`. `null` for agent-sourced findings. |

### Normalization rule

If a finding loaded from a state file contains a `reviewer` field (old schema v1 format) instead of `reporters`, convert it: `reporters: [reviewer]`. Remove the `reviewer` field. Write the normalized form back before processing.

During normalization, `finding_id` values are preserved as-is. Do not regenerate them.

**Unknown fields policy:** Consumers must preserve unknown top-level fields when writing back to a state file (additive forward-compatibility). Do not strip fields not present in the current schema version.

### Migration Rules

All schema migrations are defined here. Both SKILL.md files should say "Apply migrations per state-schema.md" rather than re-specifying transformations.

| From Version | To Version | Transformation |
|-------------|------------|----------------|
| 1 | 2 | For each finding: if `reviewer` (string) exists, replace with `reporters: [reviewer]`, remove `reviewer`. Set `schema_version` to `2`. Write back. |

### Finding status transitions

| From | To | Trigger |
|------|----|---------|
| `open` | `fixed` | fix-and-verify commits a fix; set `fixed_at` and `fixed_by_run` |
| `open` | `dismissed` | Skeptic (review-pipeline Stage 4) or human marks as false positive; set `status: "dismissed"`, `dismissed_at`, and `dismissed_reason` |
| `open` | `escalated` | fix-and-verify exhausts retry attempts; set `escalated_at` and `escalation_reason` |
| `open` | `fixed` | review-pipeline Stage 2 auto-fix succeeds; set `auto_fixed: true`, `fixed_at` |
| _(created as)_ | `dismissed` | Scan-sourced finding ingested at Step 5A as pre-existing baseline debt. Scan-sourced findings are inserted with `status: "dismissed"`, `dismissed_reason: "sec_baseline"` on first sight so they do not count against convergence stop condition 1 and do not block fix-and-verify Gate 8. This is the only case where a finding is created directly in a non-`open` state. |
| `dismissed` (sec_baseline or sec_resolved_pending) | `dismissed` (sec_resolved_pending) | Step 5A rescans and a scan-sourced finding is absent from the current scan. First absent round: mark `dismissed_reason: "sec_resolved_pending"`. See `convergence.md` security-finding tombstoning. |
| `dismissed` (sec_resolved_pending) | `fixed` | Step 5A rescans and the finding is STILL absent on the next consecutive run. Set `fixed_at`; promote out of the pending state. Two consecutive absences are required to suppress dep-bump CVE churn. |

No other transitions are valid. Status never reverts from `fixed`, `dismissed`, or `escalated` back to `open`.

**Tag mutability:** Finding tags (e.g., `[CONFLICT]` -> `[CONFIRM]`) can change independently of status. The Architect agent may reclassify a `[CONFLICT]` finding as `[CONFIRM]` after adjudication. The transitions table above covers only `status` changes.

### Re-run behavior

When starting a new convergence round (not `--resume` but a fresh invocation after fixes), create a new state file with a new `run_id`. Copy the previous run's findings (preserving their status and all fields), copy `run_history` from the previous state file, and reset `stages_completed` to `[]`. This allows all stages to run fresh while preserving finding history for convergence matching.

Update the state file after every stage completion and after applying auto-fixes.

### Stable handoff path

After writing the state file, also write a copy to `.review-state/latest.json`. This provides a stable path for fix-and-verify and other consumers to reference without needing the specific `run_id`.
