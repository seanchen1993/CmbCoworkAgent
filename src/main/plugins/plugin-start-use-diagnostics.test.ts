import { describe, expect, it, vi } from "vitest"
import type { FunctionUserConfigView } from "../../shared/mods/v2/user-config-view"
import {
  pluginStartUseConfigurationIssues,
  pluginStartUseDependencyIssues,
  pluginStartUseDestinationConfigurationIssues
} from "./plugin-start-use-diagnostics"

const view = (fields: FunctionUserConfigView["fields"]): FunctionUserConfigView => ({
  pluginId: "plugin",
  plugin: "sample",
  digest: "a".repeat(64),
  workspace: "workspace",
  savedRevision: 1,
  state: "inactive",
  fields
})
const field = (extra: Partial<FunctionUserConfigView["fields"][number]>) => ({
  key: "value",
  label: "PRIVATE_LABEL",
  description: "PRIVATE_DESCRIPTION",
  type: "string" as const,
  supported: true,
  required: true,
  ...extra
})

describe("start-use missing configuration facts", () => {
  it.each(["host-project", "plugin-project"] as const)(
    "does not inspect the author's configuration for %s",
    async (destination) => {
      const read = vi.fn(async () => {
        throw Error("AUTHOR_CONFIGURATION_MUST_NOT_BE_READ")
      })
      expect(await pluginStartUseDestinationConfigurationIssues(destination, read)).toEqual([])
      expect(read).not.toHaveBeenCalled()
    }
  )
  it("retains missing configuration and native failure diagnostics when the destination is chat", async () => {
    const read = vi.fn(async () => ({
      ...view([field({ type: "directory" }), field({ sensitive: true })]),
      state: "failed" as const
    }))
    expect(
      (await pluginStartUseDestinationConfigurationIssues("chat", read)).map((issue) => issue.code)
    ).toEqual(["knowledge", "configuration", "runtime"])
    expect(read).toHaveBeenCalledOnce()
  })
  it("reports locked dependency readiness without claiming that opening the project authorizes execution", () => {
    const dependency = {
      pluginId: "id",
      name: "rules",
      digest: "a".repeat(64),
      actionIds: ["check"],
      capabilities: []
    }
    expect(
      pluginStartUseDependencyIssues([{ ...dependency, state: "ready", configurationReady: true }])
    ).toEqual([])
    for (const state of [
      "needs-approval",
      "missing",
      "disabled",
      "source-changed",
      "invalid"
    ] as const)
      expect(pluginStartUseDependencyIssues([{ ...dependency, state }])).toEqual([
        expect.objectContaining({
          code: "dependency",
          resolution: "project-form",
          message: expect.stringContaining("rules")
        })
      ])
    expect(
      pluginStartUseDependencyIssues([
        { ...dependency, state: "ready", configurationReady: false }
      ])[0].message
    ).toContain("配置")
    expect(
      pluginStartUseDependencyIssues([{ ...dependency, state: "ready" }], {
        enabled: false,
        globallyEnabled: true
      })[0].code
    ).toBe("permission")
    expect(pluginStartUseDependencyIssues([], { enabled: false, globallyEnabled: false })).toEqual(
      []
    )
    expect(
      pluginStartUseDependencyIssues(
        Array.from({ length: 100 }, () => ({ ...dependency, state: "missing" as const }))
      )
    ).toHaveLength(49)
  })
  it("does not mistake false or zero for missing and does not require live approval", () => {
    expect(
      pluginStartUseConfigurationIssues(
        view([
          field({ type: "boolean", value: false }),
          field({ type: "number", value: 0 }),
          field({ sensitive: true, secretState: "saved" })
        ])
      )
    ).toEqual([])
  })
  it("reports required directory and secret absence without projecting sensitive content", () => {
    const issues = pluginStartUseConfigurationIssues(
      view([
        field({ type: "directory" }),
        field({ sensitive: true, secretState: "unavailable" }),
        field({ value: "PRIVATE_SECRET", required: false })
      ])
    )
    expect(issues.map((issue) => issue.code)).toEqual(["knowledge", "configuration"])
    expect(JSON.stringify(issues)).not.toMatch(/PRIVATE_|value/)
  })
  it("treats empty required multi-select as missing but accepts optional fields", () => {
    expect(
      pluginStartUseConfigurationIssues(
        view([field({ multiple: true, value: [] }), field({ required: false })])
      )
    ).toHaveLength(1)
    expect(pluginStartUseConfigurationIssues(view([field({ required: false })]))).toEqual([])
  })
  it("keeps a native runtime failure separate from successful installation", () => {
    expect(pluginStartUseConfigurationIssues({ ...view([]), state: "failed" })).toEqual([
      expect.objectContaining({ code: "runtime", resolution: "chat-settings" })
    ])
  })
})
