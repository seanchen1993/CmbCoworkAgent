import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { getQuickJS } from "quickjs-emscripten"
import { FUNCTION_CODEGEN_GUARD } from "./guest-codegen"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import {
  CODEGEN_PROBE_COUNT,
  CODEGEN_PROBE_SOURCE
} from "../../../../tests/fixtures/mods-v2/codegen-probes"

const guests: FunctionGuestRuntime[] = []
const options: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["session.id"],
  plugin: { name: "codegen", root: "/plugin" }
}
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))
async function create(code: string) {
  const guest = await FunctionGuestRuntime.create(code, { plugin: "codegen" })
  guests.push(guest)
  return guest
}
const denied = Array.from({ length: CODEGEN_PROBE_COUNT }, () => ({
  name: "TypeError",
  message: "MODS_CODE_GENERATION_DENIED"
}))

it("blocks native async and async-generator constructors before source lowering", async () => {
  const context = (await getQuickJS()).newContext()
  try {
    context.unwrapResult(context.evalCode(FUNCTION_CODEGEN_GUARD)).dispose()
    const result = context.unwrapResult(
      context.evalCode(`[
      async function(){},async function*(){}
    ].map(fn=>{
      const proto=Object.getPrototypeOf(fn);let message;
      try{proto.constructor("return 2")}catch(error){message=error.message}
      let redefined=false;
      try{Object.defineProperty(proto,"constructor",{value:()=>42})}catch{redefined=true}
      return {message,redefined}
    })`)
    )
    try {
      expect(context.dump(result)).toEqual(
        Array.from({ length: 2 }, () => ({
          message: "MODS_CODE_GENERATION_DENIED",
          redefined: true
        }))
      )
    } finally {
      result.dispose()
    }
  } finally {
    context.dispose()
  }
})

it("blocks direct and indirect generation before plugin registration", async () => {
  const guest = await create(`${CODEGEN_PROBE_SOURCE}
    const initial=codegenProbe();
    var __cmbFunctionMod={register(on){on("command.run",()=>initial)}}`)
  expect((await guest.invoke("0", {}, async () => ({}), options)).value).toEqual(denied)
})

it("keeps generation blocked after an actual asynchronous SDK continuation", async () => {
  const guest = await create(`${CODEGEN_PROBE_SOURCE}
    var __cmbFunctionMod={register(on){on("command.run",async $=>{
      const id=await $.session.id();return {id,probes:codegenProbe()}
    })}}`)
  expect(
    (await guest.invoke("0", {}, async () => ({ value: "real-host" }), options)).value
  ).toEqual({
    id: "real-host",
    probes: denied
  })
})

it("does not allow replacing the global or prototype bindings", async () => {
  const guest = await create(`var __cmbFunctionMod={register(on){on("command.run",()=>{
    const results=[];
    for(const [object,key] of [[globalThis,"eval"],[globalThis,"Function"],
      [Object.getPrototypeOf(()=>{}),"constructor"],
      [Object.getPrototypeOf(function*(){}),"constructor"]]) {
      let redefine=false;try{Object.defineProperty(object,key,{value:()=>42})}catch{redefine=true}
      results.push({redefine,set:Reflect.set(object,key,()=>42),deleted:Reflect.deleteProperty(object,key)})
    }
    return results
  })}}`)
  expect((await guest.invoke("0", {}, async () => ({}), options)).value).toEqual(
    Array.from({ length: 4 }, () => ({ redefine: true, set: false, deleted: false }))
  )
})

it("applies the same restriction to a real isolated Client draw", async () => {
  const guest = await create(`${CLIENT_BOOTSTRAP}\n${CODEGEN_PROBE_SOURCE}
    var __cmbSurfaceMod={default(_,s){return h(s.elements.Text,null,JSON.stringify(codegenProbe()))}}`)
  const result = await guest.invoke(
    "0",
    { kind: "render", props: {}, columns: 80, rows: 20 },
    async () => {
      throw Error("Client must not call host")
    },
    { ...options, event: "surface.update", capabilities: [] }
  )
  expect(result.value).toMatchObject({ tree: { type: "Text", children: [JSON.stringify(denied)] } })
})

it("preserves ordinary functions, generators, regex matching and host invocation", async () => {
  const guest = await create(`var __cmbFunctionMod={register(on){
    on("command.run",{command:/^check$/},async $=>({
      normal:(x=>x+1)(1),generator:(function*(){yield 3})().next().value,
      id:await $.session.id(),prototypeKept:Function.prototype===Object.getPrototypeOf(()=>{}),
      ambient:[typeof WebAssembly,typeof process,typeof setTimeout]
    }))}}`)
  expect(guest.matches("0", { command: "check" })).toBe(true)
  expect(guest.matches("0", { command: "other" })).toBe(false)
  expect((await guest.invoke("0", {}, async () => ({ value: "alive" }), options)).value).toEqual({
    normal: 2,
    generator: 3,
    id: "alive",
    prototypeKept: true,
    ambient: Array(3).fill("undefined")
  })
})
