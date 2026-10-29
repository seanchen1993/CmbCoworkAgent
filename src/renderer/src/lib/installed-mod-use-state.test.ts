import { expect, it } from "vitest"
import type { ClawView } from "../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { installedModNextAction, installedModUseState } from "./installed-mod-use-state"

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
  ).toBe("首次使用需确认权限")
  expect(installedModUseState(plugin, "workspace", false, view)).toBe("灵件开关已关闭")
  expect(
    installedModUseState(plugin, "workspace", true, {
      ...view,
      active: { id: "empty", name: "Empty", capabilities: [] }
    })
  ).toBe("未用于此聊天")
})
it("shows default usage without requiring an extra saved composition", () => {
  expect(installedModUseState(plugin, "workspace", true, view)).toBe("按默认设置使用")
  expect(installedModUseState(plugin, "workspace", true, { ...view, applicable: false })).toBe(
    "当前场景未使用"
  )
})
it("does not publish foreign, unread or stale-version usage as active", () => {
  expect(installedModUseState(plugin, "other", true, view)).toBe("使用状态待核对")
  expect(installedModUseState(plugin, "workspace", true, view, true)).toBe("使用状态待核对")
  const active = {
    id: "used",
    name: "My settings",
    capabilities: [{ pluginId: "installed", name: "Feature", digest: "old" }]
  }
  expect(installedModUseState(plugin, "workspace", true, { ...view, active })).toBe(
    "使用配置需核对"
  )
  active.capabilities[0].digest = "a"
  expect(installedModUseState(plugin, "workspace", true, { ...view, active })).toBe(
    "已用于此聊天 · My settings"
  )
})

it("gives each card one next action without claiming installation is approval", () => {
  expect(installedModNextAction(true, { ...plugin, state: "invalid" })).toBe("修复")
  expect(installedModNextAction(false, { ...plugin, state: "invalid" })).toBe("修复")
  expect(installedModNextAction(false, plugin)).toBe("启用")
  expect(installedModNextAction(true, { ...plugin, state: "disabled" })).toBe("启用")
  expect(installedModNextAction(true, { ...plugin, state: "needs-approval" })).toBe("启用")
  expect(installedModNextAction(true, plugin, false)).toBe("启用")
  expect(installedModNextAction(true, plugin)).toBe("去使用")
  expect(installedModNextAction(true, undefined, false)).toBe("去使用")
})
