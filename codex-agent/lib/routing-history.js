/**
 * routing-history.js — Record dispatch outcomes and compute routing adjustments.
 *
 * Tracks historical success/failure per agent at each complexity range,
 * then nudges the router's complexity score based on accumulated evidence.
 * No npm dependencies. ES5 strict.
 *
 * Usage from node -e:
 *   var rh = require("<path>/routing-history.js");
 *   rh.recordOutcome(historyPath, { timestamp: "...", ... });
 *   var adj = rh.computeAdjustment(rh.loadHistory(historyPath), 0.3);
 */

"use strict";

var fs = require("fs");
var path = require("path");

/**
 * Complexity score bin boundaries.
 * Each bin covers a 0.5-wide range from -1 to +1.
 */
var BINS = [
  { min: -1.0, max: -0.5, label: "very-simple" },
  { min: -0.5, max:  0.0, label: "simple" },
  { min:  0.0, max:  0.5, label: "moderate" },
  { min:  0.5, max:  1.0, label: "complex" }
];

/**
 * Find which bin a complexity score falls into.
 * @param {number} score
 * @returns {object} The matching bin
 */
function findBin(score) {
  for (var i = 0; i < BINS.length; i++) {
    if (score >= BINS[i].min && score < BINS[i].max) {
      return BINS[i];
    }
  }
  // Edge case: score === 1.0 falls into the last bin
  return BINS[BINS.length - 1];
}

/**
 * Load the routing history from disk.
 * @param {string} historyPath - Absolute path to routing-history.json
 * @returns {Array} Array of outcome entries
 */
function loadHistory(historyPath) {
  try {
    var raw = fs.readFileSync(historyPath, "utf-8");
    var data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Record a dispatch outcome to the history file.
 * @param {string} historyPath - Absolute path to routing-history.json
 * @param {object} entry - Outcome entry with: timestamp, taskDescription, complexityScore,
 *   agent, routedTo, outcome, tokensUsed, durationMs, filesChanged
 */
function recordOutcome(historyPath, entry) {
  var history = loadHistory(historyPath);

  // Truncate task description
  var desc = entry.taskDescription || "";
  if (desc.length > 200) desc = desc.substring(0, 200);

  history.push({
    timestamp: entry.timestamp || new Date().toISOString(),
    taskDescription: desc,
    complexityScore: typeof entry.complexityScore === "number" ? entry.complexityScore : 0,
    agent: entry.agent || "codex",
    routedTo: entry.routedTo || entry.agent || "codex",
    outcome: entry.outcome || "success",
    tokensUsed: typeof entry.tokensUsed === "number" ? entry.tokensUsed : 0,
    durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
    filesChanged: typeof entry.filesChanged === "number" ? entry.filesChanged : 0
  });

  // Atomic write
  var dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var tmpPath = historyPath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf-8");
  fs.renameSync(tmpPath, historyPath);
}

/**
 * Compute a routing score adjustment based on historical outcomes.
 *
 * Bins the given complexityScore, then compares success rates of codex vs
 * claudeSubagent in that bin. If one agent has a significantly higher
 * success rate (>70% with >=5 samples), nudges the score toward that agent.
 *
 * @param {Array} history - Array of outcome entries
 * @param {number} complexityScore - The current complexity score to adjust
 * @returns {{ adjustment: number, confidence: string, sampleSize: number }}
 */
function computeAdjustment(history, complexityScore) {
  var bin = findBin(complexityScore);
  var codexSuccesses = 0;
  var codexTotal = 0;
  var claudeSuccesses = 0;
  var claudeTotal = 0;

  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    var score = entry.complexityScore;
    if (typeof score !== "number") continue;
    if (score < bin.min || score >= bin.max) {
      // Edge case for score === 1.0
      if (!(score === 1.0 && bin.max === 1.0)) continue;
    }

    if (entry.routedTo === "codex") {
      codexTotal++;
      if (entry.outcome === "success") codexSuccesses++;
    } else if (entry.routedTo === "claudeSubagent") {
      claudeTotal++;
      if (entry.outcome === "success") claudeSuccesses++;
    }
  }

  var totalSamples = codexTotal + claudeTotal;

  // Need minimum samples for any adjustment
  if (totalSamples < 5) {
    return { adjustment: 0, confidence: "low", sampleSize: totalSamples };
  }

  var codexRate = codexTotal > 0 ? codexSuccesses / codexTotal : 0;
  var claudeRate = claudeTotal > 0 ? claudeSuccesses / claudeTotal : 0;

  // Only adjust if one agent has >= 5 samples and > 70% success rate
  // Positive adjustment = favor Codex (higher complexity score)
  // Negative adjustment = favor Claude subagent (lower complexity score)
  var adjustment = 0;
  var confidence = "low";

  if (codexTotal >= 5 && codexRate > 0.7 && (claudeTotal < 5 || codexRate > claudeRate + 0.15)) {
    // Codex is performing better in this bin
    adjustment = totalSamples >= 20 ? 0.2 : 0.1;
    confidence = totalSamples >= 20 ? "high" : "medium";
  } else if (claudeTotal >= 5 && claudeRate > 0.7 && (codexTotal < 5 || claudeRate > codexRate + 0.15)) {
    // Claude subagent is performing better in this bin
    adjustment = totalSamples >= 20 ? -0.2 : -0.1;
    confidence = totalSamples >= 20 ? "high" : "medium";
  }

  return { adjustment: adjustment, confidence: confidence, sampleSize: totalSamples };
}

/**
 * Prune the history to keep only the most recent N entries.
 * @param {string} historyPath - Absolute path to routing-history.json
 * @param {number} maxEntries - Maximum entries to keep
 */
function pruneHistory(historyPath, maxEntries) {
  var max = typeof maxEntries === "number" && maxEntries > 0 ? maxEntries : 500;
  var history = loadHistory(historyPath);

  if (history.length <= max) return;

  // Keep the most recent entries (last N)
  history = history.slice(history.length - max);

  // Atomic write
  var dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var tmpPath = historyPath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf-8");
  fs.renameSync(tmpPath, historyPath);
}

module.exports = {
  recordOutcome: recordOutcome,
  loadHistory: loadHistory,
  computeAdjustment: computeAdjustment,
  pruneHistory: pruneHistory
};
