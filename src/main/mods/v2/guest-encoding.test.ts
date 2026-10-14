import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { compileFunctionPlugin } from "./loader"
import {
  ENCODING_PROBE_SOURCE,
  expectedEncodingProbe
} from "../../../../tests/support/function-encoding-probe"

async function probe(expression: string, client = false, source = ""): Promise<unknown> {
  const code =
    source +
    (client
      ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
      : `var __cmbFunctionMod={register(on){on("command.run",()=>(${expression}))}}`)
  const guest = await FunctionGuestRuntime.create(code, { plugin: "encoding" })
  try {
    const result = await guest.invoke(
      "0",
      client ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
      async () => {
        throw Error("Encoding must not call the host")
      },
      {
        event: client ? "surface.update" : "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "encoding", root: "/encoding" }
      }
    )
    return client
      ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
      : result.value
  } finally {
    guest.dispose()
  }
}

it.each([false, true])("matches native UTF-8 in a real VM (Client=%s)", async (client) => {
  expect(await probe("encodingProbe()", client, ENCODING_PROBE_SOURCE)).toEqual(
    expectedEncodingProbe()
  )
})

it("rejects lexical require and keeps ambient require absent after real Hooks and Client bundling", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-encoding-bundle-"))
  try {
    await mkdir(join(root, "hooks"))
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "encoding-bundle" }))
    await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.tsx"] }))
    const source = `${ENCODING_PROBE_SOURCE}
      function bundleProbe(name) {
        let requireDenied=false;
        try {require(name)} catch {requireDenied=true}
        return {probe:encodingProbe(),lexicalRequire:typeof require,requireDenied};
      }`
    await writeFile(
      join(root, "hooks/register.tsx"),
      `${source}
      export function register(on){
        on("command.run",(_,e)=>bundleProbe(e.module));
        on("ui.render",($,e)=>{const {Client}=$.ui.resolve(e);return <Client key="test" module="./surface.tsx"/>})
      }`
    )
    await writeFile(
      join(root, "hooks/surface.tsx"),
      `${source}
      export default function Surface(props,s){const {Text}=s.elements;return <Text>{JSON.stringify(bundleProbe(props.module))}</Text>}`
    )
    // Hooks and Clients independently reject lexical require before bundling.
    await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_IMPORT_DENIED")
    for (const file of ["register.tsx", "surface.tsx"]) {
      const path = join(root, "hooks", file)
      const text = await readFile(path, "utf8")
      await writeFile(path, text.replaceAll("require(name)", 'globalThis[["requ", "ire"].join("")](name)')
        .replaceAll("typeof require", 'typeof globalThis[["requ", "ire"].join("")]')
        .replaceAll("globalThis.require", 'globalThis[["requ", "ire"].join("")]'))
      if (file === "register.tsx")
        await expect(compileFunctionPlugin(root)).rejects.toThrow("MODS_IMPORT_DENIED")
    }
    const compiled = await compileFunctionPlugin(root)
    expect(compiled.code).not.toContain("__require")
    for (const client of [false, true]) {
      const code = client
        ? `${CLIENT_BOOTSTRAP}\n${compiled.clients["hooks/surface.tsx"]}`
        : compiled.code
      const guest = await FunctionGuestRuntime.create(code, { plugin: "encoding-bundle" })
      try {
        const result = await guest.invoke(
          "0",
          client
            ? { kind: "render", props: { module: "node:fs" }, columns: 80, rows: 20 }
            : { module: "node:fs" },
          async () => {
            throw Error("Codec probe must not call host")
          },
          {
            event: client ? "surface.update" : "command.run",
            origin: { plugin: "engine", tier: "core" },
            capabilities: [],
            plugin: { name: "encoding-bundle", root }
          }
        )
        const actual = client
          ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
          : result.value
        expect(actual).toEqual({
          probe: expectedEncodingProbe(),
          lexicalRequire: "undefined",
          requireDenied: true
        })
      } finally {
        guest.dispose()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("matches malformed UTF-8, arbitrary chunk boundaries and fatal errors", async () => {
  const vectors: number[][] = []
  for (let i = 0; i < 256; i++) vectors.push([i], [0xe2, i, 0x82], [0xf0, i, 0x80, 0x80])
  for (let group = 0; group < vectors.length; group += 96) {
    const input = vectors.slice(group, group + 96)
    const expression = `(()=>{const vectors=${JSON.stringify(input)};return vectors.map(bytes=>{
      const results=[];
      for(const fatal of [false,true]) {
        const decoder=new TextDecoder("utf-8",{fatal});
        try {results.push(bytes.map(x=>decoder.decode(new Uint8Array([x]),{stream:true})).join("")+decoder.decode())}
        catch(error){results.push(error.name)}
      }
      return results;
    })})()`
    expect(await probe(expression)).toEqual(new Function(`return ${expression}`)())
  }
})

it("handles BOM state across streams and resets after completed decode", async () => {
  const expression = `(()=>{const d=new TextDecoder();return [
    d.decode(new Uint8Array([239]),{stream:true}),d.decode(new Uint8Array([187,191,65]),{stream:true}),
    d.decode(new Uint8Array([239,187,191])),d.decode(new Uint8Array([239,187,191,66])),
    d.decode(new Uint8Array([226]),{stream:true}),d.decode(),d.decode(new Uint8Array([67]))]})()`
  expect(await probe(expression)).toEqual(new Function(`return ${expression}`)())
})

it("matches recovery after fatal errors and Uint8Array destination offsets", async () => {
  const expression = `(()=>{
    const decoder=new TextDecoder("utf8",{fatal:true}), result=[];
    for(const value of [[226],[65],[239,187,191,66],[67]]) {
      try{result.push(decoder.decode(new Uint8Array(value),{stream:true}))}catch(e){result.push(e.name)}
    }
    result.push(decoder.decode());
    const buffer=new Uint8Array([99,99,99,99,99,99]);
    result.push(new TextEncoder().encodeInto("中a",buffer.subarray(1,5)),Array.from(buffer));
    result.push(Object.prototype.toString.call(new TextEncoder()),Object.prototype.toString.call(decoder));
    return result;
  })()`
  expect(await probe(expression)).toEqual(new Function(`return ${expression}`)())
})

it("rejects forged buffers, wrong brands, unsupported encodings and non Uint8 destinations", async () => {
  expect(
    await probe(`(()=>{const name=fn=>{try {fn();return "accepted"}catch(e){return e.name}};
    return [name(()=>new TextDecoder("latin1")),name(()=>new TextDecoder().decode({buffer:new ArrayBuffer(1),byteLength:1,[Symbol.toStringTag]:"Uint8Array"})),
    name(()=>new TextEncoder().encodeInto("x",new Uint8ClampedArray(1))),name(()=>TextDecoder.prototype.decode.call({})),
    name(()=>new TextEncoder().encode(Symbol())),name(()=>new TextDecoder(Symbol())),
    name(()=>TextEncoder()),name(()=>TextDecoder())]})()`)
  ).toEqual([
    "RangeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError",
    "TypeError"
  ])
})

it("uses intrinsic view offsets and char access despite prototype mutations", async () => {
  expect(
    await probe(`(()=>{const c=String.prototype.charCodeAt;
    String.prototype.charCodeAt=()=>0;const bytes=new Uint8Array([88,65,66,88]);
    const part=bytes.subarray(1,3);Object.defineProperty(part,"byteOffset",{value:0});
    Object.defineProperty(part,"buffer",{value:new ArrayBuffer(0)});
    try {return [Array.from(new TextEncoder().encode("中")),new TextDecoder().decode(part)]}
    finally {String.prototype.charCodeAt=c}})()`)
  ).toEqual([[228, 184, 173], "AB"])
})

it("keeps constructors immutable and enforces deterministic input limits", async () => {
  expect(
    await probe(`(()=>{const original=TextEncoder;try{Object.defineProperty(globalThis,"TextEncoder",{value:null})}catch{}
    const name=fn=>{try{fn();return "accepted"}catch(e){return [e.name,e.message]}};
    return [TextEncoder===original,name(()=>new TextEncoder().encode("a".repeat(524289))),
      name(()=>new TextDecoder().decode(new Uint8Array(1048577)))]})()`)
  ).toEqual([true, ["RangeError", "MODS_ENCODING_LIMIT"], ["RangeError", "MODS_ENCODING_LIMIT"]])
})
