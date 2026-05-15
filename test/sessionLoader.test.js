'use strict';

const { resolveWorkspaceName, scanChatSessionFiles, buildSessionList, loadSessionsAsync } = require('../src/sessionLoader');

describe('resolveWorkspaceName', () => {
  test('extracts folder name from workspace.json folder URI', () => {
    const readFileSync = jest.fn(() => JSON.stringify({ folder: 'file:///Users/bob/my-project' }));
    expect(resolveWorkspaceName('/ws', {}, 'abc123', { readFileSync })).toBe('my-project');
  });

  test('strips .code-workspace extension', () => {
    const readFileSync = jest.fn(() => JSON.stringify({ workspace: 'file:///Users/bob/work/myws.code-workspace' }));
    expect(resolveWorkspaceName('/ws', {}, 'abc123', { readFileSync })).toBe('myws');
  });

  test('falls back to hash prefix on error', () => {
    const readFileSync = jest.fn(() => { throw new Error('no file'); });
    expect(resolveWorkspaceName('/ws', {}, 'abcdef1234', { readFileSync })).toBe('abcdef12');
  });

  test('resolves from copilot folder entries for Code workspace files', () => {
    const readFileSync = jest.fn(() => JSON.stringify({ workspace: 'file:///Users/bob/.vscode/Code/Workspaces/xyz/workspace.json' }));
    const dbValues = {
      'GitHub.copilot-chat': {
        workspaceFolderIds: { entries: [{ uri: 'file:///Users/bob/projects/cool-app' }] }
      }
    };
    const result = resolveWorkspaceName('/ws', dbValues, 'abc123', { readFileSync });
    expect(result).toBe('projects/cool-app');
  });
});

describe('scanChatSessionFiles', () => {
  test('finds .jsonl files and maps to session id', () => {
    const existsSync = jest.fn(() => true);
    const readdirSync = jest.fn(() => ['abc123.jsonl', 'def456.json']);
    const result = scanChatSessionFiles('/chatSessions', { existsSync, readdirSync });
    expect(result['abc123']).toMatch(/abc123\.jsonl$/);
    expect(result['def456']).toMatch(/def456\.json$/);
  });

  test('.jsonl takes precedence over .json for same id', () => {
    const existsSync = jest.fn(() => true);
    const readdirSync = jest.fn(() => ['abc.json', 'abc.jsonl']);
    const result = scanChatSessionFiles('/chatSessions', { existsSync, readdirSync });
    expect(result['abc']).toMatch(/\.jsonl$/);
  });

  test('returns empty object when dir does not exist', () => {
    const existsSync = jest.fn(() => false);
    const readdirSync = jest.fn();
    const result = scanChatSessionFiles('/nonexistent', { existsSync, readdirSync });
    expect(result).toEqual({});
    expect(readdirSync).not.toHaveBeenCalled();
  });
});

describe('buildSessionList', () => {
  const wsHash = 'abc123';
  const copilotCliDir = '/home/.copilot/session-state';

  test('builds session from index entry with sessionFile', () => {
    const entries = {
      'sess1': { title: 'My Chat', lastMessageDate: 2000, timing: { created: 1000 }, initialLocation: 'panel' }
    };
    const chatFiles = { 'sess1': '/chatSessions/sess1.jsonl' };
    const existsSync = jest.fn(() => false);
    const sessions = buildSessionList(entries, chatFiles, 'my-project', wsHash, copilotCliDir, { existsSync });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('My Chat');
    expect(sessions[0].sessionFile).toBe('/chatSessions/sess1.jsonl');
    expect(sessions[0].eventsFile).toBeNull();
  });

  test('skips isEmpty sessions', () => {
    const entries = { 's1': { isEmpty: true, title: 'Skip me' } };
    const sessions = buildSessionList(entries, {}, 'ws', wsHash, copilotCliDir);
    expect(sessions).toHaveLength(0);
  });

  test('sets eventsFile for copilotcli:/ external sessions when file exists', () => {
    const entries = {
      'copilotcli:/uuid-123': { title: 'CLI Chat', isExternal: true }
    };
    const existsSync = jest.fn(() => true);
    const sessions = buildSessionList(entries, {}, 'ws', wsHash, copilotCliDir, { existsSync });
    expect(sessions[0].eventsFile).toContain('uuid-123');
    expect(sessions[0].eventsFile).toContain('events.jsonl');
  });

  test('eventsFile is null when events.jsonl does not exist', () => {
    const entries = { 'copilotcli:/uuid-xyz': { title: 'T', isExternal: true } };
    const existsSync = jest.fn(() => false);
    const sessions = buildSessionList(entries, {}, 'ws', wsHash, copilotCliDir, { existsSync });
    expect(sessions[0].eventsFile).toBeNull();
  });
});

describe('loadSessionsAsync', () => {
  test('throws when workspaceStorage not found', async () => {
    const fsDep = { existsSync: jest.fn(() => false) };
    await expect(loadSessionsAsync('/nodir', undefined, { fs: fsDep })).rejects.toThrow('workspaceStorage not found');
  });

  test('returns empty array when no workspace dirs have a DB', async () => {
    const fsDep = {
      existsSync: jest.fn((p) => p.endsWith('workspaceStorage') ? true : false),
      readdirSync: jest.fn(() => ['ws1']),
      statSync: jest.fn(() => ({ isDirectory: () => true })),
    };
    const osDep = { homedir: jest.fn(() => '/home') };
    const queryDb = jest.fn().mockResolvedValue({});
    const msgs = [];
    const sessions = await loadSessionsAsync('/backup', m => msgs.push(m), { fs: fsDep, os: osDep, queryDbValueAsync: queryDb });
    expect(sessions).toEqual([]);
    expect(msgs.some(m => m.includes('no DB'))).toBe(true);
  });

  test('returns sessions sorted newest-first', async () => {
    const index = {
      entries: {
        's1': { title: 'Old', lastMessageDate: 1000, timing: { created: 500 } },
        's2': { title: 'New', lastMessageDate: 9000, timing: { created: 8000 } },
      }
    };
    const fsDep = {
      existsSync: jest.fn((p) => {
        if (p.endsWith('workspaceStorage')) return true;
        if (p.endsWith('state.vscdb')) return true;
        return false;
      }),
      readdirSync: jest.fn((p, opts) => {
        if (p.endsWith('workspaceStorage')) return ['wshash1'];
        if (p.endsWith('chatSessions')) return [];
        return [];
      }),
      statSync: jest.fn(() => ({ isDirectory: () => true })),
      readFileSync: jest.fn(() => JSON.stringify({ folder: 'file:///my/project' })),
    };
    const osDep = { homedir: jest.fn(() => '/home') };
    const queryDb = jest.fn().mockResolvedValue({ 'chat.ChatSessionStore.index': index });
    const sessions = await loadSessionsAsync('/backup', () => { }, { fs: fsDep, os: osDep, queryDbValueAsync: queryDb });
    expect(sessions[0].title).toBe('New');
    expect(sessions[1].title).toBe('Old');
  });
});
