import { app, dialog, shell, type BrowserWindow } from "electron"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { BotDomainError } from "../../shared/bot-types"
import {
  botArtifactDownloadStartSchema,
  botArtifactDownloadMutationSchema,
  botArtifactDownloadPageInputSchema
} from "../../shared/bot-artifact-downloads"
import { validateBotFileName } from "./artifact-validation"
import { DesktopArtifactDownloads } from "./desktop-artifact-downloads"
import { DesktopArtifactDownloadSource } from "./desktop-artifact-download-provider"
import { openArtifactSourceConnection } from "./desktop-artifact-source-connection"
import {
  getDesktopBotClient,
  assertDesktopBotConnectionAvailable,
  registerDesktopBotMaintenanceParticipant
} from "./desktop-client"

interface Owner {
  configuredRoot: string
  active: boolean
  manager?: DesktopArtifactDownloads
}
const chooserOwner = new AsyncLocalStorage<BrowserWindow>()
let owner: Owner | undefined
let initializing: Promise<DesktopArtifactDownloads> | undefined
let shutdown = false
let shutdownPromise: Promise<void> | undefined
let nativeChoice: Promise<string | undefined> | undefined

async function choose(name: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  if (nativeChoice)
    throw new BotDomainError("download_request_rejected", "保存对话框已打开，请先完成文件选择")
  const window = chooserOwner.getStore()
  if (!window || window.isDestroyed())
    throw new BotDomainError("download_request_rejected", "保存窗口已关闭，请从主界面重新保存")
  const selection = dialog
    .showSaveDialog(window, {
      title: "另存成果文件",
      defaultPath: join(app.getPath("downloads"), validateBotFileName(name)),
      buttonLabel: "保存",
      message: "请选择新的文件名；已有文件不会被覆盖。",
      properties: ["createDirectory"]
    })
    .then((result) => (result.canceled ? undefined : result.filePath))
  nativeChoice = selection
  const clear = () => {
    if (nativeChoice === selection) nativeChoice = undefined
  }
  void selection.then(clear, clear)
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("文件选择已取消"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    signal.throwIfAborted()
    const result = await Promise.race([selection, cancelled])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

async function manager(): Promise<DesktopArtifactDownloads> {
  if (shutdown) throw new BotDomainError("download_request_rejected", "保存服务正在关闭")
  if (initializing) return initializing
  const configuredRoot = getCmbCoworkAgentDataRoot()
  if (owner?.configuredRoot === configuredRoot && owner.active && owner.manager)
    return owner.manager
  initializing = (async () => {
    const previous = owner
    if (previous?.manager) await previous.manager.close()
    if (previous) previous.active = false
    if (shutdown) throw new BotDomainError("download_request_rejected", "保存服务正在关闭")
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 })
    const root = await realpath(configuredRoot)
    if (shutdown) throw new BotDomainError("download_request_rejected", "保存服务正在关闭")
    const current: Owner = { configuredRoot, active: true }
    owner = current
    const assertOwnership = () => {
      if (!current.active || owner !== current || getCmbCoworkAgentDataRoot() !== configuredRoot)
        throw new BotDomainError(
          "download_request_rejected",
          "保存服务的工作目录已变化，请重新打开"
        )
    }
    const source = new DesktopArtifactDownloadSource(
      (signal) => openArtifactSourceConnection(signal, getDesktopBotClient),
      assertOwnership
    )
    try {
      current.manager = new DesktopArtifactDownloads(
        join(root, "desktop-bot-downloads", "saves.sqlite"),
        {
          source,
          choose,
          assertOwnership,
          async reveal(path) {
            shell.showItemInFolder(path)
          },
          async withPublication(_source, signal, operation) {
            assertOwnership()
            signal.throwIfAborted()
            assertDesktopBotConnectionAvailable()
            // The manager registered this active stream before this admission;
            // maintenance drains the stream through link and its durable receipt.
            return operation()
          }
        }
      )
      return current.manager
    } catch (error) {
      current.active = false
      if (owner === current) owner = undefined
      throw error
    }
  })().finally(() => {
    initializing = undefined
  })
  return initializing
}

registerDesktopBotMaintenanceParticipant({
  async drain() {
    await initializing?.catch(() => undefined)
    await owner?.manager?.drainForMaintenance()
  },
  end() {
    owner?.manager?.endMaintenance()
  }
})

export async function startDesktopBotArtifactDownload(input: unknown, window: BrowserWindow) {
  const request = botArtifactDownloadStartSchema.parse(input)
  assertDesktopBotConnectionAvailable()
  const current = await manager()
  assertDesktopBotConnectionAvailable()
  return chooserOwner.run(window, () => current.start(request))
}
export async function pageDesktopBotArtifactDownloads(input: unknown) {
  const request = botArtifactDownloadPageInputSchema.parse(input)
  return (await manager()).page(request)
}
export async function resumeDesktopBotArtifactDownload(input: unknown) {
  const request = botArtifactDownloadMutationSchema.parse(input)
  assertDesktopBotConnectionAvailable()
  const current = await manager()
  assertDesktopBotConnectionAvailable()
  return current.resume(request)
}
export async function pauseDesktopBotArtifactDownload(input: unknown) {
  const request = botArtifactDownloadMutationSchema.parse(input)
  return (await manager()).pause(request)
}
export async function cancelDesktopBotArtifactDownload(input: unknown) {
  const request = botArtifactDownloadMutationSchema.parse(input)
  return (await manager()).cancel(request)
}
export async function revealDesktopBotArtifactDownload(input: unknown) {
  const request = botArtifactDownloadMutationSchema.parse(input)
  return (await manager()).reveal(request)
}
export async function forgetDesktopBotArtifactDownload(input: unknown) {
  const request = botArtifactDownloadMutationSchema.parse(input)
  return (await manager()).forget(request)
}
export function hasDesktopBotArtifactDownloads(): boolean {
  return owner !== undefined || initializing !== undefined || nativeChoice !== undefined
}
export function closeDesktopBotArtifactDownloads(): Promise<void> {
  shutdown = true
  shutdownPromise ??= (async () => {
    await initializing?.catch(() => undefined)
    await owner?.manager?.close()
    if (owner) owner.active = false
  })()
  return shutdownPromise
}
