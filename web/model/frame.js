/* BLK.frame: columnar helpers for the JS model port (web/model/).
 *
 * Semantics mirror pandas where the model relies on them:
 *  - missing = null (JSON nulls; isNull also treats NaN/undefined as missing)
 *  - sorts are ALWAYS stable: pandas multi-column sort_values is stable
 *    (lexsort) and single-column quicksort is not, but every place where
 *    ties matter uses explicit kind="stable" on the Python side.
 *  - nulls sort last (pandas na_position='last'), both in argsort and in
 *    groupBy key ordering (pandas groupby also DROPS NaN keys).
 *  - mergeAsof mirrors pandas.merge_asof on numeric keys:
 *      backward: last right row (in sorted order) with on <= left on
 *      forward:  first right row with on >= left on
 *      nearest:  smaller |diff| of the two candidates, tie -> backward
 *      by-keys:  exact equality, and (pandas 3.x) null by-keys match other
 *                null by-keys; left rows with null 'on' never match
 *      tolerance: inclusive (|left - right| <= tol)
 *
 * INT64 WARNING for P4b: model.py's file key `s_dev * 2**40 + ino` exceeds
 * 2^53 (e.g. 65155 * 2^40 ≈ 7e16) — NEVER compute it as a JS Number. Use
 * composite string keys (e.g. `sdev + ':' + ino`) or nested Maps.
 *
 * Classic script, no modules. Exposes globalThis.BLK.frame.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = (BLK.frame = {});

  const isNull = function (v) {
    return v === null || v === undefined ||
      (typeof v === 'number' && Number.isNaN(v));
  };
  frame.isNull = isNull;

  /* pandas-like ascending compare: null last; numbers numerically;
   * strings lexically. */
  function cmpVal(a, b) {
    const na = isNull(a);
    const nb = isNull(b);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (a < b) return -1;
    if (a > b) return 1;
    if (a === b) return 0;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
  frame.cmpVal = cmpVal;

  /* Per-column numeric sort key for argsort: numbers sort by value with
   * missing -> +Infinity (nulls last); columns containing non-numeric
   * values are dictionary-encoded into cmpVal-ordered ranks (missing ->
   * last rank). Keeps the comparator free of isNull/cmpVal calls. */
  function sortKey(col, n) {
    let numeric = true;
    for (let i = 0; i < n; i++) {
      const v = col[i];
      if (v !== null && v !== undefined && typeof v !== 'number') {
        numeric = false;
        break;
      }
    }
    const key = new Float64Array(n);
    if (numeric) {
      for (let i = 0; i < n; i++) {
        const v = col[i];
        key[i] = (v === null || v === undefined || v !== v)
          ? Infinity : v;
      }
      return key;
    }
    const uniq = new Map();
    for (let i = 0; i < n; i++) {
      const v = col[i];
      if (!isNull(v) && !uniq.has(v)) uniq.set(v, null);
    }
    const vals = Array.from(uniq.keys());
    vals.sort(cmpVal);
    for (let r = 0; r < vals.length; r++) uniq.set(vals[r], r);
    const miss = vals.length;
    for (let i = 0; i < n; i++) {
      const v = col[i];
      key[i] = isNull(v) ? miss : uniq.get(v);
    }
    return key;
  }

  /* Stable argsort over one or more column arrays, ascending, nulls last.
   * cols = [col0, col1, ...] each of length n; returns Int32Array of row
   * indices in sorted order (ties keep original index order). */
  frame.argsort = function (cols, n) {
    const keys = cols.map(function (c) { return sortKey(c, n); });
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    const nk = keys.length;
    // Array.prototype.sort is stable in modern engines; a packed-SMI
    // index array sorts faster than a TypedArray with a JS comparator.
    arr.sort(function (a, b) {
      for (let k = 0; k < nk; k++) {
        const d = keys[k][a] - keys[k][b];
        if (d) return d;
      }
      return a - b;
    });
    return arr;
  };

  /* Stable argsort of a single column array. */
  frame.argsort1 = function (col, n) {
    return frame.argsort([col], n === undefined ? col.length : n);
  };

  /* pandas groupby: groups row indices by the value(s) of keyCols,
   * iterating keys in sorted ascending order, NaN keys DROPPED.
   * Returns array of {key, idxs} where key is the single value
   * (keyCols.length == 1) or an array of values. */
  frame.groupBy = function (keyCols, n) {
    const map = new Map(); // encoded -> {key, idxs}
    const single = keyCols.length === 1;
    for (let i = 0; i < n; i++) {
      let enc;
      let key;
      if (single) {
        const v = keyCols[0][i];
        if (isNull(v)) continue;
        key = v;
        enc = encodeKeyVal(v);
      } else {
        const parts = [];
        let skip = false;
        for (const c of keyCols) {
          const v = c[i];
          if (isNull(v)) { skip = true; break; }
          parts.push(v);
        }
        if (skip) continue;
        key = parts;
        enc = parts.map(encodeKeyVal).join('\x01');
      }
      let g = map.get(enc);
      if (!g) {
        g = { key: key, idxs: [] };
        map.set(enc, g);
      }
      g.idxs.push(i);
    }
    const groups = Array.from(map.values());
    groups.sort(function (a, b) {
      const ka = Array.isArray(a.key) ? a.key : [a.key];
      const kb = Array.isArray(b.key) ? b.key : [b.key];
      for (let i = 0; i < ka.length; i++) {
        const d = cmpVal(ka[i], kb[i]);
        if (d) return d;
      }
      return 0;
    });
    return groups;
  };

  /* Canonical encoding of a by-key component: numbers and nulls get a
   * distinct encoding so NaN-by matches NaN-by (pandas 3.x) and types
   * never collide. */
  function encodeKeyVal(v) {
    if (isNull(v)) return '\x00';
    if (typeof v === 'number') return '#' + v;
    return 's' + String(v);
  }
  frame.encodeKeyVal = encodeKeyVal;

  frame.byKey = function (vals) {
    let s = '';
    for (let i = 0; i < vals.length; i++) {
      if (i) s += '\x01';
      s += encodeKeyVal(vals[i]);
    }
    return s;
  };

  /* Numeric by-key array for mergeAsof: Float64Array with missing ->
   * NaN. NaN is a valid Map key under SameValueZero, so NaN by-keys
   * match NaN by-keys — the same semantics as encodeKeyVal's '\x00',
   * without building a string per row. */
  frame.numBy = function (col, n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = col[i];
      out[i] = (v === null || v === undefined || v !== v) ? NaN : v;
    }
    return out;
  };

  /* pandas.merge_asof on numeric keys.
   *   leftOn:   left 'on' values in LEFT ROW ORDER (output aligns to it)
   *   rightOn:  right 'on' values in SORTED order
   *   leftBy:   optional array of encoded by-keys (frame.byKey) per left row
   *   rightBy:  same per right row (aligned with rightOn)
   *   direction 'backward' | 'forward' | 'nearest'
   *   tolerance: inclusive; undefined/null = no tolerance
   *   allowExactMatches: default true
   * Returns Int32Array: per left row the right ROW INDEX (into rightOn/
   * rightBy), or -1. Both arrays must already be sorted by 'on'. */
  frame.mergeAsof = function (opts) {
    const leftOn = opts.leftOn;
    const rightOn = opts.rightOn;
    const leftBy = opts.leftBy || null;
    const rightBy = opts.rightBy || null;
    const dir = opts.direction || 'backward';
    const tol = opts.tolerance;
    const exact = opts.allowExactMatches !== false;
    const nl = leftOn.length;
    const nr = rightOn.length;
    const out = new Int32Array(nl).fill(-1);

    // by-key -> sorted list of right indices
    let groups = null;
    let all = null;
    if (rightBy) {
      groups = new Map();
      for (let j = 0; j < nr; j++) {
        const v = rightOn[j];
        if (v === null || v === undefined || v !== v) continue;
        const k = rightBy[j];
        let l = groups.get(k);
        if (!l) { l = []; groups.set(k, l); }
        l.push(j);
      }
    } else {
      all = [];
      for (let j = 0; j < nr; j++) {
        const v = rightOn[j];
        if (!(v === null || v === undefined || v !== v)) all.push(j);
      }
    }

    function upperBound(list, x, strict) {
      // first position with on > x (strict=false) or >= x (strict=true)
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const v = rightOn[list[mid]];
        if (strict ? v >= x : v > x) hi = mid; else lo = mid + 1;
      }
      return lo;
    }

    function bwd(list, x) {
      const p = upperBound(list, x, !exact) - 1;
      if (p < 0) return -1;
      return list[p];
    }
    function fwd(list, x) {
      // exact -> first on >= x; !exact -> first on > x
      const p = upperBound(list, x, exact);
      if (p >= list.length) return -1;
      return list[p];
    }

    for (let i = 0; i < nl; i++) {
      const x = leftOn[i];
      if (x === null || x === undefined || x !== x) continue;
      const list = groups ? groups.get(leftBy[i]) : all;
      if (!list || !list.length) continue;
      let j = -1;
      if (dir === 'backward') {
        j = bwd(list, x);
        if (j >= 0 && tol !== undefined && tol !== null &&
            x - rightOn[j] > tol) j = -1;
      } else if (dir === 'forward') {
        j = fwd(list, x);
        if (j >= 0 && tol !== undefined && tol !== null &&
            rightOn[j] - x > tol) j = -1;
      } else {
        const jb = bwd(list, x);
        const jf = fwd(list, x);
        if (jb < 0) j = jf;
        else if (jf < 0) j = jb;
        else {
          const db = x - rightOn[jb];
          const df = rightOn[jf] - x;
          j = db <= df ? jb : jf;   // tie -> backward
        }
        if (j >= 0 && tol !== undefined && tol !== null &&
            Math.abs(rightOn[j] - x) > tol) j = -1;
      }
      out[i] = j;
    }
    return out;
  };

  /* Python string ordering: pandas sorts/modes strings by code POINT,
   * while JS '<' compares UTF-16 code units (they differ only beyond the
   * BMP). UTF-8 byte order is identical to code-point order, so compare
   * the encodings. */
  const _te = new TextEncoder();
  frame.cmpStr = function (a, b) {
    if (a === b) return 0;
    const ba = _te.encode(String(a));
    const bb = _te.encode(String(b));
    const n = Math.min(ba.length, bb.length);
    for (let i = 0; i < n; i++) {
      if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
    }
    return ba.length - bb.length;
  };

  /* pd.to_numeric(errors='coerce') equivalent: returns a number or NaN.
   * Accepts decimal/int/float/inf/nan literals like pandas. */
  const NUM_RE = /^[\s]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[\s]*$/;
  const NUM_WORD = { 'inf': Infinity, '+inf': Infinity, 'infinity': Infinity,
    '+infinity': Infinity, '-inf': -Infinity, '-infinity': -Infinity,
    'nan': NaN };
  frame.pyToNumber = function (v) {
    if (v === null || v === undefined) return NaN;
    const t = typeof v;
    if (t === 'number') return v;
    if (t === 'boolean') return v ? 1 : 0;
    if (t === 'string') {
      const s = v.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(NUM_WORD, s)) {
        return NUM_WORD[s];
      }
      if (!s || !NUM_RE.test(s)) return NaN;
      return Number(s);
    }
    return NaN;
  };

  /* Python '%.*f' formatting: round-half-EVEN on the exact binary value
   * of the double (JS toFixed rounds ties up). Exact arithmetic on the
   * mantissa: |x| = mant * 2^exp2; scaled = |x| * 10^n = mant*5^n * 2^(n+exp2),
   * rounded to an integer with ties-to-even. */
  frame.pyFixed = function (x, n) {
    if (!isFinite(x)) return x !== x ? 'nan' : (x < 0 ? '-inf' : 'inf');
    const neg = x < 0 || Object.is(x, -0);
    const buf = new ArrayBuffer(8);
    const f64 = new Float64Array(buf);
    const u32 = new Uint32Array(buf);
    f64[0] = Math.abs(x);
    const hi = u32[1], lo = u32[0];
    const expBits = (hi >>> 20) & 0x7ff;
    let mantHi, exp2;
    if (expBits === 0) {          // subnormal: no implicit leading bit
      mantHi = hi & 0xfffff;
      exp2 = -1074;
    } else {
      mantHi = (hi & 0xfffff) | 0x100000;
      exp2 = expBits - 1075;
    }
    let num = (BigInt(mantHi) * 4294967296n + BigInt(lo)) *
      (5n ** BigInt(n));
    const shift = n + exp2;
    let q;
    if (shift >= 0) {
      q = num << BigInt(shift);   // already integral
    } else {
      const d = 1n << BigInt(-shift);
      q = num / d;
      const cmp = (num % d) * 2n - d;    // remainder vs divisor/2
      if (cmp > 0n || (cmp === 0n && (q & 1n))) q += 1n;
    }
    let s = q.toString();
    if (n > 0) {
      while (s.length <= n) s = '0' + s;
      s = s.slice(0, -n) + '.' + s.slice(-n);
    }
    return (neg ? '-' : '') + s;
  };

  /* Binary min-heap with comparator (for heapq port: heap of tuples). */
  frame.Heap = class {
    constructor(cmp) {
      this.cmp = cmp || ((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.a = [];
    }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    push(v) {
      const a = this.a, cmp = this.cmp;
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (cmp(a[i], a[p]) < 0) {
          const t = a[i]; a[i] = a[p]; a[p] = t; i = p;
        } else break;
      }
    }
    pop() {
      const a = this.a, cmp = this.cmp;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          let m = i;
          const l = 2 * i + 1, r = l + 1;
          if (l < a.length && cmp(a[l], a[m]) < 0) m = l;
          if (r < a.length && cmp(a[r], a[m]) < 0) m = r;
          if (m === i) break;
          const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
        }
      }
      return top;
    }
  };

  /* Columnar table constructor. */
  frame.table = function (columns, data) {
    return { columns: columns.slice(), data: data };
  };

  frame.emptyTable = function (columns) {
    const data = {};
    for (const c of columns) data[c] = [];
    return { columns: columns.slice(), data: data };
  };

  frame.nrows = function (t) {
    return t.columns.length ? t.data[t.columns[0]].length : 0;
  };
})();
