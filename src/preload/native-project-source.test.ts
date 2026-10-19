import { expect, it, vi } from "vitest"
import { createNativeProjectSourceBridge } from "./native-project-source"
import type { FunctionUserConfigView } from "../shared/mods/v2/user-config-view"

it("routes the original native editor and consent without exposing generic configuration control", async () => {
  const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>(async () => undefined)
  const api = createNativeProjectSourceBridge(invoke, "project-composition-unit")
  const view = {
    pluginId: "native-installation",
    plugin: "compiled-name",
    digest: "a".repeat(64),
    workspace: "host-derived-unit",
    savedRevision: 3,
    state: "inactive",
    fields: []
  } satisfies FunctionUserConfigView
  await api.config.userConfig("host-routing-key", view.pluginId, view.workspace)
  expect(invoke).toHaveBeenLastCalledWith("project-composition-unit:user-config", {
    threadId: "host-routing-key",
    pluginId: view.pluginId,
    expectedWorkspace: view.workspace
  })
  await api.config.saveUserConfig("host-routing-key", view, "label", "chosen-value")
  expect(invoke).toHaveBeenLastCalledWith("project-composition-unit:user-config-save", {
    threadId: "host-routing-key",
    pluginId: view.pluginId,
    digest: view.digest,
    key: "label",
    value: "chosen-value",
    revision: 3,
    workspace: view.workspace
  })
  await api.read("host-routing-key")
  expect(invoke).toHaveBeenLastCalledWith("project-composition-unit:mods-read", "host-routing-key")
  const approval = {
    projectId: "host-routing-key",
    projectVersion: 1,
    packageDigest: "b".repeat(64),
    compiledDigest: view.digest
  }
  await api.approve(approval)
  expect(invoke).toHaveBeenLastCalledWith("project-composition-unit:mods-approve", approval)
  const count = invoke.mock.calls.length
  await expect(api.config.configList("host-routing-key")).rejects.toThrow("UNSUPPORTED")
  await expect(api.config.configSet("host-routing-key", "native.policy", false)).rejects.toThrow(
    "UNSUPPORTED"
  )
  expect(invoke).toHaveBeenCalledTimes(count)
})
