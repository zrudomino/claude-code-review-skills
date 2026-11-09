// Regression cases for lib/parallel-run.js parameter checks (no Codex calls).
// Usage: node codex-agent/tests/parallel-run-cases.js [path/to/lib]  -> "parallel-run all ok"
"use strict";
var path = require("path");
var fs = require("fs");
var os = require("os");
var cp = require("child_process");

var libDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "lib");
var runner = require(path.join(libDir, "parallel-run.js"));

var failures = [];
function check(name, cond, detail) { if (!cond) failures.push(name + (detail ? ": " + detail : "")); }

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-parallel-test-"));
var taskFile = path.join(tmp, "task.txt");
fs.writeFileSync(taskFile, "Reply with OK.");
function params(over) {
  var p = { taskFile: taskFile, models: [null, "gpt-6.1-sol"], workingDir: tmp, timeoutMs: 300000, profile: "lean" };
  for (var k in over) p[k] = over[k];
  return p;
}

check("valid params", runner.validateParams(params({})) === null, runner.validateParams(params({})));
check("two defaults", runner.validateParams(params({ models: [null, null] })) === null);
var badModels = ["gpt-6'; touch x", "$(touch x)", "a b", "", "gpt\"x", "`x`", 5];
badModels.forEach(function (m) {
  check("rejects model " + JSON.stringify(m), runner.validateParams(params({ models: [m, null] })) !== null);
});
check("one model only", runner.validateParams(params({ models: ["gpt-6-sol"] })) !== null);
check("three models", runner.validateParams(params({ models: [null, null, null] })) !== null);
check("missing task file", runner.validateParams(params({ taskFile: path.join(tmp, "nope.txt") })) !== null);
check("task file is a folder", runner.validateParams(params({ taskFile: tmp })) !== null);
check("missing folder", runner.validateParams(params({ workingDir: path.join(tmp, "nope") })) !== null);
check("timeout too small", runner.validateParams(params({ timeoutMs: 500 })) !== null);
check("timeout as string", runner.validateParams(params({ timeoutMs: "300000" })) !== null);
check("timeout at timer limit", runner.validateParams(params({ timeoutMs: runner.MAX_TIMEOUT_MS })) === null);
check("timeout above timer limit", runner.validateParams(params({ timeoutMs: runner.MAX_TIMEOUT_MS + 1 })) !== null);
check("timeout not an integer", runner.validateParams(params({ timeoutMs: 300000.5 })) !== null);
check("timeout infinite", runner.validateParams(params({ timeoutMs: Infinity })) !== null);
check("readTask ok", runner.readTask(taskFile).text === "Reply with OK.");
check("readTask failure is an error, not a throw", /cannot read taskFile/.test(runner.readTask(path.join(tmp, "gone.txt")).error || ""));
check("bad profile", runner.validateParams(params({ profile: "lean; rm" })) !== null);
check("not an object", runner.validateParams(null) !== null);

// summarize(): drops stdout, keeps the runner's fields, falls back when there is no stdout.
var s1 = runner.summarize({ stdout: '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}', result: "OK", model: null, durationMs: 5 },
  require(path.join(libDir, "parse-output.js")));
check("summarize: no stdout field", s1.stdout === undefined);
check("summarize: parsed", s1.parsedResult === "OK" && s1.parsedUsage.cachedInputTokens === 4 && s1.parsedSessionId === "t1" && s1.parsedStatus === "completed", JSON.stringify(s1));
var s2 = runner.summarize({ result: "", status: "timeout", error: "Timed out" }, require(path.join(libDir, "parse-output.js")));
check("summarize: timeout kept", s2.parsedStatus === "timeout" && s2.parsedUsage.cachedInputTokens === 0, JSON.stringify(s2));

// CLI: a bad params file is refused before any Codex process starts.
var bad = path.join(tmp, "bad.json");
fs.writeFileSync(bad, JSON.stringify(params({ models: ["$(touch " + path.join(tmp, "marker").replace(/\\/g, "/") + ")", null] })));
var out = cp.spawnSync(process.execPath, [path.join(libDir, "parallel-run.js"), bad], { encoding: "utf-8" });
check("cli: exit 1", out.status === 1, out.status);
check("cli: error json", /"error":"invalid model name/.test(out.stdout), out.stdout);
check("cli: no marker", !fs.existsSync(path.join(tmp, "marker")));
var notJson = path.join(tmp, "x.json");
fs.writeFileSync(notJson, "{ not json");
out = cp.spawnSync(process.execPath, [path.join(libDir, "parallel-run.js"), notJson], { encoding: "utf-8" });
check("cli: unreadable params", out.status === 1 && /cannot read params file/.test(out.stdout), out.stdout);

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) { console.log("FAIL\n" + failures.join("\n")); process.exit(1); }
console.log("parallel-run all ok");
