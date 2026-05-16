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
  const log = vscode.window.createOutputChannel('Copilot Chat Viewer');
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
}

module.exports = { activate, deactivate: () => { } };
