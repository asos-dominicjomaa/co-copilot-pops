'use strict';

const fs = require('fs');

/**
 * Apply a JSON patch (kind:2) to a mutable session object.
 * @param {object} obj
 * @param {string[]} keys  — dot-path segments
 * @param {*} val
 */
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

/**
 * Parse a .jsonl session file using kind:0 (base) + kind:2 (patch) records.
 * @param {string} filePath
 * @param {{ readFileSync?: Function }} [opts]
 * @returns {object|null}
 */
function parseJsonlSession(filePath, { readFileSync = fs.readFileSync } = {}) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
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

/**
 * Extract plain text from an array of VS Code response parts.
 * @param {Array<object>} responseParts
 * @returns {string}
 */
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

/**
 * Load turns from a .jsonl or .json VS Code chat session file.
 * @param {string} sessionFilePath
 * @param {{ readFileSync?: Function }} [opts]
 * @returns {Array<{user:string, ai:string, model:string|null, ts:number}>|null}
 */
function loadChatSessionFile(sessionFilePath, { readFileSync = fs.readFileSync } = {}) {
  try {
    let data;
    if (sessionFilePath.endsWith('.jsonl')) {
      data = parseJsonlSession(sessionFilePath, { readFileSync });
    } else {
      data = JSON.parse(readFileSync(sessionFilePath, 'utf8'));
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

/**
 * Load turns from a Copilot CLI `~/.copilot/session-state/<uuid>/events.jsonl` file.
 * @param {string} eventsFilePath
 * @param {{ readFileSync?: Function }} [opts]
 * @returns {Array<{user:string, ai:string, model:string|null, ts:number}>|null}
 */
function loadCopilotCliEvents(eventsFilePath, { readFileSync = fs.readFileSync } = {}) {
  try {
    const lines = readFileSync(eventsFilePath, 'utf8').split('\n');
    const interactions = {};
    const interactionOrder = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { continue; }

      const type = ev.type;
      if (type === 'user.message') {
        let content = ev.data?.content || '';
        const userReqMatch = content.match(/<userRequest>([\s\S]*?)<\/userRequest>/);
        if (userReqMatch) content = userReqMatch[1].trim();
        else content = content
          .replace(/<reminder>[\s\S]*?<\/reminder>/g, '')
          .replace(/<attachments>[\s\S]*?<\/attachments>/g, '')
          .trim();
        const iid = ev.data?.interactionId || ev.id;
        if (!interactions[iid]) { interactions[iid] = { user: '', ai: '', ts: 0, model: null }; interactionOrder.push(iid); }
        interactions[iid].user = content;
        interactions[iid].ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
      } else if (type === 'assistant.message') {
        const data = ev.data || {};
        const iid = data.interactionId || ev.parentId || ev.id;
        if (iid && data.content) {
          if (!interactions[iid]) { interactions[iid] = { user: '', ai: '', ts: 0, model: null }; interactionOrder.push(iid); }
          interactions[iid].ai = (interactions[iid].ai ? interactions[iid].ai + '\n' : '') + data.content.trim();
          if (data.model && !interactions[iid].model) interactions[iid].model = data.model;
        }
      }
    }

    const turns = interactionOrder
      .map(iid => interactions[iid])
      .filter(t => t.user || t.ai)
      .map(t => ({ user: t.user, ai: t.ai, model: t.model, ts: t.ts }));
    return turns.length > 0 ? turns : null;
  } catch { return null; }
}

module.exports = {
  applyJsonlPatch,
  parseJsonlSession,
  extractResponseText,
  loadChatSessionFile,
  loadCopilotCliEvents,
};
