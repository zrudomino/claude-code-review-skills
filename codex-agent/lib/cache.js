/**
 * cache.js — Result caching with hash-based lookup and TTL expiration.
 *
 * Caches Codex dispatch results keyed by SHA-256 hash of task + working dir.
 * No npm dependencies. ES5 strict.
 *
 * Usage from node -e:
 *   var c = require("<path>/cache.js");
 *   var key = c.computeKey("task description", "/work/dir");
 *   c.store(cacheDir, key, { ... });
 *   var hit = c.lookup(cacheDir, key, 3600000);
 */

"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

/**
 * Compute a cache key from task description and working directory.
 * @param {string} taskDescription
 * @param {string} workingDir
 * @returns {string} Hex SHA-256 hash
 */
function computeKey(taskDescription, workingDir) {
  var input = (taskDescription || "") + "\n" + (workingDir || "");
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Look up a cached entry by key. Returns hit/miss with optional TTL check.
 * @param {string} cacheDir - Path to cache directory
 * @param {string} key - The cache key (hex hash)
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @returns {{ hit: boolean, entry: object|null }}
 */
function lookup(cacheDir, key, ttlMs) {
  var filePath = path.join(cacheDir, key + ".json");
  try {
    var raw = fs.readFileSync(filePath, "utf-8");
    var entry = JSON.parse(raw);
    // Check TTL
    if (typeof ttlMs === "number" && ttlMs > 0) {
      if (Date.now() - entry.cachedAt > ttlMs) {
        return { hit: false, entry: null };
      }
    }
    return { hit: true, entry: entry };
  } catch (e) {
    return { hit: false, entry: null };
  }
}

/**
 * Store a result in the cache. Evicts oldest entry if maxEntries is reached.
 * @param {string} cacheDir - Path to cache directory
 * @param {string} key - The cache key (hex hash)
 * @param {object} entry - The cache entry to store
 * @param {number} [maxEntries] - Maximum entries before eviction (default 100)
 */
function store(cacheDir, key, entry, maxEntries) {
  var max = typeof maxEntries === "number" && maxEntries > 0 ? maxEntries : 100;

  // Ensure cache directory exists
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Eviction: if at capacity, delete the oldest entry
  var files;
  try {
    files = fs.readdirSync(cacheDir).filter(function (f) {
      return f.endsWith(".json") && !f.includes(".tmp-");
    });
  } catch (e) {
    files = [];
  }

  if (files.length >= max) {
    // Find oldest by cachedAt
    var oldest = null;
    var oldestTime = Infinity;
    for (var i = 0; i < files.length; i++) {
      try {
        var raw = fs.readFileSync(path.join(cacheDir, files[i]), "utf-8");
        var parsed = JSON.parse(raw);
        if (typeof parsed.cachedAt === "number" && parsed.cachedAt < oldestTime) {
          oldestTime = parsed.cachedAt;
          oldest = files[i];
        }
      } catch (e) {
        // If we can't read it, it's a good eviction candidate
        oldest = files[i];
        oldestTime = 0;
      }
    }
    if (oldest) {
      try { fs.unlinkSync(path.join(cacheDir, oldest)); } catch (e) { /* ignore */ }
    }
  }

  // Ensure cachedAt is set
  if (!entry.cachedAt) {
    entry.cachedAt = Date.now();
  }
  if (!entry.key) {
    entry.key = key;
  }

  // Atomic write
  var filePath = path.join(cacheDir, key + ".json");
  var tmpPath = filePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Invalidate (delete) a single cache entry.
 * @param {string} cacheDir
 * @param {string} key
 */
function invalidate(cacheDir, key) {
  var filePath = path.join(cacheDir, key + ".json");
  try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
}

/**
 * Clear all cache entries.
 * @param {string} cacheDir
 */
function clear(cacheDir) {
  var files;
  try {
    files = fs.readdirSync(cacheDir).filter(function (f) {
      return f.endsWith(".json");
    });
  } catch (e) {
    return;
  }
  for (var i = 0; i < files.length; i++) {
    try { fs.unlinkSync(path.join(cacheDir, files[i])); } catch (e) { /* ignore */ }
  }
}

/**
 * Get cache statistics.
 * @param {string} cacheDir
 * @returns {{ entries: number, totalSize: number, oldestAt: number|null, newestAt: number|null }}
 */
function stats(cacheDir) {
  var result = { entries: 0, totalSize: 0, oldestAt: null, newestAt: null };
  var files;
  try {
    files = fs.readdirSync(cacheDir).filter(function (f) {
      return f.endsWith(".json") && !f.includes(".tmp-");
    });
  } catch (e) {
    return result;
  }

  result.entries = files.length;
  for (var i = 0; i < files.length; i++) {
    var filePath = path.join(cacheDir, files[i]);
    try {
      var stat = fs.statSync(filePath);
      result.totalSize += stat.size;
      var raw = fs.readFileSync(filePath, "utf-8");
      var parsed = JSON.parse(raw);
      if (typeof parsed.cachedAt === "number") {
        if (result.oldestAt === null || parsed.cachedAt < result.oldestAt) {
          result.oldestAt = parsed.cachedAt;
        }
        if (result.newestAt === null || parsed.cachedAt > result.newestAt) {
          result.newestAt = parsed.cachedAt;
        }
      }
    } catch (e) { /* skip */ }
  }

  return result;
}

module.exports = {
  computeKey: computeKey,
  lookup: lookup,
  store: store,
  invalidate: invalidate,
  clear: clear,
  stats: stats
};
