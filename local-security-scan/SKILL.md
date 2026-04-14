---
name: local-security-scan
version: 0.8.0
description: >
  This skill should be used when the user asks to "scan for security issues",
  "check for CVEs", "look for secrets", "run a SAST scan", "security review
  this project", "check for vulnerabilities", "audit this code for security",
  or similar explicit scan phrasing against a concrete project. Runs three
  local scanners (Semgrep, Gitleaks, OSV-Scanner), writes JSON reports to
  <project>/.sec-scan/, and produces a prioritized fix list. Primarily local —
  code never leaves the machine; Semgrep downloads rule packs once and caches.
  Do NOT activate for conceptual security questions or general code review
  without an explicit scan request.
---

# Local Security Scan

Run three local security scanners against a project and report prioritized findings. No code uploaded. Scanners: Semgrep (SAST), Gitleaks (secrets), OSV-Scanner (dependency CVEs).

---

## Invariants -- Never Violate These

1. **Never activate without an explicit, project-targeted scan request.** Conceptual questions about security, general code review, or educational questions do NOT trigger this skill. If the user's intent is ambiguous, ask once: *"Want me to run a local security scan on this project?"* before activating.
2. **Never install or reinstall scanner binaries.** All three tools are pre-installed on this machine. If a tool is missing, report the gap with the install command; do not run installers without explicit user consent.
3. **Never dump full JSON reports into the conversation.** Filter with `grep -cE` first. Use Read with `offset`/`limit` only after counts indicate something worth inspecting.
4. **Never report "clean" without verifying the JSON report files are present and non-empty.** After `scan.sh` exits 0, run `wc -c "<project>/.sec-scan/semgrep.json" "<project>/.sec-scan/gitleaks.json" "<project>/.sec-scan/osv.json"` and confirm each file that exists is at least 2 bytes (valid empty JSON is `[]` or `{}`, both 2 bytes). On modern OSV (`--allow-no-lockfiles` supported), `osv.json` should be present even when no manifests are found (typically `"results": null`). On legacy OSV fallback paths only, `osv.json` may be absent for "no package sources found" and that is not a failure. A 0- or 1-byte `semgrep.json` or `gitleaks.json` means the tool silently failed; treat as a tool error, not a clean result.
5. **Never auto-fix findings.** Report only. A separate fix-and-verify pass decides what to change.
6. **Never bypass ignore files.** Respect `.semgrepignore`, `.gitleaksignore`, `osv-scanner.toml` in the project root. See `examples/sample-output.md` for ignore-file formats.
7. **Never scan a large dependency tree without warning the user first.** If the project root contains `node_modules`, `vendor`, `.venv`, or `target` as top-level directories, confirm the user wants those included before running — scans can take tens of minutes on dependency trees.
8. **Never hide any part of a composite RESULT line.** `scan.sh` emits a single `RESULT:` line that can list MULTIPLE parts joined by `; ` when more than one condition holds — e.g. `RESULT: setup incomplete (some scanners missing); findings present (read JSON reports in .sec-scan)`. This also applies to deliberately-skipped scanners: `RESULT: clean — skipped (osv-scanner bypassed via SKIP env var)` means Semgrep and Gitleaks ran clean while OSV was bypassed via `OSV_SKIP=1`, and you MUST surface the skip when reporting to the user. Do not hide findings because a tool was missing, do not hide missing/errored tools because findings were found, and do not hide a skipped scanner because everything else was clean. Exit code precedence: missing or errored → exit 2; findings-only → exit 1; clean (or skips-only) → exit 0. A skipped scanner does NOT raise the exit code — it is observable only via the RESULT line and the `"skipped": true` flag in the corresponding JSON file. The RESULT line is authoritative; the exit code is a summary.

---

## Scanners

| Tool | Covers |
|---|---|
| **Semgrep** | Code patterns (SAST) — unsafe API use, injection risks, OWASP-style flaws across ~30 languages |
| **Gitleaks** | Secrets in working tree AND git history (API keys, tokens, private keys) |
| **OSV-Scanner** | Known CVEs in dependency lockfiles (npm, pip, go, cargo, maven, etc.) |

All three must be on PATH. `scan.sh` detects missing tools and reports them with the install command. See `references/environment.md` for install sources, PATH caveats, privacy/network boundaries, and troubleshooting.

---

## How to run a scan

1. Determine the project root. Default: current working directory (`pwd`). If the user names a path, use that.
2. Verify the path exists and is a directory.
3. Run the wrapper script via Bash:
   ```
   bash ~/.claude/skills/local-security-scan/scan.sh "<project>"
   ```
4. Check the exit code AND read the `RESULT:` line (it may list multiple parts joined by `; `):
   - `0` — all tools ran; no findings above threshold (**verify per Invariant 4 before reporting clean**)
   - `1` — actionable findings present (RESULT: `findings present (...)`)
   - `2` — setup/tool error OR missing scanner OR timeout (RESULT may list multiple conditions, including findings that coexist with the error — per Invariant 8, report every part)
5. Read the JSON reports in `<project>/.sec-scan/` using the filter patterns below.
6. Synthesize and report to the user using the format at the bottom of this file.

---

## Reading reports without flooding context

Never cat a full JSON report. Filter first with count queries:

**Semgrep** — compact JSON (no spaces around colons):
```bash
grep -cE '"severity":[[:space:]]*"ERROR"' .sec-scan/semgrep.json
grep -cE '"severity":[[:space:]]*"WARNING"' .sec-scan/semgrep.json
```

**OSV-Scanner** — pretty-printed JSON; OSV uses `MEDIUM` for NVD-sourced entries and `MODERATE` for GHSA-sourced entries, so match both:
```bash
grep -cE '"severity":[[:space:]]*"CRITICAL"' .sec-scan/osv.json
grep -cE '"severity":[[:space:]]*"HIGH"' .sec-scan/osv.json
grep -cE '"severity":[[:space:]]*"(MEDIUM|MODERATE)"' .sec-scan/osv.json
```

**Gitleaks** — every finding matters; no severity filter:
```bash
grep -c '"RuleID"' .sec-scan/gitleaks.json
```

For detailed extraction (check IDs, file paths, line numbers, fixed versions), use the Python one-liners in `references/environment.md`. Page through JSON with Read `offset`/`limit` only after counts show there is something to inspect.

---

## Reporting findings to the user

Format:

```
Security scan complete for <project-name>.

CRITICAL:
  - [<tool>] <description> (<file>:<line>)
    -> Fix: <concrete action>

HIGH:
  - [<tool>] ...

MEDIUM / LOW:
  <count> additional findings — see .sec-scan/<tool>.json for details

Recommended next action: <ONE sentence — the single most important fix>
```

Rules:
- Lead with the ONE most important fix. Never bury it.
- Group by severity, not by tool.
- Dependency CVEs: always include the fixed version number.
- Semgrep findings: include the rule ID so the user can look it up.
- Gitleaks findings: include the fingerprint so the user can ignore-list false positives.
- List no more than ~10 findings in the conversation. Refer to JSON files for the tail.
- For leaked secrets: ALWAYS recommend rotation first, code removal second. A rotated key in git history is harmless; a current key anywhere is dangerous.

See `examples/sample-output.md` for a worked example of stdout output and a full user-facing report.

---

## Out of scope

See `references/environment.md` for the full "what this skill does NOT cover" list. In brief: no auto-fix, no container/IaC scanning (use Trivy), no license compliance, no dynamic analysis, no manual-review replacement for crypto/auth/payments code.

---

## Consumers

v0.8.0 added skip env vars so other skills can wire `scan.sh` into their own flows without paying the cost of scanners they don't need. Two known consumers live in this project:

- **review-pipeline Step 5A ("Security Corpus Seeding")** — calls `bash scan.sh "$PROJECT"` during its pre-stage with `OSV_SKIP=1` when the diff touches no dependency manifest, normalizes the three JSON reports into review-pipeline's canonical finding schema, and uses the findings to seed Stage 1 agent prompts and escalate Stage 0 tier classification on fresh P0 secrets/CVEs. Canonical normalization rules live in `review-pipeline/references/security-corpus.md`.
- **fix-and-verify Gate 8 ("Security Regression Delta")** — captures a `sec_baseline` at Step 0, runs `bash scan.sh` again between Step 4 (Codex Adversarial) and Step 5 (Commit), and blocks the commit loop if the delta contains *new* findings relative to baseline. Delta identity uses Semgrep's `match_based_id`, Gitleaks's `Fingerprint`, and an OSV tuple `(ecosystem, package, advisory_id, manifest_path)` — never raw line numbers. Full procedure in `fix-and-verify/references/security-gate-8.md`.

**Skip env vars (v0.8.0+):** `SEMGREP_SKIP=1`, `GITLEAKS_SKIP=1`, `OSV_SKIP=1`. A skipped scanner writes an empty-but-valid JSON file with `{"skipped": true, "scanner": "<name>", "results": []}`, appends a `skipped (<name> bypassed via SKIP env var)` token to the RESULT line, and does NOT raise the exit code. Consumers that require a complete scan MUST check each JSON file for the `"skipped": true` flag and set their own completeness state accordingly — a skipped scanner is clean from scan.sh's perspective but incomplete from the consumer's perspective if the consumer needed that scanner to run.

**Canonical finding schema** is owned by review-pipeline at `review-pipeline/references/state-schema.md`. The `reporters[]` array is always `["local-security-scan"]` for findings originating from this skill. See the normalization tables in `review-pipeline/references/security-corpus.md` (canonical) and `fix-and-verify/references/security-gate-8.md` (convenience copy) for the Semgrep/Gitleaks/OSV → canonical-finding mapping.

---

## References

- `references/environment.md` — install sources, PATH, privacy, ignore-files, troubleshooting, Python one-liners
- `examples/sample-output.md` — worked examples of stdout, user reports, and ignore-file entries
