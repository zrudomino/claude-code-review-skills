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
  "gate_6_baseline": 0,
  "gate_7_baseline": null,
  "gate_6_post_autofix": null,
  "gate_7_post_autofix": null,
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
      "escalation_reason": null
    }
  ],
  "run_history": [
    {
      "round": 1,
      "timestamp": "<ISO>",
      "finding_count": 0,
      "p0_p1_count": 0,
      "p3_only": false
    }
  ],
  "created_at": "<ISO>",
  "updated_at": "<ISO>"
}
```

## Field Notes

### Top-level fields

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | integer | Must be `2`. Consumers must reject files with mismatched version. |
| `run_id` | string (uuid) | Unique identifier for this run. Also used as the lock file name and state file name. |
| `files_scope` | array\|null | Array of paths if `--files` was used, `null` otherwise. Used to re-scope diffs on resume. |
| `stages_completed` | array | Valid values: `"pre-stage"`, `"stage-0"`, `"stage-1"`, `"stage-2"`, `"stage-3"`, `"stage-4"`. Append each stage name when it completes. |
| `gate_6_baseline` | integer | Lint + type check warning count captured during pre-stage, before any modifications. |
| `gate_7_baseline` | object\|null | Per-file coverage map captured during pre-stage (e.g. `{"src/foo.py": 85.2}`). `null` if no coverage tool detected. |
| `gate_6_post_autofix` | integer\|null | Lint + type check warning count captured after Stage 2 auto-fixes complete. `null` until Stage 2 finishes. |
| `gate_7_post_autofix` | object\|null | Per-file coverage map captured after Stage 2 auto-fixes complete. `null` until Stage 2 finishes (or if no coverage tool). |

### Finding fields

| Field | Type | Notes |
|-------|------|-------|
| `finding_id` | string (uuid) | Stable identifier. Preserved across convergence rounds. |
| `reporters` | array of strings | Agent names that reported this finding. ALWAYS an array. Never a bare string. |
| `run_id` | string\|null | The `run_id` of the review-pipeline run that created this finding. Injected when findings are extracted from a state file. |
| `symbol` | string\|null | Function/method/class name, if applicable. Used in Level 3 convergence matching. |
| `expected_behavior` | string\|null | Optional. Not all agents produce this. |
| `actual_behavior` | string\|null | Optional. Not all agents produce this. |
| `fixed_at` | ISO string\|null | Timestamp when status changed to `fixed`. |
| `fixed_by_run` | string\|null | `run_id` of the run that fixed this finding. |
| `escalated_at` | ISO string\|null | Timestamp when status changed to `escalated`. |
| `escalation_reason` | string\|null | Human-readable reason for escalation. |

### Normalization rule

If a finding loaded from a state file contains a `reviewer` field (old schema v1 format) instead of `reporters`, convert it: `reporters: [reviewer]`. Remove the `reviewer` field. Write the normalized form back before processing.

### Finding status transitions

| From | To | Trigger |
|------|----|---------|
| `open` | `fixed` | fix-and-verify commits a fix; set `fixed_at` and `fixed_by_run` |
| `open` | `dismissed` | Skeptic or human marks as false positive |
| `open` | `escalated` | fix-and-verify exhausts retry attempts; set `escalated_at` and `escalation_reason` |

No other transitions are valid. Status never reverts from `fixed`, `dismissed`, or `escalated` back to `open`.

### Re-run behavior

When starting a new convergence round (not `--resume` but a fresh invocation after fixes), create a new state file with a new `run_id`. Copy the previous run's findings (preserving their status and all fields) and reset `stages_completed` to `[]`. This allows all stages to run fresh while preserving finding history for convergence matching.

Update the state file after every stage completion and after applying auto-fixes.

### Stable handoff path

After writing the state file, also write a copy to `.review-state/latest.json`. This provides a stable path for fix-and-verify and other consumers to reference without needing the specific `run_id`.
