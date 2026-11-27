import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  DESIGN_MARKET_SYSTEM_MAX_BYTES,
  DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES,
  type DesignMarketActor,
  type DesignMarketDownloadPlan,
  type DesignMarketDownloadProgress,
  type DesignMarketDownloadResult,
  type LocalMarketAssetsState,
  type LocalMarketSystemEntry,
  type LocalMarketTemplateEntry,
  type MarketSystemSummary,
  type MarketTemplateSummary
} from "../../../shared/design-market"
import {
  compareSemVer,
  formatCompatibilityRange,
  isSystemVersionCompatible,
  pickLatestCompatibleVersion
} from "../../../shared/design-market-semver"
import type { DesignSystemInfo } from "../../../shared/design-system"
import type { DesignTemplateInfo, DesignTemplatePackage } from "../../../shared/design-template"
import type { DesignMarketBackendTransport } from "./market-http"
import { inspectTemplateZipFile } from "./market-validation"
import type { DesignSystemLibrary } from "./system-library"
import { DesignTemplatePackages } from "./template-packages"

interface LocalMarketIndexFile {
  version: number
  systems: Record<string, LocalMarketSystemEntry>
  templates: Record<string, LocalMarketTemplateEntry>
}

interface StagedMarketInstall {
  stagingDir: string
  finalDir: string
}

type DownloadProgressListener = (event: DesignMarketDownloadProgress) => void

interface MarketDownload {
  controller: AbortController
  promise: Promise<DesignMarketDownloadResult>
  listeners: Set<DownloadProgressListener>
  progress?: DesignMarketDownloadProgress
}

function sanitizeIdPart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function makeMarketSystemLocalId(systemId: string, versionId: string): string {
  return `mkt_sys_${sanitizeIdPart(systemId)}_${sanitizeIdPart(versionId)}`
}

export function makeMarketTemplateLocalId(templateId: string, versionId: string): string {
  return `mkt_tpl_${sanitizeIdPart(templateId)}_${sanitizeIdPart(versionId)}`
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    fs.renameSync(tmp, filePath)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function writeStagedInstall(stagingDir: string, write: () => void): void {
  fs.mkdirSync(stagingDir)
  try {
    write()
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

export class DesignMarketLocalStore {
  private readonly indexPath: string
  private readonly systemsDir: string
  private readonly templatesDir: string
  private readonly tmpDir: string
  private index: LocalMarketIndexFile
  private readonly inFlight = new Map<string, MarketDownload>()

  constructor(readonly storageDir: string) {
    this.indexPath = path.join(storageDir, "index.json")
    this.systemsDir = path.join(storageDir, "systems")
    this.templatesDir = path.join(storageDir, "templates")
    this.tmpDir = path.join(storageDir, "tmp")
    fs.mkdirSync(this.systemsDir, { recursive: true })
    fs.mkdirSync(this.templatesDir, { recursive: true })
    fs.mkdirSync(this.tmpDir, { recursive: true })
    this.cleanupStaleTempFiles()
    if (fs.existsSync(this.indexPath)) {
      this.index = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as LocalMarketIndexFile
    } else {
      this.index = { version: 1, systems: {}, templates: {} }
      this.persistIndex()
    }
    this.cleanupUnindexedInstalls()
  }

  private cleanupUnindexedInstalls(): void {
    const indexed = new Set([
      ...Object.values(this.index.systems).map((entry) => path.dirname(entry.markdownPath)),
      ...Object.values(this.index.templates).map((entry) => path.dirname(entry.rootDir))
    ])
    for (const dir of [this.systemsDir, this.templatesDir]) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^mkt_(sys|tpl)_.+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        if (!indexed.has(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true })
      }
    }
  }

  cleanupStaleTempFiles(): number {
    if (!fs.existsSync(this.tmpDir)) return 0
    let removed = 0
    for (const entry of fs.readdirSync(this.tmpDir, { withFileTypes: true })) {
      fs.rmSync(path.join(this.tmpDir, entry.name), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  private persistIndex(
    next: LocalMarketIndexFile = this.index,
    installs: StagedMarketInstall[] = []
  ): void {
    const moved: string[] = []
    try {
      for (const { stagingDir, finalDir } of installs) {
        fs.renameSync(stagingDir, finalDir)
        moved.push(finalDir)
      }
      atomicWriteJson(this.indexPath, next)
    } catch (error) {
      for (const dir of moved.reverse()) fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
    this.index = next
  }

  private isSystemFilesValid(entry: LocalMarketSystemEntry): boolean {
    try {
      return fs.existsSync(entry.markdownPath) && fs.statSync(entry.markdownPath).isFile()
    } catch {
      return false
    }
  }

  private isTemplateFilesValid(entry: LocalMarketTemplateEntry): boolean {
    try {
      const entryFull = path.join(entry.rootDir, entry.defaultEntryPath)
      return fs.existsSync(entry.rootDir) && fs.existsSync(entryFull) && fs.statSync(entryFull).isFile()
    } catch {
      return false
    }
  }

  private activeSystemsForMarketId(systemId: string): LocalMarketSystemEntry[] {
    return Object.values(this.index.systems).filter(
      (sys) => !sys.removedFromPicker && sys.systemId === systemId && this.isSystemFilesValid(sys)
    )
  }

  private compatibleSystemForTemplate(tpl: LocalMarketTemplateEntry): LocalMarketSystemEntry | null {
    const active = this.activeSystemsForMarketId(tpl.systemId)
    return pickLatestCompatibleVersion(active, (item) => item.version, tpl.minSystemVersion)
  }

  getLocalState(marketSummary?: {
    systems: Map<string, MarketSystemSummary>
    templates: Map<string, MarketTemplateSummary>
  }): LocalMarketAssetsState {
    const systems = Object.values(this.index.systems)
      .filter((entry) => this.isSystemFilesValid(entry))
      .map((entry) => {
        const remote = marketSummary?.systems.get(entry.systemId)
        const latestMarketVersion = remote?.latestVersion ?? null
        const updateAvailable = Boolean(
          latestMarketVersion &&
            remote?.status === "published" &&
            compareSemVer(latestMarketVersion, entry.version) > 0
        )
        return {
          ...entry,
          latestMarketVersion,
          updateAvailable,
          marketStatus: remote?.status
        }
      })
      .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))

    const templates = Object.values(this.index.templates)
      .filter((entry) => this.isTemplateFilesValid(entry))
      .map((entry) => {
        const compatSys = this.compatibleSystemForTemplate(entry)
        const remote = marketSummary?.templates.get(entry.templateId)
        const latestMarketVersion = remote?.latestVersion ?? null
        const updateAvailable = Boolean(
          latestMarketVersion &&
            remote?.effectiveStatus === "published" &&
            compareSemVer(latestMarketVersion, entry.version) > 0
        )
        return {
          ...entry,
          missingCompatibleSystem: !compatSys,
          compatibleSystemVersion: compatSys?.version ?? null,
          latestMarketVersion,
          updateAvailable,
          effectiveStatus: remote?.effectiveStatus
        }
      })
      .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))

    return { systems, templates }
  }

  /** Returns ALL local market system versions (including removed ones so historical sessions resolve). */
  listAllSystemInfos(): DesignSystemInfo[] {
    const entries = Object.values(this.index.systems).filter((entry) => this.isSystemFilesValid(entry))
    const latestActiveBySystemId = new Map<string, string>()
    for (const entry of entries) {
      if (entry.removedFromPicker) continue
      const currentBest = latestActiveBySystemId.get(entry.systemId)
      if (!currentBest || compareSemVer(entry.version, currentBest) > 0) {
        latestActiveBySystemId.set(entry.systemId, entry.version)
      }
    }

    return entries
      .map((entry): DesignSystemInfo => {
        const isLatest =
          !entry.removedFromPicker && latestActiveBySystemId.get(entry.systemId) === entry.version
        return {
          id: entry.localId,
          name: entry.name,
          description: entry.description,
          ownership: "market",
          category: entry.category,
          source: "design-market",
          updatedAt: Date.parse(entry.downloadedAt) || Date.now(),
          isLatest,
          path: entry.markdownPath,
          marketSystemId: entry.systemId,
          marketVersion: entry.version,
          marketVersionId: entry.versionId,
          marketOwnerName: entry.ownerName,
          palette: entry.palette,
          removedFromPicker: entry.removedFromPicker
        }
      })
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  registerAllTemplatesInPackages(packages: DesignTemplatePackages): void {
    for (const entry of Object.values(this.index.templates)) {
      if (!this.isTemplateFilesValid(entry)) continue
      packages.registerMarket(entry.localId, entry.rootDir, {
        id: entry.localId,
        name: entry.name,
        designSystemKey: `market:${entry.systemId}`,
        entryPath: entry.defaultEntryPath,
        pages: entry.pages,
        files: entry.files,
        totalBytes: entry.totalBytes,
        framework: entry.framework,
        importedAt: entry.downloadedAt,
        source: "market",
        marketTemplateId: entry.templateId,
        marketSystemId: entry.systemId,
        marketVersion: entry.version,
        marketVersionId: entry.versionId,
        marketMinSystemVersion: entry.minSystemVersion,
        marketOwnerName: entry.ownerName,
        previewImageDataUrl: entry.coverDataUrl
      })
    }
  }

  listSelectableTemplateInfos(packages: DesignTemplatePackages): DesignTemplateInfo[] {
    this.registerAllTemplatesInPackages(packages)
    const entries = Object.values(this.index.templates)
      .filter((entry) => !entry.removedFromPicker && this.isTemplateFilesValid(entry))
      .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))

    const out: DesignTemplateInfo[] = []
    for (const entry of entries) {
      const entryFull = path.join(entry.rootDir, entry.defaultEntryPath)
      out.push({
        designSystemKey: `market:${entry.systemId}`,
        name: entry.name,
        description: entry.description,
        path: entryFull,
        mode: "prototype",
        platform: "desktop",
        scenario: entry.scenario,
        previewHtml: "",
        previewPath: entryFull,
        previewImageDataUrl: entry.coverDataUrl,
        pages: entry.pages,
        source: "market",
        marketTemplateId: entry.templateId,
        marketSystemId: entry.systemId,
        marketVersion: entry.version,
        marketVersionId: entry.versionId,
        marketMinSystemVersion: entry.minSystemVersion,
        marketOwnerName: entry.ownerName,
        package: { id: entry.localId, entryPath: entry.defaultEntryPath }
      })
    }
    return out
  }

  async planDownload(
    transport: DesignMarketBackendTransport,
    actor: DesignMarketActor | null,
    kind: "system" | "template",
    assetId: string,
    versionId?: string,
    selectedLocalSystemId?: string | null
  ): Promise<DesignMarketDownloadPlan> {
    if (kind === "system") {
      const detail = await transport.getSystemDetail(assetId, actor)
      const target = versionId
        ? detail.versions.find((v) => v.versionId === versionId)
        : detail.versions.find((v) => v.versionId === detail.system.latestVersionId) ?? detail.versions[0]
      if (!target) throw new Error("找不到可下载的设计系统版本")
      return {
        kind: "system",
        assetId,
        versionId: target.versionId,
        compatible: true,
        willDownloadSystem: true,
        systemToDownload: {
          systemId: detail.system.systemId,
          name: detail.system.name,
          versionId: target.versionId,
          version: target.version,
          bytes: target.bytes
        }
      }
    }

    const tplDetail = await transport.getTemplateDetail(assetId, actor)
    const targetTpl = versionId
      ? tplDetail.versions.find((v) => v.versionId === versionId)
      : tplDetail.versions.find((v) => v.versionId === tplDetail.template.latestVersionId) ??
        tplDetail.versions[0]
    if (!targetTpl) throw new Error("找不到可下载的模板版本")

    const selectedEntry = selectedLocalSystemId ? this.index.systems[selectedLocalSystemId] : undefined
    if (
      selectedEntry &&
      !selectedEntry.removedFromPicker &&
      this.isSystemFilesValid(selectedEntry) &&
      selectedEntry.systemId === tplDetail.template.systemId &&
      isSystemVersionCompatible(selectedEntry.version, targetTpl.minSystemVersion)
    ) {
      return {
        kind: "template",
        assetId,
        versionId: targetTpl.versionId,
        compatible: true,
        willDownloadSystem: false,
        reusedSystemVersion: selectedEntry.version,
        systemToDownload: null
      }
    }

    const localBest = pickLatestCompatibleVersion(
      this.activeSystemsForMarketId(tplDetail.template.systemId),
      (item) => item.version,
      targetTpl.minSystemVersion
    )
    if (localBest) {
      return {
        kind: "template",
        assetId,
        versionId: targetTpl.versionId,
        compatible: true,
        willDownloadSystem: false,
        reusedSystemVersion: localBest.version,
        systemToDownload: null
      }
    }

    const sysDetail = await transport.getSystemDetail(tplDetail.template.systemId, actor)
    if (sysDetail.system.status !== "published") {
      return {
        kind: "template",
        assetId,
        versionId: targetTpl.versionId,
        compatible: false,
        willDownloadSystem: false,
        missingReason: `缺少适配版本：所属设计系统当前已下架`
      }
    }

    const remoteBest = pickLatestCompatibleVersion(
      sysDetail.versions,
      (v) => v.version,
      targetTpl.minSystemVersion
    )
    if (!remoteBest) {
      return {
        kind: "template",
        assetId,
        versionId: targetTpl.versionId,
        compatible: false,
        willDownloadSystem: false,
        missingReason: `缺少适配版本：该模板需要所属设计系统 ${formatCompatibilityRange(targetTpl.minSystemVersion)}`
      }
    }

    return {
      kind: "template",
      assetId,
      versionId: targetTpl.versionId,
      compatible: true,
      willDownloadSystem: true,
      systemToDownload: {
        systemId: sysDetail.system.systemId,
        name: sysDetail.system.name,
        versionId: remoteBest.versionId,
        version: remoteBest.version,
        bytes: remoteBest.bytes
      }
    }
  }

  private startDownload(
    key: string,
    listener: DownloadProgressListener | undefined,
    run: (signal: AbortSignal, publish: DownloadProgressListener) => Promise<DesignMarketDownloadResult>
  ): Promise<DesignMarketDownloadResult> {
    const existing = this.inFlight.get(key)
    if (existing) {
      if (listener && !existing.listeners.has(listener)) {
        existing.listeners.add(listener)
        if (existing.progress) listener(existing.progress)
      }
      return existing.promise
    }

    const controller = new AbortController()
    const active: MarketDownload = {
      controller,
      listeners: new Set(listener ? [listener] : []),
      promise: Promise.resolve().then(() => run(controller.signal, (event) => {
        active.progress = event
        for (const listen of active.listeners) listen(event)
      })).finally(() => this.inFlight.delete(key))
    }
    this.inFlight.set(key, active)
    return active.promise
  }

  cancelDownload(downloadKey: string): boolean {
    const active = this.inFlight.get(downloadKey)
    if (!active) return false
    active.controller.abort(new Error("下载已取消"))
    return true
  }

  private async streamToVerifiedFile(options: {
    downloadKey: string
    kind: "system" | "template"
    assetId: string
    versionId: string
    maxBytes: number
    expectedBytes: number
    expectedSha256: string
    transport: DesignMarketBackendTransport
    actor: DesignMarketActor | null
    signal: AbortSignal
    onProgress?: (event: DesignMarketDownloadProgress) => void
  }): Promise<{ tempFile: string; bytes: number; sha256: string }> {
    const opened = await options.transport.openDownloadStream(
      options.kind,
      options.assetId,
      options.versionId,
      options.actor,
      options.signal
    )
    const tempFile = path.join(this.tmpDir, `dl-${randomUUID()}.bin`)
    const hash = createHash("sha256")
    let receivedBytes = 0
    const totalBytes = options.expectedBytes
    const downloadMessage = options.kind === "system" ? "正在下载设计规范…" : "正在下载模板压缩包…"
    const emit = (phase: DesignMarketDownloadProgress["phase"], message: string) => {
      options.onProgress?.({
        downloadKey: options.downloadKey,
        kind: options.kind,
        assetId: options.assetId,
        versionId: options.versionId,
        phase,
        receivedBytes,
        totalBytes,
        message
      })
    }

    try {
      if (opened.versionId !== options.versionId ||
          opened.expectedBytes !== totalBytes ||
          opened.expectedSha256 !== options.expectedSha256 ||
          !Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > options.maxBytes ||
          !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
        throw new Error("下载文件元数据与所选市场版本不一致")
      }
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.byteLength
          if (receivedBytes > totalBytes) {
            callback(new Error("下载文件超过所选版本的大小限制"))
            return
          }
          hash.update(chunk)
          emit("downloading", downloadMessage)
          callback(null, chunk)
        }
      })
      emit("downloading", downloadMessage)
      await pipeline(opened.stream, meter, fs.createWriteStream(tempFile, { flags: "wx" }), {
        signal: options.signal
      })
      emit("verifying", "正在校验文件完整性…")
      if (receivedBytes !== totalBytes) {
        throw new Error(`文件大小校验失败（期望 ${totalBytes} 字节，实际 ${receivedBytes} 字节）`)
      }
      const sha256 = hash.digest("hex")
      if (sha256 !== options.expectedSha256) throw new Error("文件 SHA-256 校验失败，请重试")
      return { tempFile, bytes: receivedBytes, sha256 }
    } catch (error) {
      if ("destroy" in opened.stream && typeof opened.stream.destroy === "function") opened.stream.destroy()
      fs.rmSync(tempFile, { force: true })
      throw error
    }
  }

  private stageSystemFromFile(
    tempFile: string,
    detail: Awaited<ReturnType<DesignMarketBackendTransport["getSystemDetail"]>>,
    versionId: string,
    sha256: string,
    bytes: number
  ): { stagingDir: string; finalDir: string; entry: LocalMarketSystemEntry } {
    const ver = detail.versions.find((v) => v.versionId === versionId)
    if (!ver) throw new Error("设计系统版本信息不完整")
    const content = fs.readFileSync(tempFile, "utf8")
    if (!content.trim() || content.includes("\0") || content.includes("\ufffd")) {
      throw new Error("设计规范文件损坏")
    }
    const localId = makeMarketSystemLocalId(detail.system.systemId, ver.versionId)
    const stagingDir = path.join(this.tmpDir, `stage-sys-${randomUUID()}`)
    const finalDir = path.join(this.systemsDir, `${localId}-${randomUUID()}`)
    const markdownPath = path.join(finalDir, "DESIGN.md")
    const entry: LocalMarketSystemEntry = {
      localId,
      systemId: detail.system.systemId,
      versionId: ver.versionId,
      version: ver.version,
      name: detail.system.name,
      description: detail.system.description,
      category: detail.system.category,
      ownerId: detail.system.ownerId,
      ownerName: detail.system.ownerName,
      palette: ver.palette,
      markdownPath,
      downloadedAt: new Date().toISOString(),
      sha256,
      bytes,
      removedFromPicker: false
    }
    writeStagedInstall(stagingDir, () => {
      fs.writeFileSync(path.join(stagingDir, "DESIGN.md"), content, "utf8")
      fs.writeFileSync(path.join(stagingDir, "meta.json"), JSON.stringify(entry, null, 2), "utf8")
    })
    return { stagingDir, finalDir, entry }
  }

  private stageTemplateFromZipFile(
    tempFile: string,
    detail: Awaited<ReturnType<DesignMarketBackendTransport["getTemplateDetail"]>>,
    versionId: string,
    sha256: string
  ): { stagingDir: string; finalDir: string; entry: LocalMarketTemplateEntry } {
    const ver = detail.versions.find((v) => v.versionId === versionId)
    if (!ver) throw new Error("模板版本信息不完整")
    const validated = inspectTemplateZipFile(tempFile, ver.defaultEntryPath)
    const localId = makeMarketTemplateLocalId(detail.template.templateId, ver.versionId)
    const finalDir = path.join(this.templatesDir, `${localId}-${randomUUID()}`)
    const finalRootDir = path.join(finalDir, "files")
    const stagingDir = path.join(this.tmpDir, `stage-tpl-${randomUUID()}`)
    const stagingFilesDir = path.join(stagingDir, "files")
    const entry: LocalMarketTemplateEntry = {
      localId,
      templateId: detail.template.templateId,
      systemId: detail.template.systemId,
      systemName: detail.system.name,
      versionId: ver.versionId,
      version: ver.version,
      minSystemVersion: ver.minSystemVersion,
      name: detail.template.name,
      description: detail.template.description,
      scenario: detail.template.scenario,
      ownerId: detail.template.ownerId,
      ownerName: detail.template.ownerName,
      defaultEntryPath: validated.defaultEntryPath,
      pages: validated.pages,
      files: validated.fileList,
      totalBytes: validated.totalBytes,
      framework: validated.framework,
      coverDataUrl: ver.coverDataUrl,
      rootDir: finalRootDir,
      downloadedAt: new Date().toISOString(),
      sha256,
      removedFromPicker: false,
      missingCompatibleSystem: false
    }
    writeStagedInstall(stagingDir, () => {
      for (const rel of validated.fileList) {
        const target = path.join(stagingFilesDir, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, validated.files.get(rel)!)
      }
      fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(entry, null, 2), "utf8")
    })
    return { stagingDir, finalDir, entry }
  }

  async downloadSystemVersion(options: {
    transport: DesignMarketBackendTransport
    actor: DesignMarketActor | null
    systemId: string
    versionId?: string
    onProgress?: (event: DesignMarketDownloadProgress) => void
  }): Promise<DesignMarketDownloadResult> {
    const detail = await options.transport.getSystemDetail(options.systemId, options.actor)
    const targetVer = options.versionId
      ? detail.versions.find((v) => v.versionId === options.versionId)
      : detail.versions.find((v) => v.versionId === detail.system.latestVersionId) ?? detail.versions[0]
    if (!targetVer) {
      return { success: false, error: "找不到可下载的设计系统版本" }
    }

    const downloadKey = `system:${options.systemId}:${targetVer.versionId}`
    const localId = makeMarketSystemLocalId(options.systemId, targetVer.versionId)
    return this.startDownload(downloadKey, options.onProgress, async (signal, publish) => {
      const existingLocal = this.index.systems[localId]
      if (existingLocal && this.isSystemFilesValid(existingLocal)) {
        if (existingLocal.removedFromPicker) {
          this.persistIndex({
            ...this.index,
            systems: { ...this.index.systems, [localId]: { ...existingLocal, removedFromPicker: false } }
          })
          return { success: true, system: this.index.systems[localId], reusedExisting: true }
        }
        return { success: true, system: existingLocal, reusedExisting: true }
      }

      let tempFile: string | undefined
      let stagingDir: string | undefined
      try {
        const downloaded = await this.streamToVerifiedFile({
          downloadKey,
          kind: "system",
          assetId: options.systemId,
          versionId: targetVer.versionId,
          maxBytes: DESIGN_MARKET_SYSTEM_MAX_BYTES,
          expectedBytes: targetVer.bytes,
          expectedSha256: targetVer.sha256,
          transport: options.transport,
          actor: options.actor,
          signal: signal,
          onProgress: publish
        })
        tempFile = downloaded.tempFile
        const staged = this.stageSystemFromFile(
          tempFile,
          detail,
          targetVer.versionId,
          downloaded.sha256,
          downloaded.bytes
        )
        stagingDir = staged.stagingDir
        publish({
          downloadKey,
          kind: "system",
          assetId: options.systemId,
          versionId: targetVer.versionId,
          phase: "committing",
          receivedBytes: downloaded.bytes,
          totalBytes: downloaded.bytes,
          message: "正在写入本地设计系统库…"
        })
        signal.throwIfAborted()
        const current = this.index.systems[localId]
        const reusable = current && this.isSystemFilesValid(current)
        const entry = reusable ? { ...current, removedFromPicker: false } : staged.entry
        this.persistIndex(
          { ...this.index, systems: { ...this.index.systems, [localId]: entry } },
          reusable ? [] : [staged]
        )
        publish({
          downloadKey,
          kind: "system",
          assetId: options.systemId,
          versionId: targetVer.versionId,
          phase: "done",
          receivedBytes: downloaded.bytes,
          totalBytes: downloaded.bytes,
          message: "设计系统下载完成"
        })
        return { success: true, system: entry }
      } catch (error) {
        const canceled = signal.aborted
        const msg = error instanceof Error ? error.message : "下载失败"
        publish({
          downloadKey,
          kind: "system",
          assetId: options.systemId,
          versionId: targetVer.versionId,
          phase: canceled ? "canceled" : "error",
          receivedBytes: 0,
          totalBytes: targetVer.bytes,
          message: canceled ? "已取消下载" : msg,
          error: canceled ? undefined : msg
        })
        return { success: false, canceled, error: canceled ? undefined : msg }
      } finally {
        if (tempFile) fs.rmSync(tempFile, { force: true })
        if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true })
      }
    })
  }

  async downloadTemplateVersion(options: {
    transport: DesignMarketBackendTransport
    actor: DesignMarketActor | null
    templateId: string
    versionId?: string
    selectedLocalSystemId?: string | null
    onProgress?: (event: DesignMarketDownloadProgress) => void
  }): Promise<DesignMarketDownloadResult> {
    const plan = await this.planDownload(
      options.transport,
      options.actor,
      "template",
      options.templateId,
      options.versionId,
      options.selectedLocalSystemId
    )
    if (!plan.compatible) {
      return { success: false, error: plan.missingReason || "缺少适配的设计系统版本" }
    }

    const tplDetail = await options.transport.getTemplateDetail(options.templateId, options.actor)
    const targetTpl = tplDetail.versions.find((v) => v.versionId === plan.versionId)
    if (!targetTpl) {
      return { success: false, error: "找不到对应的模板版本" }
    }

    const downloadKey = `template:${options.templateId}:${plan.versionId}`
    const tplLocalId = makeMarketTemplateLocalId(options.templateId, plan.versionId)
    return this.startDownload(downloadKey, options.onProgress, async (signal, publish) => {
      const existingLocalTpl = this.index.templates[tplLocalId]
      if (existingLocalTpl && this.isTemplateFilesValid(existingLocalTpl) && !plan.willDownloadSystem) {
        if (existingLocalTpl.removedFromPicker) {
          this.persistIndex({
            ...this.index,
            templates: { ...this.index.templates, [tplLocalId]: { ...existingLocalTpl, removedFromPicker: false } }
          })
          return { success: true, template: this.index.templates[tplLocalId], reusedExisting: true }
        }
        return { success: true, template: existingLocalTpl, reusedExisting: true }
      }

      let tplTempFile: string | undefined
      let sysTempFile: string | undefined
      let tplStageDir: string | undefined
      let sysStageDir: string | undefined
      try {
        const tplDownloaded = await this.streamToVerifiedFile({
          downloadKey,
          kind: "template",
          assetId: options.templateId,
          versionId: plan.versionId,
          maxBytes: DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES,
          expectedBytes: targetTpl.bytes,
          expectedSha256: targetTpl.sha256,
          transport: options.transport,
          actor: options.actor,
          signal: signal,
          onProgress: publish
        })
        tplTempFile = tplDownloaded.tempFile
        const stagedTpl = this.stageTemplateFromZipFile(
          tplTempFile,
          tplDetail,
          plan.versionId,
          tplDownloaded.sha256
        )
        tplStageDir = stagedTpl.stagingDir

        let stagedSys: { stagingDir: string; finalDir: string; entry: LocalMarketSystemEntry } | undefined
        if (plan.willDownloadSystem && plan.systemToDownload) {
          const sysDetail = await options.transport.getSystemDetail(
            plan.systemToDownload.systemId,
            options.actor
          )
          const sysVersion = sysDetail.versions.find((v) => v.versionId === plan.systemToDownload?.versionId)
          if (!sysVersion) throw new Error("找不到所需的设计系统版本")
          const sysDownloaded = await this.streamToVerifiedFile({
            downloadKey,
            kind: "system",
            assetId: plan.systemToDownload.systemId,
            versionId: plan.systemToDownload.versionId,
            maxBytes: DESIGN_MARKET_SYSTEM_MAX_BYTES,
            expectedBytes: sysVersion.bytes,
            expectedSha256: sysVersion.sha256,
            transport: options.transport,
            actor: options.actor,
            signal: signal,
            onProgress: publish
          })
          sysTempFile = sysDownloaded.tempFile
          stagedSys = this.stageSystemFromFile(
            sysTempFile,
            sysDetail,
            plan.systemToDownload.versionId,
            sysDownloaded.sha256,
            sysDownloaded.bytes
          )
          sysStageDir = stagedSys.stagingDir
        }

        if (signal.aborted) {
          throw signal.reason || new Error("下载已取消")
        }

        publish({
          downloadKey,
          kind: "template",
          assetId: options.templateId,
          versionId: plan.versionId,
          phase: "committing",
          receivedBytes: tplDownloaded.bytes,
          totalBytes: tplDownloaded.bytes,
          message: "正在校验并提交到本地模板库…"
        })

        signal.throwIfAborted()
        const next = {
          ...this.index,
          systems: { ...this.index.systems },
          templates: { ...this.index.templates }
        }
        const installs: StagedMarketInstall[] = []
        let alsoDownloadedSystem: LocalMarketSystemEntry | undefined
        if (stagedSys) {
          const current = next.systems[stagedSys.entry.localId]
          if (current && this.isSystemFilesValid(current)) {
            next.systems[current.localId] = { ...current, removedFromPicker: false }
          } else {
            installs.push(stagedSys)
            next.systems[stagedSys.entry.localId] = stagedSys.entry
            alsoDownloadedSystem = stagedSys.entry
          }
        } else if (!this.compatibleSystemForTemplate(stagedTpl.entry)) {
          throw new Error("下载期间适配的设计系统已被移除，请重新下载")
        }
        const currentTemplate = next.templates[tplLocalId]
        if (currentTemplate && this.isTemplateFilesValid(currentTemplate)) {
          next.templates[tplLocalId] = { ...currentTemplate, removedFromPicker: false }
        } else {
          installs.push(stagedTpl)
          next.templates[tplLocalId] = stagedTpl.entry
        }
        this.persistIndex(next, installs)

        publish({
          downloadKey,
          kind: "template",
          assetId: options.templateId,
          versionId: plan.versionId,
          phase: "done",
          receivedBytes: tplDownloaded.bytes,
          totalBytes: tplDownloaded.bytes,
          message: "下载并导入完成"
        })
        return {
          success: true,
          template: next.templates[tplLocalId],
          alsoDownloadedSystem
        }
      } catch (error) {
        const canceled = signal.aborted
        const msg = error instanceof Error ? error.message : "下载失败"
        publish({
          downloadKey,
          kind: "template",
          assetId: options.templateId,
          versionId: plan.versionId,
          phase: canceled ? "canceled" : "error",
          receivedBytes: 0,
          totalBytes: targetTpl.bytes,
          message: canceled ? "已取消下载" : msg,
          error: canceled ? undefined : msg
        })
        return { success: false, canceled, error: canceled ? undefined : msg }
      } finally {
        if (tplTempFile) fs.rmSync(tplTempFile, { force: true })
        if (sysTempFile) fs.rmSync(sysTempFile, { force: true })
        if (tplStageDir) fs.rmSync(tplStageDir, { recursive: true, force: true })
        if (sysStageDir) fs.rmSync(sysStageDir, { recursive: true, force: true })
      }
    })
  }

  countAffectedTemplatesForSystemRemoval(localSystemId: string): number {
    const target = this.index.systems[localSystemId]
    if (!target || target.removedFromPicker) return 0
    const remainingActive = this.activeSystemsForMarketId(target.systemId).filter(
      (sys) => sys.localId !== localSystemId
    )
    let affected = 0
    for (const tpl of Object.values(this.index.templates)) {
      if (tpl.removedFromPicker || tpl.systemId !== target.systemId) continue
      const currentlyCompat = this.compatibleSystemForTemplate(tpl) !== null
      const wouldBeCompat =
        pickLatestCompatibleVersion(remainingActive, (s) => s.version, tpl.minSystemVersion) !== null
      if (currentlyCompat && !wouldBeCompat) affected += 1
    }
    return affected
  }

  removeSystemFromPicker(localSystemId: string): LocalMarketAssetsState {
    const target = this.index.systems[localSystemId]
    if (target) {
      target.removedFromPicker = true
      this.persistIndex()
    }
    return this.getLocalState()
  }

  restoreSystemToPicker(localSystemId: string): LocalMarketAssetsState {
    const target = this.index.systems[localSystemId]
    if (target && this.isSystemFilesValid(target)) {
      target.removedFromPicker = false
      this.persistIndex()
    }
    return this.getLocalState()
  }

  removeTemplateFromPicker(localTemplateId: string): LocalMarketAssetsState {
    const target = this.index.templates[localTemplateId]
    if (target) {
      target.removedFromPicker = true
      this.persistIndex()
    }
    return this.getLocalState()
  }

  restoreTemplateToPicker(localTemplateId: string): LocalMarketAssetsState {
    const target = this.index.templates[localTemplateId]
    if (target && this.isTemplateFilesValid(target)) {
      target.removedFromPicker = false
      this.persistIndex()
    }
    return this.getLocalState()
  }

  copySystemToLocalLibrary(localSystemId: string, library: DesignSystemLibrary): DesignSystemInfo {
    const entry = this.index.systems[localSystemId]
    if (!entry || !this.isSystemFilesValid(entry)) {
      throw new Error("找不到本地已下载的设计系统文件")
    }
    const content = fs.readFileSync(entry.markdownPath, "utf8")
    return library.save({
      name: `${entry.name} · 本地副本`.slice(0, 80),
      content,
      source: "market-copy"
    })
  }

  copyTemplateToLocalPackages(
    localTemplateId: string,
    packages: DesignTemplatePackages
  ): DesignTemplatePackage {
    const entry = this.index.templates[localTemplateId]
    if (!entry || !this.isTemplateFilesValid(entry)) {
      throw new Error("找不到本地已下载的模板包")
    }
    const hasCompatibleSystem = this.compatibleSystemForTemplate(entry) !== null
    return packages.importLocalCopy(entry.rootDir, {
      name: `${entry.name} · 本地副本`,
      entryPath: entry.defaultEntryPath,
      designSystemKey: hasCompatibleSystem ? `market:${entry.systemId}` : null
    })
  }

  getTemplateEntryByLocalId(localTemplateId: string): LocalMarketTemplateEntry | null {
    const entry = this.index.templates[localTemplateId]
    if (!entry || !this.isTemplateFilesValid(entry)) return null
    return entry
  }
}
