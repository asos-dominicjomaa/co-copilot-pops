'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Recursively copy a directory.
 * @param {string} src
 * @param {string} dest
 * @param {{ mkdirSync?: Function, readdirSync?: Function, copyFileSync?: Function, statSync?: Function }} [opts]
 */
function copyDirRecursive(src, dest, opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const readdirSync = opts.readdirSync || fs.readdirSync;
  const copyFileSync = opts.copyFileSync || fs.copyFileSync;
  const statSync = opts.statSync || fs.statSync;

  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath, opts);
    else copyFileSync(srcPath, destPath);
  }
}

/**
 * Derive the workspace folder label from workspace.json content.
 * Returns the last path segment, or the hash prefix as fallback.
 * @param {string} wsDir
 * @param {string} wsHash
 * @param {{ readFileSync?: Function }} [opts]
 * @returns {string}
 */
function resolveBackupLabel(wsDir, wsHash, { readFileSync = fs.readFileSync } = {}) {
  try {
    const wsJson = JSON.parse(readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = wsJson.workspace || wsJson.folder || '';
    const parts = decodeURIComponent(uri).replace('file://', '').split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch { /* ignore */ }
  return wsHash.slice(0, 8);
}

/**
 * Generate a timestamped backup name for a workspace.
 * @param {string} wsLabel — workspace folder name
 * @param {Date} [now]
 * @returns {string}
 */
function buildBackupName(wsLabel, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  return `${wsLabel} — ${stamp}`;
}

/**
 * Copy workspace files into a new history backup folder.
 * @param {string} wsDir — source workspace storage dir
 * @param {string} destDir — destination dir (will be created)
 * @param {{ mkdirSync?: Function, existsSync?: Function, copyFileSync?: Function, readdirSync?: Function, statSync?: Function }} [opts]
 */
function copyWorkspaceFiles(wsDir, destDir, opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const copyFileSync = opts.copyFileSync || fs.copyFileSync;

  mkdirSync(destDir, { recursive: true });

  const filesToCopy = ['workspace.json', 'state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm'];
  for (const f of filesToCopy) {
    const src = path.join(wsDir, f);
    if (existsSync(src)) copyFileSync(src, path.join(destDir, f));
  }

  const chatSrc = path.join(wsDir, 'chatSessions');
  if (existsSync(chatSrc)) {
    copyDirRecursive(chatSrc, path.join(destDir, 'chatSessions'), opts);
  }
}

/**
 * Sync workspace files into an existing history backup folder.
 * Only copies files that are newer in source or missing in dest.
 * @param {string} wsDir — live workspace storage dir
 * @param {string} destDir — existing backup dir
 * @param {{ mkdirSync?: Function, existsSync?: Function, copyFileSync?: Function, readdirSync?: Function, statSync?: Function }} [opts]
 * @returns {{ updated: number, added: number }}
 */
function syncWorkspaceFiles(wsDir, destDir, opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const copyFileSync = opts.copyFileSync || fs.copyFileSync;
  const statSync = opts.statSync || fs.statSync;
  const readdirSync = opts.readdirSync || fs.readdirSync;

  mkdirSync(destDir, { recursive: true });

  let updated = 0;
  let added = 0;

  const syncFile = (src, dest) => {
    if (!existsSync(src)) return;
    const destExists = existsSync(dest);
    if (!destExists) {
      copyFileSync(src, dest);
      added++;
    } else {
      const srcStat = statSync(src);
      const destStat = statSync(dest);
      const srcMtime = srcStat.mtimeMs;
      const destMtime = destStat.mtimeMs;
      if (srcMtime > destMtime || (srcStat.size || 0) !== (destStat.size || 0)) {
        copyFileSync(src, dest);
        updated++;
      }
    }
  };

  const syncDirRecursive = (srcDir, destDirPath) => {
    if (!existsSync(srcDir)) return;
    mkdirSync(destDirPath, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDirPath, entry.name);
      if (entry.isDirectory()) {
        syncDirRecursive(srcPath, destPath);
      } else if (typeof entry.isFile !== 'function' || entry.isFile()) {
        syncFile(srcPath, destPath);
      }
    }
  };

  // Sync top-level files
  for (const f of ['workspace.json', 'state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm']) {
    syncFile(path.join(wsDir, f), path.join(destDir, f));
  }

  // Sync chatSessions directory
  const chatSrc = path.join(wsDir, 'chatSessions');
  if (existsSync(chatSrc)) {
    syncDirRecursive(chatSrc, path.join(destDir, 'chatSessions'));
  }

  return { updated, added };
}

module.exports = { copyDirRecursive, resolveBackupLabel, buildBackupName, copyWorkspaceFiles, syncWorkspaceFiles };
