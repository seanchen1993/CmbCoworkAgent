import { describe, expect, it } from "vitest"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"
import { pluginStartUseConfigurationIssues } from "./plugin-start-use-diagnostics"

const view = (fields: FunctionUserConfigView["fields"]): FunctionUserConfigView => ({
  pluginId: "plugin", plugin: "sample", digest: "a".repeat(64), workspace: "workspace",
  savedRevision: 1, state: "inactive", fields
})
const field = (extra: Partial<FunctionUserConfigView["fields"][number]>) => ({
  key: "value", label: "PRIVATE_LABEL", description: "PRIVATE_DESCRIPTION", type: "string" as const,
  supported: true, required: true, ...extra
})

describe("start-use missing configuration facts", () => {
  it("does not mistake false or zero for missing and does not require live approval", () => {
    expect(pluginStartUseConfigurationIssues(view([
      field({ type: "boolean", value: false }), field({ type: "number", value: 0 }),
      field({ sensitive: true, secretState: "saved" })
    ]))).toEqual([])
  })
  it("reports required directory and secret absence without projecting sensitive content", () => {
    const issues = pluginStartUseConfigurationIssues(view([
      field({ type: "directory" }), field({ sensitive: true, secretState: "unavailable" }),
      field({ value: "PRIVATE_SECRET", required: false })
    ]))
    expect(issues.map(issue => issue.code)).toEqual(["knowledge", "configuration"])
    expect(JSON.stringify(issues)).not.toMatch(/PRIVATE_|value/)
  })
  it("treats empty required multi-select as missing but accepts optional fields", () => {
    expect(pluginStartUseConfigurationIssues(view([
      field({ multiple: true, value: [] }), field({ required: false })
    ]))).toHaveLength(1)
    expect(pluginStartUseConfigurationIssues(view([field({ required: false })]))).toEqual([])
  })
  it("keeps a native runtime failure separate from successful installation", () => {
    expect(pluginStartUseConfigurationIssues({ ...view([]), state: "failed" }))
      .toEqual([expect.objectContaining({ code: "runtime", resolution: "chat-settings" })])
  })
})
