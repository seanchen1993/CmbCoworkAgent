import { expect, it } from "vitest"
import { ModToolLoading, MODS_TOOL_SEARCH } from "./mods-tool-loading"
import { describeModTools } from "./mods-tool-descriptions"
import type { RegisteredFunctionTool } from "../../shared/mods/v2/tools"

const tool = (overrides: Partial<RegisteredFunctionTool> = {}): RegisteredFunctionTool => ({
  name: "mcp__demo__probe", plugin: "demo", description: "Inspect a record", mcp: true,
  inputSchema: { type: "object", properties: { count: { type: "integer" } } },
  registrationId: "one", isDeferred: true, ...overrides
})

it("loads only matching names, publishes schemas next step and retains exact schema identity", () => {
  const loading = new ModToolLoading(), original = tool()
  const first = loading.prepare([original], () => {})
  expect(first.tools.map(entry => entry.function.name)).toEqual([MODS_TOOL_SEARCH])
  expect(first.context).toContain(original.name)
  expect(first.context).not.toContain(original.description)
  expect(first.context).not.toContain("count")
  expect(loading.search({ query: "record" }, [original])).toEqual({ loaded: [original.name], nextStep: true })
  expect(() => loading.assertCallable(original.name, [original])).toThrow("MODS_TOOL_NOT_LOADED")
  const next = loading.prepare([original], () => {})
  expect(next.tools[0].function.parameters).toBe(original.inputSchema)
  expect(() => loading.assertCallable(original.name, [original])).not.toThrow()
})

it("does not retain loaded schemas after replacement, cancellation, revocation or scope loss", () => {
  const loading = new ModToolLoading(), original = tool()
  let live = true
  const guard = () => { if (!live) throw Error("revoked") }
  loading.prepare([original], guard)
  const cancelled = new AbortController()
  cancelled.abort()
  expect(() => loading.search({ query: "probe" }, [original], cancelled.signal)).toThrow()
  expect(loading.prepare([original], guard).tools[0].function.name).toBe(MODS_TOOL_SEARCH)
  loading.search({ query: "probe" }, [original])
  loading.prepare([original], guard)
  const replacement = tool({ registrationId: "two" })
  expect(() => loading.assertCallable(original.name, [replacement])).toThrow("MODS_TOOL_NOT_LOADED")
  expect(loading.prepare([replacement], guard).tools[0].function.name).toBe(MODS_TOOL_SEARCH)
  live = false
  expect(() => loading.search({ query: "probe" }, [replacement])).toThrow("revoked")
  live = true
  const freshScope = new ModToolLoading()
  expect(freshScope.prepare([replacement], guard).tools[0].function.name).toBe(MODS_TOOL_SEARCH)
})

it("publishes eager tools immediately and never runs registered descriptions twice", async () => {
  const loading = new ModToolLoading(), eager = tool({ isDeferred: false, description: "overridden" })
  const projected = loading.prepare([eager], () => {})
  const output = await describeModTools(projected.tools, async () => {
    throw Error("description was already projected")
  }, () => {})
  expect(output[0]).toBe(projected.tools[0])
  expect(() => loading.assertCallable(eager.name, [eager])).not.toThrow()
})


it("retains a loaded registration across description refreshes but not identity/schema/placement changes", () => {
  const loading = new ModToolLoading(), original = tool()
  loading.prepare([original],()=>{})
  loading.search({query:"record"},[original])
  const updated = {...original,description:"Current description after state update"}
  const projected = loading.prepare([updated],()=>{})
  expect(projected.tools.map(entry=>entry.function.name)).toEqual([original.name])
  expect(projected.tools[0].function.description).toBe(updated.description)
  expect(()=>loading.assertCallable(original.name,[original])).not.toThrow()
  for (const changed of [tool({registrationId:"replacement"}),
    tool({inputSchema:{type:"object",properties:{different:{type:"string"}}}}),
    tool({plugin:"other"})])
    expect(()=>loading.assertCallable(original.name,[changed])).toThrow("MODS_TOOL_NOT_LOADED")
  loading.prepare([tool({isDeferred:false})],()=>{})
  expect(loading.prepare([original],()=>{}).tools[0].function.name).toBe(MODS_TOOL_SEARCH)
})
