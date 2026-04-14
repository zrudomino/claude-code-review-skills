# Skills Project

## Overview
This project contains two Claude Code skills that form a code review and fix pipeline:
- **review-pipeline** — Multi-agent code review with stack detection, tiered classification, convergence tracking, and cross-model adversarial review
- **fix-and-verify** — Red-green-commit loop for fixing review findings with isolated agents, tiered verification gates, and Codex adversarial testing

## Skill Locations
- `~/.claude/skills/review-pipeline/SKILL.md` + `references/`
- `~/.claude/skills/fix-and-verify/SKILL.md` + `references/`

## Architecture Rules
- **review-pipeline owns all canonical definitions**: finding schema, state schema, gate registry, stack table, convergence algorithm
- **fix-and-verify references, never redefines**: it points to review-pipeline's canonical sources or carries convenience copies marked as such
- **Invariants are self-contained per skill**: each skill loads independently, so invariants must carry full text (no cross-skill references for runtime behavior)
- **Codex dispatch uses Skill tool, never Agent tool**: Invariant 8 (review-pipeline) and Invariant 12 (fix-and-verify) — enforced by hookify drift guard

## Shared Concepts (canonical source)
| Concept | Canonical File |
|---------|---------------|
| Finding schema | review-pipeline/references/state-schema.md |
| State file schema | review-pipeline/references/state-schema.md |
| Gate registry | review-pipeline/references/gate-registry.md |
| Gate 8 (security regression delta) | review-pipeline/references/gate-registry.md |
| Stack detection | review-pipeline/references/stack-table.md |
| Convergence matching | review-pipeline/references/convergence.md |
| Security finding convergence + tombstoning | review-pipeline/references/convergence.md |
| Step 5A Security Corpus Seeding procedure | review-pipeline/references/security-corpus.md |
| Semgrep / Gitleaks / OSV normalization table | review-pipeline/references/security-corpus.md |
| `sec_baseline` / `sec_scanner_versions` / `matching_epoch` / `sec_escalate_tier` state fields | review-pipeline/references/state-schema.md |
| `scan_artifact_path` / `match_based_id` / `sec_identity_key` per-finding fields | review-pipeline/references/state-schema.md |

fix-and-verify carries a self-contained convenience copy of the Gate 8 procedure at `fix-and-verify/references/security-gate-8.md` (explicitly marked as such). If divergence exists, review-pipeline is authoritative.

## Three-Skill Integration
- **local-security-scan** v0.8.0 — wrapper around Semgrep + Gitleaks + OSV-Scanner. Invoked by both other skills. Supports `SEMGREP_SKIP` / `GITLEAKS_SKIP` / `OSV_SKIP` env vars with RESULT-line transparency per Invariant 8.
- **review-pipeline** v0.3.0 — runs local-security-scan at Step 5A (between Pre-Stage and Stage 0) to seed the finding corpus. Normalizes scan JSON into the canonical finding schema via the table in `references/security-corpus.md`. May escalate Stage 0 tier on P0 secrets / CVEs via `sec_escalate_tier`.
- **fix-and-verify** v0.3.0 — captures `sec_baseline` at Step 0, runs Gate 8 at Step 4.5 (between Codex Adversarial and Commit) to detect *new* findings relative to baseline. Hard-escalates on `scan_incomplete` or `matching_epoch` drift.

## Version
- review-pipeline: v0.3.0 (schema_version: 2)
- fix-and-verify: v0.3.0 (schema_version: 2)
- local-security-scan: v0.8.0
