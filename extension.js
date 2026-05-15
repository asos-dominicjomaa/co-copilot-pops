// @ts-nocheck
'use strict';

const vscode = require('vscode');
const { setupMessageHandler } = require('./src/messageHandler');
const { getHistories } = require('./src/historyStore');
const { getHtml } = require('./src/webview/getHtml');

function activate(context) {
  const log = vscode.window.createOutputChannel('Copilot Chat Viewer');
  context.subscriptions.push(log);

  const provider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = getHtml();
      setupMessageHandler(webviewView.webview, context, log);

      const pushHistories = () => {
        if (webviewView.visible) {
          const histories = getHistories(context.globalState);
          webviewView.webview.postMessage({ type: 'histories', data: histories });
        }
      };
      webviewView.onDidChangeVisibility(pushHistories);
      setTimeout(pushHistories, 100);
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
