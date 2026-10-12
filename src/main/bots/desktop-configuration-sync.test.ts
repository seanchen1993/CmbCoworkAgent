import { mkdtemp, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { botTaskModelGuard } from "./runtime-model"
import { readBotModelSnapshot } from "./model-config"

const f = vi.hoisted(() => ({
  root: "",
  unavailable: false,
  model: {
    id: "primary",
    ref: "primary",
    name: "Fixture",
    model: "fixture",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1:1/v1"
  }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => f.root }))
vi.mock("../agent/agents-md", () => ({ getCmbCoworkAgentsHome: () => join(f.root, "agents") }))
vi.mock("../mcp/desktop-sources", () => ({ readDesktopMcpSources: () => [] }))
vi.mock("./desktop-mods-config", () => ({ desktopBotModsConfig: () => undefined }))
vi.mock("./desktop-execution-config", () => ({
  desktopBotExecutionConfig: () => ({
    windowsSandbox: "none",
    resourceDirectory: join(f.root, "resources")
  })
}))
vi.mock("./desktop-skills-config", () => ({
  desktopBotSkillSources: async () => {
    if (f.unavailable) throw new Error("Fixture catalog unavailable")
    return { pluginsStorePath: join(f.root, "plugins.json") }
  }
}))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => f.model,
  getModelConfigs: () => [f.model]
}))

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.resetModules()
})

async function fixture() {
  f.root = await mkdtemp(join(tmpdir(), "cmb-desktop-config-"))
  f.unavailable = false
  f.model = {
    id: "primary",
    ref: "primary",
    name: "Fixture",
    model: "fixture",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1:1/v1"
  }
  const root = f.root
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, "bot-host"),
    path = join(directory, "models.private")
  await (await import("./desktop-model-sync")).syncDesktopBotModels(directory)
  const original = await stat(path, { bigint: true })
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Persistent task" })
  store.send({ nonce: "task", conversationId, text: "Continue working" })
  const claim = store.claim("detached-host")!
  const guard = botTaskModelGuard(
    { ...claim, store, bot, signal: new AbortController().signal, messages: [] },
    path,
    null,
    f.model
  )
  await guard()
  // A desktop restart discards its caches; the detached Host and its binding live on.
  vi.resetModules()
  const lifecycle = await import("./desktop-configuration-sync")
  const publisher = await import("./desktop-model-sync")
  const events = await import("../runtime-configuration-events")
  cleanup.push(() => lifecycle.stopDesktopBotConfigurationSync())
  return { directory, path, original, guard, lifecycle, publisher, events }
}

it("keeps an active task bound across an unchanged desktop restart without rewriting credentials", async () => {
  const test = await fixture()
  test.lifecycle.startDesktopBotConfigurationSync()
  await expect(test.guard()).resolves.toBeUndefined()
  await test.publisher.syncDesktopBotModels(test.directory)
  await expect(test.guard()).resolves.toBeUndefined()
  const current = await stat(test.path, { bigint: true })
  expect(current.ino).toBe(test.original.ino)
  expect(current.mtimeNs).toBe(test.original.mtimeNs)
  expect(existsSync(test.path + ".pending")).toBe(false)
})

it("still revokes changed credentials immediately and refuses to rebind the active task", async () => {
  const test = await fixture()
  test.lifecycle.startDesktopBotConfigurationSync()
  await test.publisher.syncDesktopBotModels(test.directory)
  f.model = { ...f.model, apiKey: "rotated-test-only" }
  test.events.notifyRuntimeConfigurationChanged()
  expect(existsSync(test.path + ".pending")).toBe(true)
  await expect(test.guard()).rejects.toMatchObject({ code: "model_configuration_unavailable" })
  await test.publisher.syncDesktopBotModels(test.directory)
  expect((await readBotModelSnapshot(test.path)).models[0].apiKey).toBe("rotated-test-only")
  await expect(test.guard()).rejects.toMatchObject({ code: "model_configuration_changed" })
})

it("suspends the old configuration if startup cannot rebuild authoritative settings", async () => {
  const test = await fixture()
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  f.unavailable = true
  test.lifecycle.startDesktopBotConfigurationSync()
  await vi.waitFor(() => expect(warning).toHaveBeenCalled(), { timeout: 2000 })
  expect(existsSync(test.path + ".pending")).toBe(true)
  await expect(test.guard()).rejects.toMatchObject({ code: "model_configuration_unavailable" })
})

it("publishes settings changed while the desktop was absent without moving old tasks to the new provider", async () => {
  const test = await fixture()
  f.model = { ...f.model, apiKey: "changed-while-desktop-closed" }
  test.lifecycle.startDesktopBotConfigurationSync()
  await test.publisher.syncDesktopBotModels(test.directory)
  expect((await readBotModelSnapshot(test.path)).models[0].apiKey).toBe(f.model.apiKey)
  await expect(test.guard()).rejects.toMatchObject({ code: "model_configuration_changed" })
})
