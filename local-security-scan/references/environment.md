# local-security-scan — Environment & Scope Reference

Detail-layer content split out of SKILL.md for progressive disclosure. Read when setup, privacy, or scope questions arise — otherwise the main SKILL.md is sufficient for normal operation.

---

## Installed scanners — sources and PATH

| Tool | Install source | Typical install command |
|---|---|---|
| **Semgrep** | pip (Python user-site) | `pip install --user semgrep` then ensure the user-site `Scripts/` folder is on PATH |
| **Gitleaks** | Scoop | `scoop install gitleaks` |
| **OSV-Scanner** | Scoop | `scoop install osv-scanner` — requires **v2.x or later** (the `scan source` subcommand used by `scan.sh` was introduced in v2; v1 users must adapt the invocation) |

Verify each with `command -v <tool>` before running `scan.sh`. The script detects missing tools and reports the correct install command — do not call installers without explicit user consent.

### PATH caveats on Windows

- On Git Bash / MSYS2, `pip install --user` may drop the Scripts folder outside the default bash PATH. Verify with `where semgrep` (cmd) or `which semgrep` (bash).
- Environment variables captured at session start are NOT live-updated when Windows PATH changes — a Claude Code restart is required to pick up a new PATH.
- If `semgrep.exe` is present but unreachable, a small bash wrapper at `~/bin/semgrep` that exports `PATH` + `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` is the standard workaround.

---

## Privacy and network boundaries

This skill is "**primarily local**" — code content never leaves the machine — but two of the three scanners make narrow network calls:

| Tool | Network behavior |
|---|---|
| **Semgrep** | Downloads rule packs (`p/default`) from the Semgrep Registry on first run, then caches them. **Code is never uploaded.** Rule pack fetches stop after first use. Telemetry is disabled via `--metrics=off`. |
| **Gitleaks** | Fully offline. No network activity. |
| **OSV-Scanner** | Queries the OSV.dev public API with **package name + version hashes only**. No source code is sent. |

For strict air-gapped mode:
- Semgrep: use `--config ./local-rules/` pointing at a vendored rule directory instead of `p/default`.
- OSV-Scanner: run `osv-scanner --offline --download-offline-databases <path>` once to cache the CVE database locally.

Update the `scan.sh` invocation if strict offline is required; the default invocation trades one-time rule-pack download for operational convenience.

---

## Ignore-file conventions

Respect these files if they exist in the project root:

| File | Purpose | Format |
|---|---|---|
| `.semgrepignore` | Semgrep path/glob patterns to skip | gitignore-style |
| `.gitleaksignore` | Gitleaks fingerprints to ignore | one fingerprint per line |
| `osv-scanner.toml` | OSV-Scanner config including CVE ignores | TOML |

When a user wants to silence a false positive, add an entry to the appropriate file rather than editing the scanner invocation. Include a short comment explaining why.

See `examples/sample-output.md` for sample ignore-file entries.

---

## Output layout

`scan.sh` writes everything under `<project>/.sec-scan/`:

```
.sec-scan/
├── semgrep.json        # SAST findings (structured)
├── semgrep.stdout      # raw stdout
├── semgrep.stderr      # raw stderr — check here if JSON missing
├── gitleaks.json       # secrets findings (structured)
├── gitleaks.stdout
├── gitleaks.stderr
├── osv.json            # dep CVEs (structured)
├── osv.stdout
└── osv.stderr
```

`scan.sh` does not mutate `.gitignore`. If `.sec-scan/` is not already ignored, the script prints a one-line hint to add it to `.gitignore` or `.git/info/exclude`.

---

## Exit-code semantics

| Exit | Meaning |
|---|---|
| `0` | All tools ran successfully; no findings above the configured threshold. **Verify by checking file sizes** (Invariant 4) before trusting a "clean" result. |
| `1` | At least one tool found an actionable finding. Read the JSON reports. |
| `2` | Setup error: a scanner binary was missing, crashed, or timed out. NOT a finding — surface as a setup gap to the user. |

The RESULT line at the bottom of `scan.sh` output distinguishes all three cases, including the case where a tool timed out (exit 2 with a `timed out:` qualifier).

---

## Python one-liners for detailed extraction

When grep-based counts show there is something to inspect, these Python one-liners pull out specific findings without requiring `jq`:

**Semgrep — list ERROR findings:**
```bash
python -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); [print(r['check_id'], r['path']+':'+str(r['start']['line'])) for r in d.get('results',[]) if r.get('extra',{}).get('severity')=='ERROR']" .sec-scan/semgrep.json
```

**OSV-Scanner — list HIGH + CRITICAL CVEs with fixed versions:**
```bash
python -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); [print(v['id'], 'in', p['package']['name']+'@'+p['package']['version'], '-> fix:', ','.join(r.get('fixed','?') for r in v.get('affected',[{}])[0].get('ranges',[{}]))) for res in d.get('results',[]) for p in res.get('packages',[]) for v in p.get('vulnerabilities',[]) if v.get('database_specific',{}).get('severity') in ('HIGH','CRITICAL')]" .sec-scan/osv.json
```

**Gitleaks — list all leaks with file + line:**
```bash
python -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); [print(f['RuleID'], f['File']+':'+str(f['StartLine']), 'fp:', f['Fingerprint']) for f in d]" .sec-scan/gitleaks.json
```

Always pass `encoding='utf-8'` on Windows — `open()` defaults to `cp1252` and will crash on Unicode in JSON values.

---

## What this skill does NOT cover

Out of scope — use separate tools for these:

- **Auto-fix** — this skill reports only. Use a fix-and-verify pass for corrections.
- **Container / image scanning** — use Trivy (`scoop install trivy`).
- **IaC scanning beyond what Semgrep / OSV catches** — use Trivy, Checkov, or tfsec.
- **License compliance** — use ScanCode Toolkit or Licensee.
- **Dynamic analysis (DAST)** — runtime security is orthogonal.
- **Git history rewriting** — if a leaked secret is found, rotate the credential and use `git-filter-repo` separately; this skill does not edit git state.
- **Manual review of crypto / auth / payments code** — static analysis cannot replace a careful human read of sensitive code.

---

## Troubleshooting

**"Semgrep produced no output."**
Check `semgrep.stderr`. Common causes: missing rule pack download (first-run network), invalid `--config` value, Python encoding error (the `PYTHONUTF8=1` wrapper should prevent this).

**"Gitleaks found nothing even though I seeded an obvious fake secret."**
Gitleaks applies Shannon-entropy filtering on top of the regex match — a secret that matches the pattern but has low entropy (sequential letters, repeated digits, keyboard-walk) is silently dropped. Verified behaviour: `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789` matches the `github-pat` regex but is filtered as low-entropy; `ghp_r8G3kLm9pXqW2vYnJb5cF7tHsD4uZ6yA1eQN` (entropy ≈5.27) is caught. If you are sanity-checking the skill with a fake, use a high-entropy random-looking string, not a sequential one. This is gitleaks's own rule-engine behaviour, not a `scan.sh` bug.

**"No package sources found" in OSV-Scanner.**
The project has no dependency lockfiles (`package-lock.json`, `requirements.txt`, `go.sum`, `Cargo.lock`, `pom.xml`, etc.). On modern OSV versions, `scan.sh` passes `--allow-no-lockfiles`, so this case returns rc=0 and still writes `osv.json` (often with `"results": null`). Legacy OSV may still return rc=128; `scan.sh` accepts that only in a strict fallback path when the modern flag is unsupported.

**"Semgrep timed out after 300s."**
The project is larger than the default timeout accommodates, or a rogue directory (`node_modules`, `.venv`, `target`) was included. Either add the folder to `.semgrepignore`, run the scanner manually with a longer timeout, or narrow the scan path.

**"`timeout` not found."**
Git Bash without MSYS2 coreutils. `scan.sh` detects this and prints a note; scanners run without hang protection. Install coreutils: `pacman -S coreutils` (MSYS2) or accept the risk.
