/* Minimal protobuf reader/writer for the trace_processor RPC protocol.
 *
 * Classic script, no modules: usable from a page, a Worker, or Node's vm.
 * Exposes globalThis.BLK.proto.{Writer, Reader, encodeString, decodeString}.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const proto = (BLK.proto = {});

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  proto.encodeString = function (s) {
    return encoder.encode(s);
  };
  proto.decodeString = function (u8, start, end) {
    return decoder.decode(u8.subarray(start, end));
  };

  /* ------------------------------ Writer ------------------------------ */

  class Writer {
    constructor() {
      this.parts = [];
      this.len = 0;
    }

    _push(u8) {
      this.parts.push(u8);
      this.len += u8.length;
    }

    /* Unsigned varint; v may be Number or BigInt. */
    rawVarint(v) {
      let big = typeof v === 'bigint' ? v : BigInt(v);
      const out = [];
      while (big > 0x7fn) {
        out.push(Number(big & 0x7fn) | 0x80);
        big >>= 7n;
      }
      out.push(Number(big));
      this._push(Uint8Array.from(out));
    }

    tag(field, wire) {
      this.rawVarint((field << 3) | wire);
    }

    /* int64 / uint64 / enum / bool. Negative int64 encodes as the
     * two's-complement 64-bit varint (10 bytes), like protobuf int64. */
    varintField(field, v) {
      this.tag(field, 0);
      if (typeof v === 'boolean') v = v ? 1 : 0;
      let big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
      this.rawVarint(big & 0xffffffffffffffffn);
    }

    bytesField(field, u8) {
      this.tag(field, 2);
      this.rawVarint(u8.length);
      this._push(u8);
    }

    stringField(field, s) {
      this.bytesField(field, encoder.encode(s));
    }

    /* Nested message given as a finished Writer or Uint8Array. */
    messageField(field, msg) {
      this.bytesField(field, msg instanceof Writer ? msg.finish() : msg);
    }

    finish() {
      const out = new Uint8Array(this.len);
      let off = 0;
      for (const p of this.parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    }
  }

  /* ------------------------------ Reader ------------------------------ */

  const TWO_63 = 1n << 63n;
  const TWO_64 = 1n << 64n;

  class Reader {
    constructor(u8) {
      this.buf = u8;
      this.pos = 0;
      this.end = u8.length;
    }

    eof() {
      return this.pos >= this.end;
    }

    /* Unsigned varint -> Number when it fits in 53 bits, else BigInt.
     * The fast path keeps the common (< 2^49) case free of BigInt cost. */
    varint() {
      const buf = this.buf;
      let result = 0;
      let shift = 0;
      let big = null;
      for (;;) {
        const byte = buf[this.pos++];
        if (big === null && shift < 49) {
          result += (byte & 0x7f) * 2 ** shift;
          shift += 7;
        } else {
          if (big === null) big = BigInt(result);
          big |= BigInt(byte & 0x7f) << BigInt(shift);
          shift += 7;
        }
        if ((byte & 0x80) === 0) break;
      }
      return big === null ? result : big;
    }

    /* varint as signed int64 -> Number when |v| fits in 53 bits, else BigInt. */
    int64() {
      let v = this.varint();
      if (typeof v === 'bigint') {
        if (v >= TWO_63) v -= TWO_64;
      }
      return v;
    }

    tag() {
      const t = this.varint();
      return [Number(t) >> 3, Number(t) & 7];
    }

    bytes() {
      const n = Number(this.varint());
      const out = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      return out;
    }

    double() {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
      const v = dv.getFloat64(0, true);
      this.pos += 8;
      return v;
    }

    /* Skip a value of the given wire type. */
    skip(wire) {
      switch (wire) {
        case 0:
          this.varint();
          return;
        case 1:
          this.pos += 8;
          return;
        case 2: {
          const n = Number(this.varint());
          this.pos += n;
          return;
        }
        case 5:
          this.pos += 4;
          return;
        default:
          throw new Error('proto: unsupported wire type ' + wire);
      }
    }
  }

  /* Iterate a length-delimited field containing packed varints. */
  proto.readPackedVarints = function (u8, cb) {
    const r = new Reader(u8);
    while (!r.eof()) cb(r.varint());
  };

  proto.Writer = Writer;
  proto.Reader = Reader;
})();
