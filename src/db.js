'use strict';

const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const defaultExecFileAsync = promisify(execFile);

let _sqlite3Bin = null;

/**
 * Locate a working sqlite3 binary. Throws if none found.
 * @param {(bin: string, args: string[]) => void} [execFn] — injectable for tests
 */
function getSqlite3(execFn = execFileSync) {
  if (_sqlite3Bin) return _sqlite3Bin;
  for (const bin of ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', 'sqlite3']) {
    try { execFn(bin, ['--version']); _sqlite3Bin = bin; return bin; } catch { /* try next */ }
  }
  throw new Error('sqlite3 not found. Install via: brew install sqlite3');
}

/** Reset cached binary (for tests). */
function _resetSqlite3Cache() { _sqlite3Bin = null; }

/**
 * Parse raw sqlite3 `key|value` output into a result map.
 * @param {string} stdout
 * @returns {Record<string, any>}
 */
function parseDbOutput(stdout) {
  const result = {};
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const sep = line.indexOf('|');
    if (sep === -1) continue;
    const k = line.slice(0, sep);
    try { result[k] = JSON.parse(line.slice(sep + 1)); } catch { result[k] = null; }
  }
  return result;
}

/**
 * Query one or multiple keys from a sqlite3 DB (synchronous).
 * Returns the parsed value for a single key, or a {key: value} map for an array.
 * @param {string} dbPath
 * @param {string | string[]} keyOrKeys
 * @param {{ execFn?: Function }} [opts]
 */
function queryDbValue(dbPath, keyOrKeys, { execFn = execFileSync } = {}) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  try {
    const list = keys.map(k => `'${k.replace(/'/g, "''")}'`).join(',');
    const out = execFn(getSqlite3(execFn), ['-readonly', dbPath, `SELECT key, value FROM ItemTable WHERE key IN (${list});`], {
      maxBuffer: 50 * 1024 * 1024, timeout: 8000
    });
    const result = parseDbOutput(out.toString());
    if (!Array.isArray(keyOrKeys)) return result[keyOrKeys] ?? null;
    return result;
  } catch {
    return Array.isArray(keyOrKeys) ? {} : null;
  }
}

/**
 * Async version of queryDbValue — non-blocking.
 * @param {string} dbPath
 * @param {string | string[]} keyOrKeys
 * @param {{ execFileAsync?: Function }} [opts]
 */
async function queryDbValueAsync(dbPath, keyOrKeys, { execFileAsync = defaultExecFileAsync } = {}) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  try {
    const list = keys.map(k => `'${k.replace(/'/g, "''")}'`).join(',');
    const { stdout } = await execFileAsync(
      getSqlite3(),
      [dbPath, `SELECT key, value FROM ItemTable WHERE key IN (${list});`],
      { maxBuffer: 50 * 1024 * 1024, timeout: 8000 }
    );
    const result = parseDbOutput(stdout);
    if (!Array.isArray(keyOrKeys)) return result[keyOrKeys] ?? null;
    return result;
  } catch {
    return Array.isArray(keyOrKeys) ? {} : null;
  }
}

module.exports = { getSqlite3, queryDbValue, queryDbValueAsync, parseDbOutput, _resetSqlite3Cache };
