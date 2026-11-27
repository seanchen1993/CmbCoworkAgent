import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BrowserWindow, dialog, ipcMain } from "electron"
import {
  DESIGN_MARKET_CATEGORIES,
  DESIGN_MARKET_DOWNLOAD_PROGRESS,
  DESIGN_MARKET_SCENARIOS,
  DESIGN_MARKET_SYSTEM_MAX_BYTES,
  normalizeMarketAccountId,
  type DesignMarketActionResult,
  type DesignMarketActor,
  type DesignMarketDownloadProgress,
  type DesignMarketDownloadResult,
  type LocalMarketAssetsState,
  type MarketCatalogQuery,
  type MarketCatalogResponse,
  type MarketCreateSystemDraftInput,
  type MarketCreateTemplateDraftInput,
  type MarketPublishSystemInput,
  type MarketPublishTemplateInput,
  type MarketSaveSystemDraftInput,
  type MarketSaveTemplateDraftInput,
  type MarketStagedPackageInfo,
  type MarketSystemSummary,
  type MarketTemplateSummary,
  type MarketTemplateVisibility
} from "../../shared/design-market"
import type { DesignSystemInfo } from "../../shared/design-system"
import { getOpenworkDir, getUserInfo, type UserInfoConfig } from "../storage"
import type { DesignMarketBackendTransport } from "../services/design/market-http"
import { DesignMarketLocalStore } from "../services/design/market-local-store"
import { DesignMarketService, MarketServiceError } from "../services/design/market-service"
import { DesignMarketplaceTransport } from "../services/design/marketplace-transport"
import {
  extractDesignSystemPalette,
  generateOfflineTemplateCover,
  validateAndPackTemplateSource,
  validateManualCoverImage
} from "../services/design/market-validation"
import type { DesignSystemLibrary } from "../services/design/system-library"
import type { DesignTemplatePackages } from "../services/design/template-packages"
import type { DesignTemplatePreview } from "../services/design/template-preview"

function designMarketActorForUser(user: UserInfoConfig | null): DesignMarketActor | null {
  const rawIds = [user?.ystId, user?.sapId]
    .map((id) => normalizeMarketAccountId(id))
    .filter(Boolean)
  const userId = rawIds[0]
  if (!userId) return null
  return {
    userId,
    userName: user?.userName?.trim() || userId,
    orgName: user?.orgName?.trim() || undefined,
    rawIds
  }
}

export function resolveCurrentDesignMarketActor(): DesignMarketActor | null {
  return designMarketActorForUser(getUserInfo())
}

function toActionError<T>(error: unknown): DesignMarketActionResult<T> {
  if (error instanceof MarketServiceError) {
    return {
      success: false,
      code: error.code,
      error: error.message,
      conflictRevision: error.conflictRevision
    }
  }
  const message = error instanceof Error ? error.message : String(error || "操作失败")
  const isOffline = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)
  return {
    success: false,
    code: isOffline ? "OFFLINE" : "VALIDATION",
    error: isOffline ? "设计市场服务暂不可用，请检查网络后重试" : message
  }
}

async function runAction<T>(fn: () => Promise<T> | T): Promise<DesignMarketActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return toActionError<T>(error)
  }
}

export function registerDesignMarketHandlers(deps: {
  localStore: DesignMarketLocalStore
  systemLibrary: () => DesignSystemLibrary
  readLocalSystem: (id: string) => { info?: DesignSystemInfo; content?: string; error?: string }
  templatePackages: DesignTemplatePackages
  templatePreview: DesignTemplatePreview
  onLocalAssetsChanged?: () => void
  transport?: DesignMarketBackendTransport
  getActor?: () => DesignMarketActor | null
}): void {
  const transport = deps.transport ?? new DesignMarketplaceTransport(
    import.meta.env?.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL,
    new DesignMarketService(path.join(getOpenworkDir(), "design-market-server"), { seedDemo: false }),
    (actor) => {
      const user = getUserInfo()
      return designMarketActorForUser(user)?.userId === actor.userId
        ? user?.ystIdToken?.trim() || null
        : null
    }
  )
  const getActor = deps.getActor ?? resolveCurrentDesignMarketActor

  const broadcastProgress = (event: DesignMarketDownloadProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(DESIGN_MARKET_DOWNLOAD_PROGRESS, event)
      }
    }
  }

  const stageAndCaptureTemplate = async (
    sourcePath: string,
    preferredEntryPath?: string
  ): Promise<MarketStagedPackageInfo> => {
    const actor = getActor()
    const packed = validateAndPackTemplateSource(sourcePath, preferredEntryPath)
    const staged = await transport.stageTemplateBlob(packed.zipBuffer, actor, packed.defaultEntryPath)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "design-market-cover-"))
    try {
      for (const rel of packed.fileList) {
        const target = path.join(tempDir, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, packed.files.get(rel)!)
      }
      const cover = await generateOfflineTemplateCover({
        rootDir: tempDir,
        entryPath: staged.defaultEntryPath,
        files: packed.fileList,
        title: packed.packageFilename.replace(/\.zip$/i, ""),
        framework: staged.framework
      })
      return {
        stagedBlobSha256: staged.sha256,
        packageFilename: packed.packageFilename,
        pages: staged.pages,
        defaultEntryPath: staged.defaultEntryPath,
        filesCount: staged.filesCount,
        totalBytes: staged.totalBytes,
        framework: staged.framework,
        coverDataUrl: cover.coverDataUrl,
        warnings: [...packed.warnings, ...cover.warnings]
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  ipcMain.handle("design-market:get-actor", () => getActor())

  ipcMain.handle(
    "design-market:list-catalog",
    async (_event, query?: MarketCatalogQuery): Promise<MarketCatalogResponse> => {
      const actor = getActor()
      try {
        return await transport.listCatalog(query ?? {}, actor)
      } catch (error) {
        const reason =
          error instanceof MarketServiceError && error.code === "UNAUTHORIZED"
            ? "未检测到登录账号，请先登录后浏览和下载设计市场资产。"
            : error instanceof Error
              ? error.message
              : "无法连接设计市场"
        return {
          actor,
          online: false,
          offlineReason: reason,
          categories: DESIGN_MARKET_CATEGORIES,
          scenarios: DESIGN_MARKET_SCENARIOS,
          categoryCounts: { 全部: 0 },
          systems: []
        }
      }
    }
  )

  ipcMain.handle("design-market:get-system-detail", (_event, systemId: string) =>
    runAction(() => transport.getSystemDetail(systemId, getActor()))
  )

  ipcMain.handle("design-market:get-template-detail", (_event, templateId: string) =>
    runAction(() => transport.getTemplateDetail(templateId, getActor()))
  )

  ipcMain.handle("design-market:list-my-uploads", () =>
    runAction(() => transport.listMyUploads(getActor()))
  )

  ipcMain.handle("design-market:list-downloaded", async (): Promise<LocalMarketAssetsState> => {
    const actor = getActor()
    if (!actor) return deps.localStore.getLocalState()
    try {
      const catalog = await transport.listCatalog({}, actor)
      const sysMap = new Map<string, MarketSystemSummary>(
        catalog.systems.map((sys) => [sys.systemId, sys])
      )
      const tplMap = new Map<string, MarketTemplateSummary>()
      const uploads = await transport.listMyUploads(actor).catch(() => null)
      for (const s of uploads?.systems ?? []) sysMap.set(s.systemId, s)
      for (const t of uploads?.templates ?? []) tplMap.set(t.templateId, t)
      const uniqueSystemIds = new Set(
        deps.localStore.getLocalState().templates.map((t) => t.systemId)
      )
      await Promise.all(
        [...uniqueSystemIds].map(async (sid) => {
          const detail = await transport.getSystemDetail(sid, actor).catch(() => null)
          if (detail) {
            sysMap.set(detail.system.systemId, detail.system)
            for (const tpl of detail.templates) tplMap.set(tpl.templateId, tpl)
          }
        })
      )
      return deps.localStore.getLocalState({ systems: sysMap, templates: tplMap })
    } catch {
      return deps.localStore.getLocalState()
    }
  })

  ipcMain.handle("design-market:extract-palette", (_event, markdown: string) =>
    extractDesignSystemPalette(String(markdown || ""))
  )

  ipcMain.handle("design-market:pick-system-markdown", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: "选择设计规范文件",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md"] }]
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { success: false, error: "已取消选择" }
    return runAction(() => {
      const file = picked.filePaths[0]
      if (fs.statSync(file).size > DESIGN_MARKET_SYSTEM_MAX_BYTES) {
        throw new MarketServiceError(422, "VALIDATION", "设计规范文件不能超过 1 MB")
      }
      const content = fs.readFileSync(file, "utf8")
      const title =
        content.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 80) ||
        path.basename(file, path.extname(file)).slice(0, 80)
      return {
        name: title,
        markdown: content,
        palette: extractDesignSystemPalette(content)
      }
    })
  })

  ipcMain.handle(
    "design-market:create-system-draft",
    (_event, input: MarketCreateSystemDraftInput) =>
      runAction(() => transport.createSystemDraft(input, getActor()))
  )

  ipcMain.handle(
    "design-market:create-system-draft-from-local",
    (_event, localSystemId: string) =>
      runAction(async () => {
        const loaded = deps.readLocalSystem(localSystemId)
        if (!loaded.info || !loaded.content) {
          throw new MarketServiceError(404, "NOT_FOUND", loaded.error || "找不到本地设计系统")
        }
        return transport.createSystemDraft(
          {
            name: loaded.info.name,
            description: loaded.info.description,
            markdown: loaded.content,
            palette: loaded.info.palette ?? extractDesignSystemPalette(loaded.content)
          },
          getActor()
        )
      })
  )

  ipcMain.handle("design-market:save-system-draft", (_event, input: MarketSaveSystemDraftInput) =>
    runAction(() => transport.saveSystemDraft(input, getActor()))
  )

  ipcMain.handle("design-market:discard-system-draft", (_event, systemId: string) =>
    runAction(() => transport.discardSystemDraft(systemId, getActor()))
  )

  ipcMain.handle("design-market:publish-system", (_event, input: MarketPublishSystemInput) =>
    runAction(() => transport.publishSystem(input, getActor()))
  )

  ipcMain.handle(
    "design-market:set-system-status",
    (_event, systemId: string, status: "published" | "unpublished") =>
      runAction(() => transport.setSystemStatus(systemId, status, getActor()))
  )

  ipcMain.handle(
    "design-market:pick-and-stage-template",
    async (event, source: "file" | "directory") => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions =
        source === "directory"
          ? { title: "选择静态模板目录", properties: ["openDirectory"] }
          : {
              title: "选择 HTML 或 ZIP 模板包",
              properties: ["openFile"],
              filters: [{ name: "模板文件", extensions: ["html", "htm", "zip"] }]
            }
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return { success: false, canceled: true }
      return runAction(() => stageAndCaptureTemplate(picked.filePaths[0]))
    }
  )

  ipcMain.handle(
    "design-market:stage-local-template",
    (_event, reference: { id: string; entryPath: string }) =>
      runAction(async () => {
        const pkg = deps.templatePackages.read(reference)
        return stageAndCaptureTemplate(pkg.rootDir, pkg.entryPath)
      })
  )

  ipcMain.handle("design-market:pick-manual-cover", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: "选择模板封面图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { success: false, canceled: true }
    return runAction(() => ({ coverDataUrl: validateManualCoverImage(picked.filePaths[0]) }))
  })

  ipcMain.handle(
    "design-market:create-template-draft",
    (_event, input: MarketCreateTemplateDraftInput) =>
      runAction(() => transport.createTemplateDraft(input, getActor()))
  )

  ipcMain.handle(
    "design-market:save-template-draft",
    (_event, input: MarketSaveTemplateDraftInput) =>
      runAction(() => transport.saveTemplateDraft(input, getActor()))
  )

  ipcMain.handle("design-market:discard-template-draft", (_event, templateId: string) =>
    runAction(() => transport.discardTemplateDraft(templateId, getActor()))
  )

  ipcMain.handle("design-market:publish-template", (_event, input: MarketPublishTemplateInput) =>
    runAction(() => transport.publishTemplate(input, getActor()))
  )

  ipcMain.handle(
    "design-market:set-template-status",
    (_event, templateId: string, status: "published" | "unpublished") =>
      runAction(() => transport.setTemplateStatus(templateId, status, getActor()))
  )

  ipcMain.handle(
    "design-market:set-template-visibility",
    (_event, templateId: string, visibility: MarketTemplateVisibility, reason?: string) =>
      runAction(() =>
        transport.setTemplateVisibilityBySystemOwner(templateId, visibility, reason, getActor())
      )
  )

  ipcMain.handle(
    "design-market:admin-takedown",
    (_event, kind: "system" | "template", assetId: string, reason: string) =>
      runAction(() => transport.adminTakedown(kind, assetId, reason, getActor()))
  )

  ipcMain.handle(
    "design-market:admin-restore",
    (_event, kind: "system" | "template", assetId: string, reason: string) =>
      runAction(() => transport.adminRestore(kind, assetId, reason, getActor()))
  )

  ipcMain.handle(
    "design-market:plan-download",
    (
      _event,
      kind: "system" | "template",
      assetId: string,
      versionId?: string,
      selectedLocalSystemId?: string | null
    ) =>
      runAction(() =>
        deps.localStore.planDownload(
          transport,
          getActor(),
          kind,
          assetId,
          versionId,
          selectedLocalSystemId
        )
      )
  )

  ipcMain.handle(
    "design-market:download-system",
    async (_event, systemId: string, versionId?: string): Promise<DesignMarketDownloadResult> => {
      try {
        const result = await deps.localStore.downloadSystemVersion({
          transport,
          actor: getActor(),
          systemId,
          versionId,
          onProgress: broadcastProgress
        })
        if (result.success) deps.onLocalAssetsChanged?.()
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "下载失败" }
      }
    }
  )

  ipcMain.handle(
    "design-market:download-template",
    async (
      _event,
      templateId: string,
      versionId?: string,
      selectedLocalSystemId?: string | null
    ): Promise<DesignMarketDownloadResult> => {
      try {
        const result = await deps.localStore.downloadTemplateVersion({
          transport,
          actor: getActor(),
          templateId,
          versionId,
          selectedLocalSystemId,
          onProgress: broadcastProgress
        })
        if (result.success) deps.onLocalAssetsChanged?.()
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "下载失败" }
      }
    }
  )

  ipcMain.handle("design-market:cancel-download", (_event, downloadKey: string) =>
    deps.localStore.cancelDownload(downloadKey)
  )

  ipcMain.handle("design-market:count-affected-templates", (_event, localSystemId: string) =>
    deps.localStore.countAffectedTemplatesForSystemRemoval(localSystemId)
  )

  ipcMain.handle("design-market:remove-system", (_event, localSystemId: string) => {
    const next = deps.localStore.removeSystemFromPicker(localSystemId)
    deps.onLocalAssetsChanged?.()
    return next
  })

  ipcMain.handle("design-market:restore-system", (_event, localSystemId: string) => {
    const next = deps.localStore.restoreSystemToPicker(localSystemId)
    deps.onLocalAssetsChanged?.()
    return next
  })

  ipcMain.handle("design-market:remove-template", (_event, localTemplateId: string) => {
    const next = deps.localStore.removeTemplateFromPicker(localTemplateId)
    deps.onLocalAssetsChanged?.()
    return next
  })

  ipcMain.handle("design-market:restore-template", (_event, localTemplateId: string) => {
    const next = deps.localStore.restoreTemplateToPicker(localTemplateId)
    deps.onLocalAssetsChanged?.()
    return next
  })

  ipcMain.handle("design-market:copy-system-local", (_event, localSystemId: string) =>
    runAction(() => {
      const saved = deps.localStore.copySystemToLocalLibrary(localSystemId, deps.systemLibrary())
      deps.onLocalAssetsChanged?.()
      return saved
    })
  )

  ipcMain.handle("design-market:copy-template-local", (_event, localTemplateId: string) =>
    runAction(() => {
      const saved = deps.localStore.copyTemplateToLocalPackages(localTemplateId, deps.templatePackages)
      deps.onLocalAssetsChanged?.()
      return saved
    })
  )

  ipcMain.handle(
    "design-market:preview-downloaded-template",
    (_event, localTemplateId: string, entryPath?: string) =>
      runAction(async () => {
        const entry = deps.localStore.getTemplateEntryByLocalId(localTemplateId)
        if (!entry) {
          throw new MarketServiceError(404, "NOT_FOUND", "请先下载该模板后再打开本地交互预览")
        }
        deps.localStore.listSelectableTemplateInfos(deps.templatePackages)
        const targetEntry = entryPath || entry.defaultEntryPath
        const pkg = deps.templatePackages.read({ id: entry.localId, entryPath: targetEntry })
        const previewUrl = await deps.templatePreview.url(pkg)
        return { previewUrl, pages: pkg.pages, entryPath: pkg.entryPath }
      })
  )
}
