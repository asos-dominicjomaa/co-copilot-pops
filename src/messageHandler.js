'use strict';

const path = require('path');
const { loadSessionsAsync } = require('./sessionLoader');
const { loadChatSessionFile, loadCopilotCliEvents } = require('./chatParser');
const { getHistories, addHistory, updateHistory, removeHistory } = require('./historyStore');
const { resolveBackupLabel, buildBackupName, copyWorkspaceFiles } = require('./workspaceBackup');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Get the workspace hash for the current open workspace.
 * @param {object} context — VS Code extension context
 * @returns {string|null}
 */
function getCurrentWsHash(context) {
  try {
    if (!context.storageUri) return null;
    return path.basename(path.dirname(context.storageUri.fsPath));
  } catch { return null; }
}

/**
 * Register the message handler on a webview.
 * @param {object} webview — vscode.Webview
 * @param {object} context — vscode extension context
 * @param {object} log — output channel
 * @param {object} [vscode] — injectable vscode module (for testing)
 */
function setupMessageHandler(webview, context, log, vscode = require('vscode')) {
  webview.onDidReceiveMessage(async msg => {
    switch (msg.type) {
      case 'ready': {
        const histories = getHistories(context.globalState);
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
        const histories = getHistories(context.globalState);
        if (histories.find(h => h.path === folderPath)) {
          webview.postMessage({ type: 'error', message: 'That folder is already added.' });
          break;
        }
        let sessions = [], loadError = null;
        try { sessions = await loadSessionsAsync(folderPath); }
        catch (e) { loadError = String(e); }
        const newHistory = { id: uid(), name: path.basename(folderPath), description: '', path: folderPath, addedAt: Date.now(), sessionCount: sessions.length };
        await addHistory(context.globalState, newHistory);
        webview.postMessage({ type: 'historyAdded', history: newHistory, sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }

      case 'loadHistory': {
        const h = getHistories(context.globalState).find(x => x.id === msg.id);
        if (!h) { webview.postMessage({ type: 'error', message: 'History not found.' }); break; }
        log.appendLine(`[loadHistory] Starting load for: ${h.path}`);
        log.show(true);
        let sessions = [], loadError = null;
        try {
          sessions = await loadSessionsAsync(h.path, (m) => {
            log.appendLine(m);
            webview.postMessage({ type: 'progress', message: m });
          });
        } catch (e) {
          loadError = String(e);
          log.appendLine(`[loadHistory] ERROR: ${loadError}`);
        }
        log.appendLine(`[loadHistory] Done — ${sessions.length} sessions`);
        webview.postMessage({ type: 'historySessions', id: h.id, name: h.name, sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }

      case 'renameHistory': {
        const h = await updateHistory(context.globalState, msg.id, { name: msg.name, description: msg.description });
        if (h) webview.postMessage({ type: 'historyRenamed', id: h.id, name: h.name, description: h.description });
        break;
      }

      case 'removeHistory': {
        await removeHistory(context.globalState, msg.id);
        webview.postMessage({ type: 'historyRemoved', id: msg.id });
        break;
      }

      case 'exportChat': {
        try {
          const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(msg.data, null, 2), language: 'json' });
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
          webview.postMessage({ type: 'error', message: 'Export failed: ' + String(e) });
        }
        break;
      }

      case 'backupWorkspace': {
        const storageUri = context.storageUri;
        if (!storageUri) {
          webview.postMessage({ type: 'error', message: 'No workspace open — open a folder/workspace first.' });
          break;
        }
        const wsDir = path.dirname(storageUri.fsPath);
        const wsHash = path.basename(wsDir);

        // Default destination: extension's own globalStorage folder (no user picker needed)
        const fs = require('fs');
        const destParent = context.globalStorageUri.fsPath;
        fs.mkdirSync(destParent, { recursive: true });

        const wsLabel = resolveBackupLabel(wsDir, wsHash);
        const defaultName = buildBackupName(wsLabel);

        const confirm = await vscode.window.showInformationMessage(
          `Create new history "${defaultName}"?`, { modal: true }, 'Yes'
        );
        if (confirm !== 'Yes') break;

        webview.postMessage({ type: 'backupStart', wsHash });

        try {
          const newHistoryPath = path.join(destParent, defaultName);
          const destDir = path.join(newHistoryPath, 'workspaceStorage', wsHash);
          copyWorkspaceFiles(wsDir, destDir);

          let sessions = [], loadError = null;
          try { sessions = await loadSessionsAsync(newHistoryPath); }
          catch (e) { loadError = String(e); }

          const newHistory = { id: uid(), name: defaultName, description: '', path: newHistoryPath, addedAt: Date.now(), sessionCount: sessions.length };
          await addHistory(context.globalState, newHistory);
          webview.postMessage({ type: 'backupComplete', historyId: newHistory.id, wsHash, sessions, error: loadError, newHistory });
        } catch (e) {
          webview.postMessage({ type: 'backupError', message: String(e) });
        }
        break;
      }

      case 'loadSessionTurns': {
        let turns = [], turnsError = null;
        try {
          if (msg.sessionFile) turns = loadChatSessionFile(msg.sessionFile) || [];
          else if (msg.eventsFile) turns = loadCopilotCliEvents(msg.eventsFile) || [];
        } catch (e) { turnsError = String(e); }
        webview.postMessage({ type: 'sessionTurns', sessionId: msg.sessionId, turns, error: turnsError });
        break;
      }

      case 'refreshHistory': {
        const h = getHistories(context.globalState).find(x => x.id === msg.id);
        if (!h) break;
        let sessions = [], loadError = null;
        try { sessions = await loadSessionsAsync(h.path); }
        catch (e) { loadError = String(e); }
        await updateHistory(context.globalState, h.id, { sessionCount: sessions.length });
        webview.postMessage({ type: 'historySessions', id: h.id, name: h.name, sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }
    }
  });
}

module.exports = { setupMessageHandler, getCurrentWsHash };
