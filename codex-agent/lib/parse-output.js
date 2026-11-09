/**
 * parse-output.js — Parse Codex JSONL stdout into a structured result.
 *
 * Adapted from src/cli/run-codex.ts (parseCodexJsonOutput / extractUsageFromCodexEvent).
 * No npm dependencies. Pure functions only.
 *
 * Usage from node -e:
 *   const { parseCodexOutput } = require("<path>/parse-output.js");
 *   const result = parseCodexOutput(stdout, lastMessageContent);
 */

"use strict";

/**
 * Parse Codex JSONL stdout + optional last-message file content into a structured result.
 *
 * Usage comes from the LAST `turn.completed` event (or legacy `task_complete`). On 0.167.0
 * that event is the only one carrying usage, and its numbers are the THREAD's running
 * total, not the turn's own share (verified: two identical resumed rounds reported 51,968
 * then 88,026 input tokens; each round's own share was ~35K; the rollout file's
 * total_token_usage agrees). Summing several such events would count earlier turns again,
 * so the final one wins. Events of other types that carry usage (older Codex versions) are
 * summed only when no final event exists.
 *
 * When resuming, pass the previous round's `threadTotals` as `previousTotals` so `usage`
 * covers this round only; feed this call's `threadTotals` into the next resumed round.
 * `threadTotals.threadId` records which thread the totals belong to: totals from another
 * thread are never subtracted.
 *
 * @param {string} stdout - Raw JSONL output from `codex exec --json`
 * @param {string|null} lastMessageContent - Content of --output-last-message file, or null
 * @param {object|null} [previousTotals] - `threadTotals` from the previous round of the same thread (resume only)
 * @returns {{ result: string, usage: object, threadTotals: object, usageMode: string, usageSource: string, filesChanged: string[], status: string, sessionId: string|null }}
 *   usageMode: "run" (no previousTotals), "delta" (usage = threadTotals - previousTotals),
 *   "raw-fallback" (totals went down, so they were not cumulative; usage left as reported),
 *   "new-thread" (previousTotals belong to another thread; usage left as reported),
 *   or "delta-unverified" (subtracted, but this output carried no thread id to confirm the
 *   thread; `exec resume <id>` targets that thread, so the same thread is the likely case).
 *   usageSource: "final-event", "summed-events" (no final event; legacy) or "none".
 */
function parseCodexOutput(stdout, lastMessageContent, previousTotals) {
  var lines = (stdout || "").split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  var summedUsage = copyUsage({});
  var finalUsage = null;
  var filesChanged = [];
  var status = "unknown";
  var sessionId = null;
  var lastAgentMessage = "";
  var nonJsonLines = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      nonJsonLines.push(line);
      continue;
    }

    // Unwrap item.completed wrapper — Codex emits {"type":"item.completed","item":{...}}
    // where the inner item carries the real type (agent_message, error, etc.)
    var inner = (data.type === "item.completed" && data.item) ? data.item : null;

    // Extract usage: the last final event wins (its numbers are running totals);
    // other usage-carrying events are summed as a legacy fallback.
    var extracted = extractUsage(data);
    if (extracted) {
      if (data.type === "turn.completed" || data.type === "task_complete") {
        finalUsage = extracted;
      } else {
        addUsage(summedUsage, extracted);
      }
    }

    // Extract files changed from tool-use events
    var changedFile = extractFileChanged(data);
    if (changedFile && filesChanged.indexOf(changedFile) === -1) {
      filesChanged.push(changedFile);
    }

    // Track last agent_message content — direct or wrapped in item.completed
    if (data.type === "agent_message" && data.content) {
      lastAgentMessage = String(data.content);
    } else if (inner && inner.type === "agent_message" && (inner.text || inner.content)) {
      lastAgentMessage = String(inner.text || inner.content);
    }

    // Extract session/conversation ID from JSONL events
    if (!sessionId) {
      // Current Codex emits {"type":"thread.started","thread_id":"..."} (verified on 0.167.0;
      // ids stopped being captured after 2026-10-31). `codex exec resume <id>` takes this id.
      if (data.thread_id) sessionId = String(data.thread_id);
      // Older Codex versions: direct fields on the event
      else if (data.session_id) sessionId = String(data.session_id);
      else if (data.conversation_id) sessionId = String(data.conversation_id);
      // Inside data.data wrapper
      else if (data.data && data.data.session_id) sessionId = String(data.data.session_id);
      else if (data.data && data.data.conversation_id) sessionId = String(data.data.conversation_id);
      // session.created or conversation.created event types
      else if ((data.type === "session.created" || data.type === "conversation.created") && data.data && data.data.id) {
        sessionId = String(data.data.id);
      } else if (data.type === "session.created" && data.id) {
        sessionId = String(data.id);
      }
      // Inside item.completed wrapper
      else if (inner && inner.session_id) sessionId = String(inner.session_id);
    }

    // Determine status
    if (data.type === "task_complete" || data.type === "turn.completed") {
      status = data.status || "completed";
    } else if (data.type === "error") {
      status = "error";
    } else if (inner && inner.type === "error") {
      status = "error";
    }
  }

  // Result text priority: lastMessageContent > last agent_message > non-JSON lines > placeholder
  var result;
  if (lastMessageContent && lastMessageContent.trim()) {
    result = lastMessageContent.trim();
  } else if (lastAgentMessage) {
    result = lastAgentMessage;
  } else if (nonJsonLines.length > 0) {
    result = nonJsonLines.join("\n");
  } else {
    result = "(No response captured from Codex)";
  }

  var hasSummed = summedUsage.inputTokens > 0 || summedUsage.outputTokens > 0;
  var usageSource = finalUsage ? "final-event" : hasSummed ? "summed-events" : "none";
  var usage = copyUsage(finalUsage || summedUsage);
  var threadTotals = copyUsage(usage);
  threadTotals.threadId = sessionId;

  var usageMode = "run";
  var otherThread = previousTotals && previousTotals.threadId && sessionId && previousTotals.threadId !== sessionId;
  if (otherThread) {
    usageMode = "new-thread";
  } else if (previousTotals) {
    var delta = subtractUsage(usage, previousTotals);
    if (!delta) {
      usageMode = "raw-fallback";
    } else {
      usage = delta;
      usageMode = previousTotals.threadId && !sessionId ? "delta-unverified" : "delta";
      // A field the final event omitted is unknown, not zero: keep the last known running
      // total so the next round's delta for that field is not inflated.
      var missing = (finalUsage && finalUsage.missingFields) || [];
      for (var m = 0; m < missing.length; m++) {
        threadTotals[missing[m]] = Number(previousTotals[missing[m]]) || 0;
      }
    }
  }

  return {
    result: result,
    usage: usage,
    threadTotals: threadTotals,
    usageMode: usageMode,
    usageSource: usageSource,
    filesChanged: filesChanged,
    status: status,
    sessionId: sessionId
  };
}

/**
 * Extract token usage from a single Codex JSONL event.
 * Handles multiple nesting patterns and field name variants.
 */
function extractUsage(data) {
  // Try multiple nesting patterns: data.usage, data.response.usage, data.output.usage,
  // plus data.data.* wrappers
  var candidate =
    (data.usage) ||
    (data.response && data.response.usage) ||
    (data.output && data.output.usage) ||
    (data.data && data.data.usage) ||
    (data.data && data.data.response && data.data.response.usage) ||
    (data.data && data.data.output && data.data.output.usage);

  if (!candidate || typeof candidate !== "object") return null;

  // Handle field variants: prompt_tokens/input_tokens, completion_tokens/output_tokens
  var inputTokens = candidate.prompt_tokens != null ? candidate.prompt_tokens
    : candidate.input_tokens != null ? candidate.input_tokens : null;
  var outputTokens = candidate.completion_tokens != null ? candidate.completion_tokens
    : candidate.output_tokens != null ? candidate.output_tokens : null;

  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;

  var totalTokens = candidate.total_tokens != null ? candidate.total_tokens : inputTokens + outputTokens;
  var hasCached = typeof candidate.cached_input_tokens === "number";
  var cachedInputTokens = hasCached ? candidate.cached_input_tokens : 0;

  // Extract cost: total_cost, cost_usd at usage level, or cost_usd at top level
  var cost = candidate.total_cost != null ? candidate.total_cost
    : candidate.cost_usd != null ? candidate.cost_usd
    : data.cost_usd;
  var hasCost = typeof cost === "number";

  // Optional fields this event did not report (unknown, not zero; see parseCodexOutput).
  var missingFields = [];
  if (!hasCached) missingFields.push("cachedInputTokens");
  if (!hasCost) missingFields.push("estimatedCost");

  return {
    inputTokens: inputTokens,
    cachedInputTokens: cachedInputTokens,
    outputTokens: outputTokens,
    totalTokens: totalTokens,
    estimatedCost: hasCost ? cost : 0,
    missingFields: missingFields
  };
}

var USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "estimatedCost"];

function copyUsage(u) {
  var out = {};
  for (var i = 0; i < USAGE_FIELDS.length; i++) out[USAGE_FIELDS[i]] = Number(u[USAGE_FIELDS[i]]) || 0;
  return out;
}

function addUsage(target, u) {
  for (var i = 0; i < USAGE_FIELDS.length; i++) target[USAGE_FIELDS[i]] += Number(u[USAGE_FIELDS[i]]) || 0;
}

/**
 * current - previous, field by field. Returns null if input or output tokens would go
 * negative, which means the reported numbers were not cumulative after all.
 */
function subtractUsage(current, previous) {
  var prev = copyUsage(previous || {});
  var out = {};
  for (var i = 0; i < USAGE_FIELDS.length; i++) {
    var f = USAGE_FIELDS[i];
    out[f] = current[f] - prev[f];
  }
  if (out.inputTokens < 0 || out.outputTokens < 0) return null;
  // A later round that omits cost (or cached tokens) while an earlier round reported
  // it would subtract to a negative value and lower the recorded spend. Treat the
  // missing value as unknown (0), never as a refund.
  if (out.estimatedCost < 0) out.estimatedCost = 0;
  if (out.cachedInputTokens < 0) out.cachedInputTokens = 0;
  return out;
}

/**
 * Extract a changed file path from a tool-use event.
 */
function extractFileChanged(data) {
  // Tool use events may have arguments with file_path or path
  var args = null;
  if (data.type === "tool_use" && data.arguments) {
    args = data.arguments;
  } else if (data.type === "function_call" && data.arguments) {
    args = data.arguments;
  } else if (data.tool_use && data.tool_use.arguments) {
    args = data.tool_use.arguments;
  }
  if (!args) return null;

  // Arguments might be a string (JSON) or object
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch (e) { return null; }
  }

  return args.file_path || args.path || null;
}

/**
 * Parse review output into a structured review object.
 *
 * Tries to parse the result as JSON directly, then falls back to extracting
 * JSON from markdown code blocks (```json ... ```). Validates shape: must have
 * `summary` (string) and `findings` (array).
 *
 * @param {string} resultText - Raw review result text from Codex
 * @returns {object|null} Parsed review object or null if not valid review JSON
 */
function parseReviewOutput(resultText) {
  if (!resultText || typeof resultText !== "string") return null;

  var text = resultText.trim();

  // Attempt 1: Direct JSON parse
  var parsed = tryParseJson(text);
  if (parsed && isValidReview(parsed)) return fillReviewDefaults(parsed);

  // Attempt 2: Extract JSON from markdown code blocks (case-insensitive language tag)
  var jsonBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  var match;
  while ((match = jsonBlockPattern.exec(text)) !== null) {
    parsed = tryParseJson(match[1].trim());
    if (parsed && isValidReview(parsed)) return fillReviewDefaults(parsed);
  }

  // Attempt 3: Find JSON object anywhere in text (first { to last })
  var firstBrace = text.indexOf("{");
  var lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    parsed = tryParseJson(text.substring(firstBrace, lastBrace + 1));
    if (parsed && isValidReview(parsed)) return fillReviewDefaults(parsed);
  }

  return null;
}

/**
 * Try to parse a string as JSON, returning null on failure.
 */
function tryParseJson(str) {
  try { return JSON.parse(str); }
  catch (e) { return null; }
}

/**
 * Validate that a parsed object looks like a review result.
 */
function isValidReview(obj) {
  return obj &&
    typeof obj === "object" &&
    typeof obj.summary === "string" &&
    Array.isArray(obj.findings);
}

/**
 * Fill in default values for optional review fields so consumers
 * don't need to handle undefined.
 */
function fillReviewDefaults(obj) {
  if (!obj.overall_severity) {
    // Derive from findings if possible
    var severityRank = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
    var maxSev = "none";
    for (var i = 0; i < obj.findings.length; i++) {
      var s = obj.findings[i].severity;
      if (s && (severityRank[s] || 0) > (severityRank[maxSev] || 0)) {
        maxSev = s;
      }
    }
    obj.overall_severity = maxSev;
  }
  if (!obj.stats || typeof obj.stats !== "object") {
    obj.stats = {};
  }
  if (typeof obj.stats.files_reviewed !== "number") {
    // Count unique file_path values from findings
    var files = {};
    for (var j = 0; j < obj.findings.length; j++) {
      if (obj.findings[j].file_path) files[obj.findings[j].file_path] = true;
    }
    obj.stats.files_reviewed = Object.keys(files).length;
  }
  if (typeof obj.stats.findings_count !== "number") {
    obj.stats.findings_count = obj.findings.length;
  }
  if (!Array.isArray(obj.limitations)) {
    obj.limitations = [];
  }
  return obj;
}

module.exports = {
  parseCodexOutput: parseCodexOutput,
  parseReviewOutput: parseReviewOutput
};
