import { beforeEach, expect, it, vi } from "vitest"
import { resolve } from "node:path"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerCommunityExampleHandlers } from "./mods-community-examples"
import { createCommunityExamplesBridge } from "../../preload/community-examples"

vi.mock("../storage", () => ({ getPlugins: () => [] }))

const install = vi.hoisted(() => vi.fn())
vi.mock("./plugins", () => ({ installBundledCommunityPlugin: install }))
type Handler = (event: unknown, input?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
const event = { sender: { mainFrame: {} } }
let allowed = true
beforeEach(() => {
  handlers.clear()
  install.mockReset()
  allowed = true
  registerCommunityExampleHandlers(
    { handle: (name: string, fn: Handler) => handlers.set(name, fn) } as never,
    resolve("resources/mods/community-originals"),
    () => {
      if (!allowed) throw Error("DENIED")
    }
  )
})

it("lists offline Chinese cards without project scope or installation effects", async () => {
  const value = (await handlers.get("mods:community-examples:list")!(event)) as {
    examples: unknown[]
  }
  expect(value.examples).toHaveLength(8)
  expect(value.examples).toContainEqual(
    expect.objectContaining({
      id: "token-weather",
      title: "用量天气",
      conflictNote: expect.any(String),
      usage: expect.any(String)
    })
  )
  expect(value.examples[0]).toMatchObject({
    id: "task-workbench-provider",
    pluginName: "task-workbench-provider",
    origin: "devclaw",
    sourcePath: "examples/sparks-task-workbench/provider"
  })
  expect(install).not.toHaveBeenCalled()
})

it("rejects untrusted calls and extra renderer paths before invoking installation", async () => {
  allowed = false
  await expect(handlers.get("mods:community-examples:list")!(event)).rejects.toThrow("DENIED")
  await expect(
    handlers.get("mods:community-examples:install")!(event, { exampleId: "token-weather" })
  ).rejects.toThrow("DENIED")
  allowed = true
  await expect(
    handlers.get("mods:community-examples:install")!(event, {
      exampleId: "token-weather",
      path: "elsewhere"
    })
  ).rejects.toThrow("MODS_COMMUNITY_EXAMPLE_INVALID")
  expect(install).not.toHaveBeenCalled()
})

it("passes only the fixed verified resource directory and rechecks sender lifetime", async () => {
  install.mockImplementation(async (directory, name, verify, current) => {
    expect(name).toBe("token-weather")
    expect(directory).toBe(resolve("resources/mods/community-originals/token-weather"))
    await verify(directory)
    event.sender.mainFrame = {}
    current()
  })
  await expect(
    handlers.get("mods:community-examples:install")!(event, { exampleId: "token-weather" })
  ).rejects.toThrow("MODS_IPC_SENDER")
})

it("preload forwards only the small explicit list/install contract", async () => {
  const invoke = vi.fn(async () => ({}))
  const bridge = createCommunityExamplesBridge(invoke)
  await bridge.list()
  await bridge.install({ exampleId: "blast-radius" })
  expect(invoke.mock.calls).toEqual([
    ["mods:community-examples:list", undefined],
    ["mods:community-examples:install", { exampleId: "blast-radius" }]
  ])
})

it("installs a local example from the fixed bundled directory with the same verification guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-example-ipc-"))
  const root = join(directory, "community-originals")
  const provider = join(directory, "platform-examples/task-workbench-provider")
  try {
    await mkdir(root)
    await cp(resolve("examples/sparks-task-workbench/provider"), provider, { recursive: true })
    registerCommunityExampleHandlers(
      { handle: (name: string, fn: Handler) => handlers.set(name, fn) } as never,
      root,
      () => {
        if (!allowed) throw Error("DENIED")
      }
    )
    install.mockImplementation(async (source, name, verify, current) => {
      expect(source).toBe(provider)
      expect(name).toBe("task-workbench-provider")
      await verify(source)
      current()
      return {
        pluginId: "provider",
        pluginName: name,
        alreadyInstalled: false,
        requiresApproval: true
      }
    })
    await expect(
      handlers.get("mods:community-examples:install")!(event, {
        exampleId: "task-workbench-provider"
      })
    ).resolves.toEqual({
      pluginId: "provider",
      pluginName: "task-workbench-provider",
      alreadyInstalled: false,
      requiresApproval: true
    })
    expect(install).toHaveBeenCalledOnce()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
