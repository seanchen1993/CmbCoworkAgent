/** Shared input vectors; the expected result is produced by the native UTF-8 implementation. */
export const ENCODING_PROBE_SOURCE = String.raw`
function encodingProbe() {
  const encode = new TextEncoder();
  const texts = ["", "ASCII", "中文😀", "a\ud800b\udcff", "\ufeffx", "\u0000é"];
  const invalid = [[255], [192, 175], [237, 160, 128], [244, 144, 128, 128], [226, 130], [226, 65], [240, 159, 65]];
  const name = fn => {try {return fn()} catch (error) {return error.name}};
  const streamed = new TextDecoder();
  const streaming = [[239], [187, 191, 240], [159], [152, 128]].map(x => streamed.decode(new Uint8Array(x), {stream:true}));
  streaming.push(streamed.decode());
  const capacities = [0,1,2,3,4,5,6,7,8].map(size => {
    const target = new Uint8Array(size); const result = encode.encodeInto("a😀中", target);
    return [result, Array.from(target)];
  });
  const offset = new Uint8Array([255, 65, 66, 255]);
  return {
    encoded: texts.map(x => Array.from(encode.encode(x))),
    decoded: texts.map(x => new TextDecoder().decode(encode.encode(x))),
    invalid: invalid.map(x => new TextDecoder().decode(new Uint8Array(x))),
    fatal: invalid.map(x => name(() => new TextDecoder("utf-8", {fatal:true}).decode(new Uint8Array(x)))),
    streaming, capacities,
    bom: [false,true].map(ignoreBOM => new TextDecoder("utf8", {ignoreBOM}).decode(new Uint8Array([239,187,191,65]))),
    offset: new TextDecoder().decode(new DataView(offset.buffer,1,2)),
    labels: [" UTF-8\n", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"].map(x => new TextDecoder(x).encoding),
    brand: [name(() => TextEncoder.prototype.encode.call({})), name(() => TextDecoder.prototype.decode.call({}))],
    // esbuild may replace bare require with a local shim; inspect actual ambient globals.
    globals: [typeof globalThis.process, typeof globalThis.require, typeof globalThis.fetch, typeof globalThis.document]
  };
}
`

export function expectedEncodingProbe(): unknown {
  // The ambient globals are an isolation assertion, not a native encoder behavior.
  const native = new Function(`${ENCODING_PROBE_SOURCE};return encodingProbe()`)() as {
    globals: string[]
  }
  native.globals = Array(4).fill("undefined")
  return native
}
