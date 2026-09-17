import { afterEach, expect, it } from "vitest"
import { resolve } from "node:path"
import { FunctionToolRegistry, functionToolSpec } from "./tool-registry"
import { validateRegisteredToolInput } from "./tool-schema"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import type { ModObject } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

it("defaults schemas, replaces only the owner's entry and never gives callers a mutable registry view", () => {
  const registry = new FunctionToolRegistry()
  expect(registry.register("demo", { name: "probe", description: "old" })).toEqual({
    tool: "mcp__demo__probe"
  })
  expect(registry.list()[0].inputSchema).toEqual({ type: "object" })
  registry.register("demo", { name: "probe", description: "new" })
  expect(registry.list()).toHaveLength(1)
  const view = registry.list()
  view[0].description = "forged"
  expect(registry.list()[0].description).toBe("new")
  registry.register("other", { name: "probe", description: "other" })
  registry.register("a__b", { name: "c", description: "owned" })
  expect(() => registry.register("a", { name: "b__c", description: "collision" })).toThrow(
    "MODS_TOOL_NAME_COLLISION"
  )
  registry.clear()
  expect(registry.list()).toEqual([])
})

it("rejects unsupported or ambiguous schemas and enforces registry bounds without partial replacement", () => {
  const invalidSchemas: ModObject[] = [
    { type: "string" },
    { type: "object", properties: { tool: { type: "string" } } },
    { type: "object", required: ["agentId"] },
    { type: "object", patternProperties: { ".*": {} } },
    { type: "object", properties: { x: { $ref: "https://example.test/schema" } } }
  ]
  for (const inputSchema of invalidSchemas)
    expect(() => functionToolSpec({ name: "probe", description: "probe", inputSchema })).toThrow(
      "MODS_TOOL_SCHEMA"
    )
  expect(() =>
    functionToolSpec({ name: "probe", description: "probe", inputSchema: null })
  ).toThrow("MODS_TOOL_SCHEMA")
  const registry = new FunctionToolRegistry()
  for (let index = 0; index < 32; index++)
    registry.register("demo", { name: `t${index}`, description: "Tool" })
  expect(() => registry.register("demo", { name: "overflow", description: "Tool" })).toThrow(
    "MODS_TOOL_REGISTRY_LIMIT"
  )
  registry.register("demo", { name: "t0", description: "replacement" })
  expect(registry.list()).toHaveLength(32)
})

it("validates nested arguments without coercion, extra properties, host identity leakage or default mutation", () => {
  const registry = new FunctionToolRegistry()
  registry.register("demo", {
    name: "probe",
    description: "Probe",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 5 },
        mode: { enum: ["a", "b"] },
        values: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
          minItems: 1,
          maxItems: 4
        }
      },
      required: ["count", "values"],
      additionalProperties: false
    }
  })
  const input = {
    tool: "mcp__demo__probe",
    tool_use_id: "host",
    agentId: "worker",
    count: 2,
    values: ["hi"]
  }
  expect(registry.validate(input)?.name).toBe(input.tool)
  const changes: ModObject[] = [
    { count: "2" },
    { count: 0 },
    { values: ["hi", "hi"] },
    { values: [""] },
    { extra: true },
    { mode: "c" }
  ]
  for (const changed of changes)
    expect(() => registry.validate({ ...input, ...changed })).toThrow("MODS_REGISTERED_TOOL_INPUT")
  expect(input).toEqual({
    tool: "mcp__demo__probe",
    tool_use_id: "host",
    agentId: "worker",
    count: 2,
    values: ["hi"]
  })
})

it("supports composition, Unicode length and order-independent object enum equality with a work budget", () => {
  const schema: ModObject = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 1 },
      choice: { oneOf: [{ const: 1 }, { type: "string" }] },
      object: { enum: [{ a: 1, b: 2 }] }
    },
    required: ["name", "choice", "object"]
  }
  expect(() =>
    validateRegisteredToolInput(schema, { name: "😀", choice: 1, object: { b: 2, a: 1 } })
  ).not.toThrow()
  expect(() =>
    validateRegisteredToolInput(schema, { name: "ab", choice: true, object: { a: 1, b: 2 } })
  ).toThrow()
  expect(() =>
    validateRegisteredToolInput(
      { type: "object", properties: { items: { type: "array", uniqueItems: true } } },
      { items: Array.from({ length: 250 }, (_, i) => i) }
    )
  ).toThrow("MODS_TOOL_VALIDATION_LIMIT")
  expect(() =>
    validateRegisteredToolInput(
      { type: "object", properties: { items: { uniqueItems: true } } },
      { items: Array.from({ length: 80 }, (_, i) => [...Array(100).fill(0), i]) }
    )
  ).toThrow("MODS_TOOL_VALIDATION_LIMIT")
})

it("checks decimal multiples without accepting tiny or nearly integral non-multiples", () => {
  for (const [value, multipleOf] of [
    [0.3, 0.1],
    [-0.3, 0.1],
    [0, 0.1],
    [1e30, 1e-30]
  ])
    expect(() =>
      validateRegisteredToolInput({ properties: { value: { multipleOf } } }, { value })
    ).not.toThrow()
  for (const value of [1e-11, 1.00000000001, -1e-11])
    expect(() =>
      validateRegisteredToolInput({ properties: { value: { multipleOf: 1 } } }, { value })
    ).toThrow("MODS_REGISTERED_TOOL_INPUT")
})

async function customSession(body: string, host: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.tool.register({name:"probe",description:"Probe",inputSchema:{type:"object",properties:{count:{type:"integer",minimum:1}},required:["count"],additionalProperties:false}});return next(e)});
    ${body}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "demo",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {},
      publish: async (v) => v,
      ...host
    }
  )
  sessions.push(session)
  return session
}

it("rejects invalid arguments before the handler and revalidates every next rewrite", async () => {
  let executed = 0
  const session = await customSession(
    `
    on("tool.call",{tool:"mcp__demo__probe"},async($,e,next)=>next({...e,count:"bad"}));
    on("tool.call",{tool:"mcp__demo__probe"},async($,e)=>{await $.store.set("ran",true);return {result:e.count}});
  `,
    {
      capability: async () => {
        executed++
        return undefined
      }
    }
  )
  const call = (count: number | string) =>
    session.interceptTool(
      { tool: "mcp__demo__probe", tool_use_id: "model", count },
      undefined,
      async () => {
        throw Error("native fallback")
      }
    )
  await expect(call("bad")).rejects.toThrow("MODS_REGISTERED_TOOL_INPUT")
  await expect(call(1)).rejects.toThrow("MODS_REGISTERED_TOOL_INPUT")
  expect(executed).toBe(0)
})

it("does not invent a native fallback for registrations without a handler", async () => {
  const session = await customSession("")
  await expect(
    session.interceptTool(
      { tool: "mcp__demo__probe", tool_use_id: "model", count: 1 },
      undefined,
      async () => ({ result: "fake" })
    )
  ).rejects.toThrow("MODS_REGISTERED_TOOL_UNHANDLED")
})

it("rejects metadata growth atomically while permitting smaller replacements", () => {
  const registry = new FunctionToolRegistry()
  for (let i = 0; i < 31; i++)
    registry.register("demo", { name: `t${i}`, description: "x".repeat(8000) })
  registry.register("demo", { name: "t31", description: "small" })
  expect(() => registry.register("demo", { name: "t31", description: "x".repeat(8000) })).toThrow(
    "MODS_TOOL_REGISTRY_LIMIT"
  )
  expect(registry.list().at(-1)?.description).toBe("small")
})

it("runs the official registry fixture through a real VM and serves both SDK and model calls", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/tool-registry"))
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest: await FunctionGuestRuntime.create(compiled.code),
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    { workspace: "/project", threadId: "thread", assertLive: () => {}, publish: async (v) => v }
  )
  sessions.push(session)
  expect((await session.registeredTools())[0].name).toBe("mcp__tool-registry__echo")
  expect(JSON.parse(String((await session.run("registry-probe", "hello")).text))).toEqual({
    registered: { tool: "mcp__tool-registry__echo" },
    tools: [{ name: "mcp__tool-registry__echo", description: "Echo replaced", mcp: true }],
    answer: { result: "hello", context: ["tool-registry"] }
  })
  expect(
    await session.interceptTool(
      { tool: "mcp__tool-registry__echo", tool_use_id: "model-id", text: "model" },
      undefined,
      async () => {
        throw Error("Must not call native fallback")
      }
    )
  ).toEqual({ result: "model", context: ["engine"] })
  await session.close()
  await expect(session.registeredTools()).rejects.toThrow("MODS_SESSION_CLOSED")
})
