import { afterEach, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { validateToolSchema, validateRegisteredToolInput } from "./tool-schema"
import { validateFunctionToolResult } from "./tool-sdk"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function sessionWith(body: string): Promise<FunctionSession> {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  const session = new FunctionSession(
    [
      {
        name: "schema",
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
      publish: async (value) => value
    }
  )
  sessions.push(session)
  return session
}

const invalidRules: ModObject[] = [
  { title: 1 },
  { description: {} },
  { $comment: false },
  { examples: "not an array" },
  { type: ["string", "string"] }
]

it.each(invalidRules)("rejects malformed supported schema metadata/type: %j", (rule) => {
  expect(() => validateToolSchema({ type: "object", properties: { query: rule } })).toThrow(
    "MODS_TOOL_SCHEMA"
  )
  expect(() => validateToolSchema({ type: "object", $defs: { query: rule } })).toThrow(
    "MODS_TOOL_SCHEMA"
  )
})

it("does not replace a live guest tool with malformed schema annotations", async () => {
  const session = await sessionWith(`
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"register",description:"Register schema"});
      await $.tool.register({name:"probe",description:"Original",inputSchema:{type:"object"}});
      return next(e);
    });
    on("command.run",{command:"register"},async($,e)=>{
      try {await $.tool.register({name:"probe",description:"Invalid replacement",inputSchema:JSON.parse(e.args)});return {text:"registered"};}
      catch(error){return {text:String(error.message)};}
    });
    on("tool.call",{tool:"mcp__schema__probe"},async()=>({result:"original tool"}));
  `)
  for (const rule of invalidRules) {
    const result = await session.run(
      "register",
      JSON.stringify({ type: "object", properties: { query: rule } })
    )
    expect(result.text).toContain("MODS_TOOL_SCHEMA")
    expect((await session.registeredTools())[0].description).toBe("Original")
  }
  await expect(
    session.interceptTool(
      { tool: "mcp__schema__probe", tool_use_id: "host" },
      undefined,
      async () => {
        throw Error("unexpected core")
      }
    )
  ).resolves.toEqual({ result: "original tool" })
})

it("retains annotation-only defaults and actual local reference/composition/enum validation", async () => {
  const schema: ModObject = {
    type: "object",
    title: "Lookup",
    description: "Bounded query",
    $comment: "No default injection",
    examples: [{ query: "example" }],
    $defs: { query: { anyOf: [{ type: "string", minLength: 2 }, { const: 7 }] } },
    properties: {
      query: { $ref: "#/$defs/query", not: { const: "no" } },
      mode: { enum: ["fast", "full"], default: "fast" },
      pair: { enum: [{ a: 1, b: 2 }] }
    },
    required: ["query"],
    additionalProperties: false,
    allOf: [
      {
        not: {
          required: ["query", "mode"],
          properties: { query: { const: 7 }, mode: { const: "full" } }
        }
      }
    ]
  }
  validateToolSchema(schema)
  const session = await sessionWith(`
    on("session.start",async($,e,next)=>{await $.tool.register({name:"probe",description:"Query",inputSchema:${JSON.stringify(schema)}});return next(e)});
    on("tool.call",{tool:"mcp__schema__probe"},async($,e)=>({result:{query:e.query,hasDefault:Object.hasOwn(e,"mode")}}));
  `)
  const call = (args: ModObject) =>
    session.interceptTool(
      { ...args, tool: "mcp__schema__probe", tool_use_id: "host" },
      undefined,
      async () => {
        throw Error("unexpected core")
      }
    )
  await expect(call({ query: "yes", pair: { b: 2, a: 1 } })).resolves.toEqual({
    result: { query: "yes", hasDefault: false }
  })
  await expect(call({ query: 7, mode: "fast" })).resolves.toEqual({
    result: { query: 7, hasDefault: true }
  })
  const invalidInputs: ModObject[] = [
    { query: "n" },
    { query: "no" },
    { query: 7, mode: "full" },
    { query: "ok", extra: true }
  ]
  for (const input of invalidInputs)
    await expect(call(input)).rejects.toThrow("MODS_REGISTERED_TOOL_INPUT")
  expect(() => validateRegisteredToolInput(schema, { query: "ok" })).not.toThrow()
})

const mixedDenials: ModObject[] = [
  { deny: "refused", context: ["cannot accompany deny"] },
  { deny: "refused", ref: 1 },
  { deny: "refused", text: "cannot accompany deny" },
  { deny: "refused", isError: true }
]

it.each(mixedDenials)("rejects mixed deny/result envelopes: %j", (value) => {
  expect(() => validateFunctionToolResult(value)).toThrow("MODS_TOOL_RESULT")
})

it.each(mixedDenials)(
  "uses optional-hook fallback for malformed guest denial: %j",
  async (value) => {
    const session = await sessionWith(`on("tool.call",async()=>(${JSON.stringify(value)}));`)
    let coreCalls = 0
    const core = async (): Promise<ModObject> => {
      coreCalls++
      return { result: "host core" }
    }
    const result = await session.interceptTool(
      { tool: "read_file", file_path: "example.txt", tool_use_id: "host" },
      undefined,
      core
    )
    expect(result).toEqual({ result: "host core" })
    expect(coreCalls).toBe(1)
  }
)

it("keeps valid guest denials terminal without calling core", async () => {
  const session = await sessionWith('on("tool.call",async()=>({deny:"refused"}));')
  await expect(
    session.interceptTool(
      { tool: "read_file", file_path: "example.txt", tool_use_id: "host" },
      undefined,
      async () => {
        throw Error("denial must not call core")
      }
    )
  ).resolves.toEqual({ deny: "refused" })
})
