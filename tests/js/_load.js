// Load blkscope web/ classic scripts into one vm context and return its BLK.
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

function loadWeb(relPaths, extraGlobals) {
  const ctx = vm.createContext(Object.assign(
    { console, TextEncoder, TextDecoder, setTimeout, queueMicrotask },
    extraGlobals || {}));
  for (const rel of relPaths) {
    const file = path.join(REPO, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return ctx.BLK;
}

module.exports = { loadWeb, REPO };
