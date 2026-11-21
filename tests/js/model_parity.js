// Model parity runner: runs the JS model (web/model/) on a dumped
// extract and compares against the Python build_model intermediate dump.
//
//   node tests/js/model_parity.js <extracted.json> <model_req.json>
//        [--cols a,b,...]
//
// Compares these m.req columns (pairing row order):
//   dev, sector, t_ins, ins_utid, t_iss0, t_iss, iss_utid, t_cmp, err,
//   bytes, nr_sector, rwbs, issue_count, cmp_lost, incomplete, op, cat,
//   t_make, mk_pid, mk_utid, cls, lvl, ux, fg_meta, utid, prio, q_ns,
//   svc_ns, total_ns, req_id, tag, rq_n, rq_reason, slot, lanes
// plus m.requeues (all rows in order) and m.counters.
// Prints up to 20 mismatches per column; exits non-zero on any mismatch.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadWeb, REPO } = require('./_load.js');

const REQ_COLS = [
  'dev', 'sector', 't_ins', 'ins_utid', 't_iss0', 't_iss', 'iss_utid',
  't_cmp', 'err', 'bytes', 'nr_sector', 'rwbs', 'issue_count', 'cmp_lost',
  'incomplete', 'op', 'cat', 't_make', 'mk_pid', 'mk_utid', 'cls', 'lvl',
  'ux', 'fg_meta', 'utid', 'prio', 'q_ns', 'svc_ns', 'total_ns', 'req_id',
  'tag', 'rq_n', 'rq_reason', 'slot', 'lanes',
];
const REQUEUE_COLS = ['ts', 'req', 'reason'];
const MAX_SHOW = 20;

function isNull(v) {
  return v === null || v === undefined ||
    (typeof v === 'number' && Number.isNaN(v));
}

function valEq(a, b) {
  const an = isNull(a), bn = isNull(b);
  if (an || bn) return an && bn;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: node tests/js/model_parity.js ' +
      '<extracted.json> <model_req.json> [--cols a,b,...]');
    process.exit(2);
  }
  let cols = REQ_COLS;
  const ci = args.indexOf('--cols');
  if (ci >= 0) {
    cols = args[ci + 1].split(',').filter(Boolean);
    args.splice(ci, 2);
  }
  const exPath = path.resolve(args[0]);
  const modelPath = path.resolve(args[1]);
  const ex = JSON.parse(fs.readFileSync(exPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

  const BLK = loadWeb([
    'web/model/frame.js',
    'web/model/req.js',
  ]);
  const t0 = Date.now();
  const got = BLK.model.buildReqs(ex);
  const jsMs = Date.now() - t0;
  console.log(`js model: ${jsMs} ms`);

  let bad = 0;
  const reqGot = got.req, reqExp = expected.req;
  const nG = reqGot.columns.length
    ? (reqGot.data[reqGot.columns[0]] || []).length : 0;
  const nE = reqExp.columns.length
    ? (reqExp.data[reqExp.columns[0]] || []).length : 0;
  if (nG !== nE) {
    console.log(`req rows: js=${nG} python=${nE}`);
    bad++;
  }
  const n = Math.min(nG, nE);
  for (const c of cols) {
    const ga = reqGot.data[c] || new Array(n).fill(null);
    const ea = reqExp.data[c] || new Array(n).fill(null);
    let shown = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (!valEq(ga[i], ea[i])) {
        count++;
        if (shown < MAX_SHOW) {
          console.log(`req.${c}[${i}]: js=${JSON.stringify(ga[i])} ` +
            `python=${JSON.stringify(ea[i])}`);
          shown++;
        }
      }
    }
    if (count) {
      console.log(`req.${c}: ${count} mismatch(es)`);
      bad++;
    }
  }

  const rqG = got.requeues, rqE = expected.requeues;
  const mG = rqG.data[rqG.columns[0]] ? rqG.data[rqG.columns[0]].length : 0;
  const mE = rqE.data[rqE.columns[0]] ? rqE.data[rqE.columns[0]].length : 0;
  if (mG !== mE) {
    console.log(`requeues rows: js=${mG} python=${mE}`);
    bad++;
  }
  for (const c of REQUEUE_COLS) {
    const ga = rqG.data[c] || [];
    const ea = rqE.data[c] || [];
    let shown = 0, count = 0;
    for (let i = 0; i < Math.min(mG, mE); i++) {
      if (!valEq(ga[i], ea[i])) {
        count++;
        if (shown < MAX_SHOW) {
          console.log(`requeues.${c}[${i}]: js=${JSON.stringify(ga[i])} ` +
            `python=${JSON.stringify(ea[i])}`);
          shown++;
        }
      }
    }
    if (count) {
      console.log(`requeues.${c}: ${count} mismatch(es)`);
      bad++;
    }
  }

  const cG = got.counters || {}, cE = expected.counters || {};
  for (const k of new Set([...Object.keys(cG), ...Object.keys(cE)])) {
    if (!valEq(cG[k], cE[k])) {
      console.log(`counters.${k}: js=${JSON.stringify(cG[k])} ` +
        `python=${JSON.stringify(cE[k])}`);
      bad++;
    }
  }

  console.log(bad ? `FAIL: ${bad} column/field group(s) differ`
                  : 'OK: model parity');
  process.exit(bad ? 1 : 0);
}

main();
