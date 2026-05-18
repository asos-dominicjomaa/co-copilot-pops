'use strict';

const path = require('path');
const { loadSessionsAsync } = require('./sessionLoader');
const { loadChatSessionFile, loadCopilotCliEvents } = require('./chatParser');
const { getHistories, addHistory, updateHistory, removeHistory } = require('./historyStore');
const { resolveBackupLabel, buildBackupName, copyWorkspaceFiles, syncWorkspaceFiles } = require('./workspaceBackup');
const { exportBundle, readBundleManifest, importBundle } = require('./bundleExporter');

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
  let syncFired = false; // guard: only auto-sync once per session

  function getArchivedByHistory() {
    return context.globalState.get('archivedSessionsByHistory', {});
  }

  async function setArchivedByHistory(value) {
    await context.globalState.update('archivedSessionsByHistory', value);
  }

  function applyArchivedState(historyId, sessions) {
    const archivedByHistory = getArchivedByHistory();
    const archivedSessions = archivedByHistory[historyId] || {};
    return (sessions || []).map(s => ({ ...s, archived: !!archivedSessions[s.id] }));
  }

  webview.onDidReceiveMessage(async msg => {
    switch (msg.type) {
      case 'ready': {
        const fs = require('fs');
        const histories = getHistories(context.globalState);
        const currentWsHash = getCurrentWsHash(context);

        log.appendLine(`[auto-sync] ready. currentWsHash=${currentWsHash || '(none)'}, storageUri=${context.storageUri?.fsPath || '(none)'}`);

        // Find the history matching the current workspace for auto-sync.
        // Primary: matched by stored wsHash. Fallback: scan backup for workspaceStorage/<hash>/.
        let syncingId = null;
        let matchedHistory = null;
        if (currentWsHash && context.storageUri) {
          matchedHistory = histories.find(h => h.wsHash === currentWsHash);
          if (matchedHistory) {
            log.appendLine(`[auto-sync] matched by wsHash: "${matchedHistory.name}"`);
          } else {
            // Fallback: check if any history backup folder contains workspaceStorage/<currentWsHash>/
            for (const h of histories) {
              if (!h.path) continue;
              const candidate = path.join(h.path, 'workspaceStorage', currentWsHash);
              if (fs.existsSync(candidate)) {
                matchedHistory = h;
                log.appendLine(`[auto-sync] matched by folder scan: "${h.name}" — storing wsHash`);
                // Persist wsHash so future matches are fast
                updateHistory(context.globalState, h.id, { wsHash: currentWsHash });
                break;
              }
            }
          }
          if (matchedHistory) syncingId = matchedHistory.id;
          else log.appendLine('[auto-sync] no matching history found — skipping sync');
        }

        webview.postMessage({ type: 'histories', data: histories, currentWsHash, syncingId });

        // Kick off background auto-sync if we have a match (only once per session)
        if (syncingId && matchedHistory && context.storageUri && !syncFired) {
          syncFired = true;
          const wsDir = path.dirname(context.storageUri.fsPath);
          const destDir = path.join(matchedHistory.path, 'workspaceStorage', currentWsHash);
          log.appendLine(`[auto-sync] syncing: ${wsDir} → ${destDir}`);
          setImmediate(async () => {
            try {
              if (!fs.existsSync(matchedHistory.path)) {
                log.appendLine('[auto-sync] backup path gone — aborting');
                webview.postMessage({ type: 'syncComplete', id: syncingId, error: 'Backup path not found' });
                return;
              }
              const { updated, added } = syncWorkspaceFiles(wsDir, destDir);
              log.appendLine(`[auto-sync] done: ${added} added, ${updated} updated`);
              let sessions = [], loadError = null;
              try { sessions = await loadSessionsAsync(matchedHistory.path); }
              catch (e) { loadError = String(e); log.appendLine(`[auto-sync] loadSessions error: ${e.message}`); }
              await updateHistory(context.globalState, syncingId, { sessionCount: sessions.length });
              webview.postMessage({ type: 'syncComplete', id: syncingId, sessionCount: sessions.length, error: loadError });
            } catch (e) {
              log.appendLine(`[auto-sync] error: ${e.message}`);
              webview.postMessage({ type: 'syncComplete', id: syncingId, error: String(e) });
            }
          });
        }
        break;
      }

      case 'addHistory': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Select folder',
          title: 'Add Chat History Folder or Import Bundle'
        });
        if (!picked || picked.length === 0) break;
        const folderPath = picked[0].fsPath;

        // Check if it's a bundle export
        const manifest = readBundleManifest(folderPath);
        if (manifest) {
          const confirm = await vscode.window.showInformationMessage(
            `This looks like a Go-Pilot export bundle (${manifest.histories.length} histories). Import all?`,
            { modal: true }, 'Import All', 'Add as Single History'
          );
          if (confirm === 'Import All') {
            const fs = require('fs');
            const globalStorageDir = context.globalStorageUri.fsPath;
            fs.mkdirSync(globalStorageDir, { recursive: true });
            const existing = getHistories(context.globalState);
            const { histories: imported, imported: count, skipped } = importBundle(manifest, folderPath, globalStorageDir, existing);
            for (const h of imported) await addHistory(context.globalState, h);
            const all = getHistories(context.globalState);
            webview.postMessage({ type: 'histories', data: all });
            vscode.window.showInformationMessage(`Imported ${count} histories${skipped ? `, skipped ${skipped} duplicates` : ''}.`);
            break;
          }
          if (!confirm) break; // cancelled
        }

        // Regular single-folder add
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

      case 'openWorkspace': {
        const h = getHistories(context.globalState).find(x => x.id === msg.id);
        if (!h) { webview.postMessage({ type: 'error', message: 'Workspace not found.' }); break; }

        // Try to resolve the workspace folder from workspace.json inside the backup
        const fs = require('fs');
        let folderUri = null;

        // First try: read workspace.json from the backup
        const wsJsonPath = path.join(h.path, 'workspaceStorage', h.wsHash || '', 'workspace.json');
        if (h.wsHash && fs.existsSync(wsJsonPath)) {
          try {
            const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
            const rawUri = wsJson.workspace || wsJson.folder || '';
            if (rawUri) {
              folderUri = vscode.Uri.parse(decodeURIComponent(rawUri));
            }
          } catch { /* fall through */ }
        }

        // Second try: scan all workspaceStorage/<hash>/workspace.json in the backup
        if (!folderUri) {
          const wsStorageDir = path.join(h.path, 'workspaceStorage');
          if (fs.existsSync(wsStorageDir)) {
            for (const hash of fs.readdirSync(wsStorageDir)) {
              const candidate = path.join(wsStorageDir, hash, 'workspace.json');
              if (fs.existsSync(candidate)) {
                try {
                  const wsJson = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                  const rawUri = wsJson.workspace || wsJson.folder || '';
                  if (rawUri) { folderUri = vscode.Uri.parse(decodeURIComponent(rawUri)); break; }
                } catch { /* continue */ }
              }
            }
          }
        }

        if (!folderUri) {
          vscode.window.showWarningMessage(`Could not determine the workspace folder path for "${h.name}".`);
          break;
        }

        try {
          await vscode.commands.executeCommand('vscode.openFolder', folderUri, true);
        } catch (e) {
          webview.postMessage({ type: 'error', message: 'Failed to open workspace: ' + String(e) });
        }
        break;
      }

      case 'exportBundle': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Export here',
          title: 'Choose export destination folder'
        });
        if (!picked || picked.length === 0) break;
        const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const destDir = require('path').join(picked[0].fsPath, `go-pilot-export ${now}`);
        const histories = getHistories(context.globalState);
        const globalStorageDir = context.globalStorageUri.fsPath;
        try {
          const { exported, skipped } = exportBundle(histories, globalStorageDir, destDir);
          vscode.window.showInformationMessage(
            `Exported ${exported} histories to:\n${destDir}${skipped ? `\n(${skipped} external histories saved as metadata only)` : ''}`
          );
        } catch (e) {
          webview.postMessage({ type: 'error', message: 'Export failed: ' + String(e) });
        }
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
        sessions = applyArchivedState(h.id, sessions);
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

          const newHistory = { id: uid(), name: defaultName, description: '', path: newHistoryPath, wsHash, addedAt: Date.now(), sessionCount: sessions.length };
          await addHistory(context.globalState, newHistory);
          webview.postMessage({ type: 'backupComplete', historyId: newHistory.id, wsHash, sessions, error: loadError, newHistory, currentWsHash: wsHash });
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

      case 'toggleSessionArchived': {
        const { historyId, sessionId, archived } = msg;
        if (!historyId || !sessionId) break;
        const archivedByHistory = getArchivedByHistory();
        const historyArchived = { ...(archivedByHistory[historyId] || {}) };
        if (archived) historyArchived[sessionId] = true;
        else delete historyArchived[sessionId];
        archivedByHistory[historyId] = historyArchived;
        await setArchivedByHistory(archivedByHistory);
        webview.postMessage({ type: 'sessionArchivedToggled', historyId, sessionId, archived: !!archived });
        break;
      }

      case 'refreshHistory': {
        const h = getHistories(context.globalState).find(x => x.id === msg.id);
        if (!h) break;
        let sessions = [], loadError = null;
        try { sessions = await loadSessionsAsync(h.path); }
        catch (e) { loadError = String(e); }
        sessions = applyArchivedState(h.id, sessions);
        await updateHistory(context.globalState, h.id, { sessionCount: sessions.length });
        webview.postMessage({ type: 'historySessions', id: h.id, name: h.name, sessions, error: loadError, currentWsHash: getCurrentWsHash(context) });
        break;
      }
    }
  });
}

module.exports = { setupMessageHandler, getCurrentWsHash };
