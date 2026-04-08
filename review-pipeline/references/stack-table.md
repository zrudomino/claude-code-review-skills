# Stack Detection Reference

## Marker File Detection

Use the Glob tool to check for each marker file. This works identically on Windows and Unix. In monorepos, recursively discover package roots by searching for marker files in subdirectories up to 3 levels deep. Run each detected stack's tools scoped to its package root. When a changed file is detected by multiple stack markers (e.g., a shared `types/` directory), run all matching stacks' tools on that file and union the findings.

| Marker File | Stack Candidate |
|-------------|-----------------|
| `pyproject.toml` or `setup.py` | Python |
| `package.json` | JS/TS (disambiguate below) |
| `build.gradle.kts` or `build.gradle` | Kotlin/Android |
| `Cargo.toml` | Rust |
| `go.mod` | Go |

## JS/TS Disambiguation

For `package.json` projects, apply these rules in order (first match wins):

| Condition | Classification |
|-----------|---------------|
| `vite.config.*` exists AND `react` NOT in any dependencies section | Vue/TS |
| `vite.config.*` exists AND `react` in any dependencies section | React/TS |
| `next.config.*` exists | Next.js |
| `react` in dependencies | React/TS |
| `strapi` in dependencies | Strapi/Node |
| `tsconfig.json` exists | Plain TS/Node |
| None of the above | Plain JS/Node |

**Note:** "in dependencies" means present in any of: `dependencies`, `devDependencies`, or `peerDependencies` in `package.json`. Read the file and check all dependency objects.

## Stack Tool Table

For each detected stack, run the tools in order during the pre-stage.

| Stack | Step 1: Lint | Step 2: Type Check | Step 3: Test Suite | Step 4: Coverage |
|-------|-------------|-------------------|-------------------|-----------------|
| Python | `ruff check .` | `mypy --strict --ignore-missing-imports .` | `python -m pytest -x -q` | `pytest --cov=. --cov-report=json` |
| Vue/TS | `npx eslint .` | `npx vue-tsc --noEmit` | `npx vitest run` | `npx vitest run --coverage` |
| Next.js/TS | `npx eslint .` | `npx tsc --noEmit` | `npx jest --passWithNoTests` or `npx vitest run` | `npx vitest run --coverage` or `npx jest --coverage` (match test runner) |
| Plain TS/Node | `npx eslint .` (skip if no eslint config) | `npx tsc --noEmit` | Detect from `package.json` `"test"` script | Detect from `package.json` -- `nyc` or `c8` if available |
| Plain JS/Node | `npx eslint .` (skip if no eslint config) | Skip | Detect from `package.json` `"test"` script | Detect from `package.json` -- `nyc` or `c8` if available |
| React/TS | `npx eslint .` | `npx tsc --noEmit` | `npx jest --passWithNoTests` or `npx vitest run` | `npx vitest run --coverage` or `npx jest --coverage` (match test runner) |
| Kotlin/Android | `./gradlew ktlintCheck` | Kotlin compiler (part of build) | `./gradlew testDebugUnitTest` | `./gradlew jacocoTestReport` |
| Strapi/Node | `npx eslint .` | `npx tsc --noEmit` | `npx jest --passWithNoTests` | `npx jest --coverage` |
| Rust | `cargo clippy -- -D warnings` | `cargo check` | `cargo test` | `cargo llvm-cov` (if installed, else `[SKIP]`) |
| Go | `golangci-lint run` | Go compiler (part of build) | `go test ./...` | `go test -cover -coverprofile=coverage.out ./...` |

**Test runner disambiguation for Next.js/React:** Detect test runner from `package.json` scripts or dependencies: if `vitest` is in dependencies or devDependencies, use vitest commands. Otherwise, use jest commands.

**Frontend stacks** (for Gate 3 skip condition): Vue/TS, React/TS, Next.js/TS. All other stacks: Gate 3 is `[SKIP]`.

## Failure Handling

If `--files` was provided, scope deterministic checks to only the stacks relevant to those files.

| Condition | Result |
|-----------|--------|
| Failure in files OUTSIDE diff scope | Emit warning: "TOOL_ERRORS (out-of-scope): [tool]: N errors in [files] -- these are pre-existing and not caused by the current diff." Do not block. |
| `TOOL_MISSING` within diff scope | Error: "[tool] not found. Install: [install command]" -- STOP |
| `TOOL_ERRORS` within diff scope | Error: "[tool]: N errors in [files]" -- STOP |
| `TOOL_CRASH` within diff scope | Error: "[tool] exited with signal [signal]" -- STOP |
| `TOOL_TIMEOUT` within diff scope | Error: "[tool] exceeded [timeout]s timeout" -- STOP |
| No marker files found | Warn "No recognized stack detected -- deterministic checks skipped" and proceed |
