---
name: fix-and-verify
version: 0.3.0
description: >
  This skill should be used when the user asks to "fix this finding", "fix and verify",
  "fix the punch list", "fix these review findings", "commit a fix for this bug",
  "apply the fix", "resolve these issues", "work through the punch list", or "apply fixes".
  It executes the red-green-commit loop for findings from the review-pipeline skill,
  using isolated worktrees, adversarial Codex testing, and gate verification before committing.
---

# Fix-and-Verify Skill

Execute the red-green-commit loop for one or more findings from `/review-pipeline`. Follow every step in order. Do not skip steps or gates. Each finding goes through: Step 0 (baseline) -> Step 1 (write failing test) -> Step 2 (apply fix) -> Step 3 (run gates) -> Step 4 (adversarial) -> Step 5 (commit + write-back).

---

## Invariants -- Never Violate These

1. **Never pass the bug description to Agent B.** Agent B receives only: the failing test file + source file(s) + (at level 2-3) prior attempt artifacts + (at level 3) public interfaces of related modules.
2. **Never pass implementation source code to Agent A at level 1.** At levels 2-3, Agent A may receive the public API surface (signatures, interfaces) but never the implementation body of the function under repair.
3. **Never skip required gates.** If a gate's tool is missing, report `TOOL_MISSING` and escalate -- do not mark the gate passed.
4. **Never commit a fix that breaks a previously passing test.** If gate 2 or 3 fails after a fix, do not commit; retry or escalate.
5. **Never accept `--no-adversarial` for P0 or P1.** Reject at pre-flight before any processing begins.
6. **Never silently drop [JUDGMENT] findings.** In single-finding mode, refuse and explain. In batch mode, skip with a warning and queue to the final report.
7. **Never retry beyond the max-attempts cap.** After all max_attempts are exhausted, escalate unconditionally.
8. **Never skip Codex Adversarial for P0 or P1.** If Codex Adversarial dispatch fails for a P0/P1 finding, escalate -- do not proceed to commit.
9. **Never silently drop [AUTO-FIX] findings.** See the pre-flight filter table for the required actionable message.
10. **Never process more than 8 findings in a single batch invocation.** Defer the remainder with an explicit message.
11. **Never write finding status in a batch at the end.** Write status back to the state file immediately after each finding completes.
12. **Never substitute an Agent tool call for a Codex dispatch.** Codex provides cross-model architectural diversity -- a Claude/Opus agent reviewing its own model family's work cannot catch the same blind spots. Always use `Skill: codex-agent:dispatch`, never the Agent tool, for Codex Adversarial testing.
13. **Never proceed to Step 5 Commit if Gate 8 returned scan_incomplete.** Escalate immediately with SEC_SCAN_INCOMPLETE. Do NOT route back to Step 2 -- the fix itself may be correct, and the failure is in verification infrastructure (scanner timeout, tool error, missing scanner, or a required scanner was bypassed via env var when this run needed it). A silent pass on an incomplete Gate 8 is a hard invariant violation. See `references/security-gate-8.md` for the full Gate 8 procedure.
14. **Never compare Gate 8 scan results across a matching_epoch boundary.** If `sec_scanner_versions` at Gate 8 scan time differ from those recorded in `sec_baseline` (captured at Step 0 or inherited from review-pipeline Step 5A), emit SEC_EPOCH_ADVANCED_MID_FIX and escalate. Do NOT attempt to match findings across scanner version changes -- the identity keys are unstable across epochs by design. A re-baseline is required, and the human operator decides whether to re-run the full flow against the new versions.

---

## Arguments

```
/fix-and-verify [options]

  --finding <json>      Single finding -- inline JSON string or path to a .json file
  --punch-list <file>   Path to punch-list file from /review-pipeline: either a
                        .review-state/<id>.json state file (preferred) or a JSON array
                        of finding objects. If a state file is provided, extract the
                        findings array.
  --no-adversarial      Skip Codex Adversarial step (REJECTED if any finding is P0 or P1)
  --worktree            Force git worktree isolation for all severities (default: always
                        use worktrees for P0/P1; use worktrees for P2/P3 only in batch
                        mode or when this flag is set; single P2/P3 findings without
                        this flag work in the current tree)
  --max-attempts <N>    Override retry cap (default: 3). Valid range: 1-10. Note: context levels cap at 3 regardless of --max-attempts; attempts beyond 3 repeat level 3 context.
```

**Mutual exclusivity:** Exactly one of `--finding` or `--punch-list` must be provided. If both are given, error: "Only one of --finding or --punch-list may be specified." If neither is given, error: "No input provided. Use --finding or --punch-list."

---

## Finding Schema

Finding objects must conform to the canonical schema defined in the review-pipeline skill. See `review-pipeline/references/state-schema.md` for the full schema.

Key fields used by this skill: `finding_id`, `severity`, `tag`, `category`, `file`, `line_start`, `line_end`, `symbol`, `description`, `expected_behavior`, `actual_behavior`, `reporters`, `auto_fixed`, `status`, `run_id`, `fixed_at`, `fixed_by_run`, `escalated_at`, `escalation_reason`.

**Normalization:** Apply migrations per `review-pipeline/references/state-schema.md` Migration Rules. Write the normalized form back to the state file before processing.

**Error recording:** Whenever an error code is triggered (agent failure, gate crash, tool timeout, etc.), append an entry to the state file's `errors` array. See `review-pipeline/references/state-schema.md` for the error record schema. This builds a diagnostic history that persists across runs.

---

## Pre-Flight: Argument Validation

Perform all checks before processing any findings.

### 1. Parse Arguments

Verify mutual exclusivity of `--finding` / `--punch-list`. If `--finding` is a file path, read the file and parse as JSON. If the file cannot be parsed as a JSON object, error: "Finding file [path] is not valid JSON. Expected a single finding object." If it is an inline string, parse directly. If `--punch-list` is given, read the file. If the file matches the `.review-state` schema (has `schema_version` and `findings` keys), extract the `findings` array. Otherwise, parse the file as a raw JSON array.

**Schema version check:** If `schema_version` is `1`, proceed with normalization (step 2 will migrate it to v2). If `schema_version` is any other value besides `1` or `2`, error: "State file uses unsupported schema v[N]. Expected v1 or v2." and stop.

**latest.json warning:** If the input path is `.review-state/latest.json`, warn: "Using latest.json -- this is a copy that may not reflect the most recent run. Prefer using a specific run state file (.review-state/<id>.json) if available." Then proceed with processing the file.

### 2. Normalize Schema

Apply migrations per `review-pipeline/references/state-schema.md` Migration Rules. After migration, set `schema_version` to `2` in the state file and write it back.

### 3. Validate Finding Schema

For each finding, verify required fields:
- `finding_id`: non-empty string
- `severity`: one of `"P0"`, `"P1"`, `"P2"`, `"P3"`
- `tag`: one of `"[AUTO-FIX]"`, `"[CONFIRM]"`, `"[JUDGMENT]"`, `"[CONFLICT]"`
- `category`: non-empty string
- `file`: non-empty string
- `description`: non-empty string

If any required field is missing or invalid, reject with `INVALID_FINDING_SCHEMA`: "Finding [id or index]: [field] is missing or invalid ([value]). Skipping." In batch mode, skip and continue. In single-finding mode, stop.

Optional fields: `line_start` defaults to `0`, `line_end` defaults to `line_start`, `symbol`/`expected_behavior`/`actual_behavior`/`reporters` default to `null`/`[]`.

### 4. Verify Target Files Exist

For each finding, check that `file` exists in the repository. If not, reject with `FILE_NOT_FOUND`: "Finding [id]: target file [path] does not exist. Skipping." In batch mode, skip and continue. In single-finding mode, stop.

### 5. Filter Findings

Process each finding's tag and status. First match wins:

| tag | status | action |
|-----|--------|--------|
| `[AUTO-FIX]` | any | Skip with actionable message: "Finding <id> has tag [AUTO-FIX] -- auto-fixes are applied by review-pipeline Stage 2. Re-run /review-pipeline or reclassify the finding's tag to [CONFIRM]." |
| `[CONFLICT]` | any | Skip with error: "Finding <id> has tag [CONFLICT] -- adjudication required before fix-and-verify. Escalate to human." |
| `[JUDGMENT]` | any | Single-finding mode: refuse with "Finding <id> has tag [JUDGMENT] -- requires human decision on approach before proceeding." Batch mode: skip with warning, queue to "Skipped [JUDGMENT]" in final report. |
| `[CONFIRM]` | `"open"` or absent/null | Keep for processing. |
| `[CONFIRM]` | `"fixed"`, `"dismissed"`, `"escalated"` | Skip silently (already processed). |
| any other tag | any | Skip with warning: "Finding <id> has unrecognized tag [tag]. Skipping." |

### 6. Reject --no-adversarial if P0/P1 Present

If `--no-adversarial` is passed and any finding has severity P0 or P1, stop immediately: "ERROR: --no-adversarial is not permitted when P0 or P1 findings are present. Codex Adversarial testing is mandatory for these severities."

### 7. Validate --max-attempts

If provided, must be an integer in range 1-10. If out of range: "ERROR: --max-attempts must be between 1 and 10."

### 8. Sort and Cap

Sort eligible findings by severity: P0 first, then P1, P2, P3. In batch mode, apply the hard cap of 8 (see `references/batch-orchestration.md`).

---

## Worktree Lifecycle

Determine worktree strategy before entering the loop:

| mode | severity | --worktree flag | action |
|------|----------|-----------------|--------|
| batch | any | any | Always create a worktree per finding (see `references/batch-orchestration.md`) |
| single | P0 or P1 | any | Create worktree before Step 0 |
| single | P2 or P3 | set | Create worktree before Step 0 |
| single | P2 or P3 | not set | Work in the current tree |

When creating a worktree for single-finding mode:
```bash
git worktree add .worktrees/fix-<finding_id> HEAD
```
All subsequent steps (0-5) operate within this worktree. Clean up after completion or escalation.

After the finding is complete (success or escalation):
```bash
git worktree remove .worktrees/fix-<finding_id>
```
If cleanup fails, warn `WORKTREE_CLEANUP_FAILED` and continue. Manual cleanup may be needed.

---

## The Red-Green-Commit Loop (per finding)

Process each finding through Steps 0-5 in order. Track attempt count (max: `--max-attempts`, default 3). See `references/retry-protocol.md` for the full context level and failure routing details.

### Step 0 -- Baseline Capture

Before any modifications, capture baselines in the worktree (or current tree).

**Baseline selection (in priority order):**

1. If state file has non-null `gate_6_post_autofix` / `gate_7_post_autofix`: use these as baselines for gates 6 and 7. They reflect the state after Stage 2 auto-fixes.
2. If `gate_6_post_autofix` / `gate_7_post_autofix` are null: use `gate_6_baseline` / `gate_7_baseline` from the state file.
3. If no state file: run the lint tool and count warnings (store as `baseline_warnings`). If a coverage tool exists, run coverage on the finding's `file` and any files it directly imports (store as `baseline_coverage`, a map of file paths to coverage percentages).

In batch mode with no state file, capture priority 3 baselines inside each finding's worktree before Step 1 for that finding.

Store resolved baselines for use in Step 3 gates 6 and 7.

**Security baseline (`sec_baseline`) for Gate 8:**

4. If the state file has non-null `sec_baseline` (inherited from review-pipeline Step 5A): use it directly. No re-scan. Record the inherited `sec_scanner_versions` for later epoch-boundary checks at Gate 8.
5. Otherwise, capture a fresh baseline inside the worktree:
   ```bash
   bash ~/.claude/skills/local-security-scan/scan.sh "$WORKTREE_PATH"
   ```
   Parse the three JSON reports (`.sec-scan/semgrep.json`, `.sec-scan/gitleaks.json`, `.sec-scan/osv.json`) using the normalization table in `references/security-gate-8.md` (convenience copy of the canonical table in `review-pipeline/references/security-corpus.md`). Store the normalized findings as `sec_baseline` in the finding state, along with `sec_scanner_versions` and a fresh `matching_epoch` value.
6. If the scan fails (`scan.sh` exit 2, or a required report file is missing, or a required scanner was skipped via env var): hard fail this finding with error code `SEC_BASELINE_FAILED`. Do NOT proceed to Step 1. A fix cannot be green-gated on a tree whose starting security state is unknown. Record the failure in `errors[]` with recovery `"escalated"`.

`sec_baseline` structure:
```json
{
  "semgrep": [<normalized_findings>],
  "gitleaks": [<normalized_findings>],
  "osv": [<normalized_findings>],
  "captured_at": "<ISO>",
  "complete": true
}
```
`complete: false` is only emitted by review-pipeline Step 5A for a failed/incomplete scan and is treated as hard fail at Gate 8 (see Invariant 13 and `references/security-gate-8.md`).

---

### Attempt Loop

```
for attempt = 1 to max_attempts (inclusive):
  context_level = min(attempt, 3)
  run Step 1 with context_level
  if Step 1 fails (construction error): continue to next attempt
  run Step 2 with context_level
  if green phase fails: continue to next attempt
  run Step 3 (gates) with failure routing
  if all required gates pass: break -> proceed to Step 4

if no attempt succeeded after max_attempts:
  ESCALATE TO HUMAN (see references/retry-protocol.md)
```

Failure routing from Step 3 may direct the next attempt to start at Step 2 instead of Step 1. See `references/retry-protocol.md` for the full failure routing table.

---

### Step 1 -- Write the Failing Test (Agent A)

Spawn Agent A using the **Agent tool**.

**Context levels for Agent A:**

| level | attempt | Agent A receives |
|-------|---------|-----------------|
| 1 | 1 | Finding metadata only: `description`, `expected_behavior`, `actual_behavior`, `file` (path only -- not contents), `line_start`, `line_end`, `symbol`, `category`. No source code. |
| 2 | 2+ | All of level 1, PLUS: failure output from the previous attempt's red-phase or green-phase check. |
| 3 | 3+ | All of level 2, PLUS: public API surface (type signatures, function signatures, class definitions, callers, import structure). NOT the implementation body. |

**Prompt Agent A with:** "You are writing a failing test for a bug report. [At level 1: You do NOT have access to the source code, only the bug description.] [At level 2-3: You also have prior attempt failure output and/or public API context.] Base the test on the bug description and expected behavior provided. Write a single focused test function that will FAIL given the current (broken) behavior and PASS once the bug is fixed. Place the test in the appropriate test directory for this stack. Name the test file per stack convention: Python: `test_fix_<finding_id>.py`; TS/JS: `fix-<finding_id>.test.ts`; Go: `fix_<finding_id>_test.go` (in the same package directory); Rust: append a `#[cfg(test)] mod tests_fix_<finding_id>` block to the source file; Kotlin: `Fix<FindingId>Test.kt` in the test source root. Output only the test file content."

If the Agent tool call returns an error or fails to return a result, report `AGENT_SPAWN_FAILED`, append an error record to the state file's `errors` array: `{ timestamp: "<now UTC>", stage: "step-1", error_code: "AGENT_SPAWN_FAILED", detail: "[error]", finding_id: "<id>", recovery: "retried" }`. Retry once (infrastructure retry -- does not consume an attempt from the outer loop). If still fails, update the error record's recovery to `"escalated"` and escalate immediately.

**After Agent A completes:**
- Write the test file to the worktree (or current tree).
- Run the test using the detected test runner.
- **Gate: Confirm red phase.** The test MUST fail.

**Red phase failure classification:**

| failure_type | definition | action |
|-------------|------------|--------|
| Behavioral failure | Assertion error, uncaught exception from code under test, runtime error during execution. Error originates from the code under test. | Valid red-phase confirmation. Proceed to Step 2. |
| Construction failure | Syntax error in test file, import/module resolution failure for the test's own imports, test framework configuration error. Error originates from the test file itself. | Agent A produced a broken test. Count as failed attempt, increment, retry with next context level. |
| Test passes (exit 0) | The test passes without any fix. | Report `RED_PHASE_FAILED`: "Red phase failed -- test passes without a fix. Test may be incorrect or bug is already resolved. Escalating to human." |

---

### Step 2 -- Apply the Minimal Fix (Agent B)

Spawn Agent B using the **Agent tool**. Agent B operates in the same worktree as Step 1.

**Context levels for Agent B:**

| level | attempt | Agent B receives |
|-------|---------|-----------------|
| 1 | 1 | Failing test file content + source file(s) under repair. No bug description. No finding metadata. |
| 2 | 2+ | All of level 1, PLUS: previous attempt's fix diff + specific gate failure output that caused the retry. |
| 3 | 3+ | All of level 2, PLUS: public interfaces and type signatures of related modules. |

**Prompt Agent B with:** "You are fixing a bug. You have a failing test and the source file(s) it tests. [At level 1: You do NOT have the bug description, only the failing test.] [At level 2-3: You also have prior attempt context.] Apply the minimal change to the source file(s) that makes the failing test pass without breaking any existing tests. Do not refactor beyond what is necessary. Output a unified diff of your changes."

**After Agent B completes:**
- Apply the diff to the worktree.
- Run the specific test written by Agent A.
- **Gate: Confirm green phase.** The test MUST now pass. If it still fails, increment attempt count and return to the attempt loop.

---

### Step 3 -- Run Verification Gates (Agent C)

Spawn Agent C using the **Agent tool**. Agent C runs all required gates using the **Bash tool** with the resolved stack tools. Agent C operates in the same worktree as Agent B.

**Gate definitions:** See `references/gate-registry.md` for the full gate table (IDs 1-7, commands, timeouts, pass criteria, skip conditions). Canonical source is the review-pipeline skill.

**Gate severity requirements:**

| severity | required gates |
|----------|---------------|
| P0, P1 | 1, 2, 3, 6, 7 (gate 4 and gate 5 run but advisory -- never block. Gate 5 escalates to human if > 200 lines for P0/P1.) |
| P2, P3 | 1, 2, 3, 6 |

**Failure routing:**

| failure_type | routing | notes |
|-------------|---------|-------|
| Gate 1 fails (test still failing) | Return to Step 2 only | Agent B produced wrong fix. Reuse existing test. Do NOT re-run Agent A. |
| Gate 2 or 3 fails (regression) | Return to Step 2 | Pass regression output as additional context. |
| Gate 4 warns (API fuzz) | Log advisory | Gate 4 is advisory only. Report warnings but proceed. Never hard-fail. |
| Gate 5 warns (patch too large) | Log advisory | If > 200 lines for P0/P1, escalate. |
| Gate 6 or 7 fails (lint/coverage regression) | Return to Step 2 | Pass specific warnings/coverage delta as context. |
| Tool timeout | Retry gate once | If still times out, report `TOOL_TIMEOUT`, append error record, and escalate. |
| Tool crash/flaky | Retry gate once | Same error = real failure, append error record. Different error = append error record and escalate. |

**Attempt counting:** The attempt loop owns the counter. Failure routing only determines which step the next iteration starts at. If all iterations are exhausted, escalate.

Agent C must report each gate result as `[PASS]`, `[FAIL]`, `[SKIP]`, or `[WARN]` with exit code and relevant output lines.

---

### Step 4 -- Adversarial Testing (Codex Adversarial)

**Severity rule:**

| severity | rule |
|----------|------|
| P0, P1 | Codex Adversarial is mandatory. Do not proceed to Step 5 without it. |
| P2, P3 | Codex Adversarial runs by default. Skip only if `--no-adversarial` was explicitly passed. |

Note: Pre-flight step 6 has already rejected runs with `--no-adversarial` and P0/P1 findings. The table above confirms operational behavior -- no second rejection is needed here.

Dispatch Codex Adversarial via the **Skill tool**: `codex-agent:dispatch`

**Prompt for Codex Adversarial:** Provide the fix diff, the full source file after the fix is applied, and the test file written by Agent A. Instruct: "You are an adversarial tester. Your goal is to find ways the fix is WRONG. Write tests that try to BREAK the fix -- edge cases, boundary conditions, race conditions, off-by-one errors, null inputs, empty collections, concurrent access patterns, or any input that would cause the fixed code to fail or behave incorrectly. You have a different architecture than the original reviewer -- use this to catch blind spots. Report any failures with a minimal reproducing test case."

**After Codex Adversarial completes or fails:**

| outcome | action |
|---------|--------|
| Dispatch fails (timeout, auth, network) for P0/P1 | Report `AGENT_D_DISPATCH_FAILED`. Hard failure -- escalate. |
| Dispatch fails for P2/P3 | Report `AGENT_D_DISPATCH_FAILED`. Warn: "Codex Adversarial unavailable -- [error]. Proceeding without adversarial testing." Continue to Step 5. |
| Codex Adversarial produces failing tests | Report to human with status ESCALATED. Do not proceed to Step 5. Do not commit. |
| Codex Adversarial finds no failures | Proceed to Step 4.5 (Gate 8). |

---

### Step 4.5 -- Gate 8: Security Regression Delta

After Step 4 approves and before the commit, run a delta security scan. Only candidates that passed every prior gate and the adversarial testing reach this point. This is the last line of defense against a fix that accidentally introduces a new secret, SAST finding, or vulnerable dependency.

1. Run `bash ~/.claude/skills/local-security-scan/scan.sh "$WORKTREE_PATH"` inside the worktree.
2. Run supplementary `gitleaks detect --staged --no-git --source "$WORKTREE_PATH"` to catch uncommitted / staged secrets that the history-oriented scan may miss.
3. **Check scan completeness.** If the scan returns `complete=false` (exit 2, missing report file, timeout, or a required scanner was skipped via env var): hard fail → escalate immediately with `SEC_SCAN_INCOMPLETE`. Do NOT route back to Step 2. **Per Invariant 13**, the fix may be correct; the failure is in verification infrastructure.
4. **Check matching_epoch.** If the `sec_scanner_versions` from this scan differ from those recorded in `sec_baseline`, emit `SEC_EPOCH_ADVANCED_MID_FIX` and escalate. **Per Invariant 14**, do NOT attempt to match findings across epoch boundaries.
5. Parse the three JSON reports using the normalization table in `references/security-gate-8.md`. Compute the delta against `sec_baseline` using scanner-native identity keys (Semgrep `match_based_id`, Gitleaks `Fingerprint`, OSV tuple `ecosystem:package:advisory_id:manifest_path` — **never raw file+line**).
6. Apply test-file exclusion: drop Semgrep findings whose `path` matches `test_*`, `*_test.*`, `*Test*`, or `tests/**` before computing the delta. Gitleaks scans the full tree; any test-file secret already present in `sec_baseline` is automatically WARN-only.
7. **Delta evaluation:**
   - If the delta is empty → Gate 8 passes, proceed to Step 5 (Commit).
   - If the delta contains new findings → Gate 8 fails. **Consumes one attempt from the outer loop counter.** Route back to Step 2 with the new findings passed to Agent B as additional context: *"Your previous fix introduced these security findings — rewrite to avoid them: <list>."*
   - If the outer loop is already at `max_attempts` when Gate 8 fails, escalate immediately with `SEC_GATE8_RETRY_EXHAUSTED`. Do NOT attempt another Step 2 iteration (Invariant 7: the attempt cap is hard).

**Full procedure, identity keys, epoch rules, completeness handling:** `references/security-gate-8.md` (self-contained convenience copy, pointer to canonical `review-pipeline/references/gate-registry.md`).

---

### Step 5 -- Commit and Write-Back

After all gates pass and Codex Adversarial is satisfied (or skipped/unavailable for P2/P3):

**5a. Commit**

1. Stage only the fix diff and the new test file. Do not stage unrelated changes.
2. Commit with message: `fix: <symbol or file> -- <one-line summary from finding description> (finding <finding_id>)` (use the file basename if `symbol` is null).
3. Do not push unless the user explicitly requests it.
4. Note the commit hash.

**5b. Write Status Back to State File (immediately after commit)**

Write the following fields to the finding in the state file that was passed via `--punch-list` (path: `.review-state/<review_pipeline_run_id>.json`):
- `status: "fixed"`
- `fixed_at: <ISO 8601 timestamp (UTC)>`
- `fixed_by_run: <top-level run_id from the state file>` (the review-pipeline run that produced this finding; fix-and-verify does not generate its own run_id)

Then copy the updated state file to `.review-state/latest.json`.

This write-back must happen immediately after each finding completes -- do not batch across multiple findings.

If no state file exists (finding was passed via `--finding` with inline JSON): create a minimal state file at `.review-state/<generated-uuid>.json` with schema_version 2, the single finding, and a fresh run_id. Write status back to it. Also write `latest.json`. This enables future convergence even for ad-hoc single-finding invocations. Note: in this ad-hoc case, `fixed_by_run` will contain the generated UUID, not a review-pipeline run ID. This is an accepted deviation from the field's normal semantics.

**5c. Report**

Report the commit hash and the updated finding status.

---

### Escalation Write-Back

When a finding is escalated (all attempts exhausted or a hard failure), write immediately to the state file:
- `status: "escalated"`
- `escalated_at: <ISO 8601 timestamp (UTC)>`
- `escalation_reason: "Exhausted <N> attempts. Last failure: <step> -- <failure_type>."`
- Append a final error record to `errors`: `{ timestamp: "<now UTC>", stage: "<step>", error_code: "<code>", detail: "Escalated after <N> attempts. Full attempt history in prior error records.", finding_id: "<id>", recovery: "escalated" }`

Then copy the updated state to `.review-state/latest.json`.

This must happen at the point of escalation, not deferred to the end of the batch.

---

## Stack Detection

Use the same marker-file logic, stack table, and detection rules as defined in the review-pipeline skill (canonical source: `review-pipeline/references/stack-table.md`). Do not redefine or reproduce the stack table here.

Detection rules summary:
- More specific markers win over generic ones.
- In a monorepo, detect all stacks and run all matching toolchains.
- For JS/TS: detect test runner from `package.json` scripts. If no test script exists, gates 1 and 2 report `TOOL_MISSING` and escalate.
- Store the detected stack(s) -- all subsequent gate commands use these resolved tools.

---

## Output Format

After all findings are processed, output a full report:

```
## Fix-and-Verify Results
**Timestamp (UTC):** <ISO timestamp>

### Finding: <description truncated to 60 chars>
**File:** <file>:<line_start> | **Severity:** <P0/P1/P2/P3> | **Attempts:** <N>/<max>

**Test:** <test file path>::<test function name>
  - Red phase: CONFIRMED
  - Green phase: PASSED

**Fix:** <file> -- <N> lines changed
  <unified diff>

**Gates:** 1[x] 2[x] 3[x] 4[x] 5[x] 6[x] 7[x] Adv[x] (Adv = Codex Adversarial)
**Commit:** <hash>
**Status:** VERIFIED | ESCALATED

---

### Batch Summary
| Finding | File | Severity | Attempts | Gates | Codex Adversarial | Status |
|---------|------|----------|----------|-------|---------|--------|
| <desc>  | <file:line> | P0 | 1/3 | 7/7 | PASS | VERIFIED |
| <desc>  | <file:line> | P2 | 2/3 | 4/4 | SKIP | VERIFIED |
| <desc>  | <file:line> | P0 | 3/3 | 3/7 | --  | ESCALATED |

Codex Adversarial column: `PASS` = adversarial found no failures, `SKIP` = `--no-adversarial` passed, `--` = not reached (finding escalated before Step 4).

### Integration Status
- Integration branch: fix-batch-<timestamp>
- Cherry-picks applied: [N] / [total]
- Conflicts: [list or "none"]

### Deferred (<N>) -- re-run to continue
- Re-run: /fix-and-verify --punch-list <file>

### Skipped [JUDGMENT] (<N>) -- requires human decision
- <file>:<line> -- <description>

### Escalated (<N>) -- requires human investigation
- <file>:<line> -- <description> (failed after <N> attempts: <failure type>)

### Errors (<N>)
- [error code]: <message> (finding <id>)
```

---

## References

- `references/error-codes.md` -- all error codes and recovery actions
- `references/batch-orchestration.md` -- sequential batch processing, integration branch, cherry-pick workflow, dependency conflict detection
- `references/retry-protocol.md` -- full retry/escalation protocol with context level detail and escalation report format
- `references/gate-registry.md` -- gate table (IDs 1-7) with baseline selection rules; convenience copy -- if divergence exists, review-pipeline's gate-registry.md is authoritative
