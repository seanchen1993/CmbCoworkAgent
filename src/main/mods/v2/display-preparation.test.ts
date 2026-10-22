import { bindFunctionUiResolveRuntime } from "./ui-resolve-runtime-binding"
import { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"
import { build } from "esbuild"
import { afterEach, expect, it, vi } from "vitest"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"
import { FunctionGuestRuntime } from "./guest-runtime"
import { analyzeStaticUiRenderSummary } from "./static-ui-render-summary"
import {
  aliasFunctionDisplayPreparation,
  FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT,
  FunctionDisplayPreparationChannel,
  functionPreparedDisplayProof,
  prepareFunctionDisplayEnvelope
} from "./display-preparation"
import { FunctionDisplayRouting } from "./display-routing"

const guests: FunctionGuestRuntime[] = []
afterEach(async () => {
  for (const guest of guests.splice(0)) await guest.dispose()
})
async function fixture() {
  const result = await build({
    stdin: {
      contents: `export function register(on) {
    on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}))
  }`
    },
    bundle: true,
    write: false,
    globalName: "__cmbFunctionMod",
    format: "iife",
    target: "es2016"
  })
  const code = result.outputFiles[0].text
  const native = await FunctionGuestRuntime.create(code)
  guests.push(native)
  const owner = { client: {}, physical: new FunctionUiResolveHostLifetime({}) }
  const proxy = (): FunctionGuest => {
    const guest: FunctionGuest = {
      registrations: native.registrations.map((row) => ({ ...row })),
      stats: { disposed: false },
      matches: vi.fn(() => {
        throw Error("must not execute matcher")
      }),
      invoke: vi.fn(() => {
        throw Error("must not execute guest")
      }),
      dispose: () => {},
      releaseUi: () => {}
    }
    // Explicit native test adapter; real ownership is separately exercised through RuntimeClient/host-entry.
    bindFunctionUiResolveRuntime(guest, owner.client as never, "runtime", owner.physical, () => {})
    return guest
  }
  return {
    native,
    code,
    owner,
    proxy,
    wire: prepareFunctionDisplayEnvelope(native, code, "runtime")
  }
}

it("does not turn a guest property or copied wire JSON into a native proof", async () => {
  const f = await fixture(),
    proxy = Object.assign(f.proxy(), { displayPreparation: f.wire })
  const analyze = vi.fn(analyzeStaticUiRenderSummary)
  expect(functionPreparedDisplayProof(proxy, f.code, analyze)).toBeNull()
  expect(
    new FunctionDisplayRouting(analyze).qualify(
      [{ guest: proxy, code: f.code }],
      "AssistantMessage"
    )
  ).toBeUndefined()
  expect(analyze).not.toHaveBeenCalled()
})

it("binds only a native load envelope to its exact source, actual registrations and lifetime", async () => {
  const f = await fixture(),
    proxy = f.proxy()
  let current = true
  const channel = new FunctionDisplayPreparationChannel(f.owner, () => {
    if (!current) throw Error("physical retired")
  })
  channel.bind(proxy, f.code, "runtime", f.wire, () => {})
  const analyze = vi.fn(() => {
    throw Error("Main AST analysis must not run")
  })
  const proof = functionPreparedDisplayProof(proxy, f.code, analyze)
  expect(proof?.components).toEqual(["AssistantMessage"])
  expect(analyze).not.toHaveBeenCalled()
  expect(Object.isFrozen(proof)).toBe(true)
  const alias = f.proxy()
  aliasFunctionDisplayPreparation(proxy, alias)
  expect(functionPreparedDisplayProof(alias, f.code, analyze)).toBe(proof)
  expect(functionPreparedDisplayProof(alias, f.code + "\n", analyze)).toBeNull()
  current = false
  expect(() => functionPreparedDisplayProof(alias, f.code, analyze)).toThrow("physical retired")
})

it("does not locally analyze a legacy utility peer without the native preparation field", async () => {
  const f = await fixture(),
    proxy = f.proxy(),
    analyze = vi.fn(analyzeStaticUiRenderSummary)
  new FunctionDisplayPreparationChannel(f.owner, () => {}).bind(
    proxy,
    f.code,
    "runtime",
    undefined,
    () => {}
  )
  expect(functionPreparedDisplayProof(proxy, f.code, analyze)).toBeNull()
  expect(analyze).not.toHaveBeenCalled()
})

it.each(["code", "runtime", "registrations", "protocol", "active-payload"])(
  "rejects a %s mismatch from the load channel",
  async (change) => {
    const f = await fixture(),
      proxy = f.proxy()
    const wire = JSON.parse(JSON.stringify(f.wire))
    if (change === "code") wire.codeDigest = "0".repeat(64)
    if (change === "runtime") wire.runtimeId = "other"
    if (change === "protocol") wire.protocol = "mods.display.preparation/v2"
    if (change === "registrations") proxy.registrations[0].hasCatch = true
    if (change === "active-payload") wire.owner = "forged-owner"
    expect(() =>
      new FunctionDisplayPreparationChannel(f.owner, () => {}).bind(
        proxy,
        f.code,
        "runtime",
        wire,
        () => {}
      )
    ).toThrow(change === "registrations" ? "PREPARATION_IDENTITY" : "PREPARATION_INVALID")
    expect(functionPreparedDisplayProof(proxy, f.code)).toBeNull()
  }
)

it("retains the original local WeakSet-issued analyzer for real direct native VMs only", async () => {
  const f = await fixture(),
    analyze = vi.fn(analyzeStaticUiRenderSummary)
  // The utility envelope above already prepared this genuine native VM once.
  expect(functionPreparedDisplayProof(f.native, f.code, analyze)?.codeDigest).toBeDefined()
  expect(analyze).not.toHaveBeenCalled()
  expect(functionPreparedDisplayProof(f.proxy(), f.code, analyze)).toBeNull()
})

it("keeps an actually loaded oversized native source unproved without running its AST checker", async () => {
  const f = await fixture()
  const code = "/*" + "x".repeat(FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT) + "*/" + f.code
  const native = await FunctionGuestRuntime.create(code)
  guests.push(native)
  const analyze = vi.fn(analyzeStaticUiRenderSummary)
  expect(functionPreparedDisplayProof(native, code, analyze)).toBeNull()
  expect(analyze).not.toHaveBeenCalled()
  expect(prepareFunctionDisplayEnvelope(native, code, "large")).toMatchObject({ state: "unknown" })
})

it("refuses a wire package without the native runtime binding or from another physical client", async () => {
  const f = await fixture(),
    proxy = f.proxy()
  const unbound = { ...proxy }
  expect(() =>
    new FunctionDisplayPreparationChannel(f.owner, () => {}).bind(
      unbound,
      f.code,
      "runtime",
      f.wire,
      () => {}
    )
  ).toThrow("TRANSPORT_REQUIRED")
  const other = { client: {}, physical: new FunctionUiResolveHostLifetime({}) }
  expect(() =>
    new FunctionDisplayPreparationChannel(other, () => {}).bind(
      proxy,
      f.code,
      "runtime",
      f.wire,
      () => {}
    )
  ).toThrow("PREPARATION_IDENTITY")
  expect(functionPreparedDisplayProof(proxy, f.code)).toBeNull()
})
