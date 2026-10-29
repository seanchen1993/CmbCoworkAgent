import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionDispatcher, type FunctionDispatchOptions } from "./dispatcher"
import { compileFunctionPlugin } from "./loader"

const guests: FunctionGuestRuntime[] = []
const fixture = resolve("tests/fixtures/mods-v2/conformance")
async function reference(): Promise<FunctionDispatcher> {
  const compiled = await compileFunctionPlugin(fixture)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  guests.push(guest)
  return new FunctionDispatcher([
    { name: compiled.name, root: fixture, tier: "user", guest, capabilities: [] }
  ])
}
async function run(command: string, core: FunctionDispatchOptions["core"]): Promise<ModObject> {
  const engine = await reference()
  const result = await engine.dispatch(
    "command.run",
    { command, args: "", origin: { kind: "composer" } },
    { core }
  )
  return result.value as ModObject
}
afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))

describe("Claude 2.1.273 conformance: same plugin source as claude plugin test", () => {
  it("refuses redirecting the reserved command", async () => {
    expect(await run("cmb-pinned", async (_, e) => ({ text: e.command }))).toEqual({
      text: "cmb-pinned"
    })
  })
  it("rejects an omitted command and skips the rewrite", async () => {
    expect(
      await run("cmb-pinned-omitted", async (_, e) => ({ text: `${e.command}:${e.args}` }))
    ).toEqual({ text: "cmb-pinned-omitted:" })
  })
  it("ordered input and output composition", async () => {
    expect(await run("cmb-order", async (_, e) => ({ text: e.args }))).toEqual({ text: "A(B(AB))" })
  })
  it("two next calls execute downstream twice", async () => {
    let count = 0
    const ids = new Set<string>()
    expect(
      await run("cmb-double", async (_, _e, { callId }) => {
        ids.add(callId)
        return { text: String(++count) }
      })
    ).toEqual({ text: "1,2" })
    expect(count).toBe(2)
    expect(ids.size).toBe(2)
  })
  it("throw before next fails open", async () => {
    let count = 0
    expect(await run("cmb-throw-before", async () => ({ text: String(++count) }))).toEqual({
      text: "1"
    })
    expect(count).toBe(1)
  })
  it("throw after next retains downstream without replay", async () => {
    let count = 0
    expect(await run("cmb-throw-after", async () => ({ text: String(++count) }))).toEqual({
      text: "1"
    })
    expect(count).toBe(1)
  })
  it("registered catch can refuse without invoking downstream", async () => {
    let count = 0
    expect(await run("cmb-catch", async () => ({ text: String(++count) }))).toEqual({
      text: "REFUSED_BY_CATCH"
    })
    expect(count).toBe(0)
  })
  it("short circuit skips downstream", async () => {
    let count = 0
    expect(await run("cmb-short", async () => ({ text: String(++count) }))).toEqual({
      text: "SHORT"
    })
    expect(count).toBe(0)
  })
  it("trace and host origin are exposed", async () => {
    const result = await run("cmb-trace", async () => ({ text: "ok" }))
    expect(JSON.parse(String(result.text))).toMatchObject({
      text: "ok",
      origin: { plugin: "engine", tier: "core" },
      aborted: false
    })
    expect(JSON.parse(String(result.text)).entries).toBeGreaterThan(0)
  })
  it("downstream failure propagates without replay", async () => {
    let count = 0
    await expect(
      run("cmb-downstream-error", async () => {
        count++
        throw Error("downstream-probe")
      })
    ).rejects.toThrow("downstream-probe")
    expect(count).toBe(1)
  })
  it.each([
    ["cmb-catch-replay", "true:throw:1:1"],
    ["cmb-catch-once", "false:throw:1:1"],
    ["cmb-undefined-after", "1"],
    ["cmb-undefined-before", "1"]
  ])("preserves recovery semantics for %s", async (command, expected) => {
    let count = 0
    expect(await run(command, async () => ({ text: String(++count) }))).toEqual({ text: expected })
    expect(count).toBe(1)
  })
  it("event patterns and next.is agree", async () => {
    expect(
      await run("cmb-pattern", async () => {
        throw Error("unexpected core")
      })
    ).toEqual({ text: "command.run:true:true" })
  })
})
