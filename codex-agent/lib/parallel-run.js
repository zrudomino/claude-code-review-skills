/**
 * parallel-run.js — Run one task on two Codex models at once (used by /codex-agent:parallel).
 *
 * Usage: node parallel-run.js <params.json>
 *   params: { "taskFile": "<path>", "models": [<slug or null>, <slug or null>],
 *             "workingDir": "<path>", "timeoutMs": <number>, "profile": "lean" | "full" }
 *
 * The command file writes params.json with the Write tool and never generates JavaScript:
 * every value is checked here, and the task text is read from taskFile and reaches Codex
 * on stdin (parallel.js). Prints a JSON array with one result per model, or {"error": ...}
 * with exit code 1. No npm dependencies.
 */

"use strict";

var fs = require("fs");
var path = require("path");

// Model slugs as listed by `codex debug models` (e.g. gpt-6.1-sol); nothing else may reach
// the `-m` argument.
var MODEL_PATTERN = /^[A-Za-z0-9._:\/-]+$/;

// setTimeout clamps larger delays to 1 ms (TimeoutOverflowWarning), which would kill both
// Codex processes at once.
var MAX_TIMEOUT_MS = 2147483647;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/**
 * @returns {string|null} the first problem found, or null when params are usable
 */
function validateParams(params) {
  if (!params || typeof params !== "object") return "params must be a JSON object";
  if (typeof params.taskFile !== "string" || !isFile(params.taskFile)) return "taskFile missing or not a file";
  if (!Array.isArray(params.models) || params.models.length !== 2) return "models must be an array of exactly two entries";
  for (var i = 0; i < params.models.length; i++) {
    var m = params.models[i];
    if (m !== null && !(typeof m === "string" && MODEL_PATTERN.test(m))) {
      return "invalid model name " + JSON.stringify(m) + " (allowed: null or " + MODEL_PATTERN + ")";
    }
  }
  if (typeof params.workingDir !== "string" || !isDirectory(params.workingDir)) return "workingDir missing or not a directory";
  if (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 10000 || params.timeoutMs > MAX_TIMEOUT_MS) {
    return "timeoutMs must be an integer from 10000 to " + MAX_TIMEOUT_MS;
  }
  if (params.profile !== "lean" && params.profile !== "full") return "profile must be \"lean\" or \"full\"";
  return null;
}

/** Read the task file; a read failure becomes an error message, never a stack trace. */
function readTask(file) {
  try {
    return { text: fs.readFileSync(file, "utf-8") };
  } catch (e) {
    return { error: "cannot read taskFile: " + e.message };
  }
}

function summarize(result, parser) {
  var parsed = result.stdout ? parser.parseCodexOutput(result.stdout, result.result) : null;
  var out = {};
  for (var k in result) if (k !== "stdout") out[k] = result[k];
  out.parsedResult = parsed ? parsed.result : (result.result || "");
  out.parsedUsage = parsed ? parsed.usage : (result.usage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCost: 0 });
  out.parsedFilesChanged = parsed ? parsed.filesChanged : (result.filesChanged || []);
  out.parsedStatus = (parsed && parsed.status !== "unknown") ? parsed.status : (result.status || "unknown");
  out.parsedSessionId = parsed ? parsed.sessionId : null; // Codex thread id, for the plan-usage line
  return out;
}

function main(paramsFile) {
  var params;
  try {
    params = JSON.parse(fs.readFileSync(paramsFile, "utf-8"));
  } catch (e) {
    return finish({ error: "cannot read params file: " + e.message }, 1);
  }
  var problem = validateParams(params);
  if (problem) return finish({ error: problem }, 1);

  var task = readTask(params.taskFile);
  if (task.error) return finish({ error: task.error }, 1);

  var parallel = require(path.join(__dirname, "parallel.js"));
  var parser = require(path.join(__dirname, "parse-output.js"));
  var tasks = params.models.map(function (model) {
    return { prompt: task.text, model: model, workingDir: params.workingDir, timeout: params.timeoutMs, profile: params.profile };
  });

  parallel.dispatchParallel(tasks, {}, function (err, results) {
    if (err) return finish({ error: err.message || String(err) }, 1);
    finish(results.map(function (r) { return summarize(r, parser); }), 0);
  });
}

function finish(value, code) {
  console.log(JSON.stringify(value));
  process.exitCode = code;
}

if (require.main === module) {
  if (!process.argv[2]) finish({ error: "usage: node parallel-run.js <params.json>" }, 1);
  else main(process.argv[2]);
}

module.exports = { validateParams: validateParams, readTask: readTask, summarize: summarize, MODEL_PATTERN: MODEL_PATTERN, MAX_TIMEOUT_MS: MAX_TIMEOUT_MS };
