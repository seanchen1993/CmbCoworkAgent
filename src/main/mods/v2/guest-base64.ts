import type { QuickJSContext } from "quickjs-emscripten"

const BYTE_LIMIT = 512 * 1024
const ENCODED_LIMIT = 4 * Math.ceil(BYTE_LIMIT / 3)
const DECODE_INPUT_LIMIT = ENCODED_LIMIT * 2

/** Bounded pure computation: primitive strings only, no I/O, authority or host objects. */
export function installFunctionBase64Host(context: QuickJSContext): void {
  const bridge = context.newFunction("base64", (operation, argument) => {
    const error = (name: string, message: string) => ({
      error: context.newError({ name, message })
    })
    const invalid = () => error("InvalidCharacterError", "The string is not valid for Base64 conversion")
    const limited = () => error("RangeError", "MODS_BASE64_LIMIT")
    try {
      if (!operation || context.typeof(operation) !== "string" ||
          !argument || context.typeof(argument) !== "string")
        return error("TypeError", "Expected a string argument")
      const op = context.getString(operation)
      if (op !== "encode" && op !== "decode") return error("TypeError", "Invalid base64 operation")
      // The primitive string's own length is checked before copying its payload to the host.
      const lengthHandle = context.getProp(argument, "length")
      let length: number
      try { length = context.getNumber(lengthHandle) } finally { lengthHandle.dispose() }
      const inputLimit = op === "encode" ? BYTE_LIMIT : DECODE_INPUT_LIMIT
      // JSON escapes embedded NULs, which the QuickJS C-string bridge would otherwise truncate.
      if (length > inputLimit * 6 + 2) return limited()
      const input: unknown = JSON.parse(context.getString(argument))
      if (typeof input !== "string") return error("TypeError", "Expected a string argument")
      if (input.length > inputLimit) return limited()
      if (op === "encode") {
        // eslint-disable-next-line no-control-regex -- btoa accepts every Latin-1 byte, including NUL.
        if (/[^\x00-\xff]/.test(input)) return invalid()
        return context.newString(Buffer.from(input, "latin1").toString("base64"))
      }
      // WHATWG forgiving-base64 semantics, validated before Node's deliberately liberal decoder.
      let encoded = input.replace(/[\t\n\f\r ]/g, "")
      if (encoded.length > ENCODED_LIMIT) return limited()
      if (encoded.length % 4 === 0) {
        if (encoded.endsWith("==")) encoded = encoded.slice(0, -2)
        else if (encoded.endsWith("=")) encoded = encoded.slice(0, -1)
      }
      if (encoded.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(encoded)) return invalid()
      if (Math.floor(encoded.length * 6 / 8) > BYTE_LIMIT) return limited()
      const decoded = Buffer.from(encoded, "base64")
      if (decoded.length > BYTE_LIMIT) return limited()
      return context.newString(JSON.stringify(decoded.toString("latin1")))
    } catch {
      return error("OperationError", "Base64 conversion failed")
    }
  })
  context.setProp(context.global, "__functionBase64Host", bridge)
  bridge.dispose()
}

/** Guest wrappers preserve native coercion while hiding the fixed, string-only compute bridge. */
export const FUNCTION_BASE64_GLOBALS = String.raw`
(() => {
  const bridge = globalThis.__functionBase64Host;
  delete globalThis.__functionBase64Host;
  const cast = String, TypeErrorType = TypeError, RangeErrorType = RangeError;
  const stringify = JSON.stringify, parse = JSON.parse;
  const byteLimit = 512 * 1024;
  const encodedLimit = 4 * Math.ceil(byteLimit / 3);
  function text(value, count, limit) {
    if (!count || typeof value === "symbol") throw new TypeErrorType("Expected a string argument");
    const valueText = cast(value);
    if (valueText.length > limit) throw new RangeErrorType("MODS_BASE64_LIMIT");
    return stringify(valueText);
  }
  const codecs = {
    btoa(data) { return bridge("encode", text(data, arguments.length, byteLimit)); },
    atob(data) { return parse(bridge("decode", text(data, arguments.length, encodedLimit * 2))); }
  };
  for (const name of ["atob", "btoa"]) {
    const operation = codecs[name];
    Object.defineProperty(globalThis, name, { get: () => operation, configurable: false });
  }
})();
`
