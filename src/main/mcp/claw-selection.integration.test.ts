import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  root: "",
  plugins: [] as Array<{
    id: string
    name: string
    path: string
    enabled: boolean
    mcpServerCount: number
  }>,
  authorize: async () => {}
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
  authorizeCurrentModInput: () => fixture.authorize()
}))
import {
  closeGlobalMcpCapabilityService,
  getGlobalMcpCapabilityService
} from "./capability-service"
import { readClawMcpSources, restrictClawMcpService } from "../mods/claw-mcp"

afterEach(async () => {
  await closeGlobalMcpCapabilityService()
  fixture.plugins = []
  fixture.authorize = async () => {}
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  fixture.root = ""
})

it("restricts real stdio calls by provider while catalog and empty selections never connect", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "claw-mcp-selection-"))
  const journal = join(fixture.root, "journal.jsonl")
  fixture.plugins = [
    { id: "fixture", name: "Readable plugin", path: fixture.root, enabled: true, mcpServerCount: 2 }
  ]
  const configPath = join(fixture.root, ".mcp.json")
  const config = (name: string) => ({
    command: process.execPath,
    args: [resolve("tests/support/legacy-plugin-mcp-server.mjs"), journal, name],
    env: { CLAW_FIXTURE_SECRET: "must-not-be-projected" }
  })
  await writeFile(configPath, JSON.stringify({ mcpServers: { a: config("a"), b: config("b") } }))
  const sources = readClawMcpSources()
  expect(sources.map((entry) => entry.id)).toEqual(["plugin:fixture/a", "plugin:fixture/b"])
  expect(sources.every((entry) => entry.owner === "Readable plugin")).toBe(true)
  expect(JSON.stringify(sources)).not.toContain("must-not-be-projected")
  expect(existsSync(journal)).toBe(false)
  const service = getGlobalMcpCapabilityService()
  const empty = restrictClawMcpService(service, { mode: "selected", items: [] })
  expect(await empty.listTools()).toEqual([])
  expect(await empty.getSnapshot?.()).toMatchObject({ tools: [] })
  await expect(empty.invoke("plugin:fixture/b:echo", {})).rejects.toThrow(
    "CLAW_MCP_TOOL_NOT_SELECTED"
  )
  expect(existsSync(journal)).toBe(false)
  const limited = restrictClawMcpService(service, { mode: "selected", items: [sources[0]] })
  const [a] = await limited.listTools()
  const b = (await service.listTools()).find((tool) => tool.providerKey === sources[1].id)!
  expect(a.providerKey).toBe(sources[0].id)
  expect((await limited.invoke(a.toolId, { text: "allowed" })).text).toContain("a:allowed")
  for (const id of [b.capabilityId, b.toolId, b.canonicalToolId!])
    await expect(limited.invoke(id, { text: "denied" })).rejects.toThrow(
      "CLAW_MCP_TOOL_NOT_SELECTED"
    )
  const records = () =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  expect(
    records()
      .filter((row) => row.event === "call")
      .map((row) => row.text)
  ).toEqual(["allowed"])
  // Global initialization can start B. This feature restricts calls, not connection creation.
  expect(
    records()
      .filter((row) => row.event === "ready")
      .map((row) => row.revision)
      .sort()
  ).toEqual(["a", "b"])
  fixture.authorize = async () => {
    fixture.plugins[0].enabled = false
  }
  await expect(limited.invoke(a.capabilityId, { text: "revoked-during-approval" })).rejects.toThrow(
    "CLAW_MCP_SOURCE_CHANGED"
  )
  expect(records().filter((row) => row.event === "call")).toHaveLength(1)
}, 30_000)
