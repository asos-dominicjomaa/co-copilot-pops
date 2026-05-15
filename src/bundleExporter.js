'use strict';

const fs = require('fs');
const path = require('path');
const { copyDirRecursive } = require('./workspaceBackup');

const MANIFEST_FILE = 'co-pilot-pops-manifest.json';
const MANIFEST_VERSION = 1;

/**
 * Export all histories (and their backup data) to a destination folder.
 * Histories whose path lives inside globalStorageDir are fully copied.
 * External histories have their metadata exported but data is not copied.
 *
 * @param {Array<object>} histories
 * @param {string} globalStorageDir — context.globalStorageUri.fsPath
 * @param {string} destDir — user-chosen export destination folder
 * @returns {{ exported: number, skipped: number }}
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
    const isInternal = h.path && h.path.startsWith(globalStorageDir);
    if (isInternal && existsSync(h.path)) {
      const dirName = path.relative(globalStorageDir, h.path);
      const dest = path.join(destDir, dirName);
      _copyDirRecursive(h.path, dest, opts);
      manifestHistories.push({ ...h, bundleRelPath: dirName });
      exported++;
    } else {
      // External history — save metadata only, no data
      manifestHistories.push({ ...h, bundleRelPath: null });
      skipped++;
    }
  }

  const manifest = {
    version: MANIFEST_VERSION,
    app: 'co-pilot-pops',
    exportedAt: Date.now(),
    histories: manifestHistories,
  };
  writeFileSync(path.join(destDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

  return { exported, skipped };
}

/**
 * Check if a folder is a Co-Pilot-Pops export bundle.
 * @param {string} folderPath
 * @returns {object|null} parsed manifest or null
 */
function readBundleManifest(folderPath, opts = {}) {
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const manifestPath = path.join(folderPath, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.app !== 'co-pilot-pops' || !Array.isArray(manifest.histories)) return null;
    return manifest;
  } catch { return null; }
}

/**
 * Import histories from a bundle into the extension's globalStorage.
 * Copies backup dirs and returns updated history entries.
 *
 * @param {object} manifest — from readBundleManifest
 * @param {string} bundleDir — the export folder
 * @param {string} globalStorageDir
 * @param {Array<object>} existingHistories — current histories to avoid duplicates
 * @returns {{ histories: Array<object>, imported: number, skipped: number }}
 */
function importBundle(manifest, bundleDir, globalStorageDir, existingHistories = [], opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const existsSync = opts.existsSync || fs.existsSync;
  const _copyDirRecursive = opts.copyDirRecursive || copyDirRecursive;

  mkdirSync(globalStorageDir, { recursive: true });

  const newHistories = [];
  let imported = 0;
  let skipped = 0;

  for (const h of manifest.histories) {
    // Skip if already present by id
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
      // External history — import metadata only, path may not exist on new machine
      newHistories.push({ ...h, bundleRelPath: undefined });
      imported++;
    }
  }

  return { histories: newHistories, imported, skipped };
}

module.exports = { exportBundle, readBundleManifest, importBundle, MANIFEST_FILE };
