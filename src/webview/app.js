window.onerror = function(msg, src, line, col, err) {
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
      html += `<div class="edit-form" id="edit-${esc(h.id)}">
        <input id="edit-name-${esc(h.id)}" value="${esc(h.name)}" placeholder="Name" />
        <textarea id="edit-desc-${esc(h.id)}" rows="2" placeholder="Description (optional)">${esc(h.description || '')}</textarea>
        <div class="edit-form-btns">
          <button class="btn-small btn-ghost" onclick="cancelEdit()">Cancel</button>
          <button class="btn-small btn-primary" onclick="saveEdit('${esc(h.id)}')">Save</button>
        </div>
      </div>`;
    } else {
      html += `<div class="history-card" data-hid="${esc(h.id)}">
        <div class="history-card-name">${esc(h.name)}</div>
        ${h.description ? `<div class="history-card-desc">${esc(h.description)}</div>` : ''}
        <div class="history-card-meta">${h.sessionCount || 0} sessions &nbsp;·&nbsp; Added ${fmt(h.addedAt)}</div>
        <div class="card-actions">
          <button class="btn-icon" title="Rename / edit" onclick="startEdit(event, '${esc(h.id)}')">&#9998;</button>
          <button class="btn-icon" title="Remove" onclick="removeHistory(event, '${esc(h.id)}')">&#10005;</button>
        </div>
      </div>`;
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
    document.getElementById('sidebar-list').innerHTML = `<div class="error-banner">${esc(error)}</div>`;
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
      <div class="backup-item-title">&#8635; Backing up current workspace…</div>
      <div class="backup-progress-bar"><div class="backup-progress-fill"></div></div>
      <div class="backup-item-status">Copying session files</div>
    </div>`;
  }

  for (const [ws, sessions] of Object.entries(groups)) {
    html += `<div class="group-header">${esc(ws)}<span class="count-badge">${sessions.length}</span></div>`;
    for (const s of sessions) {
      const active = s.id === currentSessionId ? ' active' : '';
      const isCurrent = currentWsHash && s.wsHash === currentWsHash ? ' current-ws' : '';
      const turnCount = s.turnCount || 0;
      const refreshBtn = isCurrent
        ? `<button class="btn-icon btn-refresh" title="Refresh session" onclick="refreshSession(event, '${esc(s.id)}')">&#8635;</button>`
        : '';
      html += `<div class="session-item${active}${isCurrent}" data-id="${esc(s.id)}" style="display:flex;flex-direction:column">
        <div style="display:flex;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div class="session-title">${hlRaw(s.title, searchTerm)}</div>
            <div class="session-meta">
              <span>${fmt(s.date)}</span>
              ${turnCount ? `<span>· ${turnCount} turn${turnCount !== 1 ? 's' : ''}</span>` : ''}
              ${s.location ? '<span class="session-ws">' + esc(s.location) + '</span>' : ''}
            </div>
          </div>
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
  post({ type: 'loadSessionTurns', sessionId: session.id, sessionFile: session.sessionFile, eventsFile: session.eventsFile });
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
  if (session.location) badges.push(`<span class="meta-badge">${esc(session.location)}</span>`);
  if (session.hasPendingEdits) badges.push('<span class="meta-badge meta-badge-warn">pending edits</span>');
  if (session.stats) {
    const s = session.stats;
    if (s.added || s.removed) badges.push(`<span class="meta-badge">+${s.added||0}/-${s.removed||0} lines</span>`);
    if (s.fileCount) badges.push(`<span class="meta-badge">${s.fileCount} file${s.fileCount!==1?'s':''}</span>`);
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
      const modelTag = t.model ? `<span class="msg-model">${esc(t.model)}</span>` : '';
      if (t.user) {
        turnsHtml += `<div class="message message-user">
          <div class="msg-role">You ${modelTag}</div>
          <div class="msg-text">${hlRaw(t.user, hl)}</div>
        </div>`;
      }
      if (t.ai) {
        turnsHtml += `<div class="message message-ai">
          <div class="msg-role">Copilot</div>
          <div class="msg-text">${hlRaw(t.ai, hl)}</div>
        </div>`;
      }
    }
  }

  const turnLabel = turns.length > 0
    ? `<span class="count-badge">${filteredTurns.length}${(chatSearch||searchTerm) && filteredTurns.length !== turns.length ? ' / ' + turns.length : ''} turns</span>`
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
    if (t.ai)   text += `Copilot:\\n${t.ai}\\n\\n`;
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
      document.getElementById('sidebar-list').innerHTML =
        '<div class="sessions-loading-header"><div class="sessions-loading-spinner"></div>Loading sessions…</div>' +
        '<div id="sessions-progress-log" class="sessions-progress-log"></div>';
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
      // Only re-render home if we're not already in a detail view
      if (view === 'home' || !view) showHome();
      else renderHome(); // just update sidebar list without losing detail
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
      if (wasEmpty && allSessions.length > 0) selectSession(getSorted(allSessions)[0].id);
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
      if (currentHistory) document.getElementById('sidebar-title').textContent = currentHistory.name + ' · ' + allSessions.length;
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
      // Add the new history to the top of the list and navigate into it
      if (msg.newHistory) {
        histories.unshift(msg.newHistory);
        showDetail(msg.newHistory, msg.sessions || [], msg.error, null);
      } else {
        // Fallback: refresh current view
        const bh = histories.find(x => x.id === msg.historyId);
        if (bh && msg.sessions) bh.sessionCount = msg.sessions.length;
        if (view === 'home') renderHome();
        else if (view === 'detail') {
          allSessions = msg.sessions || allSessions;
          renderDetail();
          if (!currentSessionId && allSessions.length > 0) selectSession(allSessions[0].id);
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
post({ type: 'ready' });
