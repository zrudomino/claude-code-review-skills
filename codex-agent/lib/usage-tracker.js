/**
 * usage-tracker.js — Load/check/record usage ledger with budget enforcement.
 *
 * Adapted from src/exchange/usage-tracker.ts (atomic writes, budget checks).
 * No npm dependencies.
 *
 * Usage from node -e:
 *   const { loadLedger, checkBudget, recordUsage, resetSession } = require("<path>/usage-tracker.js");
 */

"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");

// cachedInputTokens is the part of inputTokens served from Codex's prompt cache
// (recorded since 2026-11-09; ledger.cachedTrackedSince marks when a ledger began).
var COUNTER_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "estimatedCost", "dispatches"];

function zeroAgent() {
  var entry = {};
  for (var i = 0; i < COUNTER_FIELDS.length; i++) entry[COUNTER_FIELDS[i]] = 0;
  return entry;
}

function freshSession() {
  return { startedAt: new Date().toISOString(), codex: zeroAgent(), claudeSubagent: zeroAgent() };
}

/**
 * Fresh ledger with zeroed counters.
 */
function freshLedger() {
  return {
    session: freshSession(),
    lifetime: { codex: zeroAgent(), claudeSubagent: zeroAgent() },
    cachedTrackedSince: new Date().toISOString()
  };
}

/**
 * Ensure an agent entry has all required fields (migration safety).
 */
function ensureAgentFields(entry) {
  if (!entry) return zeroAgent();
  for (var i = 0; i < COUNTER_FIELDS.length; i++) {
    if (typeof entry[COUNTER_FIELDS[i]] !== "number") entry[COUNTER_FIELDS[i]] = 0;
  }
  return entry;
}

/**
 * Load the usage ledger from disk. Returns fresh ledger if file missing or corrupted.
 * @param {string} ledgerPath - Absolute path to usage-ledger.json
 * @returns {object} The ledger object
 */
function loadLedger(ledgerPath) {
  try {
    var raw = fs.readFileSync(ledgerPath, "utf-8");
    var ledger = JSON.parse(raw);
    // Validate structure
    if (!ledger.session || !ledger.lifetime) return freshLedger();
    // Ensure agent fields exist
    ledger.session.codex = ensureAgentFields(ledger.session.codex);
    ledger.session.claudeSubagent = ensureAgentFields(ledger.session.claudeSubagent);
    ledger.lifetime.codex = ensureAgentFields(ledger.lifetime.codex);
    ledger.lifetime.claudeSubagent = ensureAgentFields(ledger.lifetime.claudeSubagent);
    if (!ledger.session.startedAt) ledger.session.startedAt = new Date().toISOString();
    if (!ledger.cachedTrackedSince) ledger.cachedTrackedSince = new Date().toISOString();
    return ledger;
  } catch (e) {
    return freshLedger();
  }
}

/**
 * Check whether a dispatch is allowed given current usage vs config budgets.
 * @param {object} ledger - The loaded ledger
 * @param {object} config - The loaded config.json
 * @param {string} agent - "codex" or "claudeSubagent"
 * @returns {{ allowed: boolean, reason: string|null, sessionPercent: number, lifetimePercent: number }}
 */
function checkBudget(ledger, config, agent) {
  var budgetConfig = config.budgets && config.budgets[agent];
  if (!budgetConfig) return { allowed: true, reason: null, sessionPercent: 0, lifetimePercent: 0 };

  var sessionAgent = ledger.session[agent] || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  var lifetimeAgent = ledger.lifetime[agent] || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

  var sessionTokens = sessionAgent.inputTokens + sessionAgent.outputTokens;
  var lifetimeTokens = lifetimeAgent.inputTokens + lifetimeAgent.outputTokens;

  // Calculate percentages
  var sessionTokenPercent = budgetConfig.maxTokensPerSession > 0
    ? (sessionTokens / budgetConfig.maxTokensPerSession) * 100 : 0;
  var sessionCostPercent = budgetConfig.maxCostPerSession > 0
    ? (sessionAgent.estimatedCost / budgetConfig.maxCostPerSession) * 100 : 0;
  var lifetimeTokenPercent = budgetConfig.maxTokensTotal > 0
    ? (lifetimeTokens / budgetConfig.maxTokensTotal) * 100 : 0;
  var lifetimeCostPercent = budgetConfig.maxCostTotal > 0
    ? (lifetimeAgent.estimatedCost / budgetConfig.maxCostTotal) * 100 : 0;

  var sessionPercent = Math.max(sessionTokenPercent, sessionCostPercent);
  var lifetimePercent = Math.max(lifetimeTokenPercent, lifetimeCostPercent);

  // Check hard limits
  if (budgetConfig.maxTokensPerSession > 0 && sessionTokens >= budgetConfig.maxTokensPerSession) {
    return { allowed: false, reason: "Session token limit reached (" + sessionTokens + "/" + budgetConfig.maxTokensPerSession + ")", sessionPercent: sessionPercent, lifetimePercent: lifetimePercent };
  }
  if (budgetConfig.maxCostPerSession > 0 && sessionAgent.estimatedCost >= budgetConfig.maxCostPerSession) {
    return { allowed: false, reason: "Session cost limit reached ($" + sessionAgent.estimatedCost.toFixed(2) + "/$" + budgetConfig.maxCostPerSession.toFixed(2) + ")", sessionPercent: sessionPercent, lifetimePercent: lifetimePercent };
  }
  if (budgetConfig.maxTokensTotal > 0 && lifetimeTokens >= budgetConfig.maxTokensTotal) {
    return { allowed: false, reason: "Lifetime token limit reached (" + lifetimeTokens + "/" + budgetConfig.maxTokensTotal + ")", sessionPercent: sessionPercent, lifetimePercent: lifetimePercent };
  }
  if (budgetConfig.maxCostTotal > 0 && lifetimeAgent.estimatedCost >= budgetConfig.maxCostTotal) {
    return { allowed: false, reason: "Lifetime cost limit reached ($" + lifetimeAgent.estimatedCost.toFixed(2) + "/$" + budgetConfig.maxCostTotal.toFixed(2) + ")", sessionPercent: sessionPercent, lifetimePercent: lifetimePercent };
  }

  return { allowed: true, reason: null, sessionPercent: sessionPercent, lifetimePercent: lifetimePercent };
}

/**
 * Record usage from a dispatch. Increments both session and lifetime counters.
 * Writes atomically via temp file + rename.
 * @param {string} ledgerPath - Absolute path to usage-ledger.json
 * @param {string} agent - "codex" or "claudeSubagent"
 * @param {{ inputTokens: number, cachedInputTokens?: number, outputTokens: number, estimatedCost: number }} usage
 *   One call's own usage (for a resumed round: the parse result's `usage`, never `threadTotals`).
 * @returns {object} The updated ledger
 */
function recordUsage(ledgerPath, agent, usage) {
  var ledger = loadLedger(ledgerPath);
  var add = {
    inputTokens: usage.inputTokens || 0,
    cachedInputTokens: usage.cachedInputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    estimatedCost: usage.estimatedCost || 0,
    dispatches: 1
  };
  var scopes = [ledger.session[agent], ledger.lifetime[agent]];
  for (var s = 0; s < scopes.length; s++) {
    for (var i = 0; i < COUNTER_FIELDS.length; i++) scopes[s][COUNTER_FIELDS[i]] += add[COUNTER_FIELDS[i]];
  }
  writeLedger(ledgerPath, ledger);
  return ledger;
}

/** Atomic write: temp file + rename. */
function writeLedger(ledgerPath, ledger) {
  var dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var tmpPath = ledgerPath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), "utf-8");
  fs.renameSync(tmpPath, ledgerPath);
}

/**
 * Reset session counters while preserving lifetime totals.
 * @param {string} ledgerPath - Absolute path to usage-ledger.json
 * @returns {object} The updated ledger
 */
function resetSession(ledgerPath) {
  var ledger = loadLedger(ledgerPath);
  ledger.session = freshSession();
  writeLedger(ledgerPath, ledger);
  return ledger;
}

module.exports = {
  loadLedger: loadLedger,
  checkBudget: checkBudget,
  recordUsage: recordUsage,
  resetSession: resetSession
};
