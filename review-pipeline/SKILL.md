---
name: review-pipeline
version: 0.3.0
description: >
  This skill should be used when the user asks to "review my code", "run a code review",
  "review this PR", "check my diff", "analyze these changes", "do a security review",
  "audit my code", "check for bugs", "review before I push", or "what's wrong with my diff".
  It orchestrates a multi-stage, tiered code review pipeline with deterministic checks,
  parallel agent analysis, convergence tracking, and optional auto-fix.
---

# Review Pipeline

You are executing a multi-stage code review pipeline. Follow each stage precisely. The pipeline flow is:

**Parse Arguments -> Resume? (if --resume) -> Lock -> Convergence Check -> Pre-Stage -> Stage 5A (Security Corpus Seeding) -> Stage 0 -> Stage 1 -> Stage 2 -> Stage 3 -> Stage 4 -> Output -> Cleanup**

## Invariants -- Never Violate These

1. **Lightweight tier STOPS after Stage 2.** Do not run Stage 3 or Stage 4 for Lightweight diffs.
2. **Critical force-flag is always accepted.** Never reject `--critical`.
3. **Force-flag safety override for non-Critical tiers.** If `--lightweight` or `--standard` is passed but diff contains Critical-pattern files, REJECT -- do not downgrade.
4. **No PID, no heartbeat, no background timer.** Lock freshness is checked via `written_at` timestamps only.
5. **Finding schema is canonical here.** fix-and-verify references this skill's schema; it does not redefine it.
6. **`reporters` is always an array.** Never produce a bare `reviewer` string.
7. **Gate 4 (API fuzz) is advisory only.** It never blocks the pipeline.
8. **Never substitute an Agent tool call for a Codex dispatch.** Codex provides cross-model architectural diversity -- a Claude/Opus agent reviewing its own model family's work cannot catch the same blind spots. Always use `Skill: codex-agent:dispatch`, never the Agent tool, for Codex Adversarial testing.
9. **Gate 5 (patch size) is advisory for P2/P3 and conditionally escalating for P0/P1.** It never causes a retry loop. Escalate (to human) if > 200 lines for P0/P1.
10. **Never treat `scan_incomplete` as a clean result.** `sec_baseline.complete=false` (from Step 5A) means one or more scanners timed out, errored, were missing, or were skipped via env var when they were required for this run. Step 5A MUST append a `SEC_SCAN_INCOMPLETE` entry to `errors[]` and propagate `complete=false` through the state file. Downstream stages (Stage 1 prompt augmentation, Stage 0 tier escalation) and any consuming skill (fix-and-verify Gate 8) MUST treat an incomplete baseline as unreliable and MUST NOT use it as the basis for a delta comparison. A silent pass on an incomplete scan is a hard invariant violation — the whole point of Step 5A is to surface what the static scanner found, and "found nothing" is not the same as "scanner didn't run."

## Parse Arguments

Parse the user's arguments:

| Argument | Description |
|----------|-------------|
| `--lightweight` | Force Lightweight tier |
| `--standard` | Force Standard tier |
| `--critical` | Force Critical tier (always accepted) |
| `--files <paths>` | Review specific files instead of full git diff HEAD. When provided: generate diffs with `git diff HEAD -- <paths>`, restrict `--stat`/`--name-only`/`--shortstat` to those paths, skip caller analysis outside those paths (exception: Lightweight qualification always uses repo-wide caller analysis regardless of --files), and scope deterministic checks to only the stacks those files belong to. On `--resume`, the stored `files_scope` is reused automatically. |
| `--resume <id>` | Resume from a previous run's state file |
| `--no-autofix` | Skip auto-fix in Stage 2 |
| `--verbose` | Show P3 findings (suppressed by default) |

**Mutual exclusivity:** Only one of `--lightweight`, `--standard`, `--critical` may be provided. If multiple are given, error: "Only one tier flag may be specified. Got: [list]."

**Empty repo check:** If `git rev-parse HEAD` fails (exit non-zero), error: "Repository has no commits. Create an initial commit before running the review pipeline."

**Diff size check:** Run `git diff HEAD [-- <paths>]` and count the total characters (including diff headers). If the diff exceeds 50,000 characters, error: "Diff too large. Use --files to narrow scope."

## Handle Resume

If `--resume <id>` is provided:

1. Read `.review-state/<id>.json`
2. If the file does not exist, error: "No state file found for run <id>"
3. If `schema_version` is `1`, apply migrations per `references/state-schema.md` Migration Rules (v1 -> v2). Write back.
4. Compare stored `branch_name` to current `git rev-parse --abbrev-ref HEAD`. If they differ, error: "Branch has changed since run <id>. Start a new run."
5. Compare stored `base_commit` to current merge-base (run `git merge-base HEAD main` or the detected default branch). Detect default branch: read the file `.git/refs/remotes/origin/HEAD` using the Read tool and strip the `ref: refs/remotes/origin/` prefix. If the file does not exist, try `main`, then `master`. If both `main` and `master` exist as remote branches and `origin/HEAD` cannot be resolved, warn: "Cannot determine default branch -- defaulting to `main`. Pass `--base-branch <branch>` to override." If the merge-base differs, error: "Base commit has changed since run <id>. Start a new run."
6. Compute a diff fingerprint: `git diff HEAD [-- <stored files_scope>] | git hash-object --stdin`. If it differs from stored `diff_fingerprint`: warn "Diff has changed since run <id> -- new findings may not match previous run." Also clear `gate_6_baseline`, `gate_7_baseline`, `gate_6_post_autofix`, and `gate_7_post_autofix` from the state so Pre-Stage will re-capture fresh baselines.
7. Skip stages already completed (check `stages_completed` array in state)
8. Load existing findings array and continue from next stage

## Lock File Management

The lock schema is: `{ "schema_version": 2, "run_id": "<uuid>", "created_at": "<ISO>", "stage_reached": "<stage>", "written_at": "<ISO>" }`. There is no PID, no heartbeat, no background timer.

**Acquire the lock:**

1. Check for `.review-state/*.lock` files.
2. For each lock file found, read it and check stale conditions:

| Condition | Action |
|-----------|--------|
| Lock's `written_at` > 15 minutes ago AND state file's `updated_at` > 15 minutes ago | Stale lock. Delete it. Warn: "Stale lock from hung run cleaned up." |
| Lock's `written_at` > 15 minutes ago AND state file's `updated_at` <= 15 minutes ago (recent) | Active run in a long stage. Treat as active. Error: "Run [run_id] appears to be in a long-running stage (lock stale but state recently updated). Wait or delete the lock manually." |
| Lock's `written_at` <= 15 minutes ago (fresh) | Active run. Error: "Another pipeline run is in progress (run_id: <id>). Wait for it to complete or delete `.review-state/<id>.lock` manually." |
| Lock exists but no state file for that run_id exists | Crashed run. Delete lock. Warn: "Lock from crashed run (no state file) cleaned up." |

To read the state file's `updated_at`, load `.review-state/<lock.run_id>.json` and read its `updated_at` field.

The `updated_at` field must be refreshed every time the state file is written.

3. Create `.review-state/<run_id>.lock` with the lock schema. Set `stage_reached` to `"init"` and `written_at` to now.

**TOCTOU note:** Lock acquisition is not atomic -- between checking for existing locks and creating a new one, another invocation could also see no lock and create its own. Do not run two pipeline instances simultaneously on the same repository.

**Update the lock** at every stage boundary: write the lock file again with updated `written_at` and the new `stage_reached`. This is synchronous -- write the lock file before beginning the stage's work.

Note: if a stage takes longer than 15 minutes (e.g., waiting for agents in Stage 1), the lock may appear stale to another invocation. This is an accepted trade-off -- Claude cannot update the lock while waiting for a tool call to return. The 15-minute threshold is chosen to be longer than typical stage durations.

**Release the lock** by deleting `.review-state/<run_id>.lock` after writing final output.

## Convergence Check (before Stage 0)

Run this check immediately after acquiring the lock, before any other pipeline work. See `references/convergence.md` for the full matching algorithm and stop conditions.

**When to run:** If the state file (from `--resume` or a detected prior run for the same branch) contains `run_history` with at least one entry, run convergence matching. To detect a prior run: read `.review-state/latest.json`. If it exists and its `branch_name` matches the current branch, use it as the prior run's state file. If `latest.json` exists but its `branch_name` does not match the current branch, treat as no prior run (proceed without convergence check). Do not search other state files. If `--resume` is active, use the resumed state file's `run_history` as the convergence baseline. Do not also check `latest.json` separately.

**What to do:**
1. Load the prior run's findings (those with `status: "fixed"`, `"dismissed"`, or `"escalated"` as well as `"open"`).
2. Evaluate stop conditions in order using ONLY the prior run's findings and `run_history`. Do not use "current findings" -- none exist yet. If a stop condition is met, output the current punch list and stop -- do not proceed to Stage 0. Append a `run_history` record (see `references/convergence.md`). Write state file. Set `updated_at` to the current ISO timestamp before writing. Write `.review-state/latest.json`. Delete lock file.
3. If no stop condition is met, continue to Pre-Stage.

Actual finding-to-finding matching between the new run's findings and prior findings occurs after Stage 2, not here. At this pre-Stage-0 checkpoint, evaluate stop conditions 1, 3, 4, and 5 using only the prior run's findings and run_history. Stop Condition 2 (regression detection) requires comparing prior and current findings and is deferred to post-Stage-2 matching -- skip it here.

## Pre-Stage: Deterministic Checks

Detect the project stack using marker files (use the Glob tool -- do not use shell `find` commands). See `references/stack-table.md` for the full detection table, JS/TS disambiguation rules, tool table, and failure handling.

Before writing any file to `.review-state/`, create the directory if it does not exist: `mkdir -p .review-state`.

Run each detected stack's tools scoped to its package root. In monorepos, discover package roots up to 3 levels deep.

**Capture gate baselines** (see `references/gate-registry.md` for Gate 6 and Gate 7 baseline definitions):
- Run lint + type check. Count total warnings. Store as `gate_6_baseline`.
- Run coverage on changed files. Store per-file percentages as `gate_7_baseline` (or `null`).

**Write state file. Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"pre-stage"`. Mark `"pre-stage"` in `stages_completed`.**

When creating a new state file (not resuming), populate these fields: `run_id` (generate UUID), `branch_name` (from `git rev-parse --abbrev-ref HEAD`), `base_commit` (from `git merge-base HEAD <default_branch>`), `diff_fingerprint` (from `git diff HEAD [-- <paths>] | git hash-object --stdin`), `created_at` and `updated_at` (current ISO timestamp), `errors: []` (empty array — will accumulate diagnostic records during the run).

## Step 5A: Security Corpus Seeding

After Pre-Stage correctness gates pass and before Stage 0 classification, run `local-security-scan` to seed the finding corpus with SAST / secret / CVE findings that review agents cannot reliably detect. Findings are inserted as `status: "dismissed", dismissed_reason: "sec_baseline"` on first sight so they do not count against convergence stop condition 1 or block fix-and-verify Gate 8.

**Skip OSV** if the diff touches no dependency manifest. **Tier-escalate** via `sec_escalate_tier` if a P0 secret or P0 CVE is seen (Stage 0 reads the flag). **Respect invariant 10**: an incomplete scan is NEVER a clean result.

**Full procedure, normalization table, dependency-manifest list, per-source quota rules, and `sec_escalate_tier` decision logic:** `references/security-corpus.md`.

**Write state file: update `findings[]`, `sec_baseline`, `sec_scanner_versions`, `matching_epoch`, `sec_escalate_tier`. Set `updated_at` to the current ISO timestamp. Update lock `written_at` and `stage_reached` to `"stage-5a"`. Mark `"stage-5a"` in `stages_completed`.**

## Stage 0: Change Classification

Get the diff:

```bash
git diff HEAD --stat [-- <paths>]
git diff HEAD --name-only [-- <paths>]
git diff HEAD --shortstat [-- <paths>]
```

Classify into one of three tiers:

**Lightweight** -- ALL of the following must be true:
- <= 3 files changed
- <= 120 lines changed (additions + deletions)
- No files matching Critical patterns (below)
- No external callers of modified functions found via the Grep tool (search for the function/method name in files with matching extensions outside the changed files). Caller analysis is always repo-wide, even when `--files` is set, because Lightweight requires proving no external callers exist anywhere.

**Critical** -- ANY of the following file patterns match:

| Pattern Category | Patterns |
|-----------------|---------|
| Auth / security | `**/auth*`, `**/security*`, `**/role*`, `**/token*`, `**/permission*` |
| Schema / migration | `**/migrations/**`, `**/alembic/**`, `**/schema*` |
| Finance | `**/finance*`, `**/stock*`, `**/ledger*`, `**/payment*` |
| Concurrency | `**/*async*`, `**/*concurren*`, `**/*lock*` |
| Infrastructure / deps | `.env*`, `Dockerfile*`, `docker-compose*`, `**/deps*`, `requirements*.txt`, `package.json` (only if `dependencies` or `devDependencies` sections were modified in the diff) |

**Standard** -- everything else.

**Force-flag safety override:**

| Situation | Action |
|-----------|--------|
| `--lightweight` or `--standard` passed but diff contains Critical-pattern files | Error: "This diff contains Critical-tier files ([list]). Use `--critical` or remove the force flag." |
| `--critical` passed regardless of diff content | Always accepted |

**Security tier escalation (reads `sec_escalate_tier` from Step 5A):** After the base classification above, if `sec_escalate_tier == true` in the state file, upgrade the tier:

| Trigger | Upgrade |
|---------|---------|
| P0 `secrets` finding in Step 5A baseline | `Lightweight \| Standard → Standard` (never downgrade; Critical stays Critical) |
| P0 `dependency-cve` finding in Step 5A baseline | `Lightweight \| Standard → Critical` (never downgrade) |

Bulk Semgrep warnings do NOT trigger escalation — only confirmed P0 secrets or critical CVEs. Append the escalation rationale to the classification record: *"Tier escalated to X by Step 5A `sec_escalate_tier` flag — finding: `<finding_id>` (`<category>`)"*. See `references/security-corpus.md` for the full decision logic.

**Write classification and `files_scope` to state file. Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"stage-0"`. Mark `"stage-0"` in `stages_completed`.**

## Stage 1: Parallel Broad Scan

Read the full diff content:

```bash
git diff HEAD [-- <paths>]
```

Launch agents in parallel based on tier. Send the diff as context to each agent. All agents for a tier must be launched in a SINGLE message with multiple Agent tool calls.

**Inject Step 5A baseline context into each agent prompt.** If `sec_baseline` is non-null AND `sec_baseline.complete == true`, append the following block to each agent's prompt (cap at 10 findings by severity, regardless of total count, to bound token use):

> The following {N} pre-existing security findings have already been detected by local-security-scan. Do NOT re-report them — focus your effort on issues a static scanner cannot find: logic bugs, design flaws, auth-by-omission, concurrency hazards. Findings: {top-10 by severity, each as `finding_id | category | file:line_start`}.

If `sec_baseline.complete == false`, append instead:

> The Step 5A security baseline is INCOMPLETE (scanner timeout, error, or required scanner skipped — see `errors[]`). Do not assume any static scanner has covered this diff. Pay extra attention to injection sinks, credential handling, and newly-added dependencies.

Do NOT inject anything if `sec_baseline` is null (e.g., Step 5A has not yet run on a resumed pipeline — this is an error path that should already have been caught upstream).

**Lightweight -- 2 agents in parallel:**

1. **Bug Hunter** -- `subagent_type: "feature-dev:code-reviewer"` -- Prompt: "Review this diff for bugs, logic errors, security vulnerabilities, and adherence to project conventions. Report each finding with: severity (P0-P3), category, file, line range, description, expected behavior, actual behavior. Be thorough but precise -- only report issues you are confident about."

2. **Failure Hunter** -- `subagent_type: "pr-review-toolkit:silent-failure-hunter"` -- Prompt: "Analyze this diff for silent failures, inadequate error handling, swallowed exceptions, empty catch blocks, and inappropriate fallback behavior. Report each finding with: severity (P0-P3), category, file, line range, description."

**Standard+Critical -- add a 3rd agent in the same parallel batch:**

3. **Plan Guardian** -- `subagent_type: "superpowers:code-reviewer"` -- Prompt: "Review this diff for adherence to the project's coding standards, architectural patterns, and planned approach. Check if the implementation matches the project's established conventions. Report findings with severity and description."

**Agent availability fallback:**

| Situation | Action |
|-----------|--------|
| One agent fails to spawn (tool error or failure to return a result, unavailable type) | Warn: "Agent [name] ([type]) unavailable -- skipping. Review coverage is reduced." Append an error record to the `errors` array: `{ timestamp: "<now UTC>", stage: "stage-1", error_code: "AGENT_UNAVAILABLE", detail: "[agent name] ([type]): [error message]", finding_id: null, recovery: "skipped" }`. Continue with remaining agents. |
| ALL agents fail | Append error records for each failed agent. Error: "No review agents available. Cannot proceed." |

**Collect all findings from all agents. Write state file. Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"stage-1"`. Mark `"stage-1"` in `stages_completed`.**

## Stage 2: Consolidation & Triage

This is YOUR job as orchestrator -- no agent needed.

### Step 2.1: Dedup

For each pair of findings, merge if ALL of:
- Same file
- Line ranges overlap or are within 5 lines of each other
- Same category (different categories are NEVER merged even on the same line)

When merging: keep the higher severity, combine descriptions, list all agent names in `reporters`. When creating a new finding, set `finding.run_id` to the current top-level `run_id`. When merging findings, preserve the `run_id` of the higher-severity finding.

### Step 2.2: Classify

Tag each finding:

| Tag | Apply when |
|-----|-----------|
| `[AUTO-FIX]` | Fix is ONLY: import reordering, unused import removal, trailing whitespace, or formatting. NEVER tag parameter changes, default value changes, or logic changes as AUTO-FIX. |
| `[CONFIRM]` | Clear fix exists but touches logic or behavior. Human must approve before fix-and-verify applies it. |
| `[JUDGMENT]` | Multiple valid approaches or architectural decision needed. |
| `[CONFLICT]` | Two agents proposed conflicting fixes for the same code. |

### Step 2.3: Rank and Cap

Rank: P0 > P1 > P2 > P3. Cap at 15 findings total. Suppress P3 findings unless `--verbose`.

### Step 2.1b: Post-Stage-2 Regression Check (convergence runs only)

If this is a convergence re-run (prior run exists with findings), run convergence matching now using the three-level composite key (see `references/convergence.md`). Match current findings (from Stage 2 dedup) against prior run findings. Evaluate Stop Condition 2: if any current finding matches a prior finding whose `status` was `"fixed"`, that finding has regressed. Warn: "Fix for [finding_id / description] regressed." Surface it prominently in the output. Do NOT stop the pipeline on regression -- continue processing (the pipeline has already committed to this run). The regression warning is informational for the human.

### Step 2.4: Apply Auto-Fixes (skip if `--no-autofix`)

For each `[AUTO-FIX]` finding:

1. Save a backup: copy the current working-tree file to `.review-state/autofix-backup-<finding_id>`.
2. Apply the fix.
3. Run reduced verification using Gates 2, 3, and 6 (see `references/gate-registry.md`):
   - Gate 2: Full backend test suite must pass
   - Gate 3: Full frontend test suite must pass (skip if no frontend stack)
   - Gate 6: Lint + type check must pass with no new warnings above baseline
4. If any gate fails: restore from backup (read `.review-state/autofix-backup-<finding_id>` and write its contents to `<file>` using the Write tool -- do not use `cp`), delete the backup file, reclassify finding as `[CONFIRM]`.
5. If all gates pass: set `auto_fixed: true`, `status: "fixed"`, and `fixed_at: <current ISO UTC timestamp>` on the finding. Delete the backup file.

After all auto-fixes are attempted, capture post-autofix baselines:
- Re-run lint + type check. Store warning count as `gate_6_post_autofix`.
- Re-run coverage on changed files. Store per-file map as `gate_7_post_autofix` (or `null`).

Note: When `--no-autofix` is set, `gate_6_post_autofix` and `gate_7_post_autofix` remain null. fix-and-verify will fall back to `gate_6_baseline` / `gate_7_baseline`, which may be more permissive since no auto-fixes were applied. This is an accepted trade-off.

**Write state file (including post-autofix baseline fields). Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"stage-2"`. Mark `"stage-2"` in `stages_completed`.**

**Lightweight tier: output the punch list and STOP here.** Append a `run_history` record (see `references/convergence.md`). Write state file. Set `updated_at` to the current ISO timestamp before writing. Write `.review-state/latest.json` (copy of current state, with the appended `run_history`). Delete lock. Present results.

## Stage 3: Specialists + Adversarial (Standard+Critical only)

Launch Stage 3A specialists and Stage 3B Codex in a SINGLE parallel message.

### Stage 3A: Specialists (conditional)

Launch each agent only if its trigger condition is met. Apply the same availability fallback as Stage 1.

| # | Agent | Subagent Type | Trigger | Prompt |
|---|-------|--------------|---------|--------|
| 4 | Architect (Council Blue Lens) | `Architect` | Diff contains schema/migration/API endpoint changes, OR Stage 2 produced `[CONFLICT]` findings | "Review this diff for data model implications, API contract issues, and integration patterns. Also adjudicate these conflicting findings: [list CONFLICT findings]. Recommend which fix is correct." If the Architect recommends a resolution for a `[CONFLICT]` finding, reclassify it as `[CONFIRM]` and update its description to include the recommended approach. |
| 5 | Warden (Council Slate Lens) | `Warden` | ALWAYS on Standard+Critical | "Review this diff for security issues, authorization bypasses, privilege boundary violations, and missing auth checks. Pay special attention to authorization by omission -- a missing Depends(require_role()) is a security bug even though it produces no error." |
| 6 | Test Auditor | `pr-review-toolkit:pr-test-analyzer` | Diff adds new behavior without corresponding test additions | "Analyze this diff for test coverage gaps. Identify new functionality that lacks tests." |
| 7 | Type Analyst | `pr-review-toolkit:type-design-analyzer` | Stage 1 produced 3+ findings where `category` contains 'type', 'typing', 'type_error', 'type-safety', or 'inference' | "Analyze the type design in this diff for encapsulation, invariant expression, and type safety issues." |

### Stage 3B: Codex Adversarial (always)

8. **Codex Adversarial** -- Use the Skill tool: `skill: "codex-agent:dispatch"` with args: "Adversarial code review of this diff. Be skeptical, thorough, and find bugs that a normal review would miss. [include diff]. Report findings with severity, file, line, description, and suggested fix."

If the adversarial Skill tool call fails (timeout, auth error, etc.), warn: "Adversarial review unavailable -- [error]. Proceeding without it." Append an error record: `{ timestamp: "<now UTC>", stage: "stage-3b", error_code: "AGENT_D_DISPATCH_FAILED", detail: "[error]", finding_id: null, recovery: "continued" }`. Continue the pipeline.

**All-agents-unavailable hard-stop:** If ALL Stage 3A specialists fail to spawn AND Codex adversarial also fails, error: "No Stage 3 review agents available. Cannot proceed with Standard/Critical review. Outputting Stage 2 results as final." Output the current punch list. Append `run_history` record. Set `updated_at` to the current ISO timestamp. Write state, write `latest.json`, delete lock, and stop.

**Collect all new findings. Merge with Stage 2 punch list using the same dedup rules.**

Re-apply the 15-finding cap after merging: rank P0 > P1 > P2 > P3, take the top 15, suppress the rest (count in the Advisory Warnings section).

**Write state file. Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"stage-3"`. Mark `"stage-3"` in `stages_completed`.**

Note: Stage 3A and 3B are treated as a single atomic unit for resume purposes. `stages_completed` is updated to `"stage-3"` only after both 3A and 3B complete. If the run is interrupted between 3A and 3B, a resume will re-run all of Stage 3.

**Standard tier stop condition:**

| Condition | Action |
|-----------|--------|
| Total P0/P1 count across ALL findings (all stages) is zero | Output punch list and STOP. Append `run_history` record. Set `updated_at` to the current ISO timestamp. Write state, write `latest.json`, delete lock. |
| Any P0/P1 findings exist | Proceed to Stage 4. |

## Stage 4: Skeptic Combined Review (Critical, or Standard with any P0/P1)

9. **Skeptic** -- `subagent_type: "Skeptic"` -- Prompt: "You are performing a dual-mandate meta-review. You are NOT reviewing code -- you are reviewing the FINDINGS from a code review pipeline. Here are all findings so far: [list all findings with tags, severities, files, descriptions]. Your two tasks: (1) What P0/P1 failure mode is NOT covered by any finding in this list? Think pre-mortem: this code ships, 30 days later it fails -- why? (2) Which existing findings are false positives that should be dismissed? Also check: were any [AUTO-FIX] items misclassified (should they have been [CONFIRM])? Produce at most 5 additional findings or an explicit clear-all."

If Skeptic produces new P0/P1 findings: run one targeted Codex pass via the **Skill tool**: `skill: "codex-agent:dispatch"` on the specific files and findings the Skeptic flagged. Do NOT use the Agent tool for this -- Codex is a different model architecture (see Invariant 8).

**Skeptic dismissals:** For each finding the Skeptic recommends dismissing as a false positive, set `status: "dismissed"`, `dismissed_at: <current ISO UTC timestamp>`, and `dismissed_reason: "<Skeptic's stated reason>"` in the findings array.

**Output punch list. Write state file. Set `updated_at` to the current ISO timestamp before writing. Update lock `written_at` and `stage_reached` to `"stage-4"`. Mark `"stage-4"` in `stages_completed`. Then proceed to Cleanup.**

## Output Format

```markdown
## Review Pipeline Results

**Run ID:** [id] | **Classification:** [Lightweight|Standard|Critical] | **Agents:** [N launched / M responded] | **Time:** [Xm Ys] (measured from lock acquisition to output)

### Pre-Stage Results
- **Stack(s) detected:** [list]
- **Lint:** [PASS/FAIL/SKIP] | **Type check:** [PASS/FAIL/SKIP] | **Tests:** [PASS/FAIL/SKIP]
- **Baseline warnings:** [N] | **Baseline coverage:** [per-file map or "N/A"]
- **Issues (if any):** [TOOL_MISSING/TOOL_ERRORS details, or "clean"]

### Findings ([N])

| # | P | Tag | File | Finding | Reporters |
|---|---|-----|------|---------|-----------|
| 1 | P0 | [CONFIRM] | file.py:42 | Description | Agent1, Agent2 |

### Auto-Fixed ([N]) -- verified with gates 2,3,6
- file.py:3 -- removed unused import

### Agent Availability
- [Agent name]: [responded / unavailable / timed out]

### Advisory Warnings
- [out-of-scope lint failures, tool version warnings, etc.]

### Suppressed (P3, use --verbose): [N] (omit this line if --verbose was set)

### State: .review-state/[id].json (resume with --resume [id])
### Stable path: .review-state/latest.json
```

## Cleanup

After outputting results (this section handles cleanup for runs that reach Stage 4. Early exits -- Lightweight stop, Standard-tier stop, convergence stop, all-agents hard-stop -- perform equivalent cleanup inline and do NOT flow through this section):
1. Append a `run_history` record to the state file (see `references/convergence.md` for the record format).
2. Write state file. Set `updated_at` to the current ISO timestamp before writing.
3. Write `.review-state/latest.json` (copy of current state, with the appended `run_history`).
4. Delete `.review-state/<run_id>.lock`.
5. Prune `.review-state/<id>.json` state files older than 7 days, excluding `latest.json`. Also prune any orphaned `.lock` files older than 7 days. Use the Glob tool to list files in `.review-state/`, then use the Bash tool to check modification dates with `stat` and delete old files. Do not delete `latest.json`.
6. Ensure `.review-state/` is in `.gitignore`.

## References

- `references/state-schema.md` -- Full state JSON schema with field notes, normalization rules, and status transitions
- `references/stack-table.md` -- Stack detection table, JS/TS disambiguation, tool table, and failure handling
- `references/convergence.md` -- Convergence matching algorithm and stop conditions
- `references/gate-registry.md` -- Canonical gate registry (fix-and-verify references this; does not redefine it)
