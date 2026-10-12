import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { DesktopArtifactDownloadDependencies } from "./desktop-artifact-downloads"
import type { BotArtifactDownloadsAPI } from "../../shared/bot-artifact-downloads"

type BotArtifactDownloadStart = Parameters<BotArtifactDownloadsAPI["start"]>[0]

const f = vi.hoisted(() => ({
  root: "",
  save: vi.fn(),
  reveal: vi.fn(),
  available: vi.fn(),
  participant: undefined as { drain(): Promise<void>; end(): void } | undefined,
  instances: [] as {
    dependencies: DesktopArtifactDownloadDependencies
    close: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
  }[]
}))
vi.mock("electron", () => ({
  app: { getPath: () => join(f.root, "downloads") },
  dialog: { showSaveDialog: f.save },
  shell: { showItemInFolder: f.reveal }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => f.root }))
vi.mock("./desktop-client", () => ({
  getDesktopBotClient: vi.fn(),
  assertDesktopBotConnectionAvailable: f.available,
  registerDesktopBotMaintenanceParticipant: (value: typeof f.participant) => {
    f.participant = value
  }
}))
vi.mock("./desktop-artifact-downloads", () => ({
  DesktopArtifactDownloads: class {
    readonly controller = new AbortController()
    pending: Promise<unknown> | undefined
    close = vi.fn(async () => {
      this.controller.abort()
      await this.pending
    })
    start = vi.fn((input: BotArtifactDownloadStart) => {
      this.pending = this.dependencies
        .choose("结果.txt", this.controller.signal)
        .then((path) => ({ id: input.nonce, pathChosen: Boolean(path) }))
        .catch(() => ({ id: input.nonce, cancelled: true }))
      return this.pending
    })
    constructor(
      _path: string,
      readonly dependencies: DesktopArtifactDownloadDependencies
    ) {
      f.instances.push(this)
    }
    page() {
      return Promise.resolve({ items: [], nextCursor: null, total: 0 })
    }
    drainForMaintenance() {
      return this.close()
    }
    endMaintenance = vi.fn()
  }
}))
const request = {
  nonce: "a1df2f76-4152-46f6-99be-b8209a65108c",
  source: {
    artifactId: "artifact",
    conversationId: "conversation",
    sha256: "a".repeat(64),
    size: 3,
    dataEpoch: "epoch"
  }
}
const window = { isDestroyed: () => false } as BrowserWindow
beforeEach(async () => {
  vi.resetModules()
  f.root = await mkdtemp(join(tmpdir(), "cmb-download-main-"))
  f.instances.length = 0
  f.save.mockReset().mockResolvedValue({ canceled: true })
  f.reveal.mockReset()
  f.available.mockReset()
})
afterEach(async () => {
  const api = await import("./desktop-artifact-download-service")
  await api.closeDesktopBotArtifactDownloads()
  await rm(f.root, { recursive: true, force: true })
})
it("rejects untrusted start and control data before constructing the native service", async () => {
  const api = await import("./desktop-artifact-download-service")
  await expect(
    api.startDesktopBotArtifactDownload({ ...request, path: "/arbitrary" }, window)
  ).rejects.toThrow()
  await expect(
    api.pauseDesktopBotArtifactDownload({ id: request.nonce, revision: 1, path: "/arbitrary" })
  ).rejects.toThrow()
  expect(f.instances).toHaveLength(0)
  expect(f.save).not.toHaveBeenCalled()
})
it("binds the native chooser to the verified main window and does not return native paths", async () => {
  const api = await import("./desktop-artifact-download-service")
  f.save.mockResolvedValue({ canceled: false, filePath: join(f.root, "result.txt") })
  expect(await api.startDesktopBotArtifactDownload(request, window)).toEqual({
    id: request.nonce,
    pathChosen: true
  })
  expect(f.save).toHaveBeenCalledWith(window, expect.objectContaining({ title: "另存成果文件" }))
  expect(f.save.mock.calls[0][1].defaultPath).toBe(join(f.root, "downloads", "结果.txt"))
})
it("aborts logical selection, joins shutdown once and ignores a late OS result", async () => {
  const api = await import("./desktop-artifact-download-service")
  let finish: ((value: unknown) => void) | undefined
  f.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const start = api.startDesktopBotArtifactDownload(request, window)
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
  const first = api.closeDesktopBotArtifactDownloads(),
    second = api.closeDesktopBotArtifactDownloads()
  expect(first).toBe(second)
  await first
  expect(await start).toEqual({ id: request.nonce, cancelled: true })
  finish!({ canceled: false, filePath: join(f.root, "late.txt") })
  await Promise.resolve()
  expect(f.instances[0].close).toHaveBeenCalledOnce()
  await expect(api.startDesktopBotArtifactDownload(request, window)).rejects.toMatchObject({
    code: "download_request_rejected"
  })
})
it("retains a single OS chooser until its actual result despite logical cancellation", async () => {
  const api = await import("./desktop-artifact-download-service")
  let finish: ((value: unknown) => void) | undefined
  f.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = api.startDesktopBotArtifactDownload(request, window)
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
  const controller = f.instances[0].dependencies
  const other = new AbortController()
  await expect(controller.choose("第二个.txt", other.signal)).rejects.toMatchObject({
    code: "download_request_rejected"
  })
  finish!({ canceled: true })
  await first
  expect(f.save).toHaveBeenCalledOnce()
})
it("blocks publication during shared maintenance without executing native effects", async () => {
  const api = await import("./desktop-artifact-download-service")
  await api.pageDesktopBotArtifactDownloads({})
  f.available.mockImplementation(() => {
    throw Object.assign(new Error("maintenance"), { code: "host_maintenance" })
  })
  const publish = vi.fn(),
    signal = new AbortController().signal
  await expect(
    f.instances[0].dependencies.withPublication(request.source, signal, publish)
  ).rejects.toMatchObject({ code: "host_maintenance" })
  expect(publish).not.toHaveBeenCalled()
})
