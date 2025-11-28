#!/usr/bin/env node
/**
 * Ensures every build ships with a unique bundle filename so Forge's CDN
 * does not keep serving a stale cached asset. We detect the Parcel output
 * referenced from build/index.html, append a timestamp, rename the file,
 * and update the HTML reference (plus the source map if present).
 */
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const indexPath = path.join(buildDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  throw new Error('Cannot locate build/index.html – run the Parcel build first.');
}

const html = fs.readFileSync(indexPath, 'utf8');
const scriptMatch = html.match(/src=(?:"|')?(admin-page\.[^"'>]+\.js)/);

if (!scriptMatch) {
  throw new Error('Unable to find admin-page bundle reference in index.html');
}

const originalName = scriptMatch[1];
const timestamp = Date.now().toString();
const newName = originalName.replace(/\.js$/, `.${timestamp}.js`);

const originalPath = path.join(buildDir, originalName);
const newPath = path.join(buildDir, newName);

if (!fs.existsSync(originalPath)) {
  throw new Error(`Bundle ${originalName} not found under build/`);
}

fs.renameSync(originalPath, newPath);

const originalMapPath = `${originalPath}.map`;
if (fs.existsSync(originalMapPath)) {
  fs.renameSync(originalMapPath, `${newPath}.map`);
}

const updatedHtml = html.replace(originalName, newName);
fs.writeFileSync(indexPath, updatedHtml, 'utf8');

const metadataPath = path.join(buildDir, 'cache-bust.json');
const metadata = {
  original: originalName,
  renamed: newName,
  timestamp,
  generatedAt: new Date().toISOString()
};
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

console.log(`Cache bust applied: ${originalName} -> ${newName}`);
