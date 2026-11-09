/**
 * router.js — Smart routing heuristics for Codex vs Claude subagent selection.
 *
 * Evaluates task complexity and budget state to recommend the best agent.
 * No npm dependencies.
 *
 * Usage from node -e:
 *   var r = require("<path>/router.js");
 *   var result = r.routeTask(taskDescription, ledger, config);
 *   var score = r.estimateComplexity(description, threshold);
 */

"use strict";

var usageTracker = require("./usage-tracker.js");

/**
 * Adversarial review keywords — force routing to Codex CLI.
 *
 * Adversarial reviews MUST run on a different model (Codex/OpenAI) than the
 * code author (Claude). Routing these to claudeSubagent would mean Claude
 * reviewing its own work, which defeats the entire purpose of adversarial
 * review. When any of these patterns match, routeTask() bypasses complexity
 * scoring and budget-warning heuristics to guarantee Codex routing.
 */
var ADVERSARIAL_REVIEW_KEYWORDS = [
  "adversarial", "red-team", "red team",
  "code review", "code audit", "security audit",
  "find issues", "find bugs", "find vulnerabilities",
  "critique", "audit"
];

/**
 * Heavy/complex task keywords — favor Codex.
 */
var HEAVY_KEYWORDS = [
  "refactor", "migrate", "rewrite", "overhaul", "restructure",
  "test suite", "multiple files", "across files", "codebase-wide",
  "optimize", "architecture", "integration", "end-to-end",
  "comprehensive", "large-scale", "entire", "all files"
];

/**
 * Simple/lightweight task keywords — favor Claude subagent.
 */
var SIMPLE_KEYWORDS = [
  "search", "find", "lookup", "check", "grep", "explain",
  "summarize", "research", "quick", "simple", "one file",
  "list", "show", "describe", "what is", "where is",
  "count", "read"
];

/**
 * Estimate task complexity from the description text.
 * Returns a score from -1.0 (very simple) to +1.0 (very complex).
 *
 * @param {string} description - The task description
 * @param {number} [largeContextThreshold] - Char count above which description is "large" (default 5000)
 * @returns {{ score: number, signals: string[] }}
 */
function estimateComplexity(description, largeContextThreshold) {
  if (!description || typeof description !== "string") {
    return { score: 0, signals: ["empty description"] };
  }

  var threshold = typeof largeContextThreshold === "number" ? largeContextThreshold : 5000;
  var text = description.toLowerCase();
  var score = 0;
  var signals = [];

  // Length-based signals
  if (description.length > threshold) {
    score += 0.2;
    signals.push("long description (" + description.length + " chars)");
  } else if (description.length < 200) {
    score -= 0.15;
    signals.push("short description (" + description.length + " chars)");
  }

  // Heavy keyword matching
  var heavyScore = 0;
  for (var i = 0; i < HEAVY_KEYWORDS.length; i++) {
    var pattern = new RegExp("\\b" + HEAVY_KEYWORDS[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(text)) {
      heavyScore += 0.15;
      signals.push("heavy: " + HEAVY_KEYWORDS[i]);
    }
  }
  if (heavyScore > 0.6) heavyScore = 0.6;
  score += heavyScore;

  // Simple keyword matching
  var simpleScore = 0;
  for (var j = 0; j < SIMPLE_KEYWORDS.length; j++) {
    var simplePattern = new RegExp("\\b" + SIMPLE_KEYWORDS[j].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (simplePattern.test(text)) {
      simpleScore += 0.15;
      signals.push("simple: " + SIMPLE_KEYWORDS[j]);
    }
  }
  if (simpleScore > 0.6) simpleScore = 0.6;
  score -= simpleScore;

  // Clamp to [-1, 1]
  if (score > 1) score = 1;
  if (score < -1) score = -1;

  // Round to 2 decimal places
  score = Math.round(score * 100) / 100;

  return { score: score, signals: signals };
}

/**
 * Detect whether a task description is an adversarial review that MUST
 * route to actual Codex CLI (never claudeSubagent).
 *
 * Returns true when the task contains adversarial-review language.
 * The existing detectReviewTask() handles general review detection for
 * dispatch formatting; this function specifically guards the routing
 * decision to prevent Claude from reviewing its own code.
 *
 * @param {string} description - The task description
 * @returns {{ isAdversarial: boolean, signals: string[] }}
 */
function detectAdversarialReview(description) {
  if (!description || typeof description !== "string") {
    return { isAdversarial: false, signals: [] };
  }

  var text = description.toLowerCase();
  var signals = [];

  for (var i = 0; i < ADVERSARIAL_REVIEW_KEYWORDS.length; i++) {
    var kw = ADVERSARIAL_REVIEW_KEYWORDS[i];
    var pattern = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (pattern.test(text)) {
      signals.push("adversarial: " + kw);
    }
  }

  return {
    isAdversarial: signals.length > 0,
    signals: signals
  };
}

/**
 * Get budget state for both agents.
 *
 * @param {object} ledger - The loaded usage ledger
 * @param {object} config - The loaded config.json
 * @returns {{ codex: object, claude: object }}
 */
function getBudgetState(ledger, config) {
  var codexBudget = usageTracker.checkBudget(ledger, config, "codex");
  var claudeBudget = usageTracker.checkBudget(ledger, config, "claudeSubagent");

  return {
    codex: {
      sessionPercent: Math.round(codexBudget.sessionPercent * 100) / 100,
      lifetimePercent: Math.round(codexBudget.lifetimePercent * 100) / 100,
      allowed: codexBudget.allowed
    },
    claude: {
      sessionPercent: Math.round(claudeBudget.sessionPercent * 100) / 100,
      lifetimePercent: Math.round(claudeBudget.lifetimePercent * 100) / 100,
      allowed: claudeBudget.allowed
    }
  };
}

/**
 * Route a task to the best agent based on complexity and budget state.
 *
 * @param {string} taskDescription - The task to route
 * @param {object} ledger - The loaded usage ledger
 * @param {object} config - The loaded config.json
 * @returns {{ agent: string, confidence: string, reason: string, budgetState: object }}
 */
function routeTask(taskDescription, ledger, config) {
  var budgetState = getBudgetState(ledger, config);
  var routingConfig = config.routing || {};
  var defaultsConfig = config.defaults || {};
  var warningPercent = routingConfig.budgetWarningPercent || 80;
  var largeThreshold = routingConfig.largeContextThreshold || 5000;

  var codexExhausted = !budgetState.codex.allowed;
  var claudeExhausted = !budgetState.claude.allowed;
  var codexWarning = Math.max(budgetState.codex.sessionPercent, budgetState.codex.lifetimePercent) >= warningPercent;
  var claudeWarning = Math.max(budgetState.claude.sessionPercent, budgetState.claude.lifetimePercent) >= warningPercent;

  // Priority 1: Both agents exhausted
  if (codexExhausted && claudeExhausted) {
    return {
      agent: "escalate",
      confidence: "high",
      reason: "Both Codex and Claude subagent budgets are exhausted",
      budgetState: budgetState
    };
  }

  // Priority 2: One agent exhausted — route to the other
  if (codexExhausted) {
    return {
      agent: "claudeSubagent",
      confidence: "high",
      reason: "Codex budget exhausted, routing to Claude subagent",
      budgetState: budgetState
    };
  }
  if (claudeExhausted) {
    return {
      agent: "codex",
      confidence: "high",
      reason: "Claude subagent budget exhausted, routing to Codex",
      budgetState: budgetState
    };
  }

  // Priority 2.5: Adversarial review override — MUST use actual Codex CLI.
  // Routing adversarial reviews to claudeSubagent would mean Claude reviewing
  // its own work, defeating the entire purpose of adversarial review.
  var adversarial = detectAdversarialReview(taskDescription);
  if (adversarial.isAdversarial) {
    return {
      agent: "codex",
      confidence: "high",
      reason: "Adversarial review detected — must use Codex CLI, not Claude subagent (" + adversarial.signals.join(", ") + ")",
      budgetState: budgetState
    };
  }

  // Priority 3: Preferred agent override (not "auto")
  var preferred = defaultsConfig.preferredAgent || "auto";
  if (preferred !== "auto") {
    var agentName = preferred === "claudeSubagent" ? "claudeSubagent" : "codex";
    return {
      agent: agentName,
      confidence: "high",
      reason: "Preferred agent override: " + preferred,
      budgetState: budgetState
    };
  }

  // Priority 4: Both agents above warning threshold
  if (codexWarning && claudeWarning) {
    return {
      agent: "escalate",
      confidence: "high",
      reason: "Both agents above " + warningPercent + "% budget warning threshold",
      budgetState: budgetState
    };
  }

  // Priority 5: One agent above warning — prefer the other
  if (codexWarning) {
    return {
      agent: "claudeSubagent",
      confidence: "medium",
      reason: "Codex budget above " + warningPercent + "% warning, preferring Claude subagent",
      budgetState: budgetState
    };
  }
  if (claudeWarning) {
    return {
      agent: "codex",
      confidence: "medium",
      reason: "Claude subagent budget above " + warningPercent + "% warning, preferring Codex",
      budgetState: budgetState
    };
  }

  // Priority 6: Complexity-based routing (with optional history adjustment)
  var complexity = estimateComplexity(taskDescription, largeThreshold);

  // Priority 5.5: History-based adjustment
  var routingHistoryEnabled = routingConfig.historyEnabled !== false;
  if (routingHistoryEnabled) {
    try {
      var rh = require("./routing-history.js");
      var historyPath = require("path").join(
        require("path").dirname(require.resolve("./usage-tracker.js")),
        "..", "routing-history.json"
      );
      var history = rh.loadHistory(historyPath);
      if (history.length > 0) {
        var adj = rh.computeAdjustment(history, complexity.score);
        if (adj.confidence !== "low") {
          complexity.score += adj.adjustment;
          complexity.signals.push("history: " + adj.adjustment.toFixed(2) + " (" + adj.sampleSize + " samples)");
          // Re-clamp
          if (complexity.score > 1) complexity.score = 1;
          if (complexity.score < -1) complexity.score = -1;
          // Re-round
          complexity.score = Math.round(complexity.score * 100) / 100;
        }
      }
    } catch (e) {
      // routing-history.js not available or error — skip adjustment
    }
  }

  var signalSummary = complexity.signals.length > 0 ? " (" + complexity.signals.join(", ") + ")" : "";

  if (complexity.score >= 0.3) {
    return {
      agent: "codex",
      confidence: "high",
      reason: "High complexity score " + complexity.score + signalSummary,
      budgetState: budgetState
    };
  }
  if (complexity.score >= 0.1) {
    return {
      agent: "codex",
      confidence: "medium",
      reason: "Moderate complexity score " + complexity.score + signalSummary,
      budgetState: budgetState
    };
  }
  if (complexity.score <= -0.3) {
    return {
      agent: "claudeSubagent",
      confidence: "high",
      reason: "Low complexity score " + complexity.score + signalSummary,
      budgetState: budgetState
    };
  }
  if (complexity.score <= -0.1) {
    return {
      agent: "claudeSubagent",
      confidence: "medium",
      reason: "Below-average complexity score " + complexity.score + signalSummary,
      budgetState: budgetState
    };
  }

  return {
    agent: "either",
    confidence: "low",
    reason: "Ambiguous complexity score " + complexity.score + signalSummary,
    budgetState: budgetState
  };
}

/**
 * Keywords indicating the user wants a code/diff review.
 */
var REVIEW_INTENT_KEYWORDS = [
  "code review", "diff review", "PR review", "PR feedback",
  "review the changes", "review the diff", "review the PR",
  "check changes", "check the PR", "check PR",
  "audit changes", "look over changes",
  "feedback on changes", "review recent changes",
  "review my changes", "review this PR", "review the code"
];

/**
 * Single-word "review" — matched separately so we can require it as a standalone word
 * without colliding with phrases like "implement a review system".
 */
var REVIEW_WORD_PATTERN = /\breview\b/i;

/**
 * Patterns that indicate a focused/scoped review (not a pure diff review).
 * If any match, the review should use standard exec with a review prompt template
 * rather than `codex exec review` (which can't take a prompt argument).
 */
var FOCUS_CONSTRAINT_PATTERNS = [
  // Topical focus — security domains
  /\b(security|SQL injection|XSS|CSRF|injection|auth(?:entication|orization)?|cryptograph|encrypt|vulnerabilit)/i,
  // Topical focus — quality domains
  /\b(performance|memory leak|race condition|deadlock|thread.?safe|concurren)/i,
  // Topical focus — code quality
  /\b(error handling|edge case|null.?check|type.?safe|test coverage)/i,
  // Scope narrowing — file/module/function references (requires delimiter or specific naming)
  /\b(file|module|component|function|class|method|endpoint|route|controller|service)\s*[:=]\s*\S/i,
  // Scope narrowing — path-like references (forward or back slashes)
  /(?:src|lib|test|app|pages|components|utils|services|middleware|controllers|routes)[\/\\]\S+/i,
  // Non-diff constraints
  /\b(existing code|current implementation|whole codebase|entire project)\b/i,
  // Output constraints
  /\b(only\s+(?:security|bugs|errors|warnings|performance)|just\s+(?:security|bugs|errors))\b/i,
  // Explicit "for X" pattern
  /\breview\b.*\bfor\s+\w/i
];

/**
 * Patterns showing that the request carries or names its own review scope.
 * Such a review must cover exactly that scope (Step 6c with the caller's text)
 * and must never be replaced by the working tree's `git diff HEAD` (the pure-diff
 * path). Found 2026-11-09: review-pipeline pastes its diff into the request, and
 * whether it was treated as focused depended on its file paths happening to
 * contain "lib/" or "security".
 */
var REVIEW_SCOPE_PATTERNS = [
  // A pasted unified diff
  /^diff --git /m,
  /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m,
  /^(?:---|\+\+\+) [ab]\//m,
  // A named commit, commit range or pull request
  /\bcommit\s+[0-9a-f]{7,40}\b/i,
  /\b[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\b/i,
  /\b(?:PR|pull request)\s*#?\d+\b/i,
  // A named file: a path with at least one separator and an extension
  /(?:^|[\s`'"(])[\w.-]+(?:[\/\\][\w.-]+)+\.[A-Za-z0-9]{1,6}\b/,
  // An explicitly focused review
  /\bfocused\s+(?:code\s+)?review\b/i
];

/**
 * Anti-patterns — phrases where "review" does NOT mean a code/diff review.
 * These prevent false positives from task descriptions like "implement a review system".
 */
var REVIEW_ANTI_PATTERNS = [
  /\b(implement|build|create|design|write|develop)\s+(?:a\s+|the\s+)?review\s+(system|feature|page|form|component|workflow|process|mechanism|tool|platform)\b/i,
  /\breview\s+(system|feature|page|form|component|workflow|process|mechanism)\b/i,
  // Test-writing tasks (fix-and-verify's adversarial tester) need workspace-write;
  // routing them as a review would make them read-only.
  /\b(?:write|add|create)\s+(?:\w+\s+){0,3}tests?\b/i,
  /\badversarial\s+tester\b/i
];

/**
 * Lines that belong to pasted git output: unified-diff lines and `git show` headers.
 */
var PASTED_GIT_LINE = /^(?:diff --git |index |@@ |--- |\+\+\+ |[+\- \\]|new file mode|deleted file mode|old mode|new mode|similarity index|rename (?:from|to) |Binary files |(?:Author|AuthorDate|Commit|CommitDate|Date|Merge):)/;
var PASTED_GIT_START = /^(?:diff --git |--- [ab]\/|commit [0-9a-f]{7,40}\b)/;

/**
 * The caller's instruction without pasted code. Review intent, anti-patterns and
 * focus are judged on this, because words inside a pasted diff or file ("code
 * review", "security", ...) say nothing about what the caller wants: on
 * 2026-11-09 a test-writing request carrying a diff that mentioned "code review"
 * was routed as a (read-only) review. Removes fenced ``` blocks and git output
 * blocks (from a `diff --git`, `--- a/` or `commit <sha>` line through the
 * following diff/header/blank/indented lines).
 */
/** First pattern that matches `text`, or null. (Patterns have no /g flag, so .test is stateless.) */
function firstMatch(patterns, text) {
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return patterns[i];
  }
  return null;
}

function stripPastedCode(text) {
  var lines = text.replace(/```[\s\S]*?```/g, " ").split(/\r?\n/);
  var kept = [];
  var inPasted = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (PASTED_GIT_START.test(line)) inPasted = true;
    if (inPasted && (line === "" || PASTED_GIT_LINE.test(line))) continue;
    inPasted = false;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Detect whether a task description is requesting a code review.
 *
 * Returns:
 *   isReview: true  + isFocused: false → pure diff review (codex exec review)
 *   isReview: true  + isFocused: true  → focused review (standard exec with review prompt)
 *   isReview: false                    → normal dispatch
 *   hasScope: true → the request carries/names its own scope (always makes isFocused true)
 *
 * @param {string} description - The task description
 * @returns {{ isReview: boolean, isFocused: boolean, hasScope: boolean, confidence: string, signals: string[] }}
 */
function detectReviewTask(description) {
  if (!description || typeof description !== "string") {
    return { isReview: false, isFocused: false, confidence: "high", signals: ["empty description"] };
  }

  // Intent, anti-patterns and focus come from the caller's own words; scope (Signal 3)
  // is taken from the full text, pasted diff included.
  var instruction = stripPastedCode(description);
  var signals = [];

  // Check anti-patterns first — if matched, this is NOT a review task
  var anti = firstMatch(REVIEW_ANTI_PATTERNS, instruction);
  if (anti) {
    signals.push("anti-pattern: " + anti.source.substring(0, 40));
    return { isReview: false, isFocused: false, confidence: "high", signals: signals };
  }

  // Signal 1: Review intent — check multi-word phrases first, then single word
  var hasReviewIntent = false;
  for (var i = 0; i < REVIEW_INTENT_KEYWORDS.length; i++) {
    var kwPattern = new RegExp("\\b" + REVIEW_INTENT_KEYWORDS[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (kwPattern.test(instruction)) {
      hasReviewIntent = true;
      signals.push("intent: " + REVIEW_INTENT_KEYWORDS[i]);
      break;
    }
  }
  if (!hasReviewIntent && REVIEW_WORD_PATTERN.test(instruction)) {
    hasReviewIntent = true;
    signals.push("intent: review (single word)");
  }

  if (!hasReviewIntent) {
    return { isReview: false, isFocused: false, confidence: "high", signals: signals.length > 0 ? signals : ["no review intent"] };
  }

  // Signal 2: Focus constraints — check if the review is scoped/focused
  var focus = firstMatch(FOCUS_CONSTRAINT_PATTERNS, instruction);
  if (focus) signals.push("focus: " + focus.source.substring(0, 40));

  // Signal 3: Caller-supplied scope — a review of a pasted diff, commit, PR or named
  // files must review exactly that, so it is always routed as focused.
  var scope = firstMatch(REVIEW_SCOPE_PATTERNS, description);
  if (scope) signals.push("scope: " + scope.source.substring(0, 40));

  var hasScope = scope !== null;
  var isFocused = focus !== null || hasScope;

  // Determine confidence
  var confidence = "high";
  if (signals.length === 1 && signals[0] === "intent: review (single word)") {
    confidence = "medium";
  }

  return {
    isReview: true,
    isFocused: isFocused,
    hasScope: hasScope,
    confidence: confidence,
    signals: signals
  };
}

module.exports = {
  routeTask: routeTask,
  estimateComplexity: estimateComplexity,
  detectReviewTask: detectReviewTask,
  detectAdversarialReview: detectAdversarialReview
};
