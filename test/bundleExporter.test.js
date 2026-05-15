'use strict';

const path = require('path');
const { exportBundle, readBundleManifest, importBundle, MANIFEST_FILE } = require('../src/bundleExporter');

function makeFsOpts(existingDirs = []) {
  const written = {};
  const created = [];
  return {
    mkdirSync: jest.fn((p) => created.push(p)),
    writeFileSync: jest.fn((p, content) => { written[p] = content; }),
    existsSync: jest.fn(p => existingDirs.includes(p)),
    readFileSync: jest.fn(p => written[p] || (() => { throw new Error('ENOENT'); })()),
    copyDirRecursive: jest.fn(),
    _written: written,
    _created: created,
  };
}

describe('exportBundle', () => {
  const globalStorageDir = '/global/storage';
  const destDir = '/dest/export-folder';

  test('writes manifest.json to destDir', () => {
    const opts = makeFsOpts(['/global/storage/my-history']);
    const histories = [{ id: 'h1', name: 'My History', path: '/global/storage/my-history', addedAt: 1000, sessionCount: 5 }];
    exportBundle(histories, globalStorageDir, destDir, opts);
    const manifestPath = path.join(destDir, MANIFEST_FILE);
    expect(opts.writeFileSync).toHaveBeenCalledWith(manifestPath, expect.any(String), 'utf8');
  });

  test('manifest contains correct structure', () => {
    const opts = makeFsOpts(['/global/storage/h1-folder']);
    const histories = [{ id: 'h1', name: 'Test', path: '/global/storage/h1-folder', addedAt: 1000, sessionCount: 2 }];
    exportBundle(histories, globalStorageDir, destDir, opts);
    const manifestRaw = opts._written[path.join(destDir, MANIFEST_FILE)];
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.app).toBe('co-pilot-pops');
    expect(manifest.version).toBe(1);
    expect(manifest.histories).toHaveLength(1);
    expect(manifest.histories[0].bundleRelPath).toBe('h1-folder');
  });

  test('copies internal history dirs', () => {
    const opts = makeFsOpts(['/global/storage/h1-folder']);
    const histories = [{ id: 'h1', name: 'Test', path: '/global/storage/h1-folder' }];
    const { exported } = exportBundle(histories, globalStorageDir, destDir, opts);
    expect(exported).toBe(1);
    expect(opts.copyDirRecursive).toHaveBeenCalledWith('/global/storage/h1-folder', path.join(destDir, 'h1-folder'), opts);
  });

  test('skips external histories (not inside globalStorageDir)', () => {
    const opts = makeFsOpts([]);
    const histories = [{ id: 'h1', name: 'External', path: '/some/other/folder' }];
    const { exported, skipped } = exportBundle(histories, globalStorageDir, destDir, opts);
    expect(exported).toBe(0);
    expect(skipped).toBe(1);
    expect(opts.copyDirRecursive).not.toHaveBeenCalled();
    // metadata still written to manifest
    const manifest = JSON.parse(opts._written[path.join(destDir, MANIFEST_FILE)]);
    expect(manifest.histories[0].bundleRelPath).toBeNull();
  });

  test('creates destDir', () => {
    const opts = makeFsOpts([]);
    exportBundle([], globalStorageDir, destDir, opts);
    expect(opts.mkdirSync).toHaveBeenCalledWith(destDir, { recursive: true });
  });
});

describe('readBundleManifest', () => {
  test('returns null when manifest file does not exist', () => {
    const opts = { existsSync: jest.fn(() => false), readFileSync: jest.fn() };
    expect(readBundleManifest('/some/folder', opts)).toBeNull();
  });

  test('returns null when manifest has wrong app name', () => {
    const bad = JSON.stringify({ app: 'other-app', histories: [] });
    const opts = { existsSync: jest.fn(() => true), readFileSync: jest.fn(() => bad) };
    expect(readBundleManifest('/some/folder', opts)).toBeNull();
  });

  test('returns manifest for valid bundle', () => {
    const valid = JSON.stringify({ app: 'co-pilot-pops', version: 1, histories: [{ id: 'h1' }] });
    const opts = { existsSync: jest.fn(() => true), readFileSync: jest.fn(() => valid) };
    const result = readBundleManifest('/some/folder', opts);
    expect(result).not.toBeNull();
    expect(result.histories).toHaveLength(1);
  });

  test('returns null on parse error', () => {
    const opts = { existsSync: jest.fn(() => true), readFileSync: jest.fn(() => 'not-json') };
    expect(readBundleManifest('/some/folder', opts)).toBeNull();
  });
});

describe('importBundle', () => {
  const bundleDir = '/bundle';
  const globalStorageDir = '/global/storage';

  test('copies bundled history dirs to globalStorageDir', () => {
    const opts = {
      mkdirSync: jest.fn(),
      existsSync: jest.fn(() => true),
      copyDirRecursive: jest.fn(),
    };
    const manifest = {
      histories: [{ id: 'h1', name: 'Test', path: '/old/path', bundleRelPath: 'h1-folder', sessionCount: 3 }]
    };
    const { histories, imported } = importBundle(manifest, bundleDir, globalStorageDir, [], opts);
    expect(imported).toBe(1);
    expect(opts.copyDirRecursive).toHaveBeenCalledWith('/bundle/h1-folder', '/global/storage/h1-folder', opts);
    expect(histories[0].path).toBe('/global/storage/h1-folder');
  });

  test('skips duplicate histories by id', () => {
    const opts = { mkdirSync: jest.fn(), existsSync: jest.fn(() => true), copyDirRecursive: jest.fn() };
    const manifest = { histories: [{ id: 'h1', name: 'Test', bundleRelPath: 'h1-folder' }] };
    const existing = [{ id: 'h1', name: 'Existing' }];
    const { imported, skipped } = importBundle(manifest, bundleDir, globalStorageDir, existing, opts);
    expect(imported).toBe(0);
    expect(skipped).toBe(1);
    expect(opts.copyDirRecursive).not.toHaveBeenCalled();
  });

  test('imports external-only histories (no bundleRelPath) as metadata', () => {
    const opts = { mkdirSync: jest.fn(), existsSync: jest.fn(() => false), copyDirRecursive: jest.fn() };
    const manifest = { histories: [{ id: 'h2', name: 'External', bundleRelPath: null, path: '/some/path' }] };
    const { histories, imported } = importBundle(manifest, bundleDir, globalStorageDir, [], opts);
    expect(imported).toBe(1);
    expect(opts.copyDirRecursive).not.toHaveBeenCalled();
    expect(histories[0].bundleRelPath).toBeUndefined();
  });
});
