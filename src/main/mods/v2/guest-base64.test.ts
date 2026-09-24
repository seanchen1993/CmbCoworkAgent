import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"

async function probe(expression: string, client = false): Promise<unknown> {
  const code = client
    ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
    : `var __cmbFunctionMod={register(on){on("command.run",()=>(${expression}))}}`
  const guest = await FunctionGuestRuntime.create(code, { plugin: "base64" })
  try {
    const result = await guest.invoke(
      "0",
      client ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
      async () => {
        throw Error("Base64 must not call the host")
      },
      {
        event: client ? "surface.update" : "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "base64", root: "/base64" }
      }
    )
    return client
      ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
      : result.value
  } finally {
    guest.dispose()
  }
}

const bytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("")
const plain = ["", "f", "fo", "foo", "foob", "fooba", "foobar", "\0\xff", bytes]
const encoded = [
  "",
  "Zg==",
  "Zg",
  "Zm8=",
  "Zm8",
  "Zm9v",
  " Y\tR\n==\r\f ",
  "YR",
  "YWJ",
  btoa(bytes)
]
const invalidEncode = ["你好", "\u0100", "\ud800", "😀"]
const invalid = [
  "a",
  "=",
  "===",
  "a===",
  "Zg=",
  "Zg===",
  "Z=g=",
  "Zm8==",
  "Zm9v=",
  "AA-_",
  "AA\v",
  "AA\u00a0",
  "AA\u2003",
  "你好"
]

it.each([false, true])(
  "matches native base64 vectors in a real QuickJS VM (Client=%s)",
  async (client) => {
    expect(
      await probe(
        `({encoded:${JSON.stringify(plain)}.map(x=>btoa(x)),decoded:${JSON.stringify(encoded)}.map(x=>atob(x))})`,
        client
      )
    ).toEqual({ encoded: plain.map((x) => btoa(x)), decoded: encoded.map((x) => atob(x)) })
  }
)

it.each([false, true])(
  "rejects invalid alphabet, padding and non-Latin1 without host calls (Client=%s)",
  async (client) => {
    expect(
      await probe(
        `(()=>{const name=fn=>{try{fn();return "accepted"}catch(e){return e.name}};return {
    decode:${JSON.stringify(invalid)}.map(x=>name(()=>atob(x))),
    encode:${JSON.stringify(invalidEncode)}.map(x=>name(()=>btoa(x)))}})()`,
        client
      )
    ).toEqual({
      decode: invalid.map(() => "InvalidCharacterError"),
      encode: Array(4).fill("InvalidCharacterError")
    })
  }
)

it("preserves string coercion, detached calls, arity and non-constructor behavior", async () => {
  expect(
    await probe(`(()=>{const name=fn=>{try{return fn()}catch(e){return e.name}};return {
    coerced:[btoa(null),btoa(undefined),btoa(123),btoa({toString(){return "foo"}})],
    invalid:[name(()=>btoa()),name(()=>atob()),name(()=>btoa(Symbol())),name(()=>atob(Symbol())),name(()=>new btoa("foo")),name(()=>new atob("Zm9v"))],
    lengths:[atob.length,btoa.length],detached:(0,atob)("Zm9v")}})()`)
  ).toEqual({
    coerced: [
      btoa(null as unknown as string),
      btoa(undefined as unknown as string),
      btoa("123"),
      btoa("foo")
    ],
    invalid: Array(6).fill("TypeError"),
    lengths: [1, 1],
    detached: "foo"
  })
})

it("binds the globals read-only and enforces bounded input without consuming the host", async () => {
  expect(
    await probe(`(()=>{const name=fn=>{try{fn();return "accepted"}catch(e){return [e.name,e.message]}};
    const a=atob,b=btoa;try{globalThis.atob=()=>"wrong"}catch{};try{Object.defineProperty(globalThis,"btoa",{value:()=>"wrong"})}catch{};
    return {same:atob===a&&btoa===b,over:[name(()=>atob("A".repeat(524289))),name(()=>btoa("A".repeat(524289)))],value:atob(btoa("alive"))}})()`)
  ).toEqual({
    same: true,
    over: Array(2).fill(["RangeError", "MODS_BASE64_LIMIT"]),
    value: "alive"
  })
})

it("handles a larger binary value without stack expansion or changing native intrinsics", async () => {
  const value = bytes.repeat(64)
  expect(
    await probe(
      `(()=>{const value=${JSON.stringify(value)};const result=btoa(value);return [result,atob(result)===value]})()`
    )
  ).toEqual([btoa(value), true])
})

it("keeps byte validation independent of plugin prototype mutations", async () => {
  expect(
    await probe(`(()=>{
    const original=String.prototype.charCodeAt;
    String.prototype.charCodeAt=()=>999;Object.prototype[33]=0;
    try {
      let invalid;try{atob("AA!")}catch(error){invalid=error.name}
      return [btoa("foo"),atob("Zm9v"),invalid]
    } finally {String.prototype.charCodeAt=original;delete Object.prototype[33]}
  })()`)
  ).toEqual(["Zm9v", "foo", "InvalidCharacterError"])
})
