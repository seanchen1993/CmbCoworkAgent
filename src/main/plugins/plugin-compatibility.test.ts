import { afterEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { readPluginCompatibility } from "./plugin-compatibility"
import { pluginCompatibilityReason } from "../../shared/plugin-compatibility"
import { withPinnedAutobiz } from "../mods/v2/autobiz-source"
import { snapshotDerivationSource } from "./derivation-source"
import { prepareFlowCompositionFiles } from "./derivation-flow-composition"
import type { PluginMetadata } from "../types"
vi.mock("../storage", () => ({ parsePluginHooks: () => [], parseMcpJsonFile: () => null }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^plugin-compatibility-/)
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plugin-compatibility-"))
  roots.push(root)
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
  }
  const runtime = hostProjectFixture(root).manifest
  put("plugin.json", { name: "docs", version: "1.0.0" })
  put("devclaw.project-runtime.json", runtime)
  for (const stage of runtime.stages) put(stage.skill!, "Original stage instructions")
  put("skills/notes/SKILL.md", "Standalone project notes")
  put("devclaw.capabilities.json", {
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [
      {
        id: "notes",
        title: "项目笔记",
        kind: "skill",
        usage: "project",
        entry: "skills/notes/SKILL.md"
      },
      {
        id: "draft",
        title: "原流程阶段",
        kind: "skill",
        usage: "project",
        entry: runtime.stages[0].skill
      },
      {
        id: "delivery",
        title: "文档完整流程",
        kind: "flow",
        usage: "project",
        entry: "devclaw.project-runtime.json"
      }
    ]
  })
  const plugin: PluginMetadata = {
    id: "installed",
    name: "docs",
    version: "1.0.0",
    path: root,
    enabled: true,
    description: "",
    author: "",
    skillCount: 3,
    mcpServerCount: 0,
    createdAt: "fixture",
    updatedAt: "fixture"
  }
  return { root, plugin, runtime, put }
}

it("uses the real host validators while keeping chat and execution permission unconfirmed", async () => {
  const f = fixture()
  const files = readdirSync(f.root, { recursive: true }).sort()
  const result = await readPluginCompatibility(f.plugin)
  expect(result).toMatchObject({
    status: "declared",
    authorization: "not-evaluated",
    chat: "check-in-chat"
  })
  expect(result.entries.find((entry) => entry.id === "notes")?.available).toBe(true)
  expect(result.entries.find((entry) => entry.id === "delivery")).toMatchObject({
    available: true,
    runtimeMode: "host"
  })
  expect(result.entries.find((entry) => entry.id === "draft")).toMatchObject({ available: false })
  expect(result.entries.find((entry) => entry.id === "draft")?.reasons.join()).toContain("阶段")
  expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(files)
  expect(
    (await readPluginCompatibility({ ...f.plugin, enabled: false })).entries.every(
      (entry) => !entry.available
    )
  ).toBe(true)
})

it.each(["mods", "mcp"])(
  "reports malformed %s Host extensions without granting a flow",
  async (kind) => {
    const f = fixture()
    f.put(kind === "mods" ? "mods/manifest.json" : ".mcp.json", {})
    const result = await readPluginCompatibility(f.plugin)
    const flow = result.entries.find((entry) => entry.kind === "flow")!
    expect(flow.available).toBe(false)
    expect(flow.reasons.join()).toContain(
      kind === "mods" ? "PROJECT_MODS_PROTOCOL_UNSUPPORTED" : "PROJECT_MCP_CONFIG_INVALID"
    )
    expect(flow.reasons.map(pluginCompatibilityReason).join()).toContain(
      kind === "mods" ? "灵件模块" : "外部工具连接"
    )
    expect(result.authorization).toBe("not-evaluated")
  }
)

it("inspects a complete mixed host package without loading its Mod or starting MCP", async () => {
  const f = fixture()
  f.put("mods/manifest.json", { apiVersion: "cmb.mods/v2", id: "docs-native", entry: "main.ts" })
  f.put("mods/main.ts", 'export function register(){throw Error("MUST_NOT_EXECUTE")}')
  f.put(".mcp.json", { mcpServers: { local: { command: "node", args: ["mods/server.mjs"] } } })
  f.put("mods/server.mjs", 'throw Error("MUST_NOT_START")')
  const files = readdirSync(f.root, { recursive: true }).sort()
  const result = await readPluginCompatibility(f.plugin)
  expect(result.entries.find((entry) => entry.kind === "flow")).toMatchObject({ available: true })
  expect(result.authorization).toBe("not-evaluated")
  expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(files)
})

it("keeps unknown Legacy versions and undeclared packages on their original entry", async () => {
  const f = fixture()
  f.put("devclaw.project-runtime.json", { ...f.runtime, mode: "legacy", stateOwner: "plugin" })
  const result = await readPluginCompatibility(f.plugin)
  expect(result.entries.find((entry) => entry.kind === "flow")).toMatchObject({
    available: false,
    runtimeMode: "legacy"
  })
  rmSync(join(f.root, "devclaw.capabilities.json"))
  expect(await readPluginCompatibility(f.plugin)).toMatchObject({
    status: "undeclared",
    entries: [],
    chat: "check-in-chat"
  })
})

it("reports only the reviewed Legacy protocol and platform as eligible for project preview", async () => {
  await withPinnedAutobiz(undefined, async (path) => {
    const source = await snapshotDerivationSource(path)
    const metadata = JSON.parse(
      source.files.find((file) => file.path === source.manifests[0])!.bytes.toString("utf8")
    )
    for (const file of prepareFlowCompositionFiles(source).files)
      writeFileSync(join(path, file.path), file.after, { flag: "wx" })
    const plugin = {
      id: "reviewed",
      name: metadata.name,
      version: metadata.version,
      path,
      enabled: true
    } as PluginMetadata
    const report = await readPluginCompatibility(plugin)
    expect(report.entries[0]).toMatchObject({
      runtimeMode: "legacy",
      available: process.platform === "win32"
    })
    expect(report.authorization).toBe("not-evaluated")
    writeFileSync(join(path, "hooks/state_checkpoint.py"), "changed")
    expect((await readPluginCompatibility(plugin)).entries[0]?.available).toBe(false)
  })
}, 60000)
