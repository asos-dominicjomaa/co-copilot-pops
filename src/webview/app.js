window.onerror = function (msg, src, line, col, err) {
  document.getElementById('content').innerHTML =
    '<pre style="color:red;padding:16px;font-size:11px;white-space:pre-wrap">WEBVIEW ERROR line ' + line + ':\\n' + msg + (err ? '\\n' + err.stack : '') + '</pre>';
};
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
let currentWsHistoryId = null; // id of the history that contains the current workspace
let lastViewedHistoryId = null; // id of the most recently opened history
let backupInProgress = false;
let syncingHistoryId = null; // id of the history currently being auto-synced
let showArchivedSessions = false;
let scrollHintTimer = null;
let suppressHintHideUntil = 0;
let pendingAutoSyncPulse = false;

function post(msg) { vscodeApi.postMessage(msg); }

function setDisplay(id, display) {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function pulseAutoSyncDivider() {
  const controls = document.getElementById('detail-controls');
  if (!controls) return;
  if (view !== 'detail' || controls.style.display === 'none') {
    pendingAutoSyncPulse = true;
    return;
  }
  pendingAutoSyncPulse = false;
  controls.classList.remove('auto-sync-pulse');
  void controls.offsetWidth; // restart animation for repeated sync events
  controls.classList.add('auto-sync-pulse');
}

function updateSaveWorkspaceButtonState() {
  const btn = document.getElementById('btn-backup');
  if (!btn) return;
  const disabled = !!currentWsHistoryId;
  btn.disabled = disabled;
  btn.title = disabled
    ? 'Current workspace is already saved'
    : 'Save current workspace';
}

function fmt(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function normalizeLang(lang) {
  const l = String(lang || '').trim().toLowerCase();
  if (!l) return 'text';
  if (l === 'ts' || l === 'tsx' || l === 'jsx') return 'javascript';
  if (l === 'sh' || l === 'zsh' || l === 'shell') return 'bash';
  if (l === 'yml') return 'yaml';
  return l;
}

function applyRulesWithPlaceholders(input, rules) {
  let html = input;
  const tokens = [];
  for (const [regex, cls] of rules) {
    html = html.replace(regex, (m) => {
      const id = tokens.length;
      tokens.push(`<span class="${cls}">${m}</span>`);
      return `@@TOK${id}@@`;
    });
  }
  return html.replace(/@@TOK(\d+)@@/g, (_, i) => tokens[Number(i)] || '');
}

function markEscapedText(text, term) {
  if (!term) return text;
  const s = String(text);
  const t = String(term).toLowerCase();
  if (!t) return s;
  let out = '', i = 0;
  const lower = s.toLowerCase();
  while (i < s.length) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) { out += s.slice(i); break; }
    out += s.slice(i, idx) + '<mark>' + s.slice(idx, idx + t.length) + '</mark>';
    i = idx + t.length;
  }
  return out;
}

function markHtmlText(html, term) {
  if (!term) return html;
  return html.replace(/(^|>)([^<]+)(?=<|$)/g, (m, prefix, text) => prefix + markEscapedText(text, term));
}

function highlightCode(code, lang, term) {
  const normalized = normalizeLang(lang);
  const escaped = esc(code);
  let html = escaped;

  if (normalized === 'javascript' || normalized === 'typescript') {
    html = applyRulesWithPlaceholders(html, [
      [/(\/\/.*?$|\/\*[\s\S]*?\*\/)/gm, 'tok-comment'],
      [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, 'tok-string'],
      [/\b(const|let|var|function|return|if|else|switch|case|default|for|while|do|break|continue|class|extends|new|import|export|from|async|await|try|catch|finally|throw|interface|type|implements|public|private|protected|static)\b/g, 'tok-keyword'],
      [/\b\d+(?:\.\d+)?\b/g, 'tok-number'],
    ]);
  } else if (normalized === 'python') {
    html = applyRulesWithPlaceholders(html, [
      [/(#.*$)/gm, 'tok-comment'],
      [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'tok-string'],
      [/\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|pass|yield|async|await|True|False|None)\b/g, 'tok-keyword'],
      [/\b\d+(?:\.\d+)?\b/g, 'tok-number'],
    ]);
  } else if (normalized === 'bash') {
    html = applyRulesWithPlaceholders(html, [
      [/(#.*$)/gm, 'tok-comment'],
      [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'tok-string'],
      [/\b(if|then|else|fi|for|do|done|while|case|esac|function|in|echo|export|local|readonly)\b/g, 'tok-keyword'],
      [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, 'tok-variable'],
    ]);
  } else if (normalized === 'json') {
    html = applyRulesWithPlaceholders(html, [
      [/"(?:\\.|[^"\\])*"(?=\s*:)/g, 'tok-key'],
      [/"(?:\\.|[^"\\])*"/g, 'tok-string'],
      [/\b(true|false|null)\b/g, 'tok-keyword'],
      [/\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, 'tok-number'],
    ]);
  } else if (normalized === 'yaml') {
    html = applyRulesWithPlaceholders(html, [
      [/(#.*$)/gm, 'tok-comment'],
      [/^\s*[\w.-]+(?=\s*:)/gm, 'tok-key'],
      [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, 'tok-string'],
      [/\b(true|false|null|yes|no|on|off)\b/gi, 'tok-keyword'],
      [/\b-?\d+(?:\.\d+)?\b/g, 'tok-number'],
    ]);
  }

  return markHtmlText(html, term);
}

function splitWrappedSegments(line, maxCols = 88) {
  const s = String(line || '');
  if (!s) return [''];
  const parts = [];
  let rest = s;
  while (rest.length > maxCols) {
    let cut = maxCols;
    const ws = rest.lastIndexOf(' ', maxCols);
    if (ws > Math.floor(maxCols * 0.6)) cut = ws + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

function renderCodeLines(code, lang, term) {
  const normalized = String(code || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length === 0) lines.push('');

  const out = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const wrapped = splitWrappedSegments(lines[idx]);
    for (let segIdx = 0; segIdx < wrapped.length; segIdx++) {
      const rendered = highlightCode(wrapped[segIdx], lang, term) || '&nbsp;';
      const noCls = segIdx === 0 ? 'code-line-no' : 'code-line-no continuation';
      out.push(`<span class="code-line"><span class="${noCls}">${idx + 1}</span><span class="code-line-text">${rendered}</span></span>`);
    }
  }
  return out.join('');
}

function renderInlineTextAndCode(text, term) {
  const parts = String(text || '').split(/`([^`\n]+)`/g);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += `<code class="inline-code">${highlightCode(parts[i], 'text', term)}</code>`;
    } else if (parts[i]) {
      html += hlRaw(parts[i], term);
    }
  }
  return html;
}

async function copyCodeBlock(event, btn) {
  event.preventDefault();
  event.stopPropagation();
  const block = btn && btn.closest ? btn.closest('.code-block') : null;
  if (!block) return;
  const encoded = block.getAttribute('data-code') || '';
  if (!encoded) return;
  try {
    const text = decodeURIComponent(encoded);
    await navigator.clipboard.writeText(text);
    const label = btn.querySelector('.code-copy-label');
    const prev = label ? label.textContent : null;
    if (label) label.textContent = 'Copied';
    setTimeout(() => { if (label && prev) label.textContent = prev; }, 1200);
  } catch {
    const label = btn.querySelector('.code-copy-label');
    const prev = label ? label.textContent : null;
    if (label) label.textContent = 'Failed';
    setTimeout(() => { if (label && prev) label.textContent = prev; }, 1200);
  }
}

function renderMessageText(raw, term) {
  const input = String(raw || '');
  const fenceRe = /```([a-zA-Z0-9#+-]*)?\n([\s\S]*?)```/g;
  let html = '';
  let last = 0;
  let m;
  while ((m = fenceRe.exec(input)) !== null) {
    const before = input.slice(last, m.index);
    if (before) html += renderInlineTextAndCode(before, term);
    const lang = normalizeLang(m[1] || 'text');
    const code = m[2] || '';
    if (code.trim()) {
      const encoded = encodeURIComponent(code);
      html += `<div class="code-block" data-code="${encoded}"><div class="code-block-head"><span class="code-lang">${esc(lang)}</span><button class="code-copy-btn" title="Copy code" onclick="copyCodeBlock(event, this)"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M4 4l1-1h5.414L14 6.586V14l-1 1H4l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/></svg><span class="code-copy-label">Copy</span></button></div><pre><code class="lang-${esc(lang)}">${renderCodeLines(code, lang, term)}</code></pre></div>`;
    }
    last = m.index + m[0].length;
  }
  const rest = input.slice(last);
  if (rest) html += renderInlineTextAndCode(rest, term);
  return html;
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
  const visible = showArchivedSessions ? sorted : sorted.filter(s => !s.archived);
  if (!searchTerm) return visible;
  const q = searchTerm.toLowerCase();
  return visible.filter(s => {
    if ((s.title || '').toLowerCase().includes(q)) return true;
    if ((s.workspace || '').toLowerCase().includes(q)) return true;
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
  document.getElementById('sidebar-title').textContent = 'Workspaces';
  setDisplay('btn-back', 'none');
  if (document.getElementById('home-controls')) {
    setDisplay('home-controls', '');
  } else {
    setDisplay('btn-add', '');
    setDisplay('btn-backup', '');
    setDisplay('btn-export-bundle', '');
  }
  setDisplay('detail-controls', 'none');
  updateSaveWorkspaceButtonState();
  document.getElementById('search').value = '';
  document.getElementById('chat-toolbar').style.display = 'none';
  document.getElementById('content').innerHTML = '<div class="empty">Select a history to view sessions</div>';
  renderHome();
}

function renderHome() {
  const list = document.getElementById('sidebar-list');
  if (histories.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-state-title">No histories yet</div>
      <div class="empty-state-desc">Use the controls above to save your current workspace or import existing workspace backups.</div>
    </div>`;
    return;
  }
  let html = '';
  for (const h of histories) {
    if (editingHistoryId === h.id) {
      html += `<div class="edit-form" id="edit-${esc(h.id)}">
        <input id="edit-name-${esc(h.id)}" value="${esc(h.name)}" placeholder="Name" />
        <textarea id="edit-desc-${esc(h.id)}" rows="2" placeholder="Description (optional)">${esc(h.description || '')}</textarea>
        <div class="edit-form-btns">
          <button class="btn-small btn-ghost" onclick="cancelEdit()">Cancel</button>
          <button class="btn-small btn-primary" onclick="saveEdit('${esc(h.id)}')">Save</button>
        </div>
      </div>`;
    } else {
      const isCurWs = h.id === currentWsHistoryId;
      const isLastViewed = !isCurWs && h.id === lastViewedHistoryId;
      const isSyncing = h.id === syncingHistoryId;
      const classes = ['history-card', isCurWs ? 'current-ws' : '', isLastViewed ? 'last-viewed' : '', isSyncing ? 'syncing' : ''].filter(Boolean).join(' ');
      const wsLabel = isCurWs ? '<span class="current-ws-label">Current Workspace</span>' : '';
      const syncBadge = isSyncing ? '<span class="sync-badge"><svg class="spin-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.917 7A6.002 6.002 0 0 0 2.083 7H1.071A7 7 0 0 1 15 7h-1.083z"/></svg> Syncing…</span>' : '';
      html += `<div class="${classes}" data-hid="${esc(h.id)}">
        <div class="history-card-name">${esc(h.name)}</div>
        ${h.description ? `<div class="history-card-desc">${esc(h.description)}</div>` : ''}
        <div class="history-card-meta">${h.sessionCount || 0} sessions &nbsp;·&nbsp; Added ${fmt(h.addedAt)}</div>
        ${wsLabel || syncBadge ? `<div class="history-card-label">${wsLabel}${syncBadge}</div>` : ''}
        <div class="card-actions">
          ${!isCurWs ? `<button class="btn-icon" title="Open workspace in new window" onclick="openWorkspace(event, '${esc(h.id)}')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h5v1H3v10h10v-4h1v5H2V2zm9 0h3v3h-1V3.707L8.854 8.854l-.708-.708L13.293 3H12V2z"/></svg>
          </button>` : ''}
          <button class="btn-icon" title="Rename / edit" onclick="startEdit(event, '${esc(h.id)}')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>
          </button>
          <button class="btn-icon" title="Remove" onclick="removeHistory(event, '${esc(h.id)}')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>
          </button>
        </div>
      </div>`;
    }
  }
  list.innerHTML = html;
}

function openWorkspace(e, id) {
  e.stopPropagation();
  post({ type: 'openWorkspace', id });
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
  lastViewedHistoryId = history.id;
  const isCurrentWs = currentWsHistoryId === history.id;
  const titleSuffix = isCurrentWs ? ' · Current Workspace' : '';
  document.getElementById('sidebar-title').textContent = history.name + titleSuffix;
  setDisplay('btn-back', '');
  if (document.getElementById('home-controls')) {
    setDisplay('home-controls', 'none');
  } else {
    setDisplay('btn-add', 'none');
    setDisplay('btn-backup', 'none');
    setDisplay('btn-export-bundle', 'none');
  }
  setDisplay('detail-controls', 'flex');
  if (pendingAutoSyncPulse) {
    requestAnimationFrame(() => pulseAutoSyncDivider());
  }
  updateArchivedFilterButton();
  document.getElementById('search').value = '';
  document.getElementById('sort-select').value = sortOrder;

  if (error) {
    document.getElementById('sidebar-list').innerHTML = `<div class="error-banner">${esc(error)}</div>`;
    document.getElementById('content').innerHTML = '<div class="empty">Error loading sessions</div>';
    return;
  }

  renderDetail();
  const firstVisible = getFiltered()[0];
  if (firstVisible) selectSession(firstVisible.id);
  else document.getElementById('content').innerHTML = '<div class="empty">No sessions found in this history</div>';
}

function renderDetail() {
  const filtered = getFiltered();
  const list = document.getElementById('sidebar-list');

  document.getElementById('sidebar-title').textContent =
    currentHistory.name + (searchTerm ? ` (${filtered.length})` : ` · ${allSessions.length}`);

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
    html += `<div class="backup-item">
      <div class="backup-item-title">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.56253 2.51577a7.01207 7.01207 0 019.42494 9.42494l.70709.70709a8.01003 8.01003 0 10-10.1321 10.1321l-.70709-.70709a7.01207 7.01207 0 01-.70709-9.42494l-.00003-.00003z"/><path d="M7.5 8l-.35.15-.15.35v3l.5.5h1l.5-.5v-3l-.15-.35-.35-.15h-1z"/></svg>
        Backing up current workspace…
      </div>
      <div class="backup-progress-bar"><div class="backup-progress-fill"></div></div>
      <div class="backup-item-status">Copying session files</div>
    </div>`;
  }

  for (const [ws, sessions] of Object.entries(groups)) {
    html += `<div class="group-header">${esc(ws)}<span class="count-badge">${sessions.length}</span></div>`;
    for (const s of sessions) {
      const active = s.id === currentSessionId ? ' active' : '';
      const archived = s.archived ? ' archived' : '';
      const isCurrentWsSession = currentWsHash && s.wsHash === currentWsHash;
      const turnCount = s.turnCount || 0;
      const archiveBtn = `<button class="btn-icon btn-archive" title="${s.archived ? 'Unarchive chat' : 'Archive chat'}" onclick="toggleSessionArchived(event, '${esc(s.id)}')">
            ${s.archived
          ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3l1-1h10l1 1v2l-1 1H3L2 5V3zm1 0v2h10V3H3zm1 4h8v6l-1 1H5l-1-1V7zm1 1v5h6V8H5zm1 1h4v1H6V9z"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3l1-1h10l1 1v2l-1 1H3L2 5V3zm1 0v2h10V3H3zm1 4h8v6l-1 1H5l-1-1V7zm1 1v5h6V8H5z"/></svg>'}
          </button>`;
      const refreshBtn = isCurrentWsSession
        ? `<button class="btn-icon btn-refresh" title="Refresh session" onclick="refreshSession(event, '${esc(s.id)}')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.56253 2.51577a7.01207 7.01207 0 019.42494 9.42494l.70709.70709a8.01003 8.01003 0 10-10.1321 10.1321l-.70709-.70709a7.01207 7.01207 0 01-.70709-9.42494l-.00003-.00003z"/><path d="M7.5 8l-.35.15-.15.35v3l.5.5h1l.5-.5v-3l-.15-.35-.35-.15h-1z"/></svg>
          </button>`
        : '';
      html += `<div class="session-item${active}${archived}" data-id="${esc(s.id)}" style="display:flex;flex-direction:column">
        <div style="display:flex;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div class="session-title">${hlRaw(s.title, searchTerm)}</div>
            <div class="session-meta">
              <span>${fmt(s.date)}</span>
              ${turnCount ? `<span>· ${turnCount} turn${turnCount !== 1 ? 's' : ''}</span>` : ''}
              ${s.location ? '<span class="session-ws">' + esc(s.location) + '</span>' : ''}
            </div>
          </div>
          ${archiveBtn}
          ${refreshBtn}
        </div>
      </div>`;
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

function toggleSessionArchived(e, sessionId) {
  e.stopPropagation();
  if (!currentHistory) return;
  const session = allSessions.find(s => s.id === sessionId);
  if (!session) return;
  session.archived = !session.archived;
  post({ type: 'toggleSessionArchived', historyId: currentHistory.id, sessionId, archived: session.archived });
  if (session.archived && !showArchivedSessions && currentSessionId === sessionId) {
    currentSessionId = null;
    currentSessionData = null;
    document.getElementById('chat-toolbar').style.display = 'none';
    renderContent(null);
  }
  renderDetail();
}

function updateArchivedFilterButton() {
  const btn = document.getElementById('btn-archived-filter');
  if (!btn) return;
  const label = showArchivedSessions ? 'Hide archived chats' : 'Show archived chats';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.classList.toggle('active', showArchivedSessions);
}

function updateChatToolbarTitle(session) {
  const titleEl = document.getElementById('chat-toolbar-title');
  if (!titleEl) return;
  titleEl.textContent = session?.title || 'Conversation';
}

function selectSession(id, options = {}) {
  const preserveChatSearch = !!options.preserveChatSearch;
  const forceReload = !!options.forceReload;
  currentSessionId = id;
  if (!preserveChatSearch) {
    chatSearch = '';
    chatMatchIndex = 0;
    document.getElementById('chat-search').value = '';
    document.getElementById('find-counter').style.display = 'none';
    document.getElementById('btn-find-prev').style.display = 'none';
    document.getElementById('btn-find-next').style.display = 'none';
  }
  const session = allSessions.find(s => s.id === id);
  currentSessionData = session || null;
  updateChatToolbarTitle(session);
  renderDetail();
  document.getElementById('chat-toolbar').style.display = session ? 'flex' : 'none';

  if (!session) { renderContent(null); return; }

  // If turns already loaded (cached), render immediately
  if (session.turns && !forceReload) { renderContent(session); return; }

  // Otherwise show loading and request turns from extension host
  document.getElementById('content').innerHTML = '<div class="loading">Loading conversation…</div>';
  post({ type: 'loadSessionTurns', sessionId: session.id, sessionFile: session.sessionFile, eventsFile: session.eventsFile });
}

function fmtDur(ms) {
  if (!ms) return null;
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function renderContent(session) {
  const content = document.getElementById('content');
  const hint = document.getElementById('scroll-up-hint');
  if (scrollHintTimer) { clearTimeout(scrollHintTimer); scrollHintTimer = null; }
  if (hint) hint.classList.remove('show');
  updateChatToolbarTitle(session);
  if (!session) {
    content.innerHTML = '<div class="empty">Select a session to view messages</div>';
    return;
  }

  const badges = [];
  if (session.location) badges.push(`<span class="meta-badge">${esc(session.location)}</span>`);
  if (session.hasPendingEdits) badges.push('<span class="meta-badge meta-badge-warn">pending edits</span>');
  if (session.stats) {
    const s = session.stats;
    if (s.added || s.removed) badges.push(`<span class="meta-badge">+${s.added || 0}/-${s.removed || 0} lines</span>`);
    if (s.fileCount) badges.push(`<span class="meta-badge">${s.fileCount} file${s.fileCount !== 1 ? 's' : ''}</span>`);
  }

  const turns = session.turns || [];
  const hasTurns = session.turns !== undefined; // undefined = not yet loaded
  const q = chatSearch.toLowerCase() || searchTerm.toLowerCase();

  const filteredTurns = q
    ? turns.filter(t =>
      (t.user || '').toLowerCase().includes(q) ||
      (t.ai || '').toLowerCase().includes(q)
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
      const modelTag = t.model ? `<span class="msg-model">${esc(t.model)}</span>` : '';
      if (t.user) {
        turnsHtml += `<div class="message message-user">
          <div class="msg-role">You ${modelTag}</div>
          <div class="msg-text">${renderMessageText(t.user, hl)}</div>
        </div>`;
      }
      if (t.ai) {
        turnsHtml += `<div class="message message-ai">
          <div class="msg-role">Copilot</div>
          <div class="msg-text">${renderMessageText(t.ai, hl)}</div>
        </div>`;
      }
    }
  }

  const turnLabel = turns.length > 0
    ? `<span class="count-badge">${filteredTurns.length}${(chatSearch || searchTerm) && filteredTurns.length !== turns.length ? ' / ' + turns.length : ''} turns</span>`
    : '';

  content.innerHTML = `
    <div class="chat-header">
      <h2>${esc(session.title)}</h2>
      <div class="meta-row">${badges.join('')}</div>
      <div class="meta" style="margin-top:6px">
        <strong>Workspace:</strong> ${esc(session.workspace)}
        &nbsp;·&nbsp; <strong>Created:</strong> ${fmt(session.created)}
        &nbsp;·&nbsp; <strong>Last active:</strong> ${fmt(session.date)}
      </div>
    </div>
    <div class="ws-messages-header">
      <span>Conversation</span>
      ${turnLabel}
    </div>
    ${turnsHtml}
  `;

  // Start each chat at the latest messages (bottom), and hint that earlier messages are above.
  requestAnimationFrame(() => {
    suppressHintHideUntil = Date.now() + 500;
    content.scrollTop = content.scrollHeight;
    if (!hint) return;
    if (content.scrollHeight > content.clientHeight + 20 && filteredTurns.length > 0) {
      hint.classList.add('show');
      scrollHintTimer = setTimeout(() => hint.classList.remove('show'), 3500);
    }
  });
}

// ── Sidebar toggle ──
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const arrow = document.getElementById('divider-arrow');
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  arrow.innerHTML = sidebarCollapsed
    ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 14L9 12.5 12.5 9H1V7h11.5L9 3.5 10.5 2l6 6-6 6z"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 14L9 12.5 12.5 9H1V7h11.5L9 3.5 10.5 2l6 6-6 6z" transform="rotate(180 8 8)"/></svg>';
}
document.getElementById('sidebar-divider').addEventListener('click', toggleSidebar);
document.getElementById('content').addEventListener('scroll', () => {
  if (Date.now() < suppressHintHideUntil) return;
  const hint = document.getElementById('scroll-up-hint');
  if (hint) hint.classList.remove('show');
  if (scrollHintTimer) { clearTimeout(scrollHintTimer); scrollHintTimer = null; }
});

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

  counter.textContent = `${chatMatchIndex + 1} / ${total}`;
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
  text += `Workspace: ${s.workspace} | Created: ${fmt(s.created)}\\n\\n`;
  for (const t of (s.turns || [])) {
    if (t.user) text += `You:\\n${t.user}\\n\\n`;
    if (t.ai) text += `Copilot:\\n${t.ai}\\n\\n`;
  }
  navigator.clipboard.writeText(text).catch(() => { });
});

document.getElementById('btn-export').addEventListener('click', () => {
  if (!currentSessionData) return;
  post({ type: 'exportChat', data: currentSessionData });
});

document.getElementById('btn-open-chat').addEventListener('click', () => {
  if (!currentSessionData) return;
  post({ type: 'openInCopilotChat', data: currentSessionData });
});

// ── Event listeners ──
document.getElementById('btn-back').addEventListener('click', showHome);
document.getElementById('btn-add').addEventListener('click', () => post({ type: 'addHistory' }));
document.getElementById('btn-export-bundle').addEventListener('click', () => post({ type: 'exportBundle' }));
document.getElementById('btn-backup').addEventListener('click', () => {
  const backupBtn = document.getElementById('btn-backup');
  if (backupBtn?.disabled) return;
  // Works from home view: pass all history options so host can quick-pick
  const historyId = currentHistory ? currentHistory.id : null;
  post({ type: 'backupWorkspace', historyId, allHistories: histories.map(h => ({ id: h.id, name: h.name })) });
});

document.getElementById('sort-select').addEventListener('change', e => {
  sortOrder = e.target.value;
  renderDetail();
});

const archivedFilterBtn = document.getElementById('btn-archived-filter');
if (archivedFilterBtn) {
  archivedFilterBtn.addEventListener('click', () => {
    showArchivedSessions = !showArchivedSessions;
    if (!showArchivedSessions && currentSessionId) {
      const selected = allSessions.find(s => s.id === currentSessionId);
      if (selected?.archived) {
        currentSessionId = null;
        currentSessionData = null;
        document.getElementById('chat-toolbar').style.display = 'none';
        renderContent(null);
      }
    }
    updateArchivedFilterButton();
    renderDetail();
  });
}

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
      document.getElementById('sidebar-list').innerHTML =
        '<div class="sessions-loading-header"><div class="sessions-loading-spinner"></div>Loading sessions…</div>' +
        '<div id="sessions-progress-log" class="sessions-progress-log"></div>';
      post({ type: 'loadHistory', id: hid });
    }
  } else {
    if (e.target.closest('.btn-refresh') || e.target.closest('.btn-archive')) return; // handled by button handlers
    const item = e.target.closest('.session-item');
    if (item) selectSession(item.dataset.id);
  }
});

// ── Message handler (from extension) ──
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'histories':
      readyAcked = true;
      histories = msg.data || [];
      if (msg.currentWsHash) {
        currentWsHash = msg.currentWsHash;
        const matched = histories.find(h => h.wsHash === currentWsHash);
        currentWsHistoryId = matched ? matched.id : null;
      }
      if (msg.syncingId) {
        syncingHistoryId = msg.syncingId;
      }
      if (view === 'home' || !view) showHome();
      else renderHome();
      break;
    case 'historyAdded':
      histories.unshift(msg.history);
      showDetail(msg.history, msg.sessions, msg.error, msg.currentWsHash);
      break;
    case 'syncComplete': {
      if (msg.autoSync) pulseAutoSyncDivider();
      syncingHistoryId = null;
      if (msg.id) {
        const h = histories.find(x => x.id === msg.id);
        if (h && msg.sessionCount != null) h.sessionCount = msg.sessionCount;
      }
      if (view === 'home') renderHome();
      else if (view === 'detail') renderDetail();
      break;
    }
    case 'historySessions': {
      if (msg.autoSync) pulseAutoSyncDivider();
      if (msg.autoSync && view === 'detail' && currentHistory?.id === msg.id) {
        const selectedSessionId = currentSessionId;
        const preserveChatSearch = !!chatSearch;
        allSessions = msg.sessions || [];
        if (msg.currentWsHash !== undefined) currentWsHash = msg.currentWsHash;
        renderDetail();
        const selectedStillExists = selectedSessionId
          ? allSessions.find(s => s.id === selectedSessionId)
          : null;
        const nextSession = selectedStillExists || getFiltered()[0] || null;
        if (nextSession) {
          selectSession(nextSession.id, { preserveChatSearch, forceReload: true });
        } else {
          currentSessionId = null;
          currentSessionData = null;
          document.getElementById('chat-toolbar').style.display = 'none';
          renderContent(null);
        }
        break;
      }
      // Ensure the history is in our local cache; add it if missing (e.g. after context reset)
      let h = histories.find(x => x.id === msg.id);
      if (!h && msg.id && msg.name) {
        h = { id: msg.id, name: msg.name, description: '', path: '', addedAt: 0, sessionCount: (msg.sessions || []).length };
        histories.push(h);
      }
      if (h) showDetail(h, msg.sessions, msg.error, msg.currentWsHash);
      break;
    }
    case 'autoSyncTick':
      pulseAutoSyncDivider();
      break;
    case 'sessionArchivedToggled': {
      if (view !== 'detail' || !currentHistory || currentHistory.id !== msg.historyId) break;
      const s = allSessions.find(x => x.id === msg.sessionId);
      if (s) s.archived = !!msg.archived;
      renderDetail();
      break;
    }
    case 'progress': {
      // Append each progress line to the log beneath the spinner
      const log = document.getElementById('sessions-progress-log');
      if (log) {
        const txt = msg.message || '';
        const cls = txt.includes('✓') ? 'pl-found' : txt.includes('✗') ? 'pl-error' : 'pl-empty';
        log.insertAdjacentHTML('beforeend', '<div class="' + cls + '">' + esc(txt) + '</div>');
        log.scrollTop = log.scrollHeight;
      }
      break;
    }
    case 'historySessionsBatch': {
      if (view !== 'detail' || currentHistory?.id !== msg.id) break;
      const wasEmpty = allSessions.length === 0;
      allSessions = allSessions.concat(msg.sessions || []);
      renderDetail();
      const firstVisible = getFiltered()[0];
      if (wasEmpty && firstVisible) selectSession(firstVisible.id);
      break;
    }
    case 'historySessionsDone': {
      if (view !== 'detail' || currentHistory?.id !== msg.id) break;
      if (msg.error) {
        document.getElementById('sidebar-list').innerHTML = `<div class="error-banner">${esc(msg.error)}</div>`;
      } else if (allSessions.length === 0) {
        document.getElementById('sidebar-list').innerHTML = '<div class="empty" style="padding:20px;font-size:12px">No sessions found in this history</div>';
      } else {
        renderDetail();
      }
      if (currentHistory) {
        const isCurrentWs = currentWsHistoryId === currentHistory.id;
        const suffix = isCurrentWs ? ' · Current Workspace' : ' · ' + allSessions.length;
        document.getElementById('sidebar-title').textContent = currentHistory.name + suffix;
      }
      break;
    }
    case 'historyRenamed': {
      const hr = histories.find(x => x.id === msg.id);
      if (hr) { hr.name = msg.name; hr.description = msg.description; }
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
      if (currentWsHistoryId === msg.id) currentWsHistoryId = null;
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
      if (msg.newHistory) {
        histories.unshift(msg.newHistory);
        // The backed-up history has the current workspace hash stored on it
        if (currentWsHash && msg.newHistory.wsHash === currentWsHash) {
          currentWsHistoryId = msg.newHistory.id;
        }
        showDetail(msg.newHistory, msg.sessions || [], msg.error, msg.wsHash);
      } else {
        // Fallback: refresh current view
        const bh = histories.find(x => x.id === msg.historyId);
        if (bh && msg.sessions) bh.sessionCount = msg.sessions.length;
        if (view === 'home') renderHome();
        else if (view === 'detail') {
          allSessions = msg.sessions || allSessions;
          renderDetail();
          const firstVisible = getFiltered()[0];
          if (!currentSessionId && firstVisible) selectSession(firstVisible.id);
        }
      }
      break;
    }
    case 'backupError':
      backupInProgress = false;
      if (view === 'detail') renderDetail();
      document.getElementById('content').innerHTML = `<div class="error-banner">Backup failed: ${esc(msg.message)}</div>`;
      break;
    case 'error':
      document.getElementById('content').innerHTML = `<div class="error-banner">${esc(msg.message)}</div>`;
      break;
  }
});

// ── Init ──
// Retry ready until we get a histories response (handles race condition with handler registration)
let readyAcked = false;
function sendReady() {
  if (readyAcked) return;
  post({ type: 'ready' });
  setTimeout(() => { if (!readyAcked) sendReady(); }, 300);
}
sendReady();
