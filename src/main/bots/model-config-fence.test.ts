import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  botModelSnapshotGeneration,
  completeBotModelSnapshotGeneration,
  invalidateBotModelSnapshot
} from "./model-config-fence"
import { readBotModelSnapshot, writeBotModelSnapshot } from "./model-config"
import { botConfigurationUnavailableReason } from "./model-config-fence"
import { BotStore } from "./store"
import { BotHost } from "./host"
import * as stableFiles from "../services/stable-file-handle"

const fixtures = vi.hoisted(() => ({ syncDirectory: vi.fn() }))
vi.mock("./backup-io", () => ({ syncDirectory: fixtures.syncDirectory }))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
beforeEach(() => fixtures.syncDirectory.mockReset())

it("flushes the renamed model snapshot directory before publication resolves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-config-durable-"))
  roots.push(directory)
  const path = join(directory, "models.private")
  fixtures.syncDirectory.mockImplementation(async (candidate: string) => {
    expect(candidate).toBe(directory)
    expect(existsSync(path)).toBe(true)
  })

  await writeBotModelSnapshot(path, { version: 1, defaultRef: "fixture", models: [] })

  expect(fixtures.syncDirectory).toHaveBeenCalledExactlyOnceWith(directory)
})

it("reopens a model snapshot once after a transient stable-read observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-config-reopen-"))
  roots.push(directory)
  const path = join(directory, "models.private")
  await writeBotModelSnapshot(path, { version: 1, defaultRef: "fixture", models: [] })
  const stableRead = stableFiles.readStableFileHandleBounded
  const read = vi
    .spyOn(stableFiles, "readStableFileHandleBounded")
    .mockImplementationOnce(async () => {
      throw new stableFiles.StableBoundedReadError("changed", 0)
    })
    .mockImplementation(stableRead)

  await expect(readBotModelSnapshot(path)).resolves.toMatchObject({ defaultRef: "fixture" })
  expect(read).toHaveBeenCalledTimes(2)
})

it("keeps a model snapshot closed after its one stable-read retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-config-retry-bound-"))
  roots.push(directory)
  const path = join(directory, "models.private")
  await writeBotModelSnapshot(path, { version: 1, defaultRef: "fixture", models: [] })
  const read = vi.spyOn(stableFiles, "readStableFileHandleBounded").mockImplementation(async () => {
    throw new stableFiles.StableBoundedReadError("changed", 0)
  })

  await expect(readBotModelSnapshot(path)).rejects.toMatchObject({ failure: "changed" })
  expect(read).toHaveBeenCalledTimes(2)
})

it("fences old credentials until the exact settings generation is published", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-config-fence-"))
  roots.push(directory)
  const path = join(directory, "models.private")
  invalidateBotModelSnapshot(path)
  expect(existsSync(`${path}.pending`)).toBe(false)
  await writeBotModelSnapshot(path, { version: 1, defaultRef: "old", models: [] })
  invalidateBotModelSnapshot(path)
  const first = botModelSnapshotGeneration(path)
  expect(first).not.toBeNull()
  expect(await readFile(`${path}.pending`, "utf8")).toMatch(/^[\w-]+$/)
  await expect(readBotModelSnapshot(path)).rejects.toThrow("暂停使用旧配置")
  invalidateBotModelSnapshot(path)
  const second = botModelSnapshotGeneration(path)
  expect(second).not.toBe(first)
  await writeBotModelSnapshot(path, { version: 1, defaultRef: "new", models: [] })
  completeBotModelSnapshotGeneration(path, first)
  await expect(readBotModelSnapshot(path)).rejects.toThrow("暂停使用旧配置")
  completeBotModelSnapshotGeneration(path, second)
  expect((await readBotModelSnapshot(path)).defaultRef).toBe("new")
  expect(existsSync(`${path}.pending`)).toBe(false)
})

it("keeps accepted work queued during configuration publication and executes it once after recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-config-queue-"))
  roots.push(directory)
  const path = join(directory, "models.private")
  await writeBotModelSnapshot(path, { version: 1, defaultRef: null, models: [] })
  invalidateBotModelSnapshot(path)
  const store = new BotStore(":memory:")
  const execute = vi.fn(async () => "completed")
  const host = new BotHost(store, {
    execute,
    dispatchBlockedReason: () => botConfigurationUnavailableReason(path)
  })
  try {
    const { conversationId } = store.createBot({ nonce: "bot", name: "bot" })
    const sent = store.send({ nonce: "task", conversationId, text: "work" })
    host.tick()
    expect(host.ready).toBe(false)
    expect(store.getRun(sent.runIds[0]).status).toBe("queued")
    expect(execute).not.toHaveBeenCalled()
    completeBotModelSnapshotGeneration(path, botModelSnapshotGeneration(path))
    host.tick()
    await vi.waitFor(() => expect(store.getRun(sent.runIds[0]).status).toBe("succeeded"))
    expect(host.ready).toBe(true)
    host.tick()
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await host.stop()
    store.close()
  }
})
