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
| `RED_PHASE_FAILED` | Test passes without a fix (bug may already be resolved, or test is wrong) | Escalate to human with test file and finding details |
| `AGENT_SPAWN_FAILED` | Agent tool call failed or timed out | Retry once; if still fails, escalate the finding |
| `AGENT_D_DISPATCH_FAILED` | Codex Adversarial dispatch failed (timeout, auth error, network error). Must use `Skill: codex-agent:dispatch`, NOT the Agent tool. | For P0/P1: escalate (mandatory). For P2/P3: warn and proceed to Step 5. |
| `DEPENDENCY_CONFLICT` | Fixing one finding caused a previously-passing test (from a prior finding's fix) to fail | Escalate both findings to human; do not attempt further fixes on either |
