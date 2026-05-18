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
<title>Go-Pilot</title>
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
    background: var(--vscode-button-background, #0e639c);
    width: 12px;
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
    width: 34px;
    height: 50px;
    border-width: 2px;
    color: #2da8ff;
    border-color: #2da8ff;
    box-shadow: 0 0 0 1px rgba(45, 168, 255, 0.35);
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
  .btn-icon svg {
    display: block;
    flex-shrink: 0;
  }
  .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
  .home-controls {
    padding: 0 10px 8px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .home-controls-spacer {
    height: 1px;
    background: var(--vscode-panel-border, #333);
    margin-bottom: 8px;
  }
  .controls-sections {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .control-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .control-section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--vscode-descriptionForeground, #9a9a9a);
  }
  .control-section-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .btn-control {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    line-height: 1.2;
  }
  .btn-control:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }
  .btn-control:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-disabledForeground, #808080);
  }
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
  .detail-filter-btn {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    width: 28px;
    height: 26px;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 1px;
  }
  .detail-filter-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }
  .detail-filter-btn.active {
    color: var(--vscode-focusBorder, #007acc);
    border-color: var(--vscode-focusBorder, #007acc);
  }
  .detail-filter-btn svg {
    display: block;
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
  .history-card.current-ws { border-left: 3px solid #3fb950; }
  .history-card.last-viewed { border-left: 3px solid var(--vscode-focusBorder, #007acc); }
  .history-card-name {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 74px;
  }
  .history-card-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 74px;
  }
  .history-card-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #666);
    margin-top: 4px;
  }
  .history-card-label {
    margin-top: 6px;
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
  .session-item.active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    border-left: 3px solid var(--vscode-focusBorder, #007acc);
  }
  .session-item.archived {
    box-shadow: inset 2px 0 0 rgba(255, 120, 120, 0.4);
  }
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
  .current-ws-label {
    font-size: 9px;
    font-weight: 600;
    color: #3fb950;
    background: rgba(63, 185, 80, 0.15);
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: none;
    letter-spacing: 0;
  }
  .sync-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    font-weight: 600;
    color: var(--vscode-focusBorder, #007acc);
    background: rgba(0, 122, 204, 0.12);
    padding: 2px 6px;
    border-radius: 3px;
    margin-left: 4px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin-icon { animation: spin 1s linear infinite; display: inline-block; }
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
    border-right: 2px solid var(--vscode-focusBorder, #2da8ff);
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
    background: var(--vscode-editorWidget-background, rgba(151, 151, 151, 0.05));
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
  /* ── Current workspace session highlight (kept for refresh button logic) ── */
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
    <button class="btn-icon" id="btn-back" title="Back to Workspaces" style="display:none">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7 3.093l-5 5V8.8l5 5 .707-.707-4.146-4.147H14v-1H3.56L7.708 3.8 7 3.093z"/></svg>
    </button>
    <span class="sidebar-topbar-title" id="sidebar-title">Workspaces</span>
  </div>
  <div class="home-controls" id="home-controls">
    <div class="home-controls-spacer"></div>
    <div class="controls-sections">
      <div class="control-section">
        <div class="control-section-title">Import</div>
        <div class="control-section-actions">
          <button class="btn-control" id="btn-backup">Save Current Workspace</button>
          <button class="btn-control" id="btn-add">Import Workspaces</button>
        </div>
      </div>
      <div class="control-section">
        <div class="control-section-title">Export</div>
        <div class="control-section-actions">
          <button class="btn-control" id="btn-export-bundle">Export All Workspaces</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Detail: search + sort (hidden on home) -->
  <div class="detail-controls" id="detail-controls" style="display:none">
    <select class="sort-select" id="sort-select">
      <option value="newest">Newest</option>
      <option value="oldest">Oldest</option>
      <option value="longest">Longest</option>
    </select>
    <input class="search-input" type="text" id="search" placeholder="Search…" autocomplete="off" />
    <button class="detail-filter-btn" id="btn-archived-filter" title="Show archived chats" aria-label="Show archived chats">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3c-3.5 0-6.2 2.5-7 5 .8 2.5 3.5 5 7 5s6.2-2.5 7-5c-.8-2.5-3.5-5-7-5zm0 9c-2.8 0-5-2-5.9-4 .9-2 3.1-4 5.9-4s5 2 5.9 4c-.9 2-3.1 4-5.9 4zm0-7a3 3 0 100 6 3 3 0 000-6zm0 5a2 2 0 110-4 2 2 0 010 4z"/></svg>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3l1-1h10l1 1v2l-1 1H3L2 5V3zm1 0v2h10V3H3zm1 4h8v6l-1 1H5l-1-1V7zm1 1v5h6V8H5z"/></svg>
    </button>
  </div>

  <div class="sidebar-list" id="sidebar-list"></div>
</div>

<div class="sidebar-divider" id="sidebar-divider" title="Toggle sidebar">
  <span class="divider-arrow" id="divider-arrow">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 14L9 12.5 12.5 9H1V7h11.5L9 3.5 10.5 2l6 6-6 6z" transform="rotate(180 8 8)"/></svg>
  </span>
</div>

<div class="content-pane">
  <!-- Per-chat toolbar: find nav, copy, export -->
  <div class="chat-toolbar" id="chat-toolbar" style="display:none">
    <input class="search-input" type="text" id="chat-search" placeholder="Search in chat…" autocomplete="off" />
    <span class="find-counter" id="find-counter" style="display:none"></span>
    <button class="btn-icon" id="btn-find-prev" title="Previous match (Shift+Enter)" style="display:none">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.024 3.5L7.317 4.207 10.11 7H3v1h7.11l-2.793 2.793.707.707L11.731 8 8.024 4.293v-.793z" transform="rotate(-90 8 8)"/></svg>
    </button>
    <button class="btn-icon" id="btn-find-next" title="Next match (Enter)" style="display:none">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8.024 3.5L7.317 4.207 10.11 7H3v1h7.11l-2.793 2.793.707.707L11.731 8 8.024 4.293v-.793z" transform="rotate(90 8 8)"/></svg>
    </button>
    <button class="btn-icon" id="btn-copy" title="Copy chat to clipboard">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4 4l1-1h5.414L14 6.586V14l-1 1H4l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg>
    </button>
    <button class="btn-icon" id="btn-export" title="Export chat as JSON">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4h1v5.5l2-1.5v1l-3 2.5L5 9V8l2 1.5V4h1z"/><path d="M13.5 11v-1h-11v1h-.5v2.5l.5.5h11l.5-.5V11h-.5zm-.5 2H3v-1h10v1z"/></svg>
    </button>
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
