/** UTF-8 only, entirely within QuickJS. No host objects or I/O are exposed. */
export const FUNCTION_ENCODING_GLOBALS = String.raw`
(() => {
  const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const string = String, code = String.prototype.charCodeAt, char = String.fromCharCode;
  const replace = String.prototype.replace, lowerCase = String.prototype.toLowerCase;
  const U8 = Uint8Array, AB = ArrayBuffer, view = ArrayBuffer.isView;
  const typed = Object.getPrototypeOf(U8.prototype);
  const typedBuffer = descriptor(typed, "buffer").get;
  const typedOffset = descriptor(typed, "byteOffset").get;
  const typedLength = descriptor(typed, "byteLength").get;
  const typedName = descriptor(typed, Symbol.toStringTag).get;
  const dataBuffer = descriptor(DataView.prototype, "buffer").get;
  const dataOffset = descriptor(DataView.prototype, "byteOffset").get;
  const dataLength = descriptor(DataView.prototype, "byteLength").get;
  const bufferLength = descriptor(AB.prototype, "byteLength").get;
  const Weak = WeakMap, get = WeakMap.prototype.get, set = WeakMap.prototype.set;
  const encoders = new Weak(), decoders = new Weak();
  const TypeErrorType = TypeError, RangeErrorType = RangeError;
  const textLimit = 524288, byteLimit = 1048576;
  function text(value) {
    if (typeof value === "symbol") throw new TypeErrorType("Cannot convert a Symbol to a string");
    const result = string(value);
    if (result.length > textLimit) throw new RangeErrorType("MODS_ENCODING_LIMIT");
    return result;
  }
  function brand(map, value) {
    const state = call(get, map, value);
    if (!state) throw new TypeErrorType("Illegal invocation");
    return state;
  }
  function bytes(input) {
    if (input === undefined) return new U8(0);
    let buffer, offset, length;
    if (view(input)) {
      try {
        buffer = call(typedBuffer, input); offset = call(typedOffset, input);
        length = call(typedLength, input);
      } catch {
        buffer = call(dataBuffer, input); offset = call(dataOffset, input);
        length = call(dataLength, input);
      }
    } else {
      length = call(bufferLength, input); buffer = input; offset = 0;
    }
    if (length > byteLimit) throw new RangeErrorType("MODS_ENCODING_LIMIT");
    return new U8(buffer, offset, length);
  }
  function encode(input, target) {
    let read = 0, written = 0;
    const capacity = call(typedLength, target);
    while (read < input.length) {
      let point = call(code, input, read), units = 1;
      if (point >= 0xd800 && point <= 0xdbff) {
        const next = read + 1 < input.length ? call(code, input, read + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00; units = 2;
        } else point = 0xfffd;
      } else if (point >= 0xdc00 && point <= 0xdfff) point = 0xfffd;
      const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (written + size > capacity) break;
      if (size === 1) target[written++] = point;
      else {
        if (size === 2) target[written++] = 0xc0 | (point >> 6);
        else if (size === 3) {
          target[written++] = 0xe0 | (point >> 12);
          target[written++] = 0x80 | ((point >> 6) & 63);
        } else {
          target[written++] = 0xf0 | (point >> 18);
          target[written++] = 0x80 | ((point >> 12) & 63);
          target[written++] = 0x80 | ((point >> 6) & 63);
        }
        target[written++] = 0x80 | (point & 63);
      }
      read += units;
    }
    return { read, written };
  }
  class TextEncoder {
    constructor() { call(set, encoders, this, {}); }
    get encoding() { brand(encoders, this); return "utf-8"; }
    encode(input = "") {
      brand(encoders, this);
      const value = text(input), target = new U8(value.length * 3);
      const result = encode(value, target), output = new U8(result.written);
      for (let i = 0; i < result.written; i++) output[i] = target[i];
      return output;
    }
    encodeInto(source, destination) {
      brand(encoders, this);
      const value = text(source);
      if (call(typedName, destination) !== "Uint8Array") throw new TypeErrorType("Expected Uint8Array");
      return encode(value, destination);
    }
  }
  function reset(state) {
    state.needed = 0; state.seen = 0; state.point = 0; state.lower = 0x80; state.upper = 0xbf;
  }
  class TextDecoder {
    constructor(label = "utf-8", options = {}) {
      const raw = call(lowerCase, call(replace, text(label), /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""));
      if (raw !== "utf-8" && raw !== "utf8" && raw !== "unicode-1-1-utf-8" &&
          raw !== "unicode11utf8" && raw !== "unicode20utf8" && raw !== "x-unicode20utf8")
        throw new RangeErrorType("MODS_ENCODING_UTF8_ONLY");
      if (options !== null && typeof options !== "object" && typeof options !== "function")
        throw new TypeErrorType("Expected decoder options");
      const state = { fatal: !!options?.fatal, ignoreBOM: !!options?.ignoreBOM, streaming: false, bom: false };
      reset(state); call(set, decoders, this, state);
    }
    get encoding() { brand(decoders, this); return "utf-8"; }
    get fatal() { return brand(decoders, this).fatal; }
    get ignoreBOM() { return brand(decoders, this).ignoreBOM; }
    decode(input, options = {}) {
      const state = brand(decoders, this), data = bytes(input);
      if (options !== null && typeof options !== "object" && typeof options !== "function")
        throw new TypeErrorType("Expected decoder options");
      if (!state.streaming) { reset(state); state.bom = false; }
      state.streaming = !!options?.stream;
      let output = "";
      function emit(point) {
        if (!state.bom) {
          state.bom = true;
          if (point === 0xfeff && !state.ignoreBOM) return;
        }
        output += point <= 0xffff ? char(point) : char(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 1023));
      }
      function invalid() {
        if (state.fatal) throw new TypeErrorType("The encoded data was not valid for encoding utf-8");
        emit(0xfffd);
      }
      const length = call(typedLength, data);
      for (let i = 0; i < length; i++) {
        const byte = data[i];
        if (!state.needed) {
          if (byte <= 0x7f) emit(byte);
          else if (byte >= 0xc2 && byte <= 0xdf) { state.needed = 1; state.point = byte & 31; }
          else if (byte >= 0xe0 && byte <= 0xef) {
            state.needed = 2; state.point = byte & 15;
            if (byte === 0xe0) state.lower = 0xa0;
            if (byte === 0xed) state.upper = 0x9f;
          } else if (byte >= 0xf0 && byte <= 0xf4) {
            state.needed = 3; state.point = byte & 7;
            if (byte === 0xf0) state.lower = 0x90;
            if (byte === 0xf4) state.upper = 0x8f;
          } else invalid();
        } else if (byte < state.lower || byte > state.upper) {
          reset(state); invalid(); i--;
        } else {
          state.lower = 0x80; state.upper = 0xbf;
          state.point = (state.point << 6) | (byte & 63);
          if (++state.seen === state.needed) { const point = state.point; reset(state); emit(point); }
        }
      }
      if (!state.streaming && state.needed) { reset(state); invalid(); }
      return output;
    }
  }
  for (const [name, constructor] of [["TextEncoder", TextEncoder], ["TextDecoder", TextDecoder]]) {
    define(constructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    define(globalThis, name, { get: () => constructor, configurable: false });
  }
})();
`
