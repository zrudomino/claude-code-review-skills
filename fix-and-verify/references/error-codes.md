# Error Codes Reference

All error codes produced by the fix-and-verify skill. Each entry includes the code, meaning, and recovery action.

| Code | Meaning | Recovery |
|------|---------|----------|
| `INVALID_FINDING_SCHEMA` | Finding JSON is missing required fields or has invalid values | Skip finding (batch) or stop (single-finding mode) |
| `FILE_NOT_FOUND` | Target file referenced in finding does not exist in the repository | Skip finding (batch) or stop (single-finding mode) |
| `WORKTREE_CREATE_FAILED` | `git worktree add` failed | Report git error output; escalate finding to human |
| `WORKTREE_CLEANUP_FAILED` | `git worktree remove` failed after processing | Warn and continue; manual cleanup needed |
| `MERGE_CONFLICT` | Cherry-pick or patch application produced unresolvable conflicts | Escalate both the current finding and any prior finding whose fix conflicts |
| `TOOL_MISSING` | Required gate tool not found in environment | Escalate -- do not mark gate as passed |
| `TOOL_TIMEOUT` | Gate tool exceeded its timeout | Retry gate once; if still times out, escalate |
| `TOOL_CRASH` | Gate tool exited with a signal or abnormal exit code | Retry gate once; if same error, escalate |
| `TOOL_ERRORS` | Gate tool ran but reported errors within diff scope (non-zero exit, not a crash) | Treat as gate failure; route per failure routing table |
| `RED_PHASE_FAILED` | Test passes without a fix (bug may already be resolved, or test is wrong) | Escalate to human with test file and finding details |
| `AGENT_SPAWN_FAILED` | Agent tool call failed or timed out | Retry once; if still fails, escalate the finding |
| `AGENT_D_DISPATCH_FAILED` | Codex Adversarial dispatch failed (timeout, auth error, network error). Must use `Skill: codex-agent:dispatch`, NOT the Agent tool. | For P0/P1: escalate (mandatory). For P2/P3: warn and proceed to Step 5. |
| `DEPENDENCY_CONFLICT` | Fixing one finding caused a previously-passing test (from a prior finding's fix) to fail | Escalate both findings to human; do not attempt further fixes on either |
| `SEC_BASELINE_FAILED` | Step 0 security baseline scan could not produce a usable result (scan exit 2, missing report file, or required scanner skipped via env var) | Hard fail this finding; do NOT proceed to Step 1. A fix cannot be green-gated on an unknown starting security state. |
| `SEC_SCAN_INCOMPLETE` | Gate 8 scan returned `complete=false` (timeout, tool error, missing scanner, or required scanner skipped via env var) | Escalate immediately. Per Invariant 13, do NOT route back to Step 2 -- the fix may be correct; the failure is in verification infrastructure. |
| `SEC_EPOCH_ADVANCED_MID_FIX` | Scanner versions changed between Step 0 baseline and Gate 8 scan (Semgrep upgraded, Gitleaks pattern update, etc.) | Escalate immediately. Per Invariant 14, do NOT attempt to match findings across epoch boundaries. A re-baseline is required. |
| `SEC_GATE8_RETRY_EXHAUSTED` | Gate 8 failed (new security finding detected) after all `max_attempts` have been consumed | Escalate immediately with the full list of new findings. Do NOT attempt another retry (Invariant 7: the attempt cap is hard). |
| `SEC_FINDING_QUOTA_EXCEEDED` | Step 5A ingested more than 7 scan-sourced findings (the per-source quota cap); the overflow was truncated | Informational only; continue processing. Recorded in `errors[]` with the truncation count. |
