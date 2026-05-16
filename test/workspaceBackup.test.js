'use strict';

const path = require('path');
const { copyDirRecursive, resolveBackupLabel, buildBackupName, copyWorkspaceFiles } = require('../src/workspaceBackup');

describe('resolveBackupLabel', () => {
  test('extracts folder name from workspace.json folder URI', () => {
    const readFileSync = jest.fn(() => JSON.stringify({ folder: 'file:///Users/bob/my-project' }));
    expect(resolveBackupLabel('/ws/abc', 'abc123', { readFileSync })).toBe('my-project');
  });

  test('strips .code-workspace extension from workspace key', () => {
    const readFileSync = jest.fn(() => JSON.stringify({ workspace: 'file:///Users/bob/work/myws.code-workspace' }));
    expect(resolveBackupLabel('/ws/abc', 'abc123', { readFileSync })).toBe('myws.code-workspace');
  });

  test('falls back to first 8 chars of hash on error', () => {
    const readFileSync = jest.fn(() => { throw new Error('no file'); });
    expect(resolveBackupLabel('/ws/abc', 'abcdef1234', { readFileSync })).toBe('abcdef12');
  });
});

describe('buildBackupName', () => {
  test('builds name with label and ISO timestamp', () => {
    const name = buildBackupName('my-project', new Date('2024-01-15T10:30:00Z'));
    expect(name).toMatch(/^my-project/);
    expect(name).toContain('2024-01-15');
    expect(name).toContain('10:30');
  });

  test('uses current time when date omitted', () => {
    const name = buildBackupName('label');
    expect(name.startsWith('label')).toBe(true);
    expect(name.length).toBeGreaterThan('label'.length);
  });
});

describe('copyDirRecursive', () => {
  function makeOpts(entries) {
    // entries: array of { name, isDir, path }
    return {
      mkdirSync: jest.fn(),
      readdirSync: jest.fn(() => entries.map(e => ({ name: e.name, isDirectory: () => e.isDir }))),
      copyFileSync: jest.fn(),
      statSync: jest.fn(),
    };
  }

  test('copies files from src to dest', () => {
    const opts = makeOpts([
      { name: 'a.txt', isDir: false },
      { name: 'b.txt', isDir: false },
    ]);
    copyDirRecursive('/src', '/dest', opts);
    expect(opts.copyFileSync).toHaveBeenCalledTimes(2);
    expect(opts.copyFileSync).toHaveBeenCalledWith('/src/a.txt', '/dest/a.txt');
  });

  test('creates destination directory', () => {
    const opts = makeOpts([]);
    copyDirRecursive('/src', '/dest', opts);
    expect(opts.mkdirSync).toHaveBeenCalledWith('/dest', { recursive: true });
  });

  test('recurses into subdirectories', () => {
    const inner = jest.fn(() => [{ name: 'inner.txt', isDirectory: () => false }]);
    const opts = {
      mkdirSync: jest.fn(),
      readdirSync: jest.fn()
        .mockReturnValueOnce([{ name: 'subdir', isDirectory: () => true }])
        .mockReturnValueOnce([{ name: 'file.txt', isDirectory: () => false }]),
      copyFileSync: jest.fn(),
      statSync: jest.fn(),
    };
    copyDirRecursive('/src', '/dest', opts);
    expect(opts.mkdirSync).toHaveBeenCalledWith('/dest/subdir', { recursive: true });
    expect(opts.copyFileSync).toHaveBeenCalledWith('/src/subdir/file.txt', '/dest/subdir/file.txt');
  });
});

describe('copyWorkspaceFiles', () => {
  test('copies workspace metadata files to dest', () => {
    const existsSync = jest.fn(p => p.endsWith('workspace.json') || p.endsWith('state.vscdb'));
    const mkdirSync = jest.fn();
    const copyFileSync = jest.fn();
    const readdirSync = jest.fn(() => []);

    copyWorkspaceFiles('/ws/abc', '/backup/abc', { existsSync, mkdirSync, copyFileSync, readdirSync });
    expect(copyFileSync).toHaveBeenCalledWith('/ws/abc/workspace.json', '/backup/abc/workspace.json');
    expect(copyFileSync).toHaveBeenCalledWith('/ws/abc/state.vscdb', '/backup/abc/state.vscdb');
    expect(copyFileSync).not.toHaveBeenCalledWith(expect.stringContaining('state.vscdb-wal'), expect.any(String));
  });

  test('creates dest directory', () => {
    const mkdirSync = jest.fn();
    copyWorkspaceFiles('/ws/abc', '/backup/abc', { existsSync: jest.fn(() => false), mkdirSync, copyFileSync: jest.fn(), readdirSync: jest.fn(() => []) });
    expect(mkdirSync).toHaveBeenCalledWith('/backup/abc', { recursive: true });
  });
});

const { syncWorkspaceFiles } = require('../src/workspaceBackup');

describe('syncWorkspaceFiles', () => {
  function makeOpts({ srcFiles = {}, destFiles = {}, chatFiles = [] } = {}) {
    const existsSync = jest.fn(p => {
      if (p in srcFiles || p in destFiles) return true;
      if (p.endsWith('chatSessions')) return chatFiles.length > 0;
      return false;
    });
    const statSync = jest.fn(p => {
      if (p in srcFiles) return { mtimeMs: srcFiles[p] };
      if (p in destFiles) return { mtimeMs: destFiles[p] };
      return { mtimeMs: 0 };
    });
    const copyFileSync = jest.fn();
    const mkdirSync = jest.fn();
    const readdirSync = jest.fn(() => chatFiles.map(name => ({ name, isDirectory: () => false })));
    return { existsSync, statSync, copyFileSync, mkdirSync, readdirSync };
  }

  test('copies new file not in dest', () => {
    const opts = makeOpts({ srcFiles: { '/ws/workspace.json': 100 } });
    const { updated, added } = syncWorkspaceFiles('/ws', '/backup', opts);
    expect(opts.copyFileSync).toHaveBeenCalledWith('/ws/workspace.json', '/backup/workspace.json');
    expect(added).toBe(1);
    expect(updated).toBe(0);
  });

  test('updates file where src is newer', () => {
    const opts = makeOpts({
      srcFiles: { '/ws/workspace.json': 200 },
      destFiles: { '/backup/workspace.json': 100 }
    });
    opts.existsSync.mockImplementation(p => p in { '/ws/workspace.json': 1, '/backup/workspace.json': 1 });
    const { updated, added } = syncWorkspaceFiles('/ws', '/backup', opts);
    expect(opts.copyFileSync).toHaveBeenCalled();
    expect(updated).toBe(1);
    expect(added).toBe(0);
  });

  test('skips file where dest is newer', () => {
    const opts = makeOpts({
      srcFiles: { '/ws/workspace.json': 50 },
      destFiles: { '/backup/workspace.json': 200 }
    });
    opts.existsSync.mockImplementation(p => p in { '/ws/workspace.json': 1, '/backup/workspace.json': 1 });
    syncWorkspaceFiles('/ws', '/backup', opts);
    expect(opts.copyFileSync).not.toHaveBeenCalled();
  });

  test('syncs chatSession files', () => {
    const opts = makeOpts({ chatFiles: ['session1.jsonl'] });
    opts.existsSync.mockImplementation(p => {
      if (p === '/ws/chatSessions') return true;
      if (p === '/ws/chatSessions/session1.jsonl') return true;
      return false;
    });
    opts.statSync.mockImplementation(p => ({ mtimeMs: p.includes('/ws/') ? 100 : 0 }));
    syncWorkspaceFiles('/ws', '/backup', opts);
    expect(opts.copyFileSync).toHaveBeenCalledWith('/ws/chatSessions/session1.jsonl', '/backup/chatSessions/session1.jsonl');
  });
});
