/** Pure guest computation; no host references, permissions or I/O. */
export const FUNCTION_BASE64_GLOBALS = String.raw`
(() => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const cast = String, ErrorType = Error, TypeErrorType = TypeError, RangeErrorType = RangeError;
  const code = Function.prototype.call.bind(String.prototype.charCodeAt);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const char = String.fromCharCode;
  const table = Object.create(null);
  for (let i = 0; i < 64; i++) table[code(alphabet, i)] = i;
  const limit = 512 * 1024;
  function text(value, count) {
    if (!count || typeof value === "symbol") throw new TypeErrorType("Expected a string argument");
    const valueText = cast(value);
    if (valueText.length > limit) throw new RangeErrorType("MODS_BASE64_LIMIT");
    return valueText;
  }
  function invalid() {
    const error = new ErrorType("The string is not valid for Base64 conversion");
    error.name = "InvalidCharacterError";
    return error;
  }
  const codecs = {
    btoa(data) {
      const input = text(data, arguments.length);
      let output = "";
      for (let i = 0; i < input.length; i += 3) {
        const a = code(input, i);
        const b = i + 1 < input.length ? code(input, i + 1) : 0;
        const c = i + 2 < input.length ? code(input, i + 2) : 0;
        if (a > 255 || b > 255 || c > 255) throw invalid();
        output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] +
          (i + 1 < input.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=") +
          (i + 2 < input.length ? alphabet[c & 63] : "=");
      }
      return output;
    },
    atob(data) {
      const raw = text(data, arguments.length);
      let input = "";
      for (let i = 0; i < raw.length; i++) {
        const point = code(raw, i);
        if (point !== 9 && point !== 10 && point !== 12 && point !== 13 && point !== 32)
          input += raw[i];
      }
      if (input.length % 4 === 0) {
        if (slice(input, -2) === "==") input = slice(input, 0, -2);
        else if (slice(input, -1) === "=") input = slice(input, 0, -1);
      }
      if (input.length % 4 === 1) throw invalid();
      let output = "", bits = 0, buffer = 0;
      for (let i = 0; i < input.length; i++) {
        const point = code(input, i);
        const value = point < 128 ? table[point] : undefined;
        if (value === undefined) throw invalid();
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          output += char((buffer >> bits) & 255);
          buffer &= (1 << bits) - 1;
        }
      }
      return output;
    }
  };
  for (const name of ["atob", "btoa"]) {
    const operation = codecs[name];
    Object.defineProperty(globalThis, name, { get: () => operation, configurable: false });
  }
})();
`
