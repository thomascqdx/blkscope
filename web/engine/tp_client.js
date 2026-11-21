/* BLK.TpClient: trace_processor RPC client over a MessagePort.
 *
 * Talks the same wire protocol as the Python perfetto library's HTTP /rpc
 * endpoint: a stream of length-delimited TraceProcessorRpc messages (each
 * framed as field 1 of TraceProcessorRpcStream = tag 0x0A + varint length).
 * Requests carry a monotonically increasing seq; responses carry the
 * request's method in `response` and arrive strictly in request order, so
 * they are matched FIFO against the pending queue. Responses for a single
 * request may be fragmented across several port messages and (for
 * TPM_QUERY_STREAMING) arrive as multiple messages.
 *
 * Field numbers come from protos/perfetto/trace_processor/trace_processor.proto
 * (perfetto v57.2, trace_processor.descriptor in the Python perfetto package).
 *
 * Classic script, no modules. Exposes globalThis.BLK.TpClient.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const proto = BLK.proto;

  // TraceProcessorRpc.TraceProcessorMethod
  const TPM = {
    APPEND_TRACE_DATA: 1,
    FINALIZE_TRACE_DATA: 2,
    QUERY_STREAMING: 3,
    GET_STATUS: 10,
    RESET_TRACE_PROCESSOR: 11,
  };

  // TraceProcessorRpc field numbers
  const F_SEQ = 1;
  const F_REQUEST = 2;
  const F_RESPONSE = 3;
  const F_INVALID_REQUEST = 4;
  const F_FATAL_ERROR = 5;
  const F_APPEND_TRACE_DATA = 101; // bytes: raw trace chunk
  const F_QUERY_ARGS = 103; // QueryArgs
  const F_RESET_ARGS = 107; // ResetTraceProcessorArgs
  const F_APPEND_RESULT = 201; // AppendTraceDataResult
  const F_QUERY_RESULT = 203; // QueryResult
  const F_STATUS = 210; // StatusResult
  const F_FINALIZE_RESULT = 212; // FinalizeDataResult

  // QueryResult.CellsBatch.CellType
  const CELL_NULL = 1;
  const CELL_VARINT = 2;
  const CELL_FLOAT64 = 3;
  const CELL_STRING = 4;
  const CELL_BLOB = 5;

  const MAX_SAFE = 9007199254740991n;

  /* Accumulates response bytes and yields whole TraceProcessorRpc frames. */
  class FrameStream {
    constructor() {
      this.chunks = [];
      this.len = 0;
    }

    push(u8) {
      this.chunks.push(u8);
      this.len += u8.length;
    }

    _flat(n) {
      const out = new Uint8Array(n);
      let off = 0;
      for (const c of this.chunks) {
        if (off >= n) break;
        const take = Math.min(c.length, n - off);
        out.set(c.subarray(0, take), off);
        off += take;
      }
      return out;
    }

    _drop(n) {
      while (n > 0) {
        const c = this.chunks[0];
        if (c.length <= n) {
          n -= c.length;
          this.chunks.shift();
        } else {
          this.chunks[0] = c.subarray(n);
          n = 0;
        }
      }
    }

    /* Returns the next framed TraceProcessorRpc body, or null if the
     * buffered bytes do not yet contain a complete frame. */
    next() {
      if (this.len < 2) return null;
      const head = this._flat(Math.min(this.len, 11));
      if (head[0] !== 0x0a) {
        throw new Error('rpc stream: expected msg frame tag 0x0a, got 0x' +
          head[0].toString(16));
      }
      let len = 0;
      let shift = 0;
      let i = 1;
      for (;;) {
        if (i >= head.length) return null; // need more header bytes
        const b = head[i++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (this.len < i + len) return null;
      const frame = this._flat(i + len).subarray(i);
      // consume
      let n = i + len;
      while (n > 0) {
        const c = this.chunks[0];
        if (c.length <= n) {
          n -= c.length;
          this.chunks.shift();
        } else {
          this.chunks[0] = c.subarray(n);
          n = 0;
        }
      }
      this.len -= i + len;
      return frame;
    }
  }

  function decodeStrings(u8) {
    // string_cells is one big string of NUL-separated values with a
    // trailing NUL (same layout as the Python lib expects).
    const s = proto.decodeString(u8, 0, u8.length);
    const parts = s.split('\0');
    if (parts.length) parts.pop();
    return parts;
  }

  function decodeCellsBatch(u8) {
    const r = new proto.Reader(u8);
    const out = {
      types: [], varints: [], floats: [], blobs: [], strings: null,
      isLast: false,
    };
    while (!r.eof()) {
      const [field, wire] = r.tag();
      if (field === 1 && wire === 2) {
        const packed = r.bytes();
        const pr = new proto.Reader(packed);
        while (!pr.eof()) out.types.push(Number(pr.varint()));
      } else if (field === 1 && wire === 0) {
        out.types.push(Number(r.varint()));
      } else if (field === 2 && wire === 2) {
        const packed = r.bytes();
        const pr = new proto.Reader(packed);
        while (!pr.eof()) out.varints.push(pr.int64());
      } else if (field === 2 && wire === 0) {
        out.varints.push(r.int64());
      } else if (field === 3 && wire === 2) {
        const packed = r.bytes();
        const n = packed.length >> 3;
        const dv = new DataView(packed.buffer, packed.byteOffset);
        for (let k = 0; k < n; k++) out.floats.push(dv.getFloat64(k * 8, true));
      } else if (field === 3 && wire === 1) {
        out.floats.push(r.double());
      } else if (field === 4 && wire === 2) {
        out.blobs.push(r.bytes());
      } else if (field === 5 && wire === 2) {
        out.strings = decodeStrings(r.bytes());
      } else if (field === 6 && wire === 0) {
        out.isLast = Number(r.varint()) !== 0;
      } else {
        r.skip(wire);
      }
    }
    return out;
  }

  class TpClient {
    /* port: MessagePort-like ({postMessage, onmessage}). */
    constructor(port) {
      this._port = port;
      this._seq = 0;
      this._rx = new FrameStream();
      this._pending = [];
      this._fatal = null;
      const self = this;
      port.onmessage = function (ev) {
        try {
          self._onBytes(ev.data);
        } catch (e) {
          self._failAll(e);
        }
      };
    }

    _failAll(err) {
      this._fatal = this._fatal || err;
      for (const p of this._pending.splice(0)) p.reject(this._fatal);
    }

    _onBytes(u8) {
      this._rx.push(u8);
      for (;;) {
        const frame = this._rx.next();
        if (frame === null) return;
        this._onRpc(frame);
      }
    }

    _onRpc(u8) {
      const r = new proto.Reader(u8);
      let response = 0;
      let fatalError = null;
      let invalid = 0;
      let resultField = 0;
      let resultBytes = null;
      while (!r.eof()) {
        const [field, wire] = r.tag();
        if (field === F_RESPONSE && wire === 0) {
          response = Number(r.varint());
        } else if (field === F_FATAL_ERROR && wire === 2) {
          const b = r.bytes();
          fatalError = proto.decodeString(b, 0, b.length);
        } else if (field === F_INVALID_REQUEST && wire === 0) {
          invalid = Number(r.varint());
        } else if (field === F_SEQ && wire === 0) {
          r.varint();
        } else if (wire === 2 && (field === F_APPEND_RESULT ||
            field === F_QUERY_RESULT || field === F_FINALIZE_RESULT ||
            field === F_STATUS)) {
          resultField = field;
          resultBytes = r.bytes();
        } else {
          r.skip(wire);
        }
      }
      if (fatalError !== null) {
        this._failAll(new Error('trace_processor fatal error: ' + fatalError));
        return;
      }
      const head = this._pending[0];
      if (!head) {
        throw new Error('rpc: unexpected response (no pending request)');
      }
      if (invalid) {
        this._pending.shift();
        head.reject(new Error('rpc: invalid_request=' + invalid));
        return;
      }
      if (response !== head.method) {
        this._pending.shift();
        head.reject(new Error('rpc: response method ' + response +
          ' does not match pending request ' + head.method));
        return;
      }
      let done;
      try {
        done = head.onResponse(resultField, resultBytes);
      } catch (e) {
        this._pending.shift();
        head.reject(e);
        return;
      }
      if (done) {
        this._pending.shift();
        head.resolve(head.value);
      }
    }

    _request(method, buildArgs, onResponse) {
      if (this._fatal) return Promise.reject(this._fatal);
      const w = new proto.Writer();
      const seq = ++this._seq;
      w.varintField(F_SEQ, seq);
      w.varintField(F_REQUEST, method);
      if (buildArgs) buildArgs(w);
      const rpc = w.finish();

      // Frame as TraceProcessorRpcStream.msg (field 1, length-delimited).
      const frame = new proto.Writer();
      frame.bytesField(1, rpc);
      const bytes = frame.finish();

      return new Promise((resolve, reject) => {
        this._pending.push({
          method, resolve, reject, onResponse, value: undefined,
        });
        this._port.postMessage(bytes, [bytes.buffer]);
      });
    }

    /* TPM_RESET_TRACE_PROCESSOR. Mirrors the native
     * trace_processor_shell default used by blkscope.tp.open_trace:
     * ingest_ftrace_in_raw_table=true (the shell is launched without
     * --no-ftrace-raw). Other ResetTraceProcessorArgs fields stay unset so
     * the engine's default config applies. */
    resetTraceProcessor(opts) {
      opts = opts || {};
      const ingest = opts.ingestFtraceInRaw !== false;
      return this._request(TPM.RESET_TRACE_PROCESSOR, function (w) {
        const args = new proto.Writer();
        args.varintField(2, ingest); // ingest_ftrace_in_raw_table
        if (opts.analyzeTraceProtoContent !== undefined) {
          args.varintField(3, !!opts.analyzeTraceProtoContent);
        }
        w.messageField(F_RESET_ARGS, args);
      }, function () {
        return true;
      });
    }

    /* TPM_APPEND_TRACE_DATA: raw trace bytes. Resolves with
     * AppendTraceDataResult or rejects on its `error` field. */
    parse(u8) {
      return this._request(TPM.APPEND_TRACE_DATA, function (w) {
        w.bytesField(F_APPEND_TRACE_DATA, u8);
      }, function (field, body) {
        if (field !== F_APPEND_RESULT || !body) return true;
        const r = new proto.Reader(body);
        let error = null;
        while (!r.eof()) {
          const [f, wire] = r.tag();
          if (f === 2 && wire === 2) {
            const b = r.bytes();
            error = proto.decodeString(b, 0, b.length);
          } else {
            r.skip(wire);
          }
        }
        if (error) throw new Error('trace parse failed: ' + error);
        return true;
      });
    }

    /* TPM_FINALIZE_TRACE_DATA (notify EOF). */
    notifyEof() {
      return this._request(TPM.FINALIZE_TRACE_DATA, null,
        function (field, body) {
          if (field !== F_FINALIZE_RESULT || !body) return true;
          const r = new proto.Reader(body);
          let error = null;
          while (!r.eof()) {
            const [f, wire] = r.tag();
            if (f === 1 && wire === 2) {
              const b = r.bytes();
              error = proto.decodeString(b, 0, b.length);
            } else {
              r.skip(wire);
            }
          }
          if (error) throw new Error('trace finalize failed: ' + error);
          return true;
        });
    }

    /* Reset + stream a Blob/File through the engine + finalize. */
    async loadFile(blob, opts) {
      opts = opts || {};
      const chunkSize = opts.chunkSize || 32 * 1024 * 1024;
      const onProgress = opts.onProgress || null;
      await this.resetTraceProcessor(opts.reset || {});
      const total = blob.size;
      let done = 0;
      for (let off = 0; off < total; off += chunkSize) {
        const chunk = new Uint8Array(
          await blob.slice(off, Math.min(off + chunkSize, total))
            .arrayBuffer());
        await this.parse(chunk);
        done += chunk.length;
        if (onProgress) onProgress(done, total);
      }
      await this.notifyEof();
      return total;
    }

    /* TPM_QUERY_STREAMING; resolves with a columnar result:
     * {columns: [names], rows: N, data: {name: [v0, v1, ...]}}
     * int64 -> Number (throws above 2^53), double -> Number,
     * string -> string, NULL -> null, BLOB -> Uint8Array. */
    query(sql) {
      const state = { columns: [], batches: [], error: null };
      return this._request(TPM.QUERY_STREAMING, function (w) {
        const args = new proto.Writer();
        args.stringField(1, sql); // QueryArgs.sql_query
        w.messageField(F_QUERY_ARGS, args);
      }, function (field, body) {
        if (field !== F_QUERY_RESULT || !body) return true;
        const r = new proto.Reader(body);
        let isLast = false;
        while (!r.eof()) {
          const [f, wire] = r.tag();
          if (f === 1 && wire === 2) {
            const b = r.bytes();
            state.columns.push(proto.decodeString(b, 0, b.length));
          } else if (f === 2 && wire === 2) {
            const b = r.bytes();
            state.error = proto.decodeString(b, 0, b.length);
          } else if (f === 3 && wire === 2) {
            const batch = decodeCellsBatch(r.bytes());
            state.batches.push(batch);
            if (batch.isLast) isLast = true;
          } else {
            r.skip(wire);
          }
        }
        if (state.error !== null || isLast) return true;
        return false;
      }).then(function () {
        if (state.error !== null) {
          throw new Error('query failed: ' + state.error);
        }
        return assembleColumns(state);
      });
    }

    getStatus() {
      return this._request(TPM.GET_STATUS, null, function () {
        return true;
      });
    }
  }

  function toInt(v, where) {
    if (typeof v === 'bigint') {
      if (v > MAX_SAFE || v < -MAX_SAFE) {
        throw new Error('int64 cell exceeds 2^53 at ' + where);
      }
      return Number(v);
    }
    return v;
  }

  function assembleColumns(state) {
    const cols = state.columns;
    const nCols = cols.length;
    const data = {};
    for (const c of cols) data[c] = [];
    let rows = 0;
    state.batches.forEach(function (batch, bi) {
      const nCells = batch.types.length;
      if (nCols > 0 && nCells % nCols !== 0) {
        throw new Error('query batch ' + bi + ': ' + nCells +
          ' cells not divisible by ' + nCols + ' columns');
      }
      const idx = { varints: 0, floats: 0, strings: 0, blobs: 0 };
      const nRows = nCols ? nCells / nCols : 0;
      for (let i = 0; i < nCells; i++) {
        const t = batch.types[i];
        const colName = cols[i % nCols];
        let v;
        if (t === CELL_NULL) {
          v = null;
        } else if (t === CELL_VARINT) {
          v = toInt(batch.varints[idx.varints++],
            'batch ' + bi + ' cell ' + i);
        } else if (t === CELL_FLOAT64) {
          v = batch.floats[idx.floats++];
        } else if (t === CELL_STRING) {
          v = batch.strings ? batch.strings[idx.strings++] : null;
        } else if (t === CELL_BLOB) {
          v = batch.blobs[idx.blobs++];
        } else {
          throw new Error('unknown cell type ' + t);
        }
        data[colName].push(v);
      }
      rows += nRows;
    });
    return { columns: cols, rows: rows, data: data };
  }

  BLK.TpClient = TpClient;
  BLK.TPM = TPM;
})();
