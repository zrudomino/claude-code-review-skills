/**
 * plan-usage.js — Codex plan usage: the numbers Codex's /status shows (the 5-hour and
 * weekly rate-limit windows, plus the team plan's monthly per-user limit).
 *
 * Two sources (verified on Codex CLI 0.167.0, 2026-11-09):
 *  - live: a short-lived `codex app-server` answers `account/rateLimits/read`
 *    (1.4-2.0 s, no model turn, no tokens, no session record). Includes the monthly limit.
 *  - session record: every Codex call writes a `rate_limits` snapshot into its rollout
 *    file under $CODEX_HOME/sessions/YYYY/MM/DD/. Free; 5-hour + weekly only
 *    (`individual_limit` is null there).
 *
 * CLI (prints one JSON object; exit code is always 0, failures are reported as { error }):
 *   node plan-usage.js live                  live query
 *   node plan-usage.js latest                newest snapshot from any session record
 *   node plan-usage.js thread <threadId>     snapshot from that thread's session record
 *   node plan-usage.js guard [maxAgeMin]     pre-call quota guard (default max age 30 min)
 *   node plan-usage.js line <threadId>       one-line summary after a finished call
 *
 * The account id in the live answer is never output. No npm dependencies. ES5.
 */

"use strict";

var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");

var DEFAULT_WARN_PERCENT = 80;
var DEFAULT_ASK_PERCENT = 95;
var DEFAULT_MAX_AGE_MIN = 30;
var LIVE_TIMEOUT_MS = 20000;
var SEARCH_DAYS = 60;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function windowName(mins) {
  if (mins === 300) return "5h";
  if (mins === 10080) return "week";
  if (mins >= 1440 && mins % 1440 === 0) return (mins / 1440) + "d";
  return Math.round(mins / 60) + "h";
}

function isoFromEpoch(sec) {
  return typeof sec === "number" ? new Date(sec * 1000).toISOString() : null;
}

/** A field under its live (camelCase) name, else under its session-record (snake_case) name. */
function pick(obj, camelName, snakeName) {
  return obj[camelName] != null ? obj[camelName] : obj[snakeName];
}

/** One rate-limit window from either source (live camelCase or rollout snake_case). */
function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  var used = pick(w, "usedPercent", "used_percent");
  var mins = pick(w, "windowDurationMins", "window_minutes");
  var resets = pick(w, "resetsAt", "resets_at");
  if (typeof used !== "number") return null;
  return { name: windowName(mins), usedPercent: used, windowMins: mins, resetsAt: isoFromEpoch(resets) };
}

/** Normalize a rate-limit snapshot (live `rateLimits` or rollout `rate_limits`). */
function normalizeSnapshot(rl, extra) {
  var windows = [normalizeWindow(rl.primary), normalizeWindow(rl.secondary)].filter(Boolean);
  var ind = pick(rl, "individualLimit", "individual_limit");
  var monthly = null;
  if (ind && typeof ind === "object") {
    var remaining = pick(ind, "remainingPercent", "remaining_percent");
    monthly = {
      usedPercent: typeof remaining === "number" ? Math.round((100 - remaining) * 10) / 10 : null,
      limit: ind.limit != null ? String(ind.limit) : null,
      used: ind.used != null ? String(ind.used) : null,
      resetsAt: isoFromEpoch(pick(ind, "resetsAt", "resets_at"))
    };
  }
  var out = {
    source: extra.source,
    observedAt: extra.observedAt,
    ageMinutes: extra.observedAt ? Math.round((Date.now() - Date.parse(extra.observedAt)) / 6000) / 10 : null,
    planType: pick(rl, "planType", "plan_type") || null,
    windows: windows,
    monthly: monthly,
    limitReached: pick(rl, "rateLimitReachedType", "rate_limit_reached_type") || null
  };
  if (extra.resetCreditsAvailable != null) out.resetCreditsAvailable = extra.resetCreditsAvailable;
  if (extra.file) out.file = extra.file;
  return out;
}

// ---------------------------------------------------------------- live source

function readLive(callback) {
  var proc;
  try {
    proc = child_process.spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
  } catch (e) {
    return callback({ error: "spawn failed: " + e.message });
  }
  var buf = "";
  var finished = false;

  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { proc.stdin.end(); proc.kill(); } catch (e) { /* already gone */ }
    callback(result);
  }
  function send(msg) {
    try { proc.stdin.write(JSON.stringify(msg) + "\n"); } catch (e) { finish({ error: "write failed: " + e.message }); }
  }

  var timer = setTimeout(function () { finish({ error: "app-server timeout after " + LIVE_TIMEOUT_MS + " ms" }); }, LIVE_TIMEOUT_MS);
  proc.stdin.on("error", function () { /* reported via close */ });
  proc.on("error", function (e) { finish({ error: "app-server error: " + e.message }); });
  proc.on("close", function (code) { finish({ error: "app-server exited (" + code + ") before answering" }); });
  proc.stdout.on("data", function (chunk) {
    buf += chunk.toString();
    var lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var msg;
      try { msg = JSON.parse(lines[i]); } catch (e) { continue; }
      if (msg.id === 1) {
        if (msg.error) return finish({ error: "initialize failed: " + JSON.stringify(msg.error) });
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else if (msg.id === 2) {
        if (msg.error || !msg.result || !msg.result.rateLimits) {
          return finish({ error: "account/rateLimits/read failed: " + JSON.stringify(msg.error || msg.result) });
        }
        var credits = msg.result.rateLimitResetCredits;
        return finish(normalizeSnapshot(msg.result.rateLimits, {
          source: "live",
          observedAt: new Date().toISOString(),
          resetCreditsAvailable: credits && typeof credits.availableCount === "number" ? credits.availableCount : null
        }));
      }
    }
  });

  send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-agent", version: "1.0.0" } } });
}

// ---------------------------------------------------------- session records

/** Rollout day directories, newest first, for the last SEARCH_DAYS days that exist. */
function recentDayDirs() {
  var base = path.join(codexHome(), "sessions");
  var dirs = [];
  for (var d = 0; d <= SEARCH_DAYS; d++) {
    var day = new Date(Date.now() - d * 86400000);
    var p = path.join(base, String(day.getFullYear()), ("0" + (day.getMonth() + 1)).slice(-2), ("0" + day.getDate()).slice(-2));
    if (fs.existsSync(p)) dirs.push(p);
  }
  return dirs;
}

function findRateLimits(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.rate_limits && typeof obj.rate_limits === "object") return obj.rate_limits;
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      var r = findRateLimits(obj[k]);
      if (r) return r;
    }
  }
  return null;
}

/** Last rate-limit snapshot in one rollout file, or null. */
function snapshotFromFile(file) {
  var text;
  try { text = fs.readFileSync(file, "utf-8"); } catch (e) { return null; }
  var lines = text.split(/\r?\n/);
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf("\"rate_limits\"") === -1) continue;
    var data;
    try { data = JSON.parse(lines[i]); } catch (e) { continue; }
    var rl = findRateLimits(data);
    if (!rl) continue;
    var observedAt = data.timestamp || null;
    if (!observedAt) {
      try { observedAt = fs.statSync(file).mtime.toISOString(); } catch (e) { observedAt = null; }
    }
    return normalizeSnapshot(rl, { source: "session-record", observedAt: observedAt, file: file });
  }
  return null;
}

/** Newest snapshot across all recent session records (any terminal, any project). */
function readLatest() {
  var dirs = recentDayDirs();
  for (var d = 0; d < dirs.length; d++) {
    var files = fs.readdirSync(dirs[d])
      .filter(function (f) { return /^rollout-.*\.jsonl$/.test(f); })
      .map(function (f) { var p = path.join(dirs[d], f); return { p: p, t: fs.statSync(p).mtimeMs }; })
      .sort(function (a, b) { return b.t - a.t; });
    for (var i = 0; i < files.length; i++) {
      var snap = snapshotFromFile(files[i].p);
      if (snap) return snap;
    }
  }
  return { error: "no rate-limit snapshot in session records of the last " + SEARCH_DAYS + " days" };
}

/** Snapshot from the session record of one thread (rollout file name ends in -<threadId>.jsonl). */
function readThread(threadId) {
  if (!threadId || !/^[0-9a-f-]{8,}$/i.test(threadId)) return { error: "invalid thread id" };
  var suffix = "-" + threadId + ".jsonl";
  var dirs = recentDayDirs();
  for (var d = 0; d < dirs.length; d++) {
    var names = fs.readdirSync(dirs[d]);
    for (var i = 0; i < names.length; i++) {
      if (names[i].slice(-suffix.length) === suffix) {
        return snapshotFromFile(path.join(dirs[d], names[i])) || { error: "no rate-limit snapshot in " + names[i] };
      }
    }
  }
  return { error: "no session record for thread " + threadId + " (ephemeral run?)" };
}

// ------------------------------------------------------------- guard + line

function thresholds() {
  var warn = DEFAULT_WARN_PERCENT;
  var ask = DEFAULT_ASK_PERCENT;
  try {
    var cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "codex-agent", "config.json"), "utf-8"));
    if (cfg.quota && typeof cfg.quota.warnPercent === "number") warn = cfg.quota.warnPercent;
    if (cfg.quota && typeof cfg.quota.askPercent === "number") ask = cfg.quota.askPercent;
  } catch (e) { /* defaults */ }
  return { warnPercent: warn, askPercent: ask };
}

/** level: "ok" | "warn" (>= warnPercent) | "ask" (>= askPercent or a limit reached) | "unknown". */
function evaluate(usage) {
  var t = thresholds();
  if (!usage || usage.error) {
    return { level: "unknown", reasons: [usage && usage.error ? usage.error : "no usage data"], thresholds: t, usage: usage || null };
  }
  var checks = usage.windows.slice();
  if (usage.monthly && typeof usage.monthly.usedPercent === "number") {
    checks.push({ name: "month", usedPercent: usage.monthly.usedPercent, resetsAt: usage.monthly.resetsAt });
  }
  var level = "ok";
  var reasons = [];
  var max = 0;
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    if (c.usedPercent > max) max = c.usedPercent;
    if (c.usedPercent >= t.askPercent) { level = "ask"; reasons.push(c.name + " " + c.usedPercent + "% used (>= " + t.askPercent + "%)"); }
    else if (c.usedPercent >= t.warnPercent) { if (level === "ok") level = "warn"; reasons.push(c.name + " " + c.usedPercent + "% used (>= " + t.warnPercent + "%)"); }
  }
  if (usage.limitReached) { level = "ask"; reasons.push("limit reached: " + usage.limitReached); }
  return { level: level, maxUsedPercent: max, reasons: reasons, thresholds: t, usage: usage };
}

function guard(maxAgeMin, callback) {
  var latest = readLatest();
  if (!latest.error && latest.ageMinutes != null && latest.ageMinutes <= maxAgeMin) return callback(evaluate(latest));
  readLive(function (live) {
    if (!live.error) return callback(evaluate(live));
    // Live query failed: fall back to an older snapshot rather than nothing.
    var result = evaluate(latest.error ? live : latest);
    result.note = "live query failed (" + live.error + ")" + (latest.error ? "" : "; using a " + latest.ageMinutes + "-minute-old session record");
    callback(result);
  });
}

function formatTime(iso) {
  if (!iso) return "?";
  var d = new Date(iso);
  var sameDay = d.toDateString() === new Date().toDateString();
  var hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }) + " " + hm;
}

/** "Codex plan: 5h 12% (resets 06:37) · week 23% (resets Wed 11 Nov 09:40)". */
function formatLine(usage) {
  if (!usage || usage.error) return "Codex plan: unavailable (" + (usage && usage.error ? usage.error : "no data") + ")";
  var parts = usage.windows.map(function (w) { return w.name + " " + w.usedPercent + "% (resets " + formatTime(w.resetsAt) + ")"; });
  if (usage.monthly && typeof usage.monthly.usedPercent === "number") {
    parts.push("month " + usage.monthly.usedPercent + "% (resets " + formatTime(usage.monthly.resetsAt) + ")");
  }
  if (usage.limitReached) parts.push("LIMIT REACHED: " + usage.limitReached);
  return "Codex plan: " + parts.join(" · ");
}

module.exports = {
  readLive: readLive,
  readLatest: readLatest,
  readThread: readThread,
  evaluate: evaluate,
  guard: guard,
  formatLine: formatLine,
  normalizeSnapshot: normalizeSnapshot
};

// --------------------------------------------------------------------- CLI

if (require.main === module) {
  var cmd = process.argv[2];
  var arg = process.argv[3];
  var print = function (o) { console.log(JSON.stringify(o)); };
  if (cmd === "live") readLive(print);
  else if (cmd === "latest") print(readLatest());
  else if (cmd === "thread") print(readThread(arg));
  else if (cmd === "guard") guard(arg ? Number(arg) : DEFAULT_MAX_AGE_MIN, print);
  else if (cmd === "line") {
    var snap = readThread(arg);
    if (snap.error) snap = readLatest();
    print({ line: formatLine(snap), usage: snap });
  } else {
    print({ error: "usage: node plan-usage.js live | latest | thread <id> | guard [maxAgeMin] | line <id>" });
  }
}
