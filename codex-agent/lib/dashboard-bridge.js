/**
 * dashboard-bridge.js — Write Codex dispatches as AI-AI protocol messages.
 *
 * After each dispatch, optionally writes request + response messages into the
 * conversations/ directory so the AI-AI dashboard discovers and displays them.
 * No npm dependencies. ES5 strict.
 *
 * Usage from node -e:
 *   var db = require("<path>/dashboard-bridge.js");
 *   var convId = db.getConversationId();
 *   db.ensureConversation(baseDir, convId);
 *   db.writeDispatchMessages(baseDir, convId, { task, result, usage });
 */

"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

/**
 * Generate a v4-style UUID.
 * @returns {string}
 */
function uuid() {
  var bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
    hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

/**
 * Get today's conversation ID for Codex dispatches.
 * @returns {string} e.g. "codex-dispatches-2026-02-11"
 */
function getConversationId() {
  var now = new Date();
  var y = now.getFullYear();
  var m = String(now.getMonth() + 1);
  if (m.length < 2) m = "0" + m;
  var d = String(now.getDate());
  if (d.length < 2) d = "0" + d;
  return "codex-dispatches-" + y + "-" + m + "-" + d;
}

/**
 * Format a date for display in the conversation title.
 * @param {Date} date
 * @returns {string} e.g. "Feb 11, 2026"
 */
function formatDate(date) {
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear();
}

/**
 * Ensure a conversation directory and meta.json exist.
 * @param {string} baseDir - Path to the conversations/ directory
 * @param {string} conversationId - The conversation ID
 */
function ensureConversation(baseDir, conversationId) {
  var convDir = path.join(baseDir, conversationId);
  var messagesDir = path.join(convDir, "messages");
  var metaPath = path.join(convDir, "meta.json");

  // Create directories
  if (!fs.existsSync(messagesDir)) {
    fs.mkdirSync(messagesDir, { recursive: true });
  }

  // Create meta.json if it doesn't exist
  if (!fs.existsSync(metaPath)) {
    var meta = {
      id: conversationId,
      title: "Codex Dispatches \u2014 " + formatDate(new Date()),
      participants: ["claude-code", "codex"],
      createdAt: new Date().toISOString(),
      mode: "task-delegation"
    };
    var tmpPath = metaPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    fs.renameSync(tmpPath, metaPath);
  }
}

/**
 * Write a dispatch as a request + response message pair in AI-AI protocol format.
 * @param {string} baseDir - Path to the conversations/ directory
 * @param {string} conversationId - The conversation ID
 * @param {object} dispatch - { task: string, result: string, usage: { inputTokens, outputTokens, estimatedCost } }
 */
function writeDispatchMessages(baseDir, conversationId, dispatch) {
  var messagesDir = path.join(baseDir, conversationId, "messages");
  var now = Date.now();
  var timestamp = new Date(now).toISOString();

  // Generate message IDs
  var requestId = uuid();
  var responseId = uuid();

  // Build request message (from claude-code to codex)
  var requestMsg = {
    id: requestId,
    conversationId: conversationId,
    from: "claude-code",
    to: "codex",
    role: "request",
    content: dispatch.task || "",
    timestamp: timestamp,
    metadata: {}
  };

  // Build response message (from codex to claude-code)
  var usage = dispatch.usage || {};
  var responseMsg = {
    id: responseId,
    conversationId: conversationId,
    from: "codex",
    to: "claude-code",
    role: "response",
    content: dispatch.result || "",
    timestamp: new Date(now + 1).toISOString(),
    replyTo: requestId,
    metadata: {
      usage: {
        promptTokens: usage.inputTokens || 0,
        completionTokens: usage.outputTokens || 0,
        totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
        estimatedCost: usage.estimatedCost || 0
      }
    }
  };

  // Write request message file: <epochMs>-<uuid>.json
  var reqFileName = now + "-" + requestId + ".json";
  var reqPath = path.join(messagesDir, reqFileName);
  var reqTmp = reqPath + ".tmp-" + process.pid;
  fs.writeFileSync(reqTmp, JSON.stringify(requestMsg, null, 2), "utf-8");
  fs.renameSync(reqTmp, reqPath);

  // Write response message file
  var resFileName = (now + 1) + "-" + responseId + ".json";
  var resPath = path.join(messagesDir, resFileName);
  var resTmp = resPath + ".tmp-" + process.pid;
  fs.writeFileSync(resTmp, JSON.stringify(responseMsg, null, 2), "utf-8");
  fs.renameSync(resTmp, resPath);

  return { requestId: requestId, responseId: responseId };
}

module.exports = {
  getConversationId: getConversationId,
  ensureConversation: ensureConversation,
  writeDispatchMessages: writeDispatchMessages
};
