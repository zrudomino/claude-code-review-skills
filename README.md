# review-pipeline + fix-and-verify

Two Claude Code skills that form an end-to-end code review and automated fix pipeline.

## Skills

### /review-pipeline
Multi-stage code review pipeline with:
- Automatic stack detection (Python, TS, Go, Rust, Kotlin, etc.)
- Tiered classification (Lightweight / Standard / Critical)
- Parallel agent scan (Bug Hunter, Failure Hunter, Plan Guardian)
- Specialist agents (Architect, Warden, Test Auditor, Type Analyst)
- Cross-model adversarial review via Codex
- Convergence tracking across review rounds

### /fix-and-verify
Red-green-commit loop for fixing review findings:
- Agent A writes a failing test from the bug description (no source code at level 1)
- Agent B applies a minimal fix from the failing test (no bug description at level 1)
- Agent C runs tiered verification gates (lint, type check, tests, coverage)
- Codex Adversarial testing tries to break the fix
- Automatic write-back to state file for convergence tracking

## Installation

Copy the skill directories to your Claude Code skills folder:

```bash
cp -r review-pipeline ~/.claude/skills/
cp -r fix-and-verify ~/.claude/skills/
```

## Usage

```
> review my code
> fix the punch list
```

## Version
v0.1.0 | schema_version: 2
