/**
 * session-logger.js — Per-dispatch session logging for Codex agent skill.
 *
 * Records each dispatch/discussion as a session with rounds, usage, errors.
 * No npm dependencies. ES5 strict.
 *
 * Usage from node -e:
 *   var sl = require("<path>/session-logger.js");
 *   var session = sl.createSession("dispatch", "fix the bug");
 *   sl.addRound(session, { prompt: "...", response: "...", usage: {...}, timestamp: "..." });
 *   sl.saveSession("<sessionsDir>", session);
 *   var list = sl.listSessions("<sessionsDir>", 10);
 */

"use strict";

var fs = require("fs");
var path = require("path");

/**
 * Create a new session object.
 * @param {string} type - "dispatch" or "discussion"
 * @param {string} taskDescription - The task/topic description
 * @returns {object} A new session object
 */
function createSession(type, taskDescription) {
  var id = Date.now() + "-" + Math.random().toString(16).slice(2, 10);
  var task = taskDescription || "";
  if (task.length > 500) {
    task = task.substring(0, 500);
  }
  return {
    id: id,
    type: type || "dispatch",
    startedAt: new Date().toISOString(),
    completedAt: null,
    task: task,
    agent: "codex",
    model: null,
    routing: null,
    codexSessionId: null,
    rounds: [],
    result: null,
    error: null,
    duration: null
  };
}

/**
 * Add a round to a session (for discuss.md multi-round or single dispatch).
 * @param {object} session - The session object
 * @param {object} roundData - { prompt, response, usage, timestamp }
 */
function addRound(session, roundData) {
  var response = roundData.response || "";
  if (response.length > 2000) {
    response = response.substring(0, 2000);
  }
  session.rounds.push({
    prompt: roundData.prompt || "",
    response: response,
    usage: roundData.usage || null,
    timestamp: roundData.timestamp || new Date().toISOString()
  });
}

/**
 * Finalize and save a session to disk. Atomic write via temp+rename.
 * @param {string} sessionDir - Path to sessions directory (e.g. ~/.claude/codex-agent/sessions)
 * @param {object} session - The session object to save
 */
function saveSession(sessionDir, session) {
  // Ensure sessions directory exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Finalize session
  session.completedAt = new Date().toISOString();
  if (session.startedAt) {
    var start = new Date(session.startedAt).getTime();
    var end = new Date(session.completedAt).getTime();
    session.duration = end - start;
  }

  // Determine status from result or error
  if (!session.result) {
    session.result = { status: "unknown", filesChanged: [], usage: null };
  }

  var filePath = path.join(sessionDir, session.id + ".json");
  var tmpPath = filePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return filePath;
}

/**
 * List recent sessions from the sessions directory.
 * Returns last N session summaries sorted by time (newest first).
 * @param {string} sessionDir - Path to sessions directory
 * @param {number} [limit] - Max number of sessions to return (default 10)
 * @returns {Array} Array of { id, type, task, startedAt, status, duration }
 */
function listSessions(sessionDir, limit) {
  var max = typeof limit === "number" && limit > 0 ? limit : 10;

  if (!fs.existsSync(sessionDir)) {
    return [];
  }

  var files;
  try {
    files = fs.readdirSync(sessionDir).filter(function (f) {
      return f.endsWith(".json") && !f.includes(".tmp-");
    });
  } catch (e) {
    return [];
  }

  // Sort by filename descending (epoch prefix = newest first)
  files.sort(function (a, b) {
    return b.localeCompare(a);
  });

  // Take only last N
  files = files.slice(0, max);

  var summaries = [];
  for (var i = 0; i < files.length; i++) {
    try {
      var raw = fs.readFileSync(path.join(sessionDir, files[i]), "utf-8");
      var session = JSON.parse(raw);
      summaries.push({
        id: session.id || files[i].replace(".json", ""),
        type: session.type || "unknown",
        task: session.task || "",
        startedAt: session.startedAt || null,
        status: (session.result && session.result.status) || (session.error ? "error" : "unknown"),
        duration: session.duration || null
      });
    } catch (e) {
      // Skip corrupted files
    }
  }

  return summaries;
}

module.exports = {
  createSession: createSession,
  addRound: addRound,
  saveSession: saveSession,
  listSessions: listSessions
};
