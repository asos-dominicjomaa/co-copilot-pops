'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { queryDbValueAsync } = require('./db');

/**
 * Resolve a human-readable workspace name from workspace.json and copilot DB data.
 * @param {string} wsDir
 * @param {object} dbValues — already-queried DB values for this workspace
 * @param {string} wsHash
 * @param {{ readFileSync?: Function }} [opts]
 * @returns {string}
 */
function resolveWorkspaceName(wsDir, dbValues, wsHash, { readFileSync = fs.readFileSync } = {}) {
  try {
    const wsJson = JSON.parse(readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const wsUri = wsJson.workspace || wsJson.folder || '';
    const decoded = decodeURIComponent(wsUri).replace(/\/workspace\.json$/, '');
    if (decoded.includes('/Code/Workspaces/')) {
      const copilotData = dbValues['GitHub.copilot-chat'];
      const folders = copilotData?.workspaceFolderIds?.entries || [];
      if (folders.length > 0) {
        const firstFolder = decodeURIComponent(folders[0].uri || '').replace('file://', '');
        const parts = firstFolder.split('/').filter(Boolean);
        return parts.slice(-2).join('/');
      }
    } else {
      const match = decoded.match(/\/([^/]+)\/?$/);
      if (match) return match[1].replace(/\.code-workspace$/, '');
    }
  } catch { /* fall through */ }
  return wsHash.slice(0, 8);
}

/**
 * Scan a chatSessions directory and return a map of sessionId → filePath.
 * @param {string} chatSessionsDir
 * @param {{ readdirSync?: Function, existsSync?: Function, statSync?: Function }} [opts]
 * @returns {Record<string, string>}
 */
function scanChatSessionFiles(chatSessionsDir, { readdirSync = fs.readdirSync, existsSync = fs.existsSync, statSync = fs.statSync } = {}) {
  const files = {};
  if (!existsSync(chatSessionsDir)) return files;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const fullPath = path.join(dir, name);
      const isDirectory = typeof entry === 'string'
        ? (() => { try { return statSync(fullPath).isDirectory(); } catch { return false; } })()
        : entry.isDirectory();
      const isFile = typeof entry === 'string'
        ? !isDirectory
        : entry.isFile();

      if (isDirectory) {
        walk(fullPath);
        continue;
      }
      if (!isFile) continue;

      if (name.endsWith('.jsonl') || name.endsWith('.json')) {
        const sessionId = name.replace(/\.(jsonl|json)$/, '');
        if (!files[sessionId] || name.endsWith('.jsonl')) {
          files[sessionId] = fullPath;
        }
      }
    }
  };

  walk(chatSessionsDir);
  return files;
}

/**
 * Build the session object list from a DB index, matching files and events.
 * @param {object} indexEntries — chat.ChatSessionStore.index.entries
 * @param {Record<string, string>} chatSessionFiles
 * @param {string} workspaceName
 * @param {string} wsHash
 * @param {string} copilotCliSessionDir — ~/.copilot/session-state
 * @param {{ existsSync?: Function }} [opts]
 * @returns {Array<object>}
 */
function buildSessionList(indexEntries, chatSessionFiles, workspaceName, wsHash, copilotCliSessionDir, { existsSync = fs.existsSync } = {}) {
  const sessions = [];
  for (const [sessionId, meta] of Object.entries(indexEntries)) {
    if (meta.isEmpty) continue;
    let sessionFile = chatSessionFiles[sessionId] || null;
    let eventsFile = null;
    if (!sessionFile && meta.isExternal && sessionId.startsWith('copilotcli:/')) {
      const uuid = sessionId.slice('copilotcli:/'.length);
      const candidate = path.join(copilotCliSessionDir, uuid, 'events.jsonl');
      if (existsSync(candidate)) eventsFile = candidate;
    }
    sessions.push({
      id: sessionId,
      title: meta.title || 'Untitled',
      date: meta.lastMessageDate || meta.timing?.created || 0,
      created: meta.timing?.created || 0,
      workspace: workspaceName,
      wsHash,
      location: meta.initialLocation || null,
      hasPendingEdits: meta.hasPendingEdits || false,
      turnCount: meta.stats?.requestCount || 0,
      sessionFile,
      eventsFile,
    });
  }
  return sessions;
}

/**
 * Async loader — runs DB queries concurrently across all workspace dirs.
 * @param {string} backupDir
 * @param {(msg: string) => void} [onProgress]
 * @param {{ fs?: object, os?: object, queryDbValueAsync?: Function }} [deps]
 * @returns {Promise<Array<object>>}
 */
async function loadSessionsAsync(backupDir, onProgress = () => { }, deps = {}) {
  const fsDep = deps.fs || fs;
  const osDep = deps.os || os;
  const queryDb = deps.queryDbValueAsync || queryDbValueAsync;

  const wsStorageDir = path.join(backupDir, 'workspaceStorage');
  if (!fsDep.existsSync(wsStorageDir)) throw new Error(`workspaceStorage not found in ${backupDir}`);

  const workspaceDirs = fsDep.readdirSync(wsStorageDir).filter(d => {
    try { return fsDep.statSync(path.join(wsStorageDir, d)).isDirectory(); } catch { return false; }
  });
  onProgress(`Found ${workspaceDirs.length} workspace dirs`);

  const copilotCliSessionDir = path.join(osDep.homedir(), '.copilot', 'session-state');
  let completed = 0;

  const results = await Promise.all(workspaceDirs.map(async wsHash => {
    try {
      const wsDir = path.join(wsStorageDir, wsHash);
      const dbPath = path.join(wsDir, 'state.vscdb');
      if (!fsDep.existsSync(dbPath)) {
        completed++;
        onProgress(`[${completed}/${workspaceDirs.length}] ${wsHash.slice(0, 8)}… no DB, skipping`);
        return [];
      }

      onProgress(`[${completed + 1}/${workspaceDirs.length}] ${wsHash.slice(0, 8)}… querying DB`);
      const t0 = Date.now();
      const dbValues = await queryDb(dbPath, ['chat.ChatSessionStore.index', 'GitHub.copilot-chat']);
      const index = dbValues['chat.ChatSessionStore.index'];
      completed++;
      if (!index?.entries) {
        onProgress(`[${completed}/${workspaceDirs.length}] ${wsHash.slice(0, 8)}… no chat index (${Date.now() - t0}ms)`);
        return [];
      }

      const workspaceName = resolveWorkspaceName(wsDir, dbValues, wsHash, { readFileSync: fsDep.readFileSync });
      const chatSessionFiles = scanChatSessionFiles(path.join(wsDir, 'chatSessions'), { readdirSync: fsDep.readdirSync, existsSync: fsDep.existsSync });
      const sessions = buildSessionList(index.entries, chatSessionFiles, workspaceName, wsHash, copilotCliSessionDir, { existsSync: fsDep.existsSync });

      onProgress(`[${completed}/${workspaceDirs.length}] ${workspaceName} — ${sessions.length} sessions (${Date.now() - t0}ms)`);
      return sessions;
    } catch (e) {
      completed++;
      onProgress(`[${completed}/${workspaceDirs.length}] ${wsHash.slice(0, 8)}… ERROR: ${e.message}`);
      return [];
    }
  }));

  const all = results.flat();
  all.sort((a, b) => b.date - a.date);
  return all;
}

module.exports = { loadSessionsAsync, resolveWorkspaceName, scanChatSessionFiles, buildSessionList };
