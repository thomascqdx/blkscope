// Full payload parity runner: runs BLK.analyze (web/model/) on a dumped
// extract and deep-compares EVERYTHING against the Python
// build_payload dump, passing generated/toolVersion through.
//
//   node tests/js/payload_parity.js <extracted.json> <payload.json>
//
// Prints up to 20 mismatches per path; exits non-zero on any mismatch.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadWeb } = require('./_load.js');

const MAX_SHOW = 20;
let bad = 0;
const shown = new Map();

function report(p, js, py) {
  bad++;
  const n = shown.get(p) || 0;
  if (n < MAX_SHOW) {
    shown.set(p, n + 1);
    console.log(`${p}: js=${JSON.stringify(js)} ` +
      `python=${JSON.stringify(py)}`);
  }
}

function isNull(v) {
  return v === null || v === undefined ||
    (typeof v === 'number' && Number.isNaN(v));
}

function cmp(p, js, py) {
  const jn = isNull(js), pn = isNull(py);
  if (jn || pn) {
    if (!(jn && pn)) report(p, js, py);
    return;
  }
  if (typeof js === 'number' && typeof py === 'number') {
    if (js !== py) report(p, js, py);
    return;
  }
  if (typeof js !== typeof py) { report(p, js, py); return; }
  if (typeof js !== 'object') {
    if (js !== py) report(p, js, py);
    return;
  }
  if (Array.isArray(js) || Array.isArray(py)) {
    if (!Array.isArray(js) || !Array.isArray(py)) {
      report(p, js, py);
      return;
    }
    if (js.length !== py.length) {
      report(p + '.length', js.length, py.length);
      return;
    }
    for (let i = 0; i < js.length; i++) {
      cmp(p + '[' + i + ']', js[i], py[i]);
    }
    return;
  }
  const keys = new Set([...Object.keys(js), ...Object.keys(py)]);
  for (const k of keys) {
    if (!(k in js)) { report(p + '.' + k, undefined, py[k]); continue; }
    if (!(k in py)) { report(p + '.' + k, js[k], undefined); continue; }
    cmp(p + '.' + k, js[k], py[k]);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: node tests/js/payload_parity.js ' +
      '<extracted.json> <payload.json>');
    process.exit(2);
  }
  const ex = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  const expected = JSON.parse(
    fs.readFileSync(path.resolve(args[1]), 'utf8'));

  const BLK = loadWeb([
    'web/model/frame.js',
    'web/model/req.js',
    'web/model/files.js',
    'web/model/dstate.js',
    'web/model/model.js',
    'web/model/payload.js',
  ]);
  const meta = expected.meta || {};
  const t0 = Date.now();
  const got = BLK.analyze(ex, {
    name: meta.name,
    source: meta.source,
    toolVersion: meta.tool_version,
    generated: meta.generated,
  });
  const jsMs = Date.now() - t0;
  console.log(`js analyze: ${jsMs} ms`);

  cmp('payload', got.payload, expected);

  // total mismatch count (per-path counts were capped at MAX_SHOW)
  if (bad) {
    console.log(`FAIL: ${bad} difference(s)`);
    process.exit(1);
  }
  console.log('OK: payload parity');
}

main();
