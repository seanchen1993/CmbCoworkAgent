import { expect, it } from "vitest"
import type { ClawView } from "../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { installedModUseState } from "./installed-mod-use-state"

const plugin: FunctionPluginStatus = {
  pluginId: "installed",
  name: "Feature",
  digest: "a",
  state: "ready",
  capabilities: []
}
const view: ClawView = {
  workspace: "workspace",
  revision: 1,
  bindingRevision: 1,
  enabled: true,
  applicable: true,
  capabilities: [plugin],
  profiles: [],
  active: null,
  issues: []
}
it("never equates an installed package or a grant with an applied target", () => {
  expect(
    installedModUseState({ ...plugin, state: "needs-approval" }, "workspace", true, view)
  ).toBe("已添加，待确认权限")
  expect(installedModUseState(plugin, "workspace", false, view)).toBe("已授权，当前未启用")
  expect(
    installedModUseState(plugin, "workspace", true, {
      ...view,
      active: { id: "empty", name: "Empty", capabilities: [] }
    })
  ).toBe("已授权，未用于此聊天")
})
it("shows default usage without requiring an extra saved composition", () => {
  expect(installedModUseState(plugin, "workspace", true, view)).toBe("按默认设置使用")
  expect(installedModUseState(plugin, "workspace", true, { ...view, applicable: false })).toBe(
    "已授权，当前场景未使用"
  )
})
it("does not publish foreign, unread or stale-version usage as active", () => {
  expect(installedModUseState(plugin, "other", true, view)).toBe("已授权，使用状态待核对")
  expect(installedModUseState(plugin, "workspace", true, view, true)).toBe("已授权，使用状态待核对")
  const active = {
    id: "used",
    name: "My settings",
    capabilities: [{ pluginId: "installed", name: "Feature", digest: "old" }]
  }
  expect(installedModUseState(plugin, "workspace", true, { ...view, active })).toBe(
    "已选入常用搭配，配置需核对"
  )
  active.capabilities[0].digest = "a"
  expect(installedModUseState(plugin, "workspace", true, { ...view, active })).toBe(
    "已用于此聊天 · My settings"
  )
})
