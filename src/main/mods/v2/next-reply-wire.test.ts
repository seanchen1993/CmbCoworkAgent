import { expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionHostReply, ModTraceEntry } from "../../../shared/mods/v2/contracts"
import { encodeModJson, MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { FunctionGuestRuntime } from "./guest-runtime"
import { encodeFunctionNextReply } from "./next-reply-wire"

function entry(returned: ModJson): ModTraceEntry {
  return { index: 0, plugin: "engine", tier: "core", event: "command.run",
    outcome: "returned", ms: 1, received: {}, returned }
}

async function invoke(packet: FunctionHostReply, sdk = false) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",async($,e,next)=>{
      try {
        const value=${sdk ? "await $.tool.list()" : "await next(e)"};
        return {same:JSON.stringify(next.trace[0].returned)===JSON.stringify(value),
          frozen:Object.isFrozen(next.trace)&&Object.isFrozen(next.trace[0]),
          keys:Object.keys(next.trace[0]).sort()};
      }catch(error){return {error:error.message}}
    })
  }}`)
  try {
    const result = await guest.invoke("0", {}, async method => {
      expect(method).toBe(sdk ? "tool.list" : "next")
      return packet
    }, { event: "command.run", origin: { plugin: "engine", tier: "core" },
      capabilities: sdk ? ["tool.list"] : [], plugin: { name: "wire", root: "/wire" } })
    return result.value
  } finally { guest.dispose() }
}

it.each<ModJson>([null, false, 0, "text", { nested: ["same", { value: 12 }] }])(
  "restores exact primitive/nested returned values in real next.trace: %j", async value => {
    expect(await invoke({ value, trace: [entry(value)] })).toEqual({
      same: true, frozen: true,
      keys: ["event", "index", "ms", "outcome", "plugin", "received", "returned", "tier"]
    })
  }
)

it("keeps reference metadata outside arbitrary public values", () => {
  const value = { __modsNextReturnedRefs: [99], nested: { returned: "literal" } }
  const wire = JSON.parse(encodeFunctionNextReply({ value, trace: [entry(value)] }))
  expect(wire.value).toEqual(value)
  expect(wire.__modsNextReturnedRefs).toEqual([0])
  expect(wire.trace[0]).not.toHaveProperty("returned")
})

it("keeps the ordinary packet byte-for-byte if no repeated returned value exists", () => {
  const packet = { value: "first", trace: [entry("different")] }
  expect(encodeFunctionNextReply(packet)).toBe(encodeModJson(packet))
})

it("refuses an oversized original value even when every trace would share it", async () => {
  const value = "a".repeat(MODS_MAX_BYTES)
  expect(() => encodeFunctionNextReply({ value, trace: [entry(value)] })).toThrow("MODS_JSON_SIZE")
  expect(await invoke({ value, trace: [entry(value)] })).toEqual({ error: "MODS_INVALID_HOST_RESULT" })
})

it("refuses large nonduplicate trace values without expanding the wire limit", async () => {
  const packet = { value: "a".repeat(600_000), trace: [entry("b".repeat(600_000))] }
  expect(() => encodeFunctionNextReply(packet)).toThrow("MODS_JSON_SIZE")
  expect(await invoke(packet)).toEqual({ error: "MODS_INVALID_HOST_RESULT" })
})

it("does not compress SDK replies even when they contain duplicate trace content", async () => {
  const value = "a".repeat(600_000)
  expect(await invoke({ value, trace: [entry(value)] }, true))
    .toEqual({ error: "MODS_INVALID_HOST_RESULT" })
})

it("retains unsafe-key, accessor and cyclic-data rejection before deduplication", () => {
  const unsafe = JSON.parse('{"__proto__":"data"}')
  expect(() => encodeFunctionNextReply({ value: unsafe, trace: [entry(unsafe)] }))
    .toThrow("MODS_JSON_KEY")
  let accessed = false
  const accessor = { get value() { accessed = true; return "x" }, trace: [] }
  expect(() => encodeFunctionNextReply(accessor)).toThrow("MODS_JSON_ACCESSOR")
  expect(accessed).toBe(false)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(() => encodeFunctionNextReply({ value: "x", trace: [{ returned: cyclic }] }))
    .toThrow("MODS_JSON_CYCLE")
})


it("restores a void operation result without mutating its shared frozen trace value", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.invalidate",async($,e,next)=>{
      const result=await next(e);
      return {value:{continued:true,hasValue:Object.hasOwn(result,"value"),
        valueIsUndefined:result.value===undefined,resultFrozen:Object.isFrozen(result),
        traceHasValue:Object.hasOwn(next.trace[0].returned,"value"),
        traceFrozen:Object.isFrozen(next.trace[0].returned)}};
    })
  }}`)
  try {
    const result = await guest.invoke("0", { event: "ui.render" }, async method => {
      expect(method).toBe("next")
      return { value: {}, trace: [{ ...entry({}), event: "ui.invalidate" }] }
    }, { event: "ui.invalidate", operation: true,
      origin: { plugin: "engine", tier: "core" }, capabilities: [],
      plugin: { name: "wire", root: "/wire" } })
    expect(result.value).toEqual({ value: {
      continued: true, hasValue: true, valueIsUndefined: true, resultFrozen: true,
      traceHasValue: false, traceFrozen: true
    } })
  } finally { guest.dispose() }
})
