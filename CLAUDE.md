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
| Stack detection | review-pipeline/references/stack-table.md |
| Convergence matching | review-pipeline/references/convergence.md |

## Version
Both skills are at v0.1.0 (schema_version: 2).
