import { describe, expect, it, vi } from "vitest"
import {
  classifyInstalledPluginProjectEntry,
  readInstalledPluginProjectEntry
} from "./installed-plugin-project-entry"

const plugin = {
  id: "installed",
  name: "Display name",
  version: "1.0.0",
  enabled: true,
  hasProjectMode: false,
  path: "C:/fixture/plugin",
  updatedAt: "one"
}
const template = {
  installedPluginId: "installed",
  name: "actual-host-package",
  version: "1.0.0",
  stages: ["draft"]
}
describe("installed plugin project routing", () => {
  it("uses the native Host template identity even when its name differs from display metadata", () => {
    expect(classifyInstalledPluginProjectEntry(plugin.id, [plugin], [template])).toEqual({
      kind: "host",
      pluginId: plugin.id,
      name: template.name,
      version: "1.0.0"
    })
  })
  it("preserves the legacy route only when no native Host template exists", () => {
    expect(
      classifyInstalledPluginProjectEntry(plugin.id, [{ ...plugin, hasProjectMode: true }], [])
    ).toMatchObject({ kind: "legacy", pluginId: plugin.id, name: plugin.name })
    expect(
      classifyInstalledPluginProjectEntry(
        plugin.id,
        [{ ...plugin, hasProjectMode: true }],
        [template]
      )
    ).toMatchObject({ kind: "host" })
  })
  it("does not give ordinary plugins, disabled installs or removed installs a legacy entrance", () => {
    expect(classifyInstalledPluginProjectEntry(plugin.id, [plugin], []).kind).toBe("unavailable")
    expect(
      classifyInstalledPluginProjectEntry(plugin.id, [{ ...plugin, enabled: false }], [template])
        .kind
    ).toBe("unavailable")
    expect(classifyInstalledPluginProjectEntry(plugin.id, [], [template]).kind).toBe("unavailable")
  })
  it("rejects unavailable, stale and ambiguous Host templates without a legacy fallback", () => {
    for (const templates of [
      [{ ...template, version: "2.0.0" }],
      [{ ...template, unavailableReason: "broken" }],
      [template, template]
    ])
      expect(
        classifyInstalledPluginProjectEntry(
          plugin.id,
          [{ ...plugin, hasProjectMode: true }],
          templates
        ).kind
      ).toBe("unavailable")
  })
  it("rechecks removal or disablement after template discovery", async () => {
    for (const latest of [[], [{ ...plugin, enabled: false }]]) {
      const plugins = vi.fn().mockResolvedValueOnce([plugin]).mockResolvedValueOnce(latest)
      expect(
        (
          await readInstalledPluginProjectEntry(
            plugin.id,
            { plugins, templates: async () => [template] },
            () => true
          )
        ).kind
      ).toBe("unavailable")
      expect(plugins).toHaveBeenCalledTimes(2)
    }
  })
  it("rejects a changed installation identity while awaiting templates", async () => {
    const plugins = vi
      .fn()
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, updatedAt: "two" }])
    await expect(
      readInstalledPluginProjectEntry(
        plugin.id,
        { plugins, templates: async () => [template] },
        () => true
      )
    ).rejects.toThrow("插件版本或状态已变化")
  })
  it("does not consume stale asynchronous results after its scope changes", async () => {
    let resolveTemplates!: (value: (typeof template)[]) => void
    let current = true
    const plugins = vi.fn(async () => [plugin])
    const pending = readInstalledPluginProjectEntry(
      plugin.id,
      {
        plugins,
        templates: () =>
          new Promise((resolve) => {
            resolveTemplates = resolve
          })
      },
      () => current
    )
    await Promise.resolve()
    current = false
    resolveTemplates([template])
    await expect(pending).rejects.toThrow("配置聊天或目录已变化")
    expect(plugins).toHaveBeenCalledTimes(1)
  })
  it("propagates query failures instead of guessing a project mode", async () => {
    await expect(
      readInstalledPluginProjectEntry(
        plugin.id,
        {
          plugins: async () => [plugin],
          templates: async () => {
            throw Error("query failed")
          }
        },
        () => true
      )
    ).rejects.toThrow("query failed")
  })
  it("rejects an installation changed since the visible card before reading its templates", async () => {
    for (const current of [
      { ...plugin, version: "2.0.0" },
      { ...plugin, enabled: false },
      { ...plugin, path: "C:/fixture/replacement" },
      { ...plugin, updatedAt: "two" }
    ]) {
      const templates = vi.fn(async () => [template])
      await expect(
        readInstalledPluginProjectEntry(
          plugin.id,
          {
            plugins: async () => [current],
            templates
          },
          () => true,
          plugin
        )
      ).rejects.toThrow("插件版本或状态已变化")
      expect(templates).not.toHaveBeenCalled()
    }
  })
})
