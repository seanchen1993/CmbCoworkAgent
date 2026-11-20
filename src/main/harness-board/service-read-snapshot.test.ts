import { describe, expect, it, vi } from "vitest"
import {
  createHarnessPluginReadSnapshot,
  findHarnessPluginInReadSnapshot
} from "./service-read-snapshot"

interface TestPlugin {
  id: string
  name: string
  path: string
  board: boolean
}

describe("harness service read snapshot", () => {
  it("reads each plugin config once regardless of project count", () => {
    const plugins: TestPlugin[] = Array.from({ length: 12 }, (_, index) => ({
      id: `adapter-${index}`,
      name: `Adapter ${index}`,
      path: `/plugin-${index}`,
      board: true
    }))
    const readBoardConfig = vi.fn((plugin: TestPlugin) => ({ apiVersion: 1, id: plugin.id }))
    const snapshot = createHarnessPluginReadSnapshot({
      plugins,
      getPath: (plugin) => plugin.path,
      getAdapterId: (plugin) => plugin.id,
      getName: (plugin) => plugin.name,
      hasBoardConfig: (plugin) => plugin.board,
      readBoardConfig
    })

    for (let index = 0; index < 10_000; index += 1) {
      const adapterIndex = index % plugins.length
      expect(
        findHarnessPluginInReadSnapshot(snapshot, { id: `adapter-${adapterIndex}` })?.id
      ).toBe(`adapter-${adapterIndex}`)
    }

    expect(readBoardConfig).toHaveBeenCalledTimes(plugins.length)
  })

  it("captures an invalid config once and keeps later lookups in memory", () => {
    const plugin: TestPlugin = {
      id: "broken",
      name: "Broken",
      path: "/broken",
      board: true
    }
    const readBoardConfig = vi.fn(() => {
      throw new Error("invalid json")
    })
    const snapshot = createHarnessPluginReadSnapshot({
      plugins: [plugin],
      getPath: (item) => item.path,
      getAdapterId: (item) => item.id,
      getName: (item) => item.name,
      hasBoardConfig: (item) => item.board,
      readBoardConfig
    })

    expect(snapshot.configByPath.get(plugin.path)?.error?.message).toBe("invalid json")
    expect(findHarnessPluginInReadSnapshot(snapshot, { name: plugin.name })).toBe(plugin)
    expect(findHarnessPluginInReadSnapshot(snapshot, { id: plugin.id })).toBe(plugin)
    expect(readBoardConfig).toHaveBeenCalledTimes(1)
  })
})
