// Regression cases for usage accounting (parse-output.js + usage-tracker.js).
// Usage: node codex-agent/tests/usage-cases.js [path/to/lib]   (default: ../lib next to this file)
// Prints "usage all ok" or the failing cases; exit code 1 on failure. No Codex calls, no network.
"use strict";
var path = require("path");
var fs = require("fs");
var os = require("os");

var libDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "lib");
var p = require(path.join(libDir, "parse-output.js"));
var ut = require(path.join(libDir, "usage-tracker.js"));

var failures = [];
function check(name, cond, detail) { if (!cond) failures.push(name + (detail ? ": " + detail : "")); }

function jsonl(events) { return events.map(function (e) { return JSON.stringify(e); }).join("\n"); }
function turn(input, cached, output) {
  return { type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } };
}
var T1 = "01a1be87-d415-7860-9c79-cf5d1bdfbc79";
var T2 = "01a1be88-eb86-7151-9edf-84f7cb46ce4b";
var started = { type: "thread.started", thread_id: T1 };
var msg = { type: "item.completed", item: { type: "agent_message", text: "ACK" } };

// 1. Fresh run: usage = the turn.completed numbers; totals tagged with the thread.
var r1 = p.parseCodexOutput(jsonl([started, msg, turn(12997, 9344, 399)]), "");
check("fresh: input", r1.usage.inputTokens === 12997, r1.usage.inputTokens);
check("fresh: cached", r1.usage.cachedInputTokens === 9344, r1.usage.cachedInputTokens);
check("fresh: mode", r1.usageMode === "run" && r1.usageSource === "final-event", r1.usageMode + "/" + r1.usageSource);
check("fresh: threadId", r1.threadTotals.threadId === T1, r1.threadTotals.threadId);
check("fresh: sessionId", r1.sessionId === T1);

// 2. Two final events in one stdout are running totals: the last one wins, no sum.
var r2 = p.parseCodexOutput(jsonl([started, turn(13677, 12544, 1656), msg, turn(29703, 24320, 3226)]), "");
check("two finals: last wins", r2.usage.inputTokens === 29703 && r2.usage.outputTokens === 3226, JSON.stringify(r2.usage));

// 3. Legacy stream without a final event: usage-carrying events are summed.
var legacy = [{ type: "response", usage: { prompt_tokens: 100, completion_tokens: 10 } },
              { type: "response", usage: { prompt_tokens: 50, completion_tokens: 5 } }];
var r3 = p.parseCodexOutput(jsonl(legacy), "");
check("legacy: summed", r3.usage.inputTokens === 150 && r3.usage.outputTokens === 15, JSON.stringify(r3.usage));
check("legacy: source", r3.usageSource === "summed-events", r3.usageSource);

// 4. Final event present alongside other usage events: final wins, others ignored.
var r4 = p.parseCodexOutput(jsonl([started].concat(legacy, [turn(500, 400, 20)])), "");
check("final beats legacy", r4.usage.inputTokens === 500, r4.usage.inputTokens);

// 5. No usage at all.
var r5 = p.parseCodexOutput(jsonl([started, msg]), "");
check("none: source", r5.usageSource === "none" && r5.usage.inputTokens === 0, r5.usageSource);

// 6. Resumed round, same thread: usage = this round only.
var prev = { inputTokens: 13677, cachedInputTokens: 12544, outputTokens: 1656, totalTokens: 15333, estimatedCost: 0, threadId: T1 };
var r6 = p.parseCodexOutput(jsonl([started, msg, turn(29703, 24320, 3226)]), "", prev);
check("resume: delta", r6.usageMode === "delta" && r6.usage.inputTokens === 16026 && r6.usage.cachedInputTokens === 11776 && r6.usage.outputTokens === 1570, JSON.stringify(r6.usage) + " " + r6.usageMode);
check("resume: totals kept", r6.threadTotals.inputTokens === 29703 && r6.threadTotals.threadId === T1);
check("resume: no threadId on usage", r6.usage.threadId === undefined);

// 7. Totals from another thread are never subtracted.
var r7 = p.parseCodexOutput(jsonl([{ type: "thread.started", thread_id: T2 }, msg, turn(29703, 24320, 3226)]), "", prev);
check("other thread: mode", r7.usageMode === "new-thread", r7.usageMode);
check("other thread: raw usage", r7.usage.inputTokens === 29703, r7.usage.inputTokens);

// 8. previousTotals without threadId (recorded before 2026-11-09): still subtracted.
var prevOld = { inputTokens: 13677, cachedInputTokens: 12544, outputTokens: 1656, totalTokens: 15333, estimatedCost: 0 };
var r8 = p.parseCodexOutput(jsonl([started, msg, turn(29703, 24320, 3226)]), "", prevOld);
check("old prev: delta", r8.usageMode === "delta" && r8.usage.inputTokens === 16026, r8.usageMode);

// 9. Totals went down: they were not cumulative, keep the raw numbers.
var r9 = p.parseCodexOutput(jsonl([started, msg, turn(5000, 4000, 100)]), "", prev);
check("totals down: raw-fallback", r9.usageMode === "raw-fallback" && r9.usage.inputTokens === 5000, r9.usageMode);

// 10. Cost or cached tokens missing in a later round never turn into a refund.
var prevCost = { inputTokens: 100, cachedInputTokens: 90, outputTokens: 10, totalTokens: 110, estimatedCost: 0.5, threadId: T1 };
var r10 = p.parseCodexOutput(jsonl([started, { type: "turn.completed", usage: { input_tokens: 200, output_tokens: 20 } }]), "", prevCost);
check("no refund", r10.usage.estimatedCost === 0 && r10.usage.cachedInputTokens === 0, JSON.stringify(r10.usage));
check("no refund: last known totals kept", r10.threadTotals.cachedInputTokens === 90 && r10.threadTotals.estimatedCost === 0.5, JSON.stringify(r10.threadTotals));

// 10b. Three rounds, the middle one omits cached tokens: the recorded rounds must add up to
// the thread's final running total (80 + 0 + 100 = 180), not 80 + 0 + 180.
var a = p.parseCodexOutput(jsonl([started, turn(100, 80, 10)]), "");
var b = p.parseCodexOutput(jsonl([started, { type: "turn.completed", usage: { input_tokens: 200, output_tokens: 20 } }]), "", a.threadTotals);
var c = p.parseCodexOutput(jsonl([started, turn(300, 180, 30)]), "", b.threadTotals);
var cachedSum = a.usage.cachedInputTokens + b.usage.cachedInputTokens + c.usage.cachedInputTokens;
var inputSum = a.usage.inputTokens + b.usage.inputTokens + c.usage.inputTokens;
check("omitted field: cached adds up", cachedSum === 180, a.usage.cachedInputTokens + "+" + b.usage.cachedInputTokens + "+" + c.usage.cachedInputTokens);
check("omitted field: input adds up", inputSum === 300, inputSum);

// 10c. Resumed output without any thread id: subtracted (resume targets that thread) but flagged.
var r10c = p.parseCodexOutput(jsonl([msg, turn(130, 100, 10)]), "", { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5, totalTokens: 105, estimatedCost: 0, threadId: T1 });
check("no thread id: flagged", r10c.usageMode === "delta-unverified" && r10c.usage.inputTokens === 30, r10c.usageMode + " " + r10c.usage.inputTokens);

// 11. Ledger: an old-format ledger (no cached field) migrates, records cached tokens, keeps the rest.
var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-usage-test-"));
var ledgerPath = path.join(tmpDir, "usage-ledger.json");
var oldEntry = function () { return { inputTokens: 1000, outputTokens: 100, estimatedCost: 1.5, dispatches: 2 }; };
fs.writeFileSync(ledgerPath, JSON.stringify({ session: { startedAt: "2026-11-04T21:05:58.965Z", codex: oldEntry(), claudeSubagent: oldEntry() },
  lifetime: { codex: oldEntry(), claudeSubagent: oldEntry() }, lifetimeResetNote: "keep me" }));
var loaded = ut.loadLedger(ledgerPath);
check("ledger: migrated cached field", loaded.lifetime.codex.cachedInputTokens === 0);
check("ledger: tracking marker", typeof loaded.cachedTrackedSince === "string");
ut.recordUsage(ledgerPath, "codex", { inputTokens: 16026, cachedInputTokens: 11776, outputTokens: 1570, estimatedCost: 0 });
var after = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
check("ledger: session add", after.session.codex.inputTokens === 17026 && after.session.codex.cachedInputTokens === 11776 && after.session.codex.dispatches === 3, JSON.stringify(after.session.codex));
check("ledger: lifetime add", after.lifetime.codex.inputTokens === 17026 && after.lifetime.codex.outputTokens === 1670 && after.lifetime.codex.estimatedCost === 1.5);
check("ledger: other agent untouched", after.lifetime.claudeSubagent.inputTokens === 1000);
check("ledger: unknown keys kept", after.lifetimeResetNote === "keep me" && after.session.startedAt === "2026-11-04T21:05:58.965Z");
ut.recordUsage(ledgerPath, "codex", { inputTokens: 10, outputTokens: 1, estimatedCost: 0 });
after = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
check("ledger: cached optional", after.lifetime.codex.cachedInputTokens === 11776 && after.lifetime.codex.dispatches === 4);
ut.resetSession(ledgerPath);
after = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
check("reset: session zeroed", after.session.codex.inputTokens === 0 && after.session.codex.cachedInputTokens === 0);
check("reset: lifetime kept", after.lifetime.codex.inputTokens === 17036);
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length) { console.log("FAIL\n" + failures.join("\n")); process.exit(1); }
console.log("usage all ok");
