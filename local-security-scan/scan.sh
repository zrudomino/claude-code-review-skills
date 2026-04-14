#!/usr/bin/env bash
# local-security-scan/scan.sh  v0.7.0
# Runs Semgrep, Gitleaks, and OSV-Scanner against a project.
# Usage:  bash scan.sh [<project-root>]
# Exit:
#   0 = all tools ran; no findings above threshold
#   1 = actionable findings present
#   2 = setup/tool error (missing binary, crash, or timeout)

set -u

PROJECT_ARG="${1:-$(pwd)}"
PROJECT="$(cd -- "$PROJECT_ARG" 2>/dev/null && pwd)" || {
  echo "error: project path does not exist or is not a directory: $PROJECT_ARG" >&2
  exit 2
}

OUT_DIR="$PROJECT/.sec-scan"

# Guard: refuse to write through a symlinked .sec-scan/ (escape risk)
if [ -L "$OUT_DIR" ]; then
  echo "error: $OUT_DIR is a symlink — refusing to write through it" >&2
  exit 2
fi
if [ -e "$OUT_DIR" ] && [ ! -d "$OUT_DIR" ]; then
  echo "error: $OUT_DIR exists but is not a directory — rename or remove it and retry" >&2
  exit 2
fi
mkdir -p "$OUT_DIR" || {
  echo "error: cannot create $OUT_DIR (permission or disk issue)" >&2
  exit 2
}
# Restrict .sec-scan/ to current user (defense against other-user symlink planting).
# On POSIX this sets 0700; on Windows+Git Bash it's a best-effort no-op.
chmod 0700 "$OUT_DIR" 2>/dev/null || true

# Clear stale JSON reports AND any pre-existing symlinks so a scanner crash
# cannot reuse last run's output (and cannot be redirected via a planted symlink).
rm -f "$OUT_DIR/semgrep.json" "$OUT_DIR/semgrep.json.tmp" \
      "$OUT_DIR/gitleaks.json" "$OUT_DIR/gitleaks.json.tmp" \
      "$OUT_DIR/osv.json" "$OUT_DIR/osv.json.tmp" \
      "$OUT_DIR/semgrep.stdout" "$OUT_DIR/semgrep.stderr" \
      "$OUT_DIR/gitleaks.stdout" "$OUT_DIR/gitleaks.stderr" \
      "$OUT_DIR/osv.stdout" "$OUT_DIR/osv.stderr"

# Read-only gitignore hint - no file mutation. The scanner is strictly
# non-destructive with respect to project files; if .sec-scan/ is not
# already ignored by any mechanism, print a one-line note and move on.
if command -v git >/dev/null 2>&1 && [ -d "$PROJECT/.git" ]; then
  if ! (cd "$PROJECT" && git check-ignore -q ".sec-scan/") 2>/dev/null; then
    echo "note: .sec-scan/ is not ignored by git - consider adding it to .gitignore or .git/info/exclude"
  fi
fi

# Timeout prefix — empty if `timeout` is unavailable (degrades gracefully).
# HAS_TIMEOUT gates the rc==124 check: without a timeout wrapper, a native 124
# exit from a scanner must NOT be misclassified as a timeout.
TIMEOUT_PREFIX=""
HAS_TIMEOUT=0
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_PREFIX="timeout 300"
  HAS_TIMEOUT=1
fi

# Size check: file exists AND is at least 2 bytes (valid empty JSON is `[]` or `{}`).
# A 0- or 1-byte file is a truncated write and MUST be treated as error.
valid_json_size() {
  [ -f "$1" ] && [ "$(wc -c < "$1" 2>/dev/null || echo 0)" -ge 2 ]
}

# Count matches by OCCURRENCE, not by line. Compact JSON (semgrep) puts many
# findings on a single line — grep -c would undercount.
count_matches() {
  local pattern="$1" file="$2" n
  valid_json_size "$file" || { echo 0; return; }
  n=$(grep -oE "$pattern" "$file" 2>/dev/null | wc -l)
  echo "$((n + 0))"
}

# Atomic-publish a tool's .tmp report to its final name. Safer than writing
# directly to the final name, because a crash mid-write leaves .tmp for inspection
# without corrupting .json, and the rename itself is atomic on the same filesystem.
publish_report() {
  local tmp="$1" final="$2"
  if [ -f "$tmp" ]; then
    mv -f "$tmp" "$final" || {
      echo "      warn: could not publish $final" >&2
      return 1
    }
  fi
  return 0
}

FLAG_FINDINGS=0
FLAG_ERROR=0
FLAG_MISSING=0
TIMED_OUT=""

echo "Local security scan  ->  $PROJECT"
echo "Reports  ->  $OUT_DIR"
[ -z "$TIMEOUT_PREFIX" ] && echo "note: 'timeout' not found — scanners will run without hang protection"
echo ""

# ---------- Semgrep ----------
# Semgrep returns 0 on success (with or without findings) when --metrics=off and
# --quiet are both set. Any non-zero exit is a tool error.
if command -v semgrep >/dev/null 2>&1; then
  echo "[1/3] Semgrep (SAST)..."
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 $TIMEOUT_PREFIX semgrep scan \
    --config p/default \
    --json \
    --output "$OUT_DIR/semgrep.json.tmp" \
    --quiet \
    --metrics=off \
    "$PROJECT" >"$OUT_DIR/semgrep.stdout" 2>"$OUT_DIR/semgrep.stderr"
  rc=$?
  if [ "$HAS_TIMEOUT" -eq 1 ] && [ "$rc" -eq 124 ]; then
    echo "      [WARN] timed out after 300s — partial results only"
    TIMED_OUT="${TIMED_OUT:+$TIMED_OUT,}semgrep"
    FLAG_ERROR=1
    publish_report "$OUT_DIR/semgrep.json.tmp" "$OUT_DIR/semgrep.json"
  elif [ "$rc" -ne 0 ]; then
    echo "      (exit $rc — see $OUT_DIR/semgrep.stderr)"
    FLAG_ERROR=1
  else
    publish_report "$OUT_DIR/semgrep.json.tmp" "$OUT_DIR/semgrep.json" || FLAG_ERROR=1
    if valid_json_size "$OUT_DIR/semgrep.json"; then
      SEMGREP_ERROR=$(count_matches '"severity":[[:space:]]*"ERROR"' "$OUT_DIR/semgrep.json")
      SEMGREP_WARN=$(count_matches '"severity":[[:space:]]*"WARNING"' "$OUT_DIR/semgrep.json")
      SEMGREP_INFO=$(count_matches '"severity":[[:space:]]*"INFO"' "$OUT_DIR/semgrep.json")
      echo "      ERROR=$SEMGREP_ERROR  WARNING=$SEMGREP_WARN  INFO=$SEMGREP_INFO"
      if [ "$SEMGREP_ERROR" -gt 0 ] || [ "$SEMGREP_WARN" -gt 0 ]; then
        FLAG_FINDINGS=1
      fi
    else
      echo "      (report missing or truncated — see $OUT_DIR/semgrep.stderr)"
      FLAG_ERROR=1
    fi
  fi
else
  echo "[1/3] Semgrep: NOT INSTALLED"
  echo "      install: pip install --user semgrep  (verify: where semgrep)"
  FLAG_MISSING=1
fi
echo ""

# ---------- Gitleaks ----------
# Gitleaks exits 0 with --exit-code 0. Any non-zero is a tool error.
# Respects $PROJECT/.gitleaksignore when cwd != project via --gitleaks-ignore-path.
if command -v gitleaks >/dev/null 2>&1; then
  echo "[2/3] Gitleaks (secrets)..."
  GITLEAKS_IGNORE_ARGS=()
  if [ -f "$PROJECT/.gitleaksignore" ]; then
    GITLEAKS_IGNORE_ARGS=(--gitleaks-ignore-path "$PROJECT/.gitleaksignore")
  fi
  $TIMEOUT_PREFIX gitleaks detect \
    --source "$PROJECT" \
    --report-format json \
    --report-path "$OUT_DIR/gitleaks.json.tmp" \
    --no-banner \
    --exit-code 0 \
    "${GITLEAKS_IGNORE_ARGS[@]}" \
    >"$OUT_DIR/gitleaks.stdout" 2>"$OUT_DIR/gitleaks.stderr"
  rc=$?
  if [ "$HAS_TIMEOUT" -eq 1 ] && [ "$rc" -eq 124 ]; then
    echo "      [WARN] timed out after 300s — partial results only"
    TIMED_OUT="${TIMED_OUT:+$TIMED_OUT,}gitleaks"
    FLAG_ERROR=1
    publish_report "$OUT_DIR/gitleaks.json.tmp" "$OUT_DIR/gitleaks.json"
  elif [ "$rc" -ne 0 ]; then
    echo "      (exit $rc — see $OUT_DIR/gitleaks.stderr)"
    FLAG_ERROR=1
  else
    publish_report "$OUT_DIR/gitleaks.json.tmp" "$OUT_DIR/gitleaks.json" || FLAG_ERROR=1
    if valid_json_size "$OUT_DIR/gitleaks.json"; then
      GITLEAKS_COUNT=$(count_matches '"RuleID"' "$OUT_DIR/gitleaks.json")
      echo "      leaks=$GITLEAKS_COUNT"
      if [ "$GITLEAKS_COUNT" -gt 0 ]; then
        FLAG_FINDINGS=1
      fi
    else
      echo "      (report missing or truncated — see $OUT_DIR/gitleaks.stderr)"
      FLAG_ERROR=1
    fi
  fi
else
  echo "[2/3] Gitleaks: NOT INSTALLED"
  echo "      install: scoop install gitleaks"
  FLAG_MISSING=1
fi
echo ""

# ---------- OSV-Scanner ----------
# OSV-Scanner exit codes:
#   0 = no vulnerabilities found
#   1 = vulnerabilities found
#   2 = tool error
#   other = unexpected
# Modern path: use --allow-no-lockfiles when supported so "no manifests"
# becomes rc=0 with valid JSON and is handled by normal parsing.
# IMPORTANT: check rc before file size to avoid misclassifying a crashed run as
# successful just because a partial JSON file was left behind.
if command -v osv-scanner >/dev/null 2>&1; then
  OSV_HAS_ALLOW_NO_LOCKFILES=0
  if osv-scanner scan source --help 2>/dev/null | grep -q -- '--allow-no-lockfiles'; then
    OSV_HAS_ALLOW_NO_LOCKFILES=1
  fi

  echo "[3/3] OSV-Scanner (dependency CVEs)..."
  OSV_ARGS=(scan source --recursive --format json --output-file "$OUT_DIR/osv.json.tmp")
  [ "$OSV_HAS_ALLOW_NO_LOCKFILES" -eq 1 ] && OSV_ARGS+=(--allow-no-lockfiles)
  OSV_ARGS+=("$PROJECT")
  $TIMEOUT_PREFIX osv-scanner "${OSV_ARGS[@]}" >"$OUT_DIR/osv.stdout" 2>"$OUT_DIR/osv.stderr"
  rc=$?
  if [ "$HAS_TIMEOUT" -eq 1 ] && [ "$rc" -eq 124 ]; then
    echo "      [WARN] timed out after 300s - partial results only"
    TIMED_OUT="${TIMED_OUT:+$TIMED_OUT,}osv-scanner"
    FLAG_ERROR=1
    publish_report "$OUT_DIR/osv.json.tmp" "$OUT_DIR/osv.json" || true
  elif [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then
    # Modern path: --allow-no-lockfiles turns "no manifests" into rc=0 with
    # valid (possibly empty-results) JSON. Process via normal logic.
    publish_report "$OUT_DIR/osv.json.tmp" "$OUT_DIR/osv.json" || FLAG_ERROR=1
    if valid_json_size "$OUT_DIR/osv.json"; then
      OSV_CRIT=$(count_matches '"severity":[[:space:]]*"CRITICAL"' "$OUT_DIR/osv.json")
      OSV_HIGH=$(count_matches '"severity":[[:space:]]*"HIGH"' "$OUT_DIR/osv.json")
      OSV_MED=$(count_matches '"severity":[[:space:]]*"(MEDIUM|MODERATE)"' "$OUT_DIR/osv.json")
      OSV_LOW=$(count_matches '"severity":[[:space:]]*"LOW"' "$OUT_DIR/osv.json")
      echo "      CRITICAL=$OSV_CRIT  HIGH=$OSV_HIGH  MED/MOD=$OSV_MED  LOW=$OSV_LOW"
      if [ "$OSV_CRIT" -gt 0 ] || [ "$OSV_HIGH" -gt 0 ]; then
        FLAG_FINDINGS=1
      fi
    else
      echo "      (report missing or truncated - see $OUT_DIR/osv.stderr)"
      FLAG_ERROR=1
    fi
  elif [ "$rc" -eq 128 ] && [ "$OSV_HAS_ALLOW_NO_LOCKFILES" -eq 0 ]; then
    # LEGACY fallback: trust rc=128 as "no sources" only when the capability
    # probe says the flag is unsupported, stderr has an exact match, and no
    # .tmp JSON was written.
    if grep -Fqx "No package sources found" "$OUT_DIR/osv.stderr" 2>/dev/null \
       && [ ! -f "$OUT_DIR/osv.json.tmp" ]; then
      echo "      (no dependency manifests found - skipped, legacy OSV)"
    else
      echo "      (exit 128 without clean legacy-skip signal - see $OUT_DIR/osv.stderr)"
      FLAG_ERROR=1
    fi
  else
    echo "      (exit $rc - see $OUT_DIR/osv.stderr)"
    FLAG_ERROR=1
  fi
else
  echo "[3/3] OSV-Scanner: NOT INSTALLED"
  echo "      install: scoop install osv-scanner"
  FLAG_MISSING=1
fi
echo ""

# ---------- Result ----------
# Three independent flags combined here so no state stomps another.
# Exit code precedence: MISSING|ERROR -> 2, FINDINGS-only -> 1, nothing -> 0.
# Parts joined with "; " separator; no leading space, no trailing separator.

RESULT_PARTS=()
if [ "$FLAG_MISSING" -gt 0 ]; then
  RESULT_PARTS+=("setup incomplete (some scanners missing)")
fi
if [ "$FLAG_ERROR" -gt 0 ]; then
  if [ -n "$TIMED_OUT" ]; then
    RESULT_PARTS+=("tool error (timed out: $TIMED_OUT)")
  else
    RESULT_PARTS+=("tool error (see .stderr files in $OUT_DIR)")
  fi
fi
if [ "$FLAG_FINDINGS" -gt 0 ]; then
  RESULT_PARTS+=("findings present (read JSON reports in $OUT_DIR)")
fi

if [ "${#RESULT_PARTS[@]}" -eq 0 ]; then
  echo "RESULT: clean — no findings above threshold"
  exit 0
fi

# Join parts with "; " separator
RESULT_MSG="${RESULT_PARTS[0]}"
for part in "${RESULT_PARTS[@]:1}"; do
  RESULT_MSG="$RESULT_MSG; $part"
done
echo "RESULT: $RESULT_MSG"

if [ "$FLAG_MISSING" -gt 0 ] || [ "$FLAG_ERROR" -gt 0 ]; then
  exit 2
else
  exit 1
fi
