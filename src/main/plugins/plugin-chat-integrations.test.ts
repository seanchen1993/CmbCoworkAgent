import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"

vi.mock("electron", () => ({ app: {} }))
const priorHome = process.env.CMB_COWORK_AGENT_HOME
let root: string | undefined
afterEach(async () => {
  vi.resetModules()
  if (priorHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = priorHome
  if (root) {
    const actual = await realpath(root)
    if (
      dirname(actual) !== (await realpath(tmpdir())) ||
      !/^chat-integrations-[\w-]{6}$/.test(basename(actual))
    )
      throw Error("Unsafe fixture cleanup")
    await rm(actual, { recursive: true, force: true })
    root = undefined
  }
})

async function fixture(kind: "hook" | "mcp" | "mixed" | "empty") {
  root = await mkdtemp(join(tmpdir(), "chat-integrations-"))
  process.env.CMB_COWORK_AGENT_HOME = join(root, "home")
  const path = join(root, "plugin")
  await mkdir(path)
  await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "tools", version: "1.0.0" }))
  if (kind === "hook" || kind === "mixed") {
    await mkdir(join(path, "hooks"))
    await writeFile(
      join(path, "hooks/hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "never-run-private-command" }] }]
        }
      })
    )
  }
  if (kind === "mcp" || kind === "mixed")
    await writeFile(
      join(path, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          documents: {
            url: "https://private.invalid",
            headers: { Authorization: "private-secret" }
          },
          invalid: { description: "not a server" }
        }
      })
    )
  const plugin: PluginMetadata = {
    id: "installed",
    name: "tools",
    version: "1.0.0",
    path,
    enabled: true,
    description: "",
    author: "",
    createdAt: "one",
    updatedAt: "one",
    skillCount: 0,
    mcpServerCount: 99,
    hookCount: 99
  }
  const { readPluginChatIntegrations } = await import("./plugin-chat-integrations")
  const { pluginChatStartUseEntries } = await import("./plugin-chat-start-use")
  const { PluginStartUseService } = await import("./plugin-start-use")
  let changed: (() => void) | undefined
  const service = new PluginStartUseService({
    plugins: () => [plugin],
    enable: async (_id, guard) => {
      guard()
      plugin.enabled = true
    },
    chatEntries: async () => {
      const entries = pluginChatStartUseEntries(
        plugin.id,
        [],
        [],
        readPluginChatIntegrations(plugin)
      )
      changed?.()
      return entries
    }
  })
  const input = {
    threadId: "chat",
    expectedWorkspace: root,
    pluginId: plugin.id,
    expected: { name: plugin.name, version: plugin.version }
  }
  return {
    plugin,
    service,
    input,
    change: (fn: () => void) => {
      changed = fn
    }
  }
}

it.each(["hook", "mcp", "mixed", "empty"] as const)(
  "projects actual %s declarations, without treating cached counts as facts or exposing configuration",
  async (kind) => {
    const f = await fixture(kind)
    const report = await f.service.prepare(f.input, () => {})
    expect(report.chat?.integrations).toEqual(
      kind === "empty"
        ? undefined
        : {
            hookCount: kind === "hook" || kind === "mixed" ? 1 : 0,
            mcpServerNames: kind === "mcp" || kind === "mixed" ? ["documents"] : []
          }
    )
    expect(JSON.stringify(report)).not.toMatch(/private-secret|private.invalid|never-run/)
    expect(report.chat?.functionMod).toBeUndefined()
    expect(report.chat?.skills).toEqual([])
    f.plugin.enabled = false
    const disabled = await f.service.prepare(f.input, () => {})
    expect(disabled).toMatchObject({ canOpen: false, activationRequired: true })
    const enabled = await f.service.enable({ ...f.input, expected: report.identity }, () => {})
    expect(enabled.canOpen).toBe(true)
    expect(enabled.chat).toEqual(report.chat)
  }
)

it("rejects disablement and scope changes during integration discovery", async () => {
  const f = await fixture("mixed")
  f.change(() => {
    f.plugin.enabled = false
  })
  await expect(f.service.prepare(f.input, () => {})).rejects.toThrow("IDENTITY_CHANGED")
  f.plugin.enabled = true
  let current = true
  f.change(() => {
    current = false
  })
  await expect(
    f.service.prepare(f.input, () => {
      if (!current) throw Error("SCOPE_CHANGED")
    })
  ).rejects.toThrow("SCOPE_CHANGED")
})

it("rejects an old exact report after MCP configuration changes", async () => {
  const f = await fixture("mcp")
  const before = await f.service.prepare(f.input, () => {})
  await writeFile(
    join(f.plugin.path, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        replacement: { command: "never-run" }
      }
    })
  )
  await expect(
    f.service.prepare({ ...f.input, expected: before.identity }, () => {})
  ).rejects.toThrow("CONTENT_CHANGED")
})
