'use strict';
const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.join(__dirname, 'app.js');

/**
 * Build the full webview HTML with inlined app.js script.
 * @returns {string}
 */
function getHtml() {
  const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');
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
    width: 6px;
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
    width: 10px;
  }
  .divider-arrow {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 28px;
    height: 44px;
    background: var(--vscode-sideBar-background, #252526);
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: var(--vscode-focusBorder, #007fd4);
    opacity: 0;
    transition: opacity 0.15s, transform 0.15s;
    pointer-events: none;
    line-height: 1;
  }
  .sidebar-divider:hover .divider-arrow {
    opacity: 1;
    transform: translate(10px, -50%);
  }
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
  .sessions-loading-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .sessions-loading-spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--vscode-foreground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sessions-progress-log {
    padding: 2px 14px 12px;
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    line-height: 1.8;
    max-height: 280px;
    overflow-y: auto;
  }
  .pl-found { color: var(--vscode-testing-iconPassed, #4caf50); }
  .pl-empty  { color: var(--vscode-descriptionForeground, #888); }
  .pl-error  { color: var(--vscode-testing-iconFailed, #f44336); }
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
  .empty-state { padding: 30px 16px; text-align: center; }
  .empty-state-title { font-size: 13px; font-weight: 600; color: var(--vscode-foreground, #ccc); margin-bottom: 10px; }
  .empty-state-desc { font-size: 12px; color: var(--vscode-descriptionForeground, #888); line-height: 1.6; }
</style>
</head>
<body>

<div class="sidebar" id="sidebar">
  <!-- Floating top bar -->
  <div class="sidebar-topbar" id="sidebar-topbar">
    <button class="btn-icon" id="btn-back" title="Back to Sessions" style="display:none">&#8592;</button>
    <span class="sidebar-topbar-title" id="sidebar-title">Sessions</span>
    <button class="btn-icon" id="btn-add" title="Import history folder" style="color:var(--vscode-testing-iconPassed,#4caf50)">&#128194;</button>
    <button class="btn-icon" id="btn-export-bundle" title="Export all histories as bundle">&#128228;</button>
    <button class="btn-icon" id="btn-backup" title="Save workspace session">&#128190;</button>
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
` + appJs + `
</script>
</body>
</html>`;
}

module.exports = { getHtml };
