import { expect, it, vi } from "vitest"
import { pickFunctionUserConfigPath } from "./user-config-path"
import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"

function fixture() {
  const view: FunctionUserConfigView = {
    workspace: "w",
    pluginId: "p",
    plugin: "sample",
    digest: "d",
    savedRevision: 1,
    state: "inactive",
    fields: [
      {
        key: "path",
        label: "File",
        description: "File",
        type: "file",
        supported: true,
        required: false
      }
    ]
  }
  const expected = { workspace: "w", pluginId: "p", digest: "d", revision: 1, key: "path" }
  const host = {
    read: vi.fn(async () => structuredClone(view)),
    assertLive: vi.fn(),
    choose: vi.fn(async () => "selected" as string | undefined),
    publish: vi.fn(async () => ({ value: "protected" }))
  }
  return { view, expected, host, pick: () => pickFunctionUserConfigPath(expected, host) }
}
it("uses the real field kind and returns only a protected draft without saving", async () => {
  const f = fixture()
  expect(await f.pick()).toBe("protected")
  expect(f.host.choose).toHaveBeenCalledWith("file")
  expect(f.host.publish).toHaveBeenCalledWith({ value: "selected" })
  expect(f.host.read).toHaveBeenCalledTimes(3)
})
it("native cancellation returns no value and publishes nothing", async () => {
  const f = fixture()
  f.host.choose.mockResolvedValue(undefined)
  expect(await f.pick()).toBeUndefined()
  expect(f.host.publish).not.toHaveBeenCalled()
})
it.each(["owner", "version", "code", "kind", "workspace", "supported"] as const)(
  "rejects a changed %s while selecting before any path publication",
  async (fact) => {
    const f = fixture()
    f.host.choose.mockImplementation(async () => {
      if (fact === "owner")
        f.host.assertLive.mockImplementation(() => {
          throw Error("owner lost")
        })
      if (fact === "version") f.view.savedRevision++
      if (fact === "code") f.view.digest = "new"
      if (fact === "kind") f.view.fields[0].type = "directory"
      if (fact === "workspace") f.view.workspace = "other"
      if (fact === "supported") f.view.fields[0].supported = false
      return "selected"
    })
    await expect(f.pick()).rejects.toThrow()
    expect(f.host.publish).not.toHaveBeenCalled()
  }
)
it("rechecks saved version after asynchronous path protection and rejects removed path", async () => {
  const f = fixture()
  f.host.publish.mockImplementation(async () => {
    f.view.savedRevision++
    return { value: "late" }
  })
  await expect(f.pick()).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  const denied = fixture()
  denied.host.publish.mockResolvedValue({ value: "" })
  await expect(denied.pick()).rejects.toThrow("MODS_CONFIG_PATH_RESULT")
})
it("a scalar/list field can never request the native chooser", async () => {
  const f = fixture()
  f.view.fields[0].type = "string"
  await expect(f.pick()).rejects.toThrow("MODS_CONFIG_PATH_FIELD")
  expect(f.host.choose).not.toHaveBeenCalled()
})
