import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { compileNativeComposition, nativeCompositionSchema, readNativeCompositionFiles } from "./native-composition"

const root = resolve("tests/fixtures/native-compositions/vendor")
const source = () => nativeCompositionSchema.parse(
  JSON.parse(readFileSync(resolve(root, "composition/source.json"), "utf8")))
const directory = { type: "directory", title: "知识目录", description: "安装后绑定", required: true }
const context = {
  sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
  knowledge: { required: true, binding: "knowledge" }
}
function compile(value: unknown) {
  return compileNativeComposition(value, { files: readNativeCompositionFiles(root, source()), actionCatalog: [] })
}

describe("native composition configuration and knowledge contracts", () => {
  it("retains portable configuration and context through the existing Host extension contract", () => {
    const result = compile({ ...source(), context,
      configuration: { userConfig: { knowledge: directory }, userConfigSchema: { version: 1, migrations: [] } } })
    const plugin = JSON.parse(result.files.find(file => file.path === "plugin.json")!.bytes.toString())
    expect(plugin.userConfig.knowledge).toEqual(directory)
    expect(plugin.userConfigSchema).toEqual({ version: 1, migrations: [] })
    expect(plugin.cmbCompatibility).toEqual({ userConfigMigrations: "v1" })
    expect(result.runtime.extensionContract.context).toEqual(context)
    expect(result.runtime.extensionContract.requires).toContain("devclaw.context-handoff/v1")
  })

  it("requires a real directory declaration and rejects bundled local paths or secrets", () => {
    expect(() => compile({ ...source(), context })).toThrow("KNOWLEDGE_BINDING_INVALID")
    expect(() => compile({ ...source(), context, configuration: {
      userConfig: { knowledge: { ...directory, type: "string" } }
    } })).toThrow("KNOWLEDGE_BINDING_INVALID")
    expect(() => compile({ ...source(), configuration: {
      userConfig: { knowledge: { ...directory, default: "C:/private/knowledge" } }
    } })).toThrow("不能包含默认值")
    expect(() => compile({ ...source(), configuration: {
      userConfig: { token: { type: "string", title: "Token", description: "Token", sensitive: true, default: "private" } }
    } })).toThrow("不能包含默认值")
  })

  it("does not silently drop missing context providers or fabricate an installed action", () => {
    const base = { ...source(), configuration: { userConfig: { knowledge: directory } } }
    expect(() => compile({ ...base, context: { ...context,
      provider: { entry: "context/missing.py", operations: ["session-context"] }
    } })).toThrow("CONTEXT_RESOURCE_MISSING")
    const withAction = { ...base, context: { ...context,
      provider: { actionId: "knowledge-context", operations: ["session-context"] }
    } }
    expect(() => compile(withAction)).toThrow("CONTEXT_ACTION_MISMATCH")
    expect(() => compile({ ...withAction, contextAction: { id: "knowledge-context",
      provider: { plugin: "knowledge-provider", actionId: "load" }, input: {} }
    })).toThrow("PROVIDER_UNRESOLVED")
  })
})
