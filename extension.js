// @ts-nocheck
'use strict';

const vscode = require('vscode');
const path = require('path');
const { setupMessageHandler } = require('./src/messageHandler');
const { getHistories } = require('./src/historyStore');
const { getHtml } = require('./src/webview/getHtml');

function getCurrentWsHash(context) {
  try {
    if (!context.storageUri) return null;
    return path.basename(path.dirname(context.storageUri.fsPath));
  } catch { return null; }
}

function activate(context) {
  const log = vscode.window.createOutputChannel('Go-Pilot');
  context.subscriptions.push(log);

  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      // Register handler BEFORE setting html to avoid dropping the first 'ready' message
      setupMessageHandler(webviewView.webview, context, log);
      webviewView.webview.html = getHtml();

      // On visibility change, re-push histories WITH currentWsHash so highlights are preserved
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          const histories = getHistories(context.globalState);
          const currentWsHash = getCurrentWsHash(context);
          webviewView.webview.postMessage({ type: 'histories', data: histories, currentWsHash });
        }
      });
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('copilotChatViewerSidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-chat-viewer.open', () =>
      vscode.commands.executeCommand('copilotChatViewerSidebar.focus')
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-chat-viewer.dev.installAndReload', async () => {
      const task = new vscode.Task(
        { type: 'shell' },
        vscode.TaskScope.Workspace,
        'Install Extension (Dev)',
        'co-pilot-pops',
        new vscode.ShellExecution('npm run install-extension')
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };

      const execution = await vscode.tasks.executeTask(task);
      const ended = await new Promise(resolve => {
        const sub = vscode.tasks.onDidEndTaskProcess(e => {
          if (e.execution !== execution) return;
          sub.dispose();
          resolve(e.exitCode ?? 0);
        });
      });

      if (ended === 0) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } else {
        vscode.window.showErrorMessage(`Install task failed with exit code ${ended}.`);
      }
    })
  );
}

module.exports = { activate, deactivate: () => { } };
