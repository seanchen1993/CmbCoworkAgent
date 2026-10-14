import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { checkFunctionPlugin } from "./check"
import { compileFunctionPlugin } from "../v2/loader"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../v2/session"
import { checkFunctionAuthorTypes } from "./authoring-check"
import { AUTHORING_TEMPLATE_KINDS, createAuthoringTemplate } from "./authoring-templates"

const roots: string[] = []
async function materialize(bundle: ReturnType<typeof createAuthoringTemplate>) {
  const root = await mkdtemp(join(tmpdir(), "mods-authoring-template-"))
  roots.push(root)
  for (const file of bundle.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.text, "utf8")
  }
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith("mods-authoring-template-")).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})

describe("installable authoring starters", () => {
  it.each(AUTHORING_TEMPLATE_KINDS)(
    "builds and checks a complete %s starter through the real compiler and guest",
    async (kind) => {
      const input = {
        kind,
        id: "created-example",
        name: "模板示例",
        instruction: "请根据提供的文本整理结果，不补造检查结论。"
      }
      const bundle = createAuthoringTemplate(input)
      expect(createAuthoringTemplate(input).digest).toBe(bundle.digest)
      const root = await materialize(bundle)
      const check = await checkFunctionPlugin(root)
      expect(check.valid).toBe(true)
      expect(check.sdkCompatibility.diagnostics).toEqual([])
      expect(check.sdkCompatibility.strictCompatible).toBe(true)
      expect(check.authorized).toBe(false)
      expect(check.registrations.length).toBeGreaterThan(0)
      const types = await checkFunctionAuthorTypes(root)
      expect(types.diagnostics).toEqual([])
      expect(types.valid).toBe(true)
    }
  )

  it("starts the generated tool and serves its exact registered schema and handler", async () => {
    const instruction = "按原文整理，不补造结论。"
    const root = await materialize(createAuthoringTemplate({
      kind: "tool",
      id: "created-example",
      name: "工具模板",
      instruction
    }))
    const compiled = await compileFunctionPlugin(root)
    const session = new FunctionSession([
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest: await FunctionGuestRuntime.create(compiled.code),
        capabilities: [...SESSION_CAPABILITIES]
      }
    ], {
      workspace: root,
      threadId: "template-test",
      assertLive: () => {},
      publish: async value => value
    })
    try {
      await session.start()
      const tools = await session.registeredTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({
        name: "mcp__created-example__format",
        plugin: "created-example",
        description: "工具模板",
        isDeferred: true
      })
      expect(tools[0].inputSchema).toEqual({
        type: "object",
        properties: { text: { type: "string", maxLength: 8000 } },
        required: ["text"],
        additionalProperties: false
      })
      const result = await session.interceptTool({
        tool: tools[0].name,
        tool_use_id: "starter-format",
        text: "待整理内容"
      }, undefined, async () => {
        throw Error("Generated tool must not fall through to a native tool")
      })
      expect(result).toEqual({ result: `${instruction}\n待整理内容` })
    } finally {
      await session.close()
    }
  })

  it("treats quotes and code-like user text only as literal text", async () => {
    const instruction = '"}); on("process.run",()=>({})); //\n${globalThis}'
    const root = await materialize(
      createAuthoringTemplate({
        kind: "flow-action",
        id: "literal-example",
        name: "literal",
        instruction
      })
    )
    const check = await checkFunctionPlugin(root)
    expect(check.registrations.map((registration) => registration.pattern)).toEqual([
      "session.start",
      "command.run"
    ])
    expect(check.sdkCompatibility.diagnostics).toEqual([])
  })

  it("rejects unsupported template kinds and path-like plugin identities", () => {
    const input = { kind: "command" as const, id: "example", name: "示例", instruction: "处理输入" }
    expect(() => createAuthoringTemplate({ ...input, id: "../../outside" })).toThrow(
      "AUTHORING_TEMPLATE_INPUT"
    )
    expect(() => createAuthoringTemplate({ ...input, instruction: " " })).toThrow(
      "AUTHORING_TEMPLATE_INPUT"
    )
    expect(() => createAuthoringTemplate({ ...input, kind: "unknown" as "command" })).toThrow(
      "AUTHORING_TEMPLATE_INPUT"
    )
  })
})
