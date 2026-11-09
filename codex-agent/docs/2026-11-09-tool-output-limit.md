# `tool_output_token_limit` measurement (item G), 2026-11-09

Codex CLI 0.167.0, Windows 10, model `gpt-6-sol` (effort high, inherited by the `lean` profile), lean profile, read-only, `--output-schema`.

## Question

Every model step re-sends the whole transcript, and in today's reviews tool output was most of that transcript. Would a lower per-output cap (`-c tool_output_token_limit=N`) make consult and review calls cheaper without losing findings?

## What the setting does (verified)

- The default comes from the model catalog (`codex debug models`, field `truncation_policy`): `{"mode":"tokens","limit":10000}` for `gpt-6-sol` and `gpt-6.1-sol`. Neither `~/.codex/config.toml` nor `lean.config.toml` sets it.
- `-c tool_output_token_limit=N` is accepted (no "unrecognized setting" warning) and **does** apply. Probe with `N=500`, one `cat` of `dispatch.md` (8,656 tokens): step 2 grew from 12,729 to 13,633 input tokens, so the model saw ~900 tokens. Codex answered "TRUNCATED".
- The rollout file still stores the **full** output with `original_token_count`, so rollout sizes show what the tool produced, not what the model saw.
- In the three reviews run earlier today (117,773 / 357,239 / 417,460 input tokens), the largest outputs sat at the 10K cap (~41.5K chars), and 1-4 outputs per review carried truncation markers.

## A/B run

The same focused review of commit `7ae6c0a` (the file + stdin change, with known issues). The prompt is identical in both runs, and they ran back to back. Prompt and scripts were scratch files (`g-review-prompt.txt`, `g-run.sh`, `g-compare.js`), not kept.

| | A: default (10,000) | B: `tool_output_token_limit=2500` |
|-|-|-|
| Wall time | 121 s | 187 s (+54%) |
| Model steps / tool calls | 6 / 5 | 14 / 13 |
| Input tokens (total) | 234,835 | 476,570 (+103%) |
| Uncached input | 49,107 | 38,298 (-22%) |
| Output tokens | 5,450 | 8,675 |
| Tool output produced (rollout `original_token_count`) | 37,803 | 28,117 |
| 5-hour plan window | 20% → 21% (+1) | 21% → 24% (+3) |
| Findings | 4 (2 high, 2 medium) | 4 (1 high, 2 medium, 1 low) |

Both runs found the same three issues: the inline session-JSON command in dispatch Step 9e, unescaped values written into the parallel script, and the topic file rewritten after the session records it. A also flagged the configured model entering the JS unvalidated; B also flagged a lone `--full` that passes input validation.

## Result

With the smaller cap, Codex read in more, smaller pieces. That meant 2.3x the model steps, and since each step re-sends the transcript, total input doubled and wall time rose 54%. Uncached input fell by 22%, but the plan window moved 3 points instead of 1. On this plan, quota tracks total input, cached included, more than uncached input. Finding quality was the same.

**Decision: keep the default (10,000).** Do not lower the cap in `lean.config.toml` or in codex-agent commands. One run per setting is a small sample, but the step count and the plan percentage point the same way.

Not measured: a *higher* cap (e.g. 20,000) could save re-reads of files that are cut at 10K, but it also enlarges every later step. Test it only if long-file reviews become a cost problem. The cheaper lever remains the prompt: name the files and line ranges, or paste the diff.
