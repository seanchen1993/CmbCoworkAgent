import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import {
  EXPECTED_STANDARD_GLOBALS_PROBE,
  STANDARD_GLOBALS_PROBE_SOURCE
} from "../../../../tests/support/function-standard-globals-probe"

async function probe(expression: string, client = false, source = ""): Promise<unknown> {
  const code =
    source +
    (client
      ? `${CLIENT_BOOTSTRAP}\nvar __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(${expression}))}}`
      : `var __cmbFunctionMod={register(on){on("command.run",async ($,e,next)=>(${expression}))}}`)
  const guest = await FunctionGuestRuntime.create(code)
  try {
    const result = await guest.invoke(
      "0",
      client ? { kind: "render", props: {}, columns: 80, rows: 20 } : {},
      async () => {
        throw Error("Standard globals must not invoke SDK operations")
      },
      {
        event: client ? "surface.update" : "command.run",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "standard", root: "/standard" }
      }
    )
    return client
      ? JSON.parse((result.value as { tree: { children: string[] } }).tree.children[0])
      : result.value
  } finally {
    guest.dispose()
  }
}

it("implements the pinned standard primitive and four digest vectors", async () => {
  expect(await probe("standardGlobalsProbe()", false, STANDARD_GLOBALS_PROBE_SOURCE)).toEqual(
    EXPECTED_STANDARD_GLOBALS_PROBE
  )
})

it.each([false, true])("uses guest-owned primitives in Hook/Client (%s)", async (client) => {
  expect(
    await probe(
      `(()=>{const a=new AbortController();a.abort();const x={};x.self=x;
    const y=structuredClone(x);const before=performance.now();Date.now=()=>-999;
    return [a.signal instanceof AbortSignal,a.signal.reason.name,y.self===y,
      performance.now()>=before,crypto.getRandomValues(new Uint8Array(0)).length,
      typeof __functionStandardHost]})()`,
      client
    )
  ).toEqual([true, "AbortError", true, true, 0, "undefined"])
})

it("composes SDK signals and retains abort reason identity and listener semantics", async () => {
  expect(
    await probe(`(()=>{const controller=new AbortController(),reason={code:1},seen=[];
    const combined=AbortSignal.any([next.signal,controller.signal]);
    const removed=()=>seen.push("removed");combined.addEventListener("abort",removed);
    combined.removeEventListener("abort",removed);
    combined.addEventListener("abort",function(e){seen.push(this===combined&&e.target===combined)},{once:true});
    combined.onabort=()=>seen.push("onabort");controller.abort(reason);controller.abort("ignored");
    let same=false;try{combined.throwIfAborted()}catch(e){same=e===reason}
    return {sdk:next.signal instanceof AbortSignal,seen,same,any:AbortSignal.any([combined]).reason===reason,
      empty:AbortSignal.any([]).aborted}})()`)
  ).toEqual({ sdk: true, seen: [true, "onabort"], same: true, any: true, empty: false })
})

it("detaches losing signal subscriptions and rejects forged signals", async () => {
  expect(
    await probe(`(()=>{const a=new AbortController(),b=new AbortController();let removed=0;
    const remove=b.signal.removeEventListener;b.signal.removeEventListener=function(...args){removed++;return remove.apply(this,args)};
    const combined=AbortSignal.any([a.signal,b.signal]);a.abort("a");b.abort("b");
    const errors=[];for(const fn of [()=>new AbortSignal(),()=>AbortSignal.any([{}]),
      ()=>AbortSignal.prototype.throwIfAborted.call({})])try{fn()}catch(e){errors.push(e.name)}
    return [removed,combined.reason,errors]})()`)
  ).toEqual([1, "a", ["TypeError", "TypeError", "TypeError"]])
})

it("validates integer view brands, byte quotas, identity and subarray boundaries", async () => {
  expect(
    await probe(`(()=>{const data=new Uint8Array(12);data.fill(7);const view=new Uint16Array(data.buffer,2,3);
    const same=crypto.getRandomValues(view)===view;const names=[];
    for(const bad of [new Float32Array(1),new Float64Array(1),new DataView(new ArrayBuffer(1)),{},
      {[Symbol.toStringTag]:"Uint8Array",byteLength:1},new Uint8Array(65537),new Uint32Array(16385)])
      try{crypto.getRandomValues(bad);names.push("accepted")}catch(e){names.push(e.name)}
    return {same,edges:[data[0],data[1],data[8],data[11]],names,
      limit:crypto.getRandomValues(new Uint32Array(16384)).byteLength,
      bigint:crypto.getRandomValues(new BigInt64Array(2)).length}})()`)
  ).toEqual({
    same: true,
    edges: [7, 7, 7, 7],
    names: [
      "TypeMismatchError",
      "TypeMismatchError",
      "TypeMismatchError",
      "TypeMismatchError",
      "TypeMismatchError",
      "QuotaExceededError",
      "QuotaExceededError"
    ],
    limit: 65536,
    bigint: 2
  })
})

it("copies digest input immediately and honors DataView and TypedArray offsets", async () => {
  expect(
    await probe(`(async()=>{const buffer=new Uint8Array([0,97,98,99,0]);
    const typed=crypto.subtle.digest("SHA-256",buffer.subarray(1,4));
    const view=crypto.subtle.digest("SHA-256",new DataView(buffer.buffer,1,3));
    buffer.fill(0);const hex=x=>Array.from(new Uint8Array(x),b=>b.toString(16).padStart(2,"0")).join("");
    return [hex(await typed),hex(await view)]})()`)
  ).toEqual([EXPECTED_STANDARD_GLOBALS_PROBE.hashes[1], EXPECTED_STANDARD_GLOBALS_PROBE.hashes[1]])
})

it("rejects bad digest algorithms, buffer forgeries and excessive raw bytes asynchronously", async () => {
  expect(
    await probe(`(async()=>{const errors=[];
    for(const [algorithm,data] of [["MD5",new Uint8Array()],["SHA-256",{}],
      ["SHA-256",{[Symbol.toStringTag]:"ArrayBuffer",byteLength:1}],["SHA-256",new Uint8Array(1048577)]]){
      const pending=crypto.subtle.digest(algorithm,data);if(!(pending instanceof Promise))throw Error("not Promise");
      try{await pending;errors.push("accepted")}catch(e){errors.push(e.name)}
    }return errors})()`)
  ).toEqual(["NotSupportedError", "TypeError", "TypeError", "QuotaExceededError"])
})

it("clones the pinned graph types including its independent view and Date copy semantics", async () => {
  expect(
    await probe(`(()=>{const date=new Date(42),r=/abc/gi;r.lastIndex=2;
    const buffer=new Uint8Array([1,2,3,4]).buffer,view=new DataView(buffer,1,2);
    const source={date,again:date,r,error:new TypeError("bad"),buffer,view,typed:new Uint8Array(buffer,1,2),
      map:new Map(),set:new Set(),big:2n};source.map.set(source,source.set);source.set.add(source);source.self=source;
    const clone=structuredClone(source);
    return [clone!==source,clone.self===clone,clone.map.get(clone)===clone.set,clone.set.has(clone),
      clone.date.getTime(),clone.date!==clone.again,clone.r.source,clone.r.flags,clone.r.lastIndex,
      clone.error.name,clone.error.message,clone.view.byteOffset,clone.view.byteLength,
      Array.from(clone.typed),clone.view.buffer!==clone.buffer,clone.typed.buffer!==clone.buffer,String(clone.big)]})()`)
  ).toEqual([
    true,
    true,
    true,
    true,
    42,
    true,
    "abc",
    "gi",
    0,
    "TypeError",
    "bad",
    0,
    2,
    [2, 3],
    true,
    true,
    "2"
  ])
})

it("rejects unsupported clone values and preserves __proto__ as safe own data", async () => {
  expect(
    await probe(`(()=>{const errors=[];for(const value of [()=>1,Symbol(),new(class X{})(),new WeakMap(),Promise.resolve(1)])
    try{structuredClone(value);errors.push("accepted")}catch(e){errors.push(e.name)}
    const clone=structuredClone(JSON.parse('{"__proto__":{"polluted":true}}'));
    return [errors,Object.hasOwn(clone,"__proto__"),Object.getPrototypeOf(clone)===Object.prototype,{}.polluted===undefined]})()`)
  ).toEqual([Array(5).fill("DataCloneError"), true, true, true])
})

it("retains VM code-generation isolation across all new public objects", async () => {
  expect(
    await probe(`(()=>{const errors=[];for(const fn of [crypto.randomUUID,crypto.subtle.digest,performance.now,
    structuredClone,AbortController,AbortSignal.prototype.addEventListener])
    try{fn.constructor("return process")();errors.push("escaped")}catch(e){errors.push(e.message)}
    return errors})()`)
  ).toEqual(Array(6).fill("MODS_CODE_GENERATION_DENIED"))
})
