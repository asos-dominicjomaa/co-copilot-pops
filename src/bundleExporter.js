'use strict';

const fs = require('fs');
const path = require('path');
const { copyDirRecursive } = require('./workspaceBackup');

const APP_ID = 'go-pilot';
const MANIFEST_FILE = 'go-pilot-manifest.json';
const MANIFEST_VERSION = 1;

/**
 * Export ALL histories and their backup data to a destination folder.
 * Internal histories use their relative path as bundle key.
 * External histories use ext-{id} as bundle key.
 * Only histories with no path on disk are saved as metadata-only.
 */
function exportBundle(histories, globalStorageDir, destDir, opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const writeFileSync = opts.writeFileSync || fs.writeFileSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const _copyDirRecursive = opts.copyDirRecursive || copyDirRecursive;

  mkdirSync(destDir, { recursive: true });

  const manifestHistories = [];
  let exported = 0;
  let skipped = 0;

  for (const h of histories) {
    if (!h.path || !existsSync(h.path)) {
      // No data on disk — save metadata only
      manifestHistories.push({ ...h, bundleRelPath: null });
      skipped++;
      continue;
    }

    const isInternal = h.path.startsWith(globalStorageDir);
    // Use relative path for internal, history id for external (avoids collisions)
    const dirName = isInternal
      ? path.relative(globalStorageDir, h.path)
      : `ext-${h.id}`;

    const dest = path.join(destDir, dirName);
    _copyDirRecursive(h.path, dest, opts);
    manifestHistories.push({ ...h, bundleRelPath: dirName });
    exported++;
  }

  const manifest = {
    version: MANIFEST_VERSION,
    app: APP_ID,
    exportedAt: Date.now(),
    histories: manifestHistories,
  };
  writeFileSync(path.join(destDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

  return { exported, skipped };
}

function readBundleManifest(folderPath, opts = {}) {
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const manifestPath = path.join(folderPath, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.app !== APP_ID || !Array.isArray(manifest.histories)) return null;
    return manifest;
  } catch { return null; }
}

function importBundle(manifest, bundleDir, globalStorageDir, existingHistories = [], opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const _copyDirRecursive = opts.copyDirRecursive || copyDirRecursive;

  mkdirSync(globalStorageDir, { recursive: true });

  const newHistories = [];
  let imported = 0;
  let skipped = 0;

  for (const h of manifest.histories) {
    if (existingHistories.find(e => e.id === h.id)) { skipped++; continue; }

    if (h.bundleRelPath) {
      const srcDir = path.join(bundleDir, h.bundleRelPath);
      const destDir = path.join(globalStorageDir, h.bundleRelPath);
      if (existsSync(srcDir)) {
        _copyDirRecursive(srcDir, destDir, opts);
        newHistories.push({ ...h, path: destDir, bundleRelPath: undefined });
        imported++;
      }
    } else {
      // No data in bundle — import metadata only
      newHistories.push({ ...h, bundleRelPath: undefined });
      imported++;
    }
  }

  return { histories: newHistories, imported, skipped };
}

module.exports = { exportBundle, readBundleManifest, importBundle, MANIFEST_FILE };
