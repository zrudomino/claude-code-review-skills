# Batch Mode Orchestration

This file describes the full batch processing workflow invoked via `--punch-list`.

## Overview

Batch mode processes multiple findings SEQUENTIALLY, one at a time, in severity order (P0 first, then P1, P2, P3). There is NO parallel wave scheduling.

Hard cap: 8 findings per batch invocation. If more than 8 findings pass the pre-flight filter, process the first 8 and defer the rest.

## Step-by-Step

### 1. Hard Cap Check

After pre-flight filtering and severity sorting, count eligible findings.

- If count <= 8: proceed normally.
- If count > 8: take the first 8 (highest severity first). Set aside the remaining N findings. At the end of the run, report: "Remaining N findings deferred. Re-run /fix-and-verify --punch-list <file> to continue."

### 2. Create Integration Branch

Before creating the integration branch, verify the working tree is clean: `git status --porcelain`. If there are uncommitted changes, error: "Working tree has uncommitted changes. Commit or stash before running batch mode."

Capture the current branch: `ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)`

```bash
git checkout -b fix-batch-<timestamp>
```

All cherry-picks from individual worktrees land on this branch. Use a Unix timestamp for `<timestamp>` (e.g., `fix-batch-1712534400`).

### 3. Sequential Processing Loop

For each finding (in severity order, one at a time):

#### a. Create Worktree

```bash
git worktree add .worktrees/fix-<finding_id> HEAD
```

For subsequent findings that touch the same file AND have overlapping or adjacent line ranges (within 10 lines) as an already-processed finding, create the worktree from the integration branch tip instead, to build on prior fixes. Findings on the same file but with non-overlapping line ranges (> 10 lines apart) may use independent worktrees from HEAD.

```bash
git worktree add --detach .worktrees/fix-<finding_id> fix-batch-<timestamp>
```

Using `--detach` avoids the "branch already checked out" error.

If worktree creation fails, report `WORKTREE_CREATE_FAILED` with the git error output. Escalate that finding. Continue to the next finding.

#### b. Run Steps 0-5 in the Worktree

Execute the full red-green-commit loop (Steps 0-5) for this finding inside the worktree. Do not start the next finding until this one is complete (success, escalation, or skip).

#### c. Cherry-Pick to Integration Branch

After a successful commit in the worktree:

```bash
git cherry-pick <commit-sha>
```

If the cherry-pick produces conflicts, report `MERGE_CONFLICT` and escalate both the current finding and any finding whose prior fix conflicts. Do not attempt further fixes on conflicting findings.

#### d. Run Gate 2 on Integration Branch (Regression Check)

After each cherry-pick, run gate 2 (full test suite) on the integration branch to detect cascading regressions.

If a previously-passing test now fails, this is a `DEPENDENCY_CONFLICT`. Flag both the current finding and the finding whose fix caused the regression. Escalate both to human. Do not attempt further fixes on either.

**Note:** Gate 6 and 7 are not re-run on the integration branch -- they are only checked per-worktree. For P0/P1 batches, consider running Gate 6 on the integration branch after all cherry-picks are complete.

#### e. Write Status Back

Immediately after each finding completes (success or escalation), write the updated status back to the state file. Do not batch writes to the end. See the write-back contract in SKILL.md Step 5.

#### f. Clean Up Worktree

```bash
git worktree remove .worktrees/fix-<finding_id>
```

If cleanup fails, warn `WORKTREE_CLEANUP_FAILED` and continue to the next finding. Manual cleanup will be needed.

### 4. Final Report

After all findings are processed, output the batch summary as described in the Output Format section of SKILL.md. Include:

- Integration branch name
- Number of successful cherry-picks vs total
- List of conflicts (or "none")
- Deferred findings (if cap was reached)
- Skipped [JUDGMENT] findings
- Escalated findings

### 5. Branch Cleanup

If zero cherry-picks succeeded (all findings were escalated, skipped, or failed), delete the integration branch:

```bash
git checkout $ORIGINAL_BRANCH && git branch -D fix-batch-<timestamp>
```

Switch back to the original branch before deleting the integration branch.

This prevents orphaned branches from accumulating in the repo.

## Dependency Conflict Detection

If running gate 2 on the integration branch after cherry-picking finding B causes a test that passed after finding A's fix to now fail:

1. Mark both findings with error code `DEPENDENCY_CONFLICT`.
2. Escalate both to human.
3. Do not attempt further processing on either finding.
4. Write `status: "escalated"` for both to the state file immediately.
