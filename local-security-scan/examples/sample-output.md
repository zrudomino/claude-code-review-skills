# Sample Output — local-security-scan

Reference output from a real scan, for Claude to compare against when synthesizing a report.

---

## Sample `scan.sh` stdout (findings present)

```
Local security scan  ->  /c/PROJECTS/MyApp
Reports  ->  /c/PROJECTS/MyApp/.sec-scan

[1/3] Semgrep (SAST)...
      ERROR=2  WARNING=5  INFO=0

[2/3] Gitleaks (secrets)...
      leaks=1

[3/3] OSV-Scanner (dependency CVEs)...
      CRITICAL=0  HIGH=3  MED/MOD=2  LOW=1

RESULT: findings present (read JSON reports in /c/PROJECTS/MyApp/.sec-scan)
```

## Sample composite `scan.sh` stdout (findings + missing scanner)

This is the case Invariant 8 is designed to catch. Both parts MUST be reported.

```
Local security scan  ->  /c/PROJECTS/MyApp
Reports  ->  /c/PROJECTS/MyApp/.sec-scan

[1/3] Semgrep: NOT INSTALLED
      install: pip install --user semgrep  (verify: where semgrep)

[2/3] Gitleaks (secrets)...
      leaks=1

[3/3] OSV-Scanner (dependency CVEs)...
      CRITICAL=0  HIGH=0  MED/MOD=0  LOW=0

RESULT: setup incomplete (some scanners missing); findings present (read JSON reports in /c/PROJECTS/MyApp/.sec-scan)
```

Exit code: `2` (because missing takes precedence over findings for the exit code), but **the RESULT line lists BOTH conditions** and Claude must report both.

---

## Sample user-facing report after synthesis

```
Security scan complete for MyApp.

CRITICAL:
  (none)

HIGH:
  - [osv-scanner] Prototype pollution in lodash@4.17.15 (CVE-2019-10744)
    -> Fix: upgrade lodash to 4.17.21
  - [osv-scanner] Regex DoS in minimist@1.2.0 (CVE-2020-7598)
    -> Fix: upgrade minimist to 1.2.6
  - [gitleaks] AWS access key in config/dev.env:4 (fp: 8f3e2a1b...)
    -> Fix: ROTATE the key immediately, then remove from history with git-filter-repo
  - [semgrep] Command injection risk: subprocess.run(shell=True) with user input
    at src/handlers/upload.py:42
    -> Fix: pass args as a list, drop shell=True, or validate input with shlex.quote

MEDIUM:
  - [semgrep] 1 finding (weak random for security-sensitive value)
  - [osv-scanner] 2 findings in transitive deps — see .sec-scan/osv.json

LOW:
  - [semgrep] 5 warnings (missing timeouts on outbound HTTP)
  - [osv-scanner] 1 informational — see .sec-scan/osv.json

Recommended next action: ROTATE the leaked AWS key in config/dev.env — it is the
only finding with active-exploit potential and takes under a minute to remediate.
```

## Sample `.gitleaksignore`

```
# .gitleaksignore — fingerprint format: <git-commit-sha1>:<file>:<rule>:<line>
# The SHA1 is 40 hex chars (Git's standard commit hash).
# Add an entry only after confirming the finding is a false positive.

# Test fixture holding a deliberately-invalid AWS key for unit tests
8f3e2a1b4c5d09876fedcba0987654321abcdef01:tests/fixtures/fake-aws.yml:aws-access-token:12

# Documentation example in README showing the shape of a key (not a real secret)
1122334455667788aabbccddeeff00112233445566:docs/auth.md:generic-api-key:87
```

## Sample `.semgrepignore`

```
# .semgrepignore — gitignore-style globs for Semgrep to skip
# One line = one pattern. Comments start with #.

# Vendored dependencies that get noise-bombed by rules we care about
vendor/
third_party/
node_modules/

# Generated code
**/*.pb.go
**/generated/
**/*_pb2.py

# Test fixtures with deliberate antipatterns
tests/fixtures/vulnerable/
```

## Sample `osv-scanner.toml`

```toml
# osv-scanner.toml — skip specific CVEs with a reason and expiry

[[IgnoredVulns]]
id = "GHSA-p6mc-m468-83gw"
ignoreUntil = "2027-12-31"
reason = "transitive in build-only dep; reviewed 2026-04-14, no runtime exposure"

[[IgnoredVulns]]
id = "CVE-2023-26136"
reason = "vulnerable code path is unreachable from our entrypoints"
```

---

## Verification: a clean scan looks like this

```
Local security scan  ->  /c/PROJECTS/SomeProject
Reports  ->  /c/PROJECTS/SomeProject/.sec-scan

[1/3] Semgrep (SAST)...
      ERROR=0  WARNING=0  INFO=0

[2/3] Gitleaks (secrets)...
      leaks=0

[3/3] OSV-Scanner (dependency CVEs)...
      CRITICAL=0  HIGH=0  MED/MOD=0  LOW=0

RESULT: clean — no findings above threshold
```

Before reporting "clean" to the user, verify JSON file sizes per Invariant 4:

```bash
wc -c .sec-scan/*.json
# Each existing file should be at least 2 bytes. On modern OSV, osv.json should exist
# even when no manifests are found (often with "results": null). Legacy fallback may omit it.
# A 0- or 1-byte semgrep.json/gitleaks.json means the tool silently failed.
```
