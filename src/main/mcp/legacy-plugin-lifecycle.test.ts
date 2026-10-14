import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

// Isolate application persistence and manager startup only. Transport, SDK server,
// configuration conversion, capability discovery, invocation and close are real.
const fixture = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{ id: string; path: string; enabled: boolean; mcpServerCount: number }>
}))
vi.mock("../storage", () => ({
  getEnabledMcpConnectors: () => [],
  getPlugins: () => fixture.plugins,
  getUserInfo: () => ({}),
  getOpenworkDir: () => fixture.root,
  parseMcpJsonFile: (path: string) => JSON.parse(readFileSync(path, "utf8")).mcpServers
}))
vi.mock("../mods/manager", () => ({
  getModsManager: () => null,
  authorizeCurrentModInput: async () => {}
}))

import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService
} from "./capability-service"

afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  fixture.plugins = []
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  fixture.root = ""
})

it("executes a real legacy Plugin MCP tool and retires processes on disable, reload and removal", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "legacy-mcp-lifecycle-"))
  const journal = join(fixture.root, "journal.jsonl")
  const configPath = join(fixture.root, ".mcp.json")
  const plugin = { id: "legacy", path: fixture.root, enabled: true, mcpServerCount: 1 }
  fixture.plugins = [plugin]
  const configure = (revision: string) =>
    writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [resolve("tests/support/legacy-plugin-mcp-server.mjs"), journal, revision]
          }
        }
      })
    )
  const records = () =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { pid: number; event: string; revision: string; text?: string }
      )
  const dead = async (pid: number) => {
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow()
      },
      { timeout: 5_000, interval: 25 }
    )
  }
  await configure("one")
  const service = getGlobalMcpCapabilityService()
  const [tool] = await service.listTools()
  expect(tool).toMatchObject({
    capabilityId: "plugin:legacy/fixture:echo",
    sourceKind: "plugin",
    pluginId: "legacy"
  })
  const first = await service.invoke(tool.capabilityId, { text: "first" })
  expect(first.isError).toBe(false)
  expect(first.text).toContain("one:first")
  const firstPid = records().find((row) => row.event === "call")!.pid

  plugin.enabled = false
  expect(await service.listTools()).toEqual([])
  await expect(service.invoke(tool.capabilityId, { text: "disabled" })).rejects.toThrow(
    "MCP tool not found"
  )
  await dead(firstPid)
  expect(records().filter((row) => row.event === "call")).toHaveLength(1)

  plugin.enabled = true
  const [reenabled] = await service.listTools()
  expect(reenabled.connectionGeneration).not.toBe(tool.connectionGeneration)
  expect((await service.invoke(tool.capabilityId, { text: "reenabled" })).text).toContain(
    "one:reenabled"
  )
  const secondPid = records()
    .filter((row) => row.event === "call")
    .at(-1)!.pid
  expect(secondPid).not.toBe(firstPid)

  await configure("two")
  const [reloaded] = await service.listTools()
  expect(reloaded.connectionGeneration).not.toBe(reenabled.connectionGeneration)
  await dead(secondPid)
  expect((await service.invoke(tool.capabilityId, { text: "reloaded" })).text).toContain(
    "two:reloaded"
  )
  const thirdPid = records()
    .filter((row) => row.event === "call")
    .at(-1)!.pid

  fixture.plugins = []
  expect(await service.listTools()).toEqual([])
  await dead(thirdPid)
  await expect(service.invoke(tool.capabilityId, { text: "deleted" })).rejects.toThrow(
    "MCP tool not found"
  )
  expect(
    records()
      .filter((row) => row.event === "call")
      .map((row) => row.text)
  ).toEqual(["first", "reenabled", "reloaded"])
}, 30_000)
