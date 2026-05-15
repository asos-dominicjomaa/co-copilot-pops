// @ts-nocheck
'use strict';

const vscode = require('vscode');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function activate(context) {
  // Activity bar WebviewViewProvider
  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true };
      webviewView.webview.html = getHtml();
      setupMessageHandler(webviewView.webview, context);
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('copilotChatViewerSidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  // Keep legacy command
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-chat-viewer.open', () =>
      vscode.commands.executeCommand('copilotChatViewerSidebar.focus')
    )
  );
}

function setupMessageHandler(webview, context) {
  webview.onDidReceiveMessage(async msg => {
    switch (msg.type) {
      case 'ready': {
        const histories = context.globalState.get('histories', []);
        webview.postMessage({ type: 'histories', data: histories });
        break;
      }
      case 'addHistory': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select vscode-chats-backup folder',
          title: 'Add Chat History Folder'
        });
        if (!picked || picked.length === 0) break;
        const folderPath = picked[0].fsPath;
        const histories = context.globalState.get('histories', []);
        const existing = histories.find(h => h.path === folderPath);
        if (existing) {
          webview.postMessage({ type: 'error', message: 'That folder is already added.' });
          break;
        }
        let result = { sessions: [] };
        let loadError = null;
        try { result = loadSessionsFromPath(folderPath); }
        catch (e) { loadError = String(e); }
        const newHistory = {
          id: uid(),
          name: path.basename(folderPath),
          description: '',
          path: folderPath,
          addedAt: Date.now(),
          sessionCount: result.sessions.length
        };
        histories.unshift(newHistory);
        await context.globalState.update('histories', histories);
        webview.postMessage({ type: 'historyAdded', history: newHistory, sessions: result.sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }
      case 'loadHistory': {
        const histories = context.globalState.get('histories', []);
        const h = histories.find(x => x.id === msg.id);
        if (!h) { webview.postMessage({ type: 'error', message: 'History not found.' }); break; }
        let result = { sessions: [] };
        let loadError = null;
        try { result = loadSessionsFromPath(h.path); }
        catch (e) { loadError = String(e); }
        webview.postMessage({ type: 'historySessions', id: h.id, name: h.name, sessions: result.sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }
      case 'renameHistory': {
        const histories = context.globalState.get('histories', []);
        const h = histories.find(x => x.id === msg.id);
        if (h) {
          h.name = msg.name || h.name;
          h.description = msg.description !== undefined ? msg.description : h.description;
          await context.globalState.update('histories', histories);
          webview.postMessage({ type: 'historyRenamed', id: h.id, name: h.name, description: h.description });
        }
        break;
      }
      case 'removeHistory': {
        let histories = context.globalState.get('histories', []);
        histories = histories.filter(x => x.id !== msg.id);
        await context.globalState.update('histories', histories);
        webview.postMessage({ type: 'historyRemoved', id: msg.id });
        break;
      }
      case 'exportChat': {
        try {
          const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(msg.data, null, 2),
            language: 'json'
          });
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          webview.postMessage({ type: 'error', message: 'Export failed: ' + String(e) });
        }
        break;
      }
      case 'backupWorkspace': {
        const histories = context.globalState.get('histories', []);
        if (histories.length === 0) {
          webview.postMessage({ type: 'error', message: 'No history folders added yet. Click + to add one first.' });
          break;
        }

        // Determine which history to back up into
        let h;
        if (msg.historyId) {
          h = histories.find(x => x.id === msg.historyId);
        }
        if (!h) {
          if (histories.length === 1) {
            h = histories[0];
          } else {
            // Quick-pick from available histories
            const items = histories.map(x => ({ label: x.name, description: x.description || x.path, id: x.id }));
            const picked = await vscode.window.showQuickPick(items, {
              title: 'Select history folder to backup into',
              placeHolder: 'Choose a history…'
            });
            if (!picked) break;
            h = histories.find(x => x.id === picked.id);
          }
        }
        if (!h) { webview.postMessage({ type: 'error', message: 'History not found.' }); break; }

        // Determine current workspace storage hash
        const storageUri = context.storageUri;
        if (!storageUri) {
          webview.postMessage({ type: 'error', message: 'No workspace open — open a folder/workspace first.' });
          break;
        }
        const wsDir = path.dirname(storageUri.fsPath);
        const wsHash = path.basename(wsDir);

        const confirm = await vscode.window.showInformationMessage(
          `Backup current workspace sessions into "${h.name}"?`,
          { modal: true }, 'Yes'
        );
        if (confirm !== 'Yes') break;

        webview.postMessage({ type: 'backupStart', wsHash });

        try {
          const destDir = path.join(h.path, 'workspaceStorage', wsHash);
          fs.mkdirSync(destDir, { recursive: true });

          const filesToCopy = ['workspace.json', 'state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm'];
          for (const f of filesToCopy) {
            const src = path.join(wsDir, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
          }
          const chatSrc = path.join(wsDir, 'chatSessions');
          if (fs.existsSync(chatSrc)) {
            copyDirRecursive(chatSrc, path.join(destDir, 'chatSessions'));
          }

          let result = { sessions: [] };
          let loadError = null;
          try { result = loadSessionsFromPath(h.path); }
          catch (e) { loadError = String(e); }

          h.sessionCount = result.sessions.length;
          await context.globalState.update('histories', histories);

          webview.postMessage({ type: 'backupComplete', historyId: h.id, wsHash, sessions: result.sessions, error: loadError });
        } catch (e) {
          webview.postMessage({ type: 'backupError', message: String(e) });
        }
        break;
      }
      case 'loadSessionTurns': {
        let turns = [];
        let turnsError = null;
        try {
          if (msg.sessionFile) {
            turns = loadChatSessionFile(msg.sessionFile) || [];
          }
        } catch (e) { turnsError = String(e); }
        webview.postMessage({ type: 'sessionTurns', sessionId: msg.sessionId, turns, error: turnsError });
        break;
      }
      case 'refreshHistory': {
        const histories = context.globalState.get('histories', []);
        const h = histories.find(x => x.id === msg.id);
        if (!h) break;
        let result = { sessions: [] };
        let loadError = null;
        try { result = loadSessionsFromPath(h.path); }
        catch (e) { loadError = String(e); }
        h.sessionCount = result.sessions.length;
        await context.globalState.update('histories', histories);
        webview.postMessage({ type: 'historySessions', id: h.id, name: h.name, sessions: result.sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }

    }
  });
}

function getCurrentWsHash(context) {
  try {
    if (!context.storageUri) return null;
    return path.basename(path.dirname(context.storageUri.fsPath));
  } catch { return null; }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

let _sqlite3Bin = null;
function getSqlite3() {
  if (_sqlite3Bin) return _sqlite3Bin;
  for (const b of ['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', 'sqlite3']) {
    try { execFileSync(b, ['--version']); _sqlite3Bin = b; return b; } catch { /* try next */ }
  }
  throw new Error('sqlite3 not found. Install via: brew install sqlite3');
}

// Query one or multiple keys in a single sqlite3 invocation.
// Returns parsed value when given a string key, or a {key: value} map when given an array.
function queryDbValue(dbPath, keyOrKeys) {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  try {
    const list = keys.map(k => `'${k.replace(/'/g, "''")}'`).join(',');
    const out = execFileSync(getSqlite3(), [dbPath, `SELECT key, value FROM ItemTable WHERE key IN (${list});`], {
      maxBuffer: 50 * 1024 * 1024, timeout: 8000
    });
    const lines = out.toString().trim().split('\n').filter(Boolean);
    const result = {};
    for (const line of lines) {
      // sqlite3 default separator is `|`; key never contains | so split on first |
      const sep = line.indexOf('|');
      if (sep === -1) continue;
      const k = line.slice(0, sep);
      try { result[k] = JSON.parse(line.slice(sep + 1)); } catch { result[k] = null; }
    }
    if (!Array.isArray(keyOrKeys)) return result[keyOrKeys] ?? null;
    return result;
  } catch {
    return Array.isArray(keyOrKeys) ? {} : null;
  }
}

function applyJsonlPatch(obj, keys, val) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur = Array.isArray(cur) ? cur[parseInt(k)] : cur[k];
    if (cur == null) return;
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur)) {
    const idx = parseInt(last);
    while (cur.length <= idx) cur.push(null);
    if (Array.isArray(cur[idx]) && Array.isArray(val)) cur[idx] = cur[idx].concat(val);
    else cur[idx] = val;
  } else if (cur && typeof cur === 'object') {
    if (Array.isArray(cur[last]) && Array.isArray(val)) cur[last] = cur[last].concat(val);
    else cur[last] = val;
  }
}

function parseJsonlSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let session = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.kind === 0) session = obj.v;
      else if (obj.kind === 2 && session && obj.k) applyJsonlPatch(session, obj.k, obj.v);
    } catch { /* skip malformed lines */ }
  }
  return session;
}

function extractResponseText(responseParts) {
  return responseParts
    .filter(p => p.kind === '' || p.kind === undefined || p.kind === null || p.kind === 'markdownContent')
    .map(p => {
      if (p.kind === 'markdownContent') return p.content?.value || '';
      return p.value || '';
    })
    .join('')
    .trim();
}

function loadChatSessionFile(sessionFilePath) {
  try {
    let data;
    if (sessionFilePath.endsWith('.jsonl')) {
      data = parseJsonlSession(sessionFilePath);
    } else {
      data = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
    }
    if (!data) return null;
    const turns = [];
    for (const req of (data.requests || [])) {
      const userText = req.message?.text || '';
      const aiText = extractResponseText(req.response || []);
      const modelId = req.modelId || req.result?.metadata?.modelId || null;
      const modelName = modelId ? modelId.replace('copilot/', '') : null;
      if (userText || aiText) {
        turns.push({ user: userText, ai: aiText, model: modelName, ts: req.timestamp || 0 });
      }
    }
    return turns.length > 0 ? turns : null;
  } catch { return null; }
}

function loadSessionsFromPath(backupDir) {
  const wsStorageDir = path.join(backupDir, 'workspaceStorage');
  if (!fs.existsSync(wsStorageDir)) {
    throw new Error(`workspaceStorage not found in ${backupDir}`);
  }

  const sessions = [];

  const workspaceDirs = fs.readdirSync(wsStorageDir).filter(d =>
    fs.statSync(path.join(wsStorageDir, d)).isDirectory()
  );

  for (const wsHash of workspaceDirs) {
    const wsDir = path.join(wsStorageDir, wsHash);
    const dbPath = path.join(wsDir, 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;

    // Single sqlite3 invocation for both keys
    const dbValues = queryDbValue(dbPath, ['chat.ChatSessionStore.index', 'GitHub.copilot-chat']);
    const index = dbValues['chat.ChatSessionStore.index'];
    if (!index?.entries) continue;

    let workspaceName = wsHash.slice(0, 8);
    try {
      const wsJson = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
      const wsUri = wsJson.workspace || wsJson.folder || '';
      const decoded = decodeURIComponent(wsUri).replace(/\/workspace\.json$/, '');
      if (decoded.includes('/Code/Workspaces/')) {
        const copilotData = dbValues['GitHub.copilot-chat'];
        const folders = copilotData?.workspaceFolderIds?.entries || [];
        if (folders.length > 0) {
          const firstFolder = decodeURIComponent(folders[0].uri || '').replace('file://', '');
          const parts = firstFolder.split('/').filter(Boolean);
          workspaceName = parts.slice(-2).join('/');
        }
      } else {
        const match = decoded.match(/\/([^/]+)\/?$/);
        if (match) workspaceName = match[1].replace(/\.code-workspace$/, '');
      }
    } catch { /* ignore */ }

    // Load per-session chat files from chatSessions/ subfolder
    const chatSessionsDir = path.join(wsDir, 'chatSessions');
    const chatSessionFiles = {};
    if (fs.existsSync(chatSessionsDir)) {
      for (const f of fs.readdirSync(chatSessionsDir)) {
        if (f.endsWith('.jsonl') || f.endsWith('.json')) {
          const sessionId = f.replace(/\.(jsonl|json)$/, '');
          // Prefer .jsonl over .json if both exist
          if (!chatSessionFiles[sessionId] || f.endsWith('.jsonl')) {
            chatSessionFiles[sessionId] = path.join(chatSessionsDir, f);
          }
        }
      }
    }

    for (const [sessionId, meta] of Object.entries(index.entries)) {
      if (meta.isEmpty) continue;

      // Note the session file path for lazy loading — don't load turns here
      const sessionFile = chatSessionFiles[sessionId] || null;
      const turnCount = meta.stats?.requestCount || 0;

      sessions.push({
        id: sessionId,
        title: meta.title || 'Untitled',
        date: meta.lastMessageDate || meta.timing?.created || 0,
        created: meta.timing?.created || 0,
        workspace: workspaceName,
        wsHash,
        location: meta.initialLocation || null,
        hasPendingEdits: meta.hasPendingEdits || false,
        stats: meta.stats || null,
        turnCount,          // for display/sort — from metadata, no file read
        sessionFile,        // path to load full turns on demand
      });
    }
  }

  sessions.sort((a, b) => b.date - a.date);
  return { sessions };
}

function getHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Chat Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui);
    font-size: var(--vscode-font-size, 13px);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    height: 100vh;
    display: flex;
    overflow: hidden;
  }
  /* ── Sidebar ── */
  .sidebar {
    width: 300px;
    min-width: 220px;
    background: var(--vscode-sideBar-background, #252526);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    transition: width 0.18s ease, min-width 0.18s ease, opacity 0.18s ease;
    overflow: hidden;
  }
  .sidebar.collapsed {
    width: 0 !important;
    min-width: 0 !important;
    opacity: 0;
  }
  /* ── Sidebar divider (clickable collapse handle) ── */
  .sidebar-divider {
    width: 5px;
    flex-shrink: 0;
    background: var(--vscode-panel-border, #333);
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, width 0.15s;
    position: relative;
    z-index: 10;
  }
  .sidebar-divider:hover {
    background: var(--vscode-focusBorder, #007fd4);
    width: 6px;
  }
  .divider-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 24px;
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--vscode-icon-foreground, #c5c5c5);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
    line-height: 1;
  }
  .sidebar-divider:hover .divider-arrow { opacity: 1; }
  .sidebar-topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .sidebar-topbar-title {
    flex: 1;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--vscode-sideBarTitle-foreground, #bbb);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-icon-foreground, #c5c5c5);
    padding: 3px 5px;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
  /* ── Detail controls (search + sort) ── */
  .detail-controls {
    display: flex;
    gap: 6px;
    padding: 7px 8px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
    align-items: center;
  }
  .sort-select {
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 11px;
    cursor: pointer;
    outline: none;
    flex-shrink: 0;
  }
  .sort-select:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .search-input {
    flex: 1;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    font-size: 12px;
    outline: none;
    min-width: 0;
  }
  .search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  /* ── Sidebar list ── */
  .sidebar-list {
    overflow-y: auto;
    flex: 1;
  }
  /* ── History cards (home view) ── */
  .history-card {
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    transition: background 0.1s;
    position: relative;
  }
  .history-card:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .history-card:hover .card-actions { opacity: 1; }
  .history-card-name {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 50px;
  }
  .history-card-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 50px;
  }
  .history-card-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #666);
    margin-top: 4px;
  }
  .card-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .card-actions .btn-icon { font-size: 12px; padding: 2px 4px; }
  /* ── Session items (detail view) ── */
  .session-item {
    padding: 9px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    transition: background 0.1s;
  }
  .session-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .session-item.active { background: var(--vscode-list-activeSelectionBackground, #094771); }
  .session-title {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-title mark {
    background: #f0a500cc;
    color: #000; border-radius: 2px;
  }
  .session-meta {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 3px;
    display: flex;
    gap: 6px;
  }
  .session-ws {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 130px;
  }
  .group-header {
    padding: 5px 12px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--vscode-descriptionForeground, #888);
    background: var(--vscode-editor-background, #1e1e1e);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .count-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 10px;
    margin-left: 4px;
  }
  /* ── Content area ── */
  .content-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }
  .chat-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
    z-index: 5;
  }
  .chat-toolbar .search-input { flex: 1; font-size: 12px; padding: 4px 8px; }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 14px;
    text-align: center;
    padding: 20px;
  }
  .chat-header {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  .chat-header h2 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .chat-header .meta { font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
  .message {
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--vscode-input-background, #3c3c3c);
    border-left: 3px solid var(--vscode-focusBorder, #007fd4);
    font-size: 13px;
    line-height: 1.5;
  }
  .message-user {
    border-left-color: var(--vscode-focusBorder, #007fd4);
  }
  .message-ai {
    border-left-color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .msg-role {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #888);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .message mark {
    background: #f0a500cc;
    color: #000; border-radius: 2px;
    outline: 1px solid transparent;
    transition: background 0.1s, outline 0.1s;
  }
  .message mark.find-active {
    background: #ff6b00ee;
    color: #fff;
    outline: 2px solid #ff6b00;
    border-radius: 2px;
  }
  /* ── Find nav in chat toolbar ── */
  .find-counter {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 42px;
    text-align: center;
  }
  .no-messages { color: var(--vscode-descriptionForeground, #888); font-style: italic; font-size: 12px; }
  .error-banner {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-inputValidation-errorForeground, #f48771);
    padding: 10px 14px;
    margin: 10px;
    border-radius: 4px;
    font-size: 12px;
    white-space: pre-wrap;
  }
  /* ── Session metadata badges ── */
  .meta-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .meta-badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .meta-badge-warn { background: var(--vscode-statusBarItem-warningBackground, #7f5700); }
  /* ── Current workspace session highlight ── */
  .session-item.current-ws {
    border-left: 3px solid #3fb950;
  }
  .session-item.current-ws .session-title::after {
    content: ' ●';
    color: #3fb950;
    font-size: 9px;
  }
  .session-item .btn-refresh {
    opacity: 0;
    transition: opacity 0.1s;
    margin-left: auto;
    flex-shrink: 0;
  }
  .session-item:hover .btn-refresh { opacity: 1; }
  /* ── Backup-in-progress item ── */
  .backup-item {
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    border-left: 3px solid var(--vscode-progressBar-background, #0e70c0);
  }
  .backup-item-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-editor-foreground, #d4d4d4);
    margin-bottom: 6px;
  }
  .backup-progress-bar {
    height: 3px;
    background: var(--vscode-panel-border, #333);
    border-radius: 2px;
    overflow: hidden;
  }
  .backup-progress-fill {
    height: 100%;
    background: var(--vscode-progressBar-background, #0e70c0);
    border-radius: 2px;
    animation: backup-pulse 1.4s ease-in-out infinite;
    width: 40%;
  }
  @keyframes backup-pulse {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }
  .backup-item-status {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 5px;
  }
  /* ── Workspace messages section ── */
  .ws-messages-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0 6px 0;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #888);
  }
  .ws-messages-note {
    font-size: 10px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
    margin-left: auto;
    text-align: right;
  }
  .msg-model, .msg-mode {
    display: inline-block;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    margin-bottom: 5px;
    margin-right: 4px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ccc);
  }
  .msg-mode { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, #444); }
  .msg-text { white-space: pre-wrap; word-break: break-word; }
  /* ── Edit inline form ── */
  .edit-form { padding: 10px 12px; background: var(--vscode-input-background, #3c3c3c); border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .edit-form input, .edit-form textarea {
    width: 100%;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    margin-bottom: 6px;
    resize: vertical;
  }
  .edit-form input:focus, .edit-form textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .edit-form-btns { display: flex; gap: 6px; justify-content: flex-end; }
  .btn-small {
    padding: 3px 10px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }
  .btn-primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn-ghost { background: transparent; color: var(--vscode-descriptionForeground, #888); border: 1px solid var(--vscode-input-border, #555); }
  .btn-ghost:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
  .loading { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
</style>
</head>
<body>

<div class="sidebar" id="sidebar">
  <!-- Floating top bar -->
  <div class="sidebar-topbar" id="sidebar-topbar">
    <button class="btn-icon" id="btn-back" title="Back to Sessions" style="display:none">&#8592;</button>
    <span class="sidebar-topbar-title" id="sidebar-title">Sessions</span>
    <button class="btn-icon" id="btn-add" title="Add history folder">&#43;</button>
  </div>

  <!-- Detail: search + sort (hidden on home) -->
  <div class="detail-controls" id="detail-controls" style="display:none">
    <select class="sort-select" id="sort-select">
      <option value="newest">Newest</option>
      <option value="oldest">Oldest</option>
      <option value="longest">Longest</option>
    </select>
    <input class="search-input" type="text" id="search" placeholder="Search…" autocomplete="off" />
  </div>

  <div class="sidebar-list" id="sidebar-list"></div>
</div>

<div class="sidebar-divider" id="sidebar-divider" title="Toggle sidebar">
  <span class="divider-arrow" id="divider-arrow">&#8249;</span>
</div>

<div class="content-pane">
  <!-- Per-chat toolbar: find nav, copy, export -->
  <div class="chat-toolbar" id="chat-toolbar" style="display:none">
    <input class="search-input" type="text" id="chat-search" placeholder="Search in chat…" autocomplete="off" />
    <span class="find-counter" id="find-counter" style="display:none"></span>
    <button class="btn-icon" id="btn-find-prev" title="Previous match (Shift+Enter)" style="display:none">&#8593;</button>
    <button class="btn-icon" id="btn-find-next" title="Next match (Enter)" style="display:none">&#8595;</button>
    <button class="btn-icon" id="btn-copy" title="Copy chat to clipboard">&#128203;</button>
    <button class="btn-icon" id="btn-export" title="Export chat as JSON">&#123;&#125;</button>
  </div>
  <div class="content" id="content">
    <div class="empty">Loading histories…</div>
  </div>
</div>

<script>
const vscodeApi = acquireVsCodeApi();

let view = 'home'; // 'home' | 'detail'
let histories = [];
let currentHistory = null;
let allSessions = [];
let currentSessionId = null;
let searchTerm = '';
let chatSearch = '';
let sortOrder = 'newest';
let editingHistoryId = null;
let currentSessionData = null;
let sidebarCollapsed = false;
let chatMatchIndex = 0;
let currentWsHash = null;
let backupInProgress = false;

function post(msg) { vscodeApi.postMessage(msg); }

function fmt(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function hlRaw(str, term) {
  if (!term) return esc(str);
  const s = String(str), t = term.toLowerCase();
  let result = '', i = 0;
  const lower = s.toLowerCase();
  while (i < s.length) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) { result += esc(s.slice(i)); break; }
    result += esc(s.slice(i, idx)) + '<mark>' + esc(s.slice(idx, idx + t.length)) + '</mark>';
    i = idx + t.length;
  }
  return result;
}

function getSorted(sessions) {
  const s = [...sessions];
  if (sortOrder === 'newest') s.sort((a, b) => b.date - a.date);
  else if (sortOrder === 'oldest') s.sort((a, b) => a.date - b.date);
  else if (sortOrder === 'longest') s.sort((a, b) => (b.turnCount || 0) - (a.turnCount || 0));
  return s;
}

function getFiltered() {
  const sorted = getSorted(allSessions);
  if (!searchTerm) return sorted;
  const q = searchTerm.toLowerCase();
  return sorted.filter(s => {
    if (s.title.toLowerCase().includes(q)) return true;
    if (s.workspace.toLowerCase().includes(q)) return true;
    // turns search: if turns are loaded in session, search them
    return (s.turns || []).some(t =>
      (t.user || '').toLowerCase().includes(q) ||
      (t.ai || '').toLowerCase().includes(q)
    );
  });
}

// ── Home view ──
function showHome() {
  view = 'home';
  currentHistory = null;
  currentSessionId = null;
  currentSessionData = null;
  allSessions = [];
  searchTerm = '';
  chatSearch = '';
  backupInProgress = false;
  document.getElementById('sidebar-title').textContent = 'Sessions';
  document.getElementById('btn-back').style.display = 'none';
  document.getElementById('btn-add').style.display = '';
  document.getElementById('btn-backup').style.display = histories.length > 0 ? '' : 'none';
  document.getElementById('detail-controls').style.display = 'none';
  document.getElementById('search').value = '';
  document.getElementById('chat-toolbar').style.display = 'none';
  document.getElementById('content').innerHTML = '<div class="empty">Select a history to view sessions</div>';
  renderHome();
}

function renderHome() {
  const list = document.getElementById('sidebar-list');
  document.getElementById('btn-backup').style.display = histories.length > 0 ? '' : 'none';
  if (histories.length === 0) {
    list.innerHTML = '<div class="empty" style="padding:30px 16px;text-align:center;font-size:12px">No histories yet.<br><br>Click <strong>+</strong> to add a chat backup folder.</div>';
    return;
  }
  let html = '';
  for (const h of histories) {
    if (editingHistoryId === h.id) {
      html += \`<div class="edit-form" id="edit-\${esc(h.id)}">
        <input id="edit-name-\${esc(h.id)}" value="\${esc(h.name)}" placeholder="Name" />
        <textarea id="edit-desc-\${esc(h.id)}" rows="2" placeholder="Description (optional)">\${esc(h.description || '')}</textarea>
        <div class="edit-form-btns">
          <button class="btn-small btn-ghost" onclick="cancelEdit()">Cancel</button>
          <button class="btn-small btn-primary" onclick="saveEdit('\${esc(h.id)}')">Save</button>
        </div>
      </div>\`;
    } else {
      html += \`<div class="history-card" data-hid="\${esc(h.id)}">
        <div class="history-card-name">\${esc(h.name)}</div>
        \${h.description ? \`<div class="history-card-desc">\${esc(h.description)}</div>\` : ''}
        <div class="history-card-meta">\${h.sessionCount || 0} sessions &nbsp;·&nbsp; Added \${fmt(h.addedAt)}</div>
        <div class="card-actions">
          <button class="btn-icon" title="Rename / edit" onclick="startEdit(event, '\${esc(h.id)}')">&#9998;</button>
          <button class="btn-icon" title="Remove" onclick="removeHistory(event, '\${esc(h.id)}')">&#10005;</button>
        </div>
      </div>\`;
    }
  }
  list.innerHTML = html;
}

function startEdit(e, id) {
  e.stopPropagation();
  editingHistoryId = id;
  renderHome();
  const nameEl = document.getElementById('edit-name-' + id);
  if (nameEl) { nameEl.focus(); nameEl.select(); }
}
function cancelEdit() { editingHistoryId = null; renderHome(); }
function saveEdit(id) {
  const name = (document.getElementById('edit-name-' + id)?.value || '').trim();
  const description = (document.getElementById('edit-desc-' + id)?.value || '').trim();
  if (!name) return;
  editingHistoryId = null;
  post({ type: 'renameHistory', id, name, description });
}
function removeHistory(e, id) {
  e.stopPropagation();
  post({ type: 'removeHistory', id });
}

// ── Detail view ──
function showDetail(history, sessions, error, wsHash) {
  view = 'detail';
  currentHistory = history;
  allSessions = sessions || [];
  currentSessionId = null;
  searchTerm = '';
  if (wsHash !== undefined) currentWsHash = wsHash;
  document.getElementById('sidebar-title').textContent = history.name;
  document.getElementById('btn-back').style.display = '';
  document.getElementById('btn-add').style.display = 'none';
  document.getElementById('btn-backup').style.display = 'none';
  document.getElementById('detail-controls').style.display = 'flex';
  document.getElementById('search').value = '';
  document.getElementById('sort-select').value = sortOrder;

  if (error) {
    document.getElementById('sidebar-list').innerHTML = \`<div class="error-banner">\${esc(error)}</div>\`;
    document.getElementById('content').innerHTML = '<div class="empty">Error loading sessions</div>';
    return;
  }

  renderDetail();
  if (allSessions.length > 0) selectSession(allSessions[0].id);
  else document.getElementById('content').innerHTML = '<div class="empty">No sessions found in this history</div>';
}

function renderDetail() {
  const filtered = getFiltered();
  const list = document.getElementById('sidebar-list');

  document.getElementById('sidebar-title').textContent =
    currentHistory.name + (searchTerm ? \` (\${filtered.length})\` : \` · \${allSessions.length}\`);

  if (filtered.length === 0 && !backupInProgress) {
    list.innerHTML = '<div class="empty" style="padding:20px;font-size:12px">No sessions match</div>';
    return;
  }

  // Group by workspace
  const groups = {};
  for (const s of filtered) {
    if (!groups[s.workspace]) groups[s.workspace] = [];
    groups[s.workspace].push(s);
  }

  let html = '';

  // Show backup-in-progress item at the top
  if (backupInProgress) {
    html += \`<div class="backup-item">
      <div class="backup-item-title">&#8635; Backing up current workspace…</div>
      <div class="backup-progress-bar"><div class="backup-progress-fill"></div></div>
      <div class="backup-item-status">Copying session files</div>
    </div>\`;
  }

  for (const [ws, sessions] of Object.entries(groups)) {
    html += \`<div class="group-header">\${esc(ws)}<span class="count-badge">\${sessions.length}</span></div>\`;
    for (const s of sessions) {
      const active = s.id === currentSessionId ? ' active' : '';
      const isCurrent = currentWsHash && s.wsHash === currentWsHash ? ' current-ws' : '';
      const turnCount = s.turnCount || 0;
      const refreshBtn = isCurrent
        ? \`<button class="btn-icon btn-refresh" title="Refresh session" onclick="refreshSession(event, '\${esc(s.id)}')">&#8635;</button>\`
        : '';
      html += \`<div class="session-item\${active}\${isCurrent}" data-id="\${esc(s.id)}" style="display:flex;flex-direction:column">
        <div style="display:flex;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div class="session-title">\${hlRaw(s.title, searchTerm)}</div>
            <div class="session-meta">
              <span>\${fmt(s.date)}</span>
              \${turnCount ? \`<span>· \${turnCount} turn\${turnCount !== 1 ? 's' : ''}</span>\` : ''}
              \${s.location ? '<span class="session-ws">' + esc(s.location) + '</span>' : ''}
            </div>
          </div>
          \${refreshBtn}
        </div>
      </div>\`;
    }
  }
  list.innerHTML = html;
}

function refreshSession(e, sessionId) {
  e.stopPropagation();
  if (!currentHistory) return;
  document.getElementById('sidebar-list').innerHTML = '<div class="loading">Refreshing…</div>';
  post({ type: 'refreshHistory', id: currentHistory.id });
}

function selectSession(id) {
  currentSessionId = id;
  chatSearch = '';
  chatMatchIndex = 0;
  document.getElementById('chat-search').value = '';
  document.getElementById('find-counter').style.display = 'none';
  document.getElementById('btn-find-prev').style.display = 'none';
  document.getElementById('btn-find-next').style.display = 'none';
  const session = allSessions.find(s => s.id === id);
  currentSessionData = session || null;
  renderDetail();
  document.getElementById('chat-toolbar').style.display = session ? 'flex' : 'none';

  if (!session) { renderContent(null); return; }

  // If turns already loaded (cached), render immediately
  if (session.turns) { renderContent(session); return; }

  // Otherwise show loading and request turns from extension host
  document.getElementById('content').innerHTML = '<div class="loading">Loading conversation…</div>';
  post({ type: 'loadSessionTurns', sessionId: session.id, sessionFile: session.sessionFile });
}

function fmtDur(ms) {
  if (!ms) return null;
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function renderContent(session) {
  const content = document.getElementById('content');
  if (!session) {
    content.innerHTML = '<div class="empty">Select a session to view messages</div>';
    return;
  }

  const badges = [];
  if (session.location) badges.push(\`<span class="meta-badge">\${esc(session.location)}</span>\`);
  if (session.hasPendingEdits) badges.push('<span class="meta-badge meta-badge-warn">pending edits</span>');
  if (session.stats) {
    const s = session.stats;
    if (s.added || s.removed) badges.push(\`<span class="meta-badge">+\${s.added||0}/-\${s.removed||0} lines</span>\`);
    if (s.fileCount) badges.push(\`<span class="meta-badge">\${s.fileCount} file\${s.fileCount!==1?'s':''}</span>\`);
  }

  const turns = session.turns || [];
  const hasTurns = session.turns !== undefined; // undefined = not yet loaded
  const q = chatSearch.toLowerCase() || searchTerm.toLowerCase();

  const filteredTurns = q
    ? turns.filter(t =>
        (t.user||'').toLowerCase().includes(q) ||
        (t.ai||'').toLowerCase().includes(q)
      )
    : turns;

  let turnsHtml = '';
  if (!hasTurns) {
    turnsHtml = '<p class="no-messages">Loading conversation…</p>';
  } else if (turns.length === 0) {
    turnsHtml = '<p class="no-messages">No chat messages found for this session. VS Code only saves sessions from your most recent backup — older sessions may have been purged.</p>';
  } else if (filteredTurns.length === 0) {
    turnsHtml = '<p class="no-messages">No messages match the search.</p>';
  } else {
    for (const t of filteredTurns) {
      const hl = chatSearch || searchTerm;
      const modelTag = t.model ? \`<span class="msg-model">\${esc(t.model)}</span>\` : '';
      if (t.user) {
        turnsHtml += \`<div class="message message-user">
          <div class="msg-role">You \${modelTag}</div>
          <div class="msg-text">\${hlRaw(t.user, hl)}</div>
        </div>\`;
      }
      if (t.ai) {
        turnsHtml += \`<div class="message message-ai">
          <div class="msg-role">Copilot</div>
          <div class="msg-text">\${hlRaw(t.ai, hl)}</div>
        </div>\`;
      }
    }
  }

  const turnLabel = turns.length > 0
    ? \`<span class="count-badge">\${filteredTurns.length}\${(chatSearch||searchTerm) && filteredTurns.length !== turns.length ? ' / ' + turns.length : ''} turns</span>\`
    : '';

  content.innerHTML = \`
    <div class="chat-header">
      <h2>\${esc(session.title)}</h2>
      <div class="meta-row">\${badges.join('')}</div>
      <div class="meta" style="margin-top:6px">
        <strong>Workspace:</strong> \${esc(session.workspace)}
        &nbsp;·&nbsp; <strong>Created:</strong> \${fmt(session.created)}
        &nbsp;·&nbsp; <strong>Last active:</strong> \${fmt(session.date)}
      </div>
    </div>
    <div class="ws-messages-header">
      <span>Conversation</span>
      \${turnLabel}
    </div>
    \${turnsHtml}
  \`;
}

// ── Sidebar toggle ──
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const arrow = document.getElementById('divider-arrow');
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  arrow.innerHTML = sidebarCollapsed ? '&#8250;' : '&#8249;';
}
document.getElementById('sidebar-divider').addEventListener('click', toggleSidebar);

// ── Find navigation ──
function updateFindNav() {
  const marks = Array.from(document.querySelectorAll('#content .message mark'));
  const total = marks.length;
  const counter = document.getElementById('find-counter');
  const prevBtn = document.getElementById('btn-find-prev');
  const nextBtn = document.getElementById('btn-find-next');

  if (total === 0 || !chatSearch) {
    counter.style.display = 'none';
    prevBtn.style.display = 'none';
    nextBtn.style.display = 'none';
    return;
  }

  if (chatMatchIndex >= total) chatMatchIndex = 0;
  if (chatMatchIndex < 0) chatMatchIndex = total - 1;

  marks.forEach((m, i) => m.classList.toggle('find-active', i === chatMatchIndex));
  marks[chatMatchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });

  counter.textContent = \`\${chatMatchIndex + 1} / \${total}\`;
  counter.style.display = '';
  prevBtn.style.display = '';
  nextBtn.style.display = '';
}

function goToMatch(dir) {
  const total = document.querySelectorAll('#content .message mark').length;
  if (total === 0) return;
  chatMatchIndex = ((chatMatchIndex + dir) % total + total) % total;
  updateFindNav();
}

// ── Chat toolbar event listeners ──
document.getElementById('chat-search').addEventListener('input', e => {
  chatSearch = e.target.value.trim();
  chatMatchIndex = 0;
  if (currentSessionData) { renderContent(currentSessionData); updateFindNav(); }
});

document.getElementById('chat-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { document.getElementById('chat-search').value = ''; chatSearch = ''; chatMatchIndex = 0; if (currentSessionData) { renderContent(currentSessionData); updateFindNav(); } }
});

document.getElementById('btn-find-prev').addEventListener('click', () => goToMatch(-1));
document.getElementById('btn-find-next').addEventListener('click', () => goToMatch(1));

document.getElementById('btn-copy').addEventListener('click', () => {
  if (!currentSessionData) return;
  const s = currentSessionData;
  let text = s.title + '\\n' + '='.repeat(s.title.length) + '\\n';
  text += \`Workspace: \${s.workspace} | Created: \${fmt(s.created)}\\n\\n\`;
  for (const t of (s.turns || [])) {
    if (t.user) text += \`You:\\n\${t.user}\\n\\n\`;
    if (t.ai)   text += \`Copilot:\\n\${t.ai}\\n\\n\`;
  }
  navigator.clipboard.writeText(text).catch(() => {});
});

document.getElementById('btn-export').addEventListener('click', () => {
  if (!currentSessionData) return;
  post({ type: 'exportChat', data: currentSessionData });
});

// ── Event listeners ──
document.getElementById('btn-back').addEventListener('click', showHome);
document.getElementById('btn-add').addEventListener('click', () => post({ type: 'addHistory' }));
document.getElementById('btn-backup').addEventListener('click', () => {
  // Works from home view: pass all history options so host can quick-pick
  const historyId = currentHistory ? currentHistory.id : null;
  post({ type: 'backupWorkspace', historyId, allHistories: histories.map(h => ({ id: h.id, name: h.name })) });
});

document.getElementById('sort-select').addEventListener('change', e => {
  sortOrder = e.target.value;
  renderDetail();
});

document.getElementById('search').addEventListener('input', e => {
  searchTerm = e.target.value.trim();
  renderDetail();
  if (currentSessionId) {
    const session = allSessions.find(s => s.id === currentSessionId);
    if (session) renderContent(session);
  }
});

document.getElementById('sidebar-list').addEventListener('click', e => {
  if (view === 'home') {
    const card = e.target.closest('.history-card');
    if (card && !e.target.closest('.card-actions')) {
      const hid = card.dataset.hid;
      document.getElementById('sidebar-list').innerHTML = '<div class="loading">Loading sessions…</div>';
      post({ type: 'loadHistory', id: hid });
    }
  } else {
    if (e.target.closest('.btn-refresh')) return; // handled by refreshSession()
    const item = e.target.closest('.session-item');
    if (item) selectSession(item.dataset.id);
  }
});

// ── Message handler (from extension) ──
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'histories':
      histories = msg.data || [];
      showHome();
      break;
    case 'historyAdded':
      histories.unshift(msg.history);
      showDetail(msg.history, msg.sessions, msg.error, msg.currentWsHash);
      break;
    case 'historySessions': {
      // Ensure the history is in our local cache; add it if missing (e.g. after context reset)
      let h = histories.find(x => x.id === msg.id);
      if (!h && msg.id && msg.name) {
        h = { id: msg.id, name: msg.name, description: '', path: '', addedAt: 0, sessionCount: (msg.sessions || []).length };
        histories.push(h);
      }
      if (h) showDetail(h, msg.sessions, msg.error, msg.currentWsHash);
      break;
    }
    case 'historyRenamed': {
      const h = histories.find(x => x.id === msg.id);
      if (h) { h.name = msg.name; h.description = msg.description; }
      editingHistoryId = null;
      if (view === 'home') renderHome();
      else if (currentHistory?.id === msg.id) {
        currentHistory.name = msg.name;
        document.getElementById('sidebar-title').textContent = msg.name + ' · ' + allSessions.length;
      }
      break;
    }
    case 'historyRemoved':
      histories = histories.filter(x => x.id !== msg.id);
      if (view === 'detail' && currentHistory?.id === msg.id) showHome();
      else renderHome();
      break;
    case 'sessionTurns': {
      // Cache turns on the session object and render if still the current session
      const s = allSessions.find(x => x.id === msg.sessionId);
      if (s) {
        s.turns = msg.turns || [];
        s.turnCount = s.turns.length;  // update with real count
      }
      if (msg.sessionId === currentSessionId) {
        currentSessionData = s || null;
        renderContent(s || null);
        updateFindNav();
        renderDetail(); // refresh turn count in sidebar
      }
      break;
    }
    case 'backupStart':
      backupInProgress = true;
      if (view === 'detail') renderDetail();
      break;
    case 'backupComplete': {
      backupInProgress = false;
      if (msg.currentWsHash !== undefined) currentWsHash = msg.currentWsHash;
      // Update cached session count on the history card
      const bh = histories.find(x => x.id === msg.historyId);
      if (bh && msg.sessions) bh.sessionCount = msg.sessions.length;
      if (view === 'home') {
        renderHome();
      } else if (view === 'detail') {
        allSessions = msg.sessions || allSessions;
        renderDetail();
        if (!currentSessionId && allSessions.length > 0) selectSession(allSessions[0].id);
      }
      break;
    }
    case 'backupError':
      backupInProgress = false;
      if (view === 'detail') renderDetail();
      document.getElementById('content').innerHTML = \`<div class="error-banner">Backup failed: \${esc(msg.message)}</div>\`;
      break;
    case 'error':
      document.getElementById('content').innerHTML = \`<div class="error-banner">\${esc(msg.message)}</div>\`;
      break;
  }
});

// ── Init ──
post({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate: () => { } };
