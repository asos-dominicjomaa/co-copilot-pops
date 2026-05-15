'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

/**
 * Recursively add all files in a directory to a JSZip instance.
 * @param {JSZip} zip
 * @param {string} dir — absolute directory to walk
 * @param {string} zipPrefix — prefix inside the zip
 * @param {{ readdirSync?: Function, statSync?: Function, readFileSync?: Function }} [opts]
 */
function addDirToZip(zip, dir, zipPrefix, opts = {}) {
  const readdirSync = opts.readdirSync || fs.readdirSync;
  const statSync = opts.statSync || fs.statSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry}` : entry;
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        addDirToZip(zip, fullPath, zipPath, opts);
      } else {
        zip.file(zipPath, readFileSync(fullPath));
      }
    } catch { /* skip unreadable entries */ }
  }
}

/**
 * Build a zip buffer containing all histories and a manifest.
 * @param {string} globalStoragePath — context.globalStorageUri.fsPath
 * @param {Array<object>} histories — from globalState
 * @param {{ readdirSync?: Function, statSync?: Function, readFileSync?: Function, existsSync?: Function }} [opts]
 * @returns {Promise<Buffer>}
 */
async function buildExportZip(globalStoragePath, histories, opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const zip = new JSZip();

  // Write manifest
  zip.file('manifest.json', JSON.stringify({ version: 1, histories }, null, 2));

  // Add each history folder that lives inside globalStorage
  for (const h of histories) {
    if (!h.path || !existsSync(h.path)) continue;
    // Only include folders that are inside globalStoragePath (skip externally-added folders)
    if (!h.path.startsWith(globalStoragePath)) continue;
    const rel = path.relative(globalStoragePath, h.path);
    addDirToZip(zip, h.path, rel, opts);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/**
 * Extract an export zip into globalStoragePath and return the manifest histories.
 * @param {Buffer|ArrayBuffer} zipBuffer
 * @param {string} globalStoragePath
 * @param {{ mkdirSync?: Function, writeFileSync?: Function }} [opts]
 * @returns {Promise<Array<object>>} histories from the manifest
 */
async function extractImportZip(zipBuffer, globalStoragePath, opts = {}) {
  const mkdirSync = opts.mkdirSync || fs.mkdirSync;
  const writeFileSync = opts.writeFileSync || fs.writeFileSync;

  const zip = await JSZip.loadAsync(zipBuffer);

  // Read manifest first
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('Invalid export file — manifest.json missing');
  const manifest = JSON.parse(await manifestFile.async('string'));
  if (!manifest.histories) throw new Error('Invalid manifest — no histories array');

  // Extract all non-manifest files
  const writes = [];
  zip.forEach((relativePath, file) => {
    if (relativePath === 'manifest.json' || file.dir) return;
    writes.push(
      file.async('nodebuffer').then(data => {
        const destPath = path.join(globalStoragePath, relativePath);
        mkdirSync(path.dirname(destPath), { recursive: true });
        writeFileSync(destPath, data);
      })
    );
  });
  await Promise.all(writes);

  // Rewrite history paths to point to the new globalStorage location
  return manifest.histories.map(h => {
    if (!h.path) return h;
    // If path was inside globalStorage, remap to current globalStoragePath
    const basename = path.basename(h.path);
    const newPath = path.join(globalStoragePath, basename);
    return { ...h, path: newPath };
  });
}

module.exports = { buildExportZip, extractImportZip, addDirToZip };
