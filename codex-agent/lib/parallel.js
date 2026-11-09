/**
 * parallel.js — Spawn concurrent Codex processes and collect results.
 *
 * Dispatches N tasks to Codex CLI in parallel, each potentially with
 * different models or prompts. Collects all results via callbacks.
 * No npm dependencies. ES5 strict.
 *
 * Usage: Create a temp script that requires this module and calls dispatchParallel.
 *   var p = require("<path>/parallel.js");
 *   p.dispatchParallel(tasks, options, function(err, results) { ... });
 */

"use strict";

var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");

/**
 * Build the command arguments array for a single codex exec invocation.
 * @param {object} task - { prompt, model, workingDir, timeout, profile } — profile: a Codex
 *   profile name such as "lean" ($CODEX_HOME/<name>.config.toml); null or "full" = user config
 * @param {string} lastMsgPath - Path for --output-last-message
 * @returns {string[]} Array of arguments for spawn
 */
function buildCommand(task, lastMsgPath) {
  var args = [];

  // -p is a global option and must come before `exec` (Codex 0.167.0).
  if (task.profile && task.profile !== "full") {
    args.push("-p", task.profile);
  }

  // `--full-auto` was removed from Codex (0.167.0 rejects it: "unexpected argument").
  // Its sandbox half is `--sandbox workspace-write`, the same mode dispatch.md uses;
  // approvals do not apply to non-interactive `codex exec`.
  // --skip-git-repo-check: exec refuses non-git folders even when config marks them
  // trusted (verified on 0.167.0); inside a git repository the flag changes nothing.
  args.push("exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--json");

  if (task.model) {
    args.push("-m", task.model);
  }

  if (task.workingDir) {
    args.push("-C", task.workingDir);
  }

  if (lastMsgPath) {
    args.push("--output-last-message", lastMsgPath);
  }

  // "-" = read the prompt from stdin (codex exec --help, 0.167.0). spawnCodex writes
  // task.prompt to stdin, so the prompt never touches a command line: no quoting or
  // shell-metacharacter issues and no ~32K Windows command-line limit.
  args.push("-");

  return args;
}

/**
 * Spawn a single Codex process and collect its output.
 * @param {object} task - { prompt, model, workingDir, timeout }
 * @param {function} callback - function(err, result)
 */
function spawnCodex(task, callback) {
  var tmpDir = path.join(os.tmpdir(), "codex-agent");
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* exists */ }

  var id = Date.now() + "-" + Math.random().toString(16).slice(2);
  var lastMsgPath = path.join(tmpDir, "par-lastmsg-" + id + ".txt");
  var args = buildCommand(task, lastMsgPath);
  var timeoutMs = task.timeout || 300000;
  var startTime = Date.now();
  var finished = false;

  var stdout = "";
  var stderr = "";

  // shell: false — with shell: true Node joins args unescaped into a cmd.exe line, which
  // split every multi-word prompt ("unexpected argument") and let & | in prompts run as
  // commands. codex resolves to codex.exe on PATH, so no shell is needed.
  var proc = child_process.spawn("codex", args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: process.env
  });

  // If codex exits before reading stdin, the write fails with EPIPE; the close/error
  // handlers below already report the failure, so don't let it crash the parent.
  proc.stdin.on("error", function () { /* reported via close/error */ });
  proc.stdin.end(task.prompt || "");

  proc.stdout.on("data", function (chunk) {
    stdout += chunk.toString();
  });

  proc.stderr.on("data", function (chunk) {
    stderr += chunk.toString();
  });

  // Timeout handler
  var timer = setTimeout(function () {
    if (!finished) {
      finished = true;
      try { proc.kill(); } catch (e) { /* ignore */ }
      callback(null, {
        result: "",
        usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
        filesChanged: [],
        status: "timeout",
        durationMs: Date.now() - startTime,
        error: "Timed out after " + (timeoutMs / 1000) + " seconds",
        stdout: stdout,
        lastMsgPath: lastMsgPath,
        model: task.model || null
      });
    }
  }, timeoutMs);

  proc.on("close", function (code) {
    clearTimeout(timer);
    if (finished) return;
    finished = true;

    var durationMs = Date.now() - startTime;

    // Read last-message file
    var lastMsg = "";
    try { lastMsg = fs.readFileSync(lastMsgPath, "utf-8"); } catch (e) { /* no file */ }

    callback(null, {
      result: lastMsg || "",
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      filesChanged: [],
      status: code === 0 ? "completed" : "error",
      durationMs: durationMs,
      error: code !== 0 ? ("Exit code " + code + (stderr ? ": " + stderr.substring(0, 500) : "")) : null,
      stdout: stdout,
      lastMsgPath: lastMsgPath,
      model: task.model || null
    });
  });

  proc.on("error", function (err) {
    clearTimeout(timer);
    if (finished) return;
    finished = true;

    callback(null, {
      result: "",
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      filesChanged: [],
      status: "error",
      durationMs: Date.now() - startTime,
      error: err.message || "spawn error",
      stdout: stdout,
      lastMsgPath: lastMsgPath,
      model: task.model || null
    });
  });
}

/**
 * Dispatch multiple Codex tasks in parallel.
 * @param {Array} tasks - Array of { prompt, model, workingDir, timeout }
 * @param {object} options - Reserved for future use
 * @param {function} callback - function(err, results) where results is an array matching tasks order
 */
function dispatchParallel(tasks, options, callback) {
  if (!tasks || tasks.length === 0) {
    return callback(null, []);
  }

  var results = new Array(tasks.length);
  var completed = 0;

  for (var i = 0; i < tasks.length; i++) {
    (function (index) {
      spawnCodex(tasks[index], function (err, result) {
        results[index] = err ? { error: err.message || String(err), status: "error" } : result;
        completed++;
        if (completed === tasks.length) {
          callback(null, results);
        }
      });
    })(i);
  }
}

module.exports = {
  dispatchParallel: dispatchParallel,
  buildCommand: buildCommand
};
