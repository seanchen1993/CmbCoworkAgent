import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { DesignArtifactPackageRef } from "../../../shared/design-package"
import { rankTemplateEntryPages } from "./template-packages"
import {
  DEFAULT_PACKAGE_SIZE_LIMITS,
  MAX_PACKAGE_HTML_BYTES,
  extractZipStreaming,
  normalizePackageRelativePath,
  visitZipStreaming
} from "./streaming-zip"
import {
  auditPackageDependencies,
  copySingleHtmlWithDependencies
} from "./package-dependencies"
import {
  DESIGN_PROTOTYPE_ZIP_MAX_BYTES,
  DESIGN_PROTOTYPE_ZIP_MAX_ENTRY_BYTES,
  DESIGN_PROTOTYPE_ZIP_MAX_IMAGES,
  DESIGN_PROTOTYPE_ZIP_MAX_JSON_BYTES,
  DESIGN_PROTOTYPE_ZIP_MAX_JSON_FILES,
  DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_IMAGE_BYTES,
  DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_JSON_BYTES,
  buildPrototypeHtml,
  extractPrototypeMetadataScreens,
  getDesignPrototypeMimeType,
  isDesignPrototypeImagePath,
  metadataMatchesImage,
  naturalPrototypeSort,
  prototypeBaseName,
  readPrototypeImageDimensions,
  resolvePrototypeHotspotTarget,
  type PrototypeImageScreen,
  type PrototypeMetadataScreen
} from "./pixso-prototype"

export const DESIGN_ARTIFACTS_DIR = ".cmb-design"
const STAGING_TTL_MS = 10 * 60_000
const STALE_STAGING_MS = 60 * 60_000

export function makeSafeDesignPackageId(value: string): string {
  const safe = String(value || "tab")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
  return (safe || "tab").slice(0, 120)
}

function insideDirectory(rootDir: string, targetPath: string): boolean {
  const rootNorm = path.resolve(rootDir).toLowerCase()
  const targetNorm = path.resolve(targetPath).toLowerCase()
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep)
}

function sameDirectory(left: string, right: string): boolean {
  if (path.relative(fs.realpathSync.native(left), fs.realpathSync.native(right)) === "") return true
  const a = fs.statSync(left, { bigint: true })
  const b = fs.statSync(right, { bigint: true })
  return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev
}

function assertRealDirInsideWorkspace(workspaceRoot: string, dirPath: string): void {
  const realWorkspace = fs.realpathSync(workspaceRoot)
  if (fs.existsSync(dirPath)) {
    const stat = fs.lstatSync(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`设计目录不可为符号链接或文件：${dirPath}`)
    }
    const realDir = fs.realpathSync(dirPath)
    const rel = path.relative(realWorkspace, realDir)
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`设计目录越界：${dirPath}`)
    }
  }
}

export function isValidPackageVersion(version: string | undefined | null): version is string {
  return typeof version === "string" && /^pkg_[a-zA-Z0-9_-]{4,80}$/.test(version)
}

export interface DesignArtifactLayout {
  workspaceRoot: string
  artifactsRoot: string
  artifactDir: string
  metadataPath: string
  versionsDir: string
  draftDir: string
  packageRoot: string
  entryRelativePath: string
  entryFilePath: string
  isPackage: boolean
  packageRef: DesignArtifactPackageRef | null
}

function readPackageRefFromMetadataFile(metadataPath: string): DesignArtifactPackageRef | null {
  try {
    if (!fs.existsSync(metadataPath) || !fs.statSync(metadataPath).isFile()) return null
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      artifactPackage?: DesignArtifactPackageRef | null
    }
    const pkg = parsed?.artifactPackage
    if (pkg && isValidPackageVersion(pkg.version) && typeof pkg.entryPath === "string") {
      return {
        version: pkg.version,
        entryPath: normalizePackageRelativePath(pkg.entryPath),
        assetCount: Number.isFinite(pkg.assetCount) ? Math.max(0, Number(pkg.assetCount)) : 0,
        sourceKind: pkg.sourceKind ?? "zip"
      }
    }
  } catch {
    // Ignore unreadable metadata.
  }
  return null
}

export function resolveDesignArtifactLayout(input: {
  sessionId: string
  workspacePath?: string | null
  artifactPath?: string | null
  artifactPackage?: DesignArtifactPackageRef | null
  fallbackRootDir: string
}): DesignArtifactLayout {
  const workspace =
    typeof input.workspacePath === "string" && input.workspacePath.trim()
      ? input.workspacePath.trim()
      : input.fallbackRootDir
  const workspaceRoot = path.resolve(workspace)
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Design workspace is not available: ${workspaceRoot}`)
  }

  const artifactsRoot = path.resolve(workspaceRoot, DESIGN_ARTIFACTS_DIR)
  const safeDirName = makeSafeDesignPackageId(
    input.sessionId.endsWith("_design-main") ? input.sessionId : `${input.sessionId}_design-main`
  )
  const artifactDir = path.resolve(artifactsRoot, safeDirName)
  if (!insideDirectory(artifactsRoot, artifactDir)) {
    throw new Error(`Design artifact path escaped workspace: ${artifactDir}`)
  }
  assertRealDirInsideWorkspace(workspaceRoot, artifactsRoot)
  assertRealDirInsideWorkspace(workspaceRoot, artifactDir)

  const v2MetaPath = path.join(artifactDir, "artifact.json")
  const explicitPkg = input.artifactPackage
  const pkg =
    explicitPkg && isValidPackageVersion(explicitPkg.version)
      ? {
          ...explicitPkg,
          entryPath: normalizePackageRelativePath(explicitPkg.entryPath)
        }
      : readPackageRefFromMetadataFile(v2MetaPath)

  if (pkg) {
    const versionDir = path.resolve(artifactDir, "packages", pkg.version)
    const packageRoot = path.resolve(versionDir, "files")
    const entryFilePath = path.resolve(packageRoot, pkg.entryPath)
    if (!insideDirectory(packageRoot, entryFilePath)) {
      throw new Error(`设计入口路径越界：${pkg.entryPath}`)
    }
    return {
      workspaceRoot,
      artifactsRoot,
      artifactDir,
      metadataPath: v2MetaPath,
      versionsDir: path.join(artifactDir, "versions"),
      draftDir: path.join(artifactDir, "drafts"),
      packageRoot,
      entryRelativePath: pkg.entryPath,
      entryFilePath,
      isPackage: true,
      packageRef: pkg
    }
  }

  // Legacy v1 flat layout
  const defaultEntry = path.resolve(artifactDir, "index.html")
  let entryFilePath = defaultEntry
  if (typeof input.artifactPath === "string" && input.artifactPath.trim()) {
    const candidate = path.resolve(input.artifactPath.trim())
    if (insideDirectory(artifactsRoot, candidate)) {
      entryFilePath = candidate
    }
  }
  const flatRoot = path.dirname(entryFilePath)
  return {
    workspaceRoot,
    artifactsRoot,
    artifactDir,
    metadataPath: path.join(flatRoot, "artifact.json"),
    versionsDir: path.join(flatRoot, "versions"),
    draftDir: flatRoot,
    packageRoot: flatRoot,
    entryRelativePath: path.basename(entryFilePath),
    entryFilePath,
    isPackage: false,
    packageRef: null
  }
}

export function listPackageFilesRelative(filesRoot: string, maxItems = 5000): string[] {
  if (!fs.existsSync(filesRoot) || !fs.statSync(filesRoot).isDirectory()) return []
  const result: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".draft-") ||
        entry.name.startsWith(".source-") ||
        entry.name.startsWith(".direct-") ||
        entry.name.startsWith(".patch-") ||
        entry.name.includes(".projection-")
      ) {
        continue
      }
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        result.push(path.relative(filesRoot, full).replace(/\\/g, "/"))
        if (result.length >= maxItems) return
      }
    }
  }
  walk(filesRoot)
  result.sort()
  return result
}

export function countPackageAssets(filesRoot: string, entryRelativePath: string): number {
  const files = listPackageFilesRelative(filesRoot)
  const normalizedEntry = normalizePackageRelativePath(entryRelativePath)
  return files.filter((item) => item !== normalizedEntry).length
}

function isTransientOrHostCleanupError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  return ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)
}

export async function removeDirectoryWithRetry(dirPath: string): Promise<void> {
  await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
}

async function moveDirectorySafe(sourceDir: string, targetDir: string): Promise<void> {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  try {
    await fsp.rename(sourceDir, targetDir)
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EXDEV" && !isTransientOrHostCleanupError(error)) throw error
    await fsp.cp(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true })
    await removeDirectoryWithRetry(sourceDir).catch(() => undefined)
  }
}

interface StagedPackageImport {
  stageId: string
  ownerId: number
  sourceKind: "html" | "zip"
  label: string
  detail: string
  stageDir: string
  filesDir: string
  workspaceRoot: string
  pages: string[]
  defaultEntryPath: string
  files: string[]
  totalBytes: number
  missingAssets: string[]
  outOfScopeAssets: string[]
  warnings: string[]
  timer: ReturnType<typeof setTimeout>
}

export interface StagedCommitResult {
  packageRef: DesignArtifactPackageRef
  packageRoot: string
  entryFilePath: string
  html: string
  missingAssets: string[]
  outOfScopeAssets: string[]
  warnings: string[]
  rollback: () => Promise<void>
}

export interface PixsoPackageCommitResult {
  packageRef: DesignArtifactPackageRef
  packageRoot: string
  entryFilePath: string
  html: string
  title: string
  imageCount: number
  metadataCount: number
  rollback: () => Promise<void>
}

export interface DesignPackageServiceOptions {
  isPackageInUse?: (packageRoot: string) => boolean
  isExportInUse?: (dirPath: string) => boolean
}

export class DesignPackageService {
  private readonly staged = new Map<string, StagedPackageImport>()
  private readonly retiredVersionDirs = new Map<string, string>() // filesDir -> versionDir
  private readonly sessionFileOperations = new Map<string, "import" | "migration">()

  constructor(private readonly options: DesignPackageServiceOptions = {}) {}

  assertSessionAvailable(id: string): void {
    const operation = this.sessionFileOperations.get(id)
    if (operation === "migration") throw new Error("该设计正在迁移工作区，请稍候")
    if (operation === "import") throw new Error("该设计正在导入，请稍候")
  }

  isMigrating(id: string): boolean {
    return this.sessionFileOperations.get(id) === "migration"
  }

  lockSession(id: string, operation: "import" | "migration"): () => void {
    this.assertSessionAvailable(id)
    this.sessionFileOperations.set(id, operation)
    return () => { this.sessionFileOperations.delete(id) }
  }

  private ensureArtifactsRoot(workspacePath: string): { workspaceRoot: string; artifactsRoot: string } {
    const workspaceRoot = path.resolve(workspacePath)
    if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
      throw new Error(`工作目录不可用：${workspaceRoot}`)
    }
    const canonicalWorkspace = fs.realpathSync(workspaceRoot)
    const artifactsRoot = path.join(workspaceRoot, DESIGN_ARTIFACTS_DIR)
    fs.mkdirSync(artifactsRoot, { recursive: true })
    if (fs.lstatSync(artifactsRoot).isSymbolicLink()) {
      throw new Error("设计产物目录不可为符号链接")
    }
    if (fs.realpathSync(artifactsRoot) !== path.join(canonicalWorkspace, DESIGN_ARTIFACTS_DIR)) {
      throw new Error("设计产物目录越界")
    }
    return { workspaceRoot, artifactsRoot }
  }

  sweepStaleStagingDirs(workspacePath: string): void {
    try {
      const { artifactsRoot } = this.ensureArtifactsRoot(workspacePath)
      const now = Date.now()
      for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(".import-staging-") && !entry.name.startsWith(".migrate-")) continue
        const full = path.join(artifactsRoot, entry.name)
        const stat = fs.statSync(full)
        if (now - stat.mtimeMs > STALE_STAGING_MS) {
          void removeDirectoryWithRetry(full).catch(() => undefined)
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  async stageImport(
    ownerId: number,
    sourcePath: string,
    workspacePath: string
  ): Promise<{
    stageId: string
    sourceKind: "html" | "zip"
    label: string
    detail: string
    pages: string[]
    defaultEntryPath: string
    fileCount: number
    totalBytes: number
    missingAssets: string[]
    outOfScopeAssets: string[]
    warnings: string[]
  }> {
    this.sweepStaleStagingDirs(workspacePath)
    const resolvedSource = path.resolve(sourcePath)
    const stat = fs.lstatSync(resolvedSource)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("请选择实际的 HTML 或 ZIP 文件")
    }
    const isZip = /\.zip$/i.test(resolvedSource)
    const isHtml = /\.html?$/i.test(resolvedSource)
    if (!isZip && !isHtml) {
      throw new Error("请选择 .html、.htm 或 .zip 文件")
    }

    const { workspaceRoot, artifactsRoot } = this.ensureArtifactsRoot(workspacePath)
    const stageId = `stg_${randomUUID().replace(/-/g, "")}`
    const stageDir = path.join(artifactsRoot, `.import-staging-${stageId}`)
    const filesDir = path.join(stageDir, "files")
    fs.mkdirSync(filesDir, { recursive: true })

    try {
      let files: string[]
      let totalBytes: number
      let missingAssets: string[] = []
      let outOfScopeAssets: string[] = []

      if (isZip) {
        const extracted = await extractZipStreaming(resolvedSource, filesDir)
        files = extracted.files
        totalBytes = extracted.totalBytes
      } else {
        const copied = copySingleHtmlWithDependencies(resolvedSource, filesDir)
        files = copied.files
        totalBytes = copied.totalBytes
        missingAssets = copied.missingAssets
        outOfScopeAssets = copied.outOfScopeAssets
      }

      const pages = rankTemplateEntryPages(files)
      if (!pages.length) {
        throw new Error("压缩包或文件中未找到 HTML 入口页面")
      }

      const defaultEntryPath = isHtml ? path.basename(resolvedSource) : pages[0]
      const audit = auditPackageDependencies(filesDir, defaultEntryPath, files)
      const mergedMissing = Array.from(new Set([...missingAssets, ...audit.missingAssets]))
      const mergedOutOfScope = Array.from(new Set([...outOfScopeAssets, ...audit.outOfScopeAssets]))
      const warnings = Array.from(
        new Set([
          ...audit.warnings,
          ...(isHtml && mergedOutOfScope.length
            ? ["单选 HTML 无法读取上级目录或根路径资源，请使用 ZIP 导入。"]
            : [])
        ])
      )
      const label = path.basename(resolvedSource) || "HTML 页面"

      const timer = setTimeout(() => {
        void this.cancelStage(ownerId, stageId)
      }, STAGING_TTL_MS)
      timer.unref()

      this.staged.set(stageId, {
        stageId,
        ownerId,
        sourceKind: isZip ? "zip" : "html",
        label,
        detail: resolvedSource,
        stageDir,
        filesDir,
        workspaceRoot,
        pages,
        defaultEntryPath,
        files,
        totalBytes,
        missingAssets: mergedMissing,
        outOfScopeAssets: mergedOutOfScope,
        warnings,
        timer
      })

      return {
        stageId,
        sourceKind: isZip ? "zip" : "html",
        label,
        detail: resolvedSource,
        pages,
        defaultEntryPath,
        fileCount: files.length,
        totalBytes,
        missingAssets: mergedMissing,
        outOfScopeAssets: mergedOutOfScope,
        warnings
      }
    } catch (error) {
      await removeDirectoryWithRetry(stageDir).catch(() => undefined)
      throw error
    }
  }

  async cancelStage(ownerId: number, stageId: string): Promise<boolean> {
    const item = this.staged.get(stageId)
    if (!item || item.ownerId !== ownerId) return false
    clearTimeout(item.timer)
    this.staged.delete(stageId)
    await removeDirectoryWithRetry(item.stageDir).catch(() => undefined)
    return true
  }

  async cancelOwner(ownerId: number): Promise<void> {
    const ids = [...this.staged.values()]
      .filter((item) => item.ownerId === ownerId)
      .map((item) => item.stageId)
    await Promise.all(ids.map((id) => this.cancelStage(ownerId, id)))
  }

  async commitStage(
    ownerId: number,
    input: {
      stageId: string
      entryPath: string
      sessionId: string
      workspacePath: string
    }
  ): Promise<StagedCommitResult> {
    const stage = this.staged.get(input.stageId)
    if (!stage || stage.ownerId !== ownerId) {
      throw new Error("导入任务已过期或不存在，请重新选择文件")
    }
    const normalizedEntry = normalizePackageRelativePath(input.entryPath)
    if (!stage.pages.includes(normalizedEntry)) {
      throw new Error(`选择的入口页面不存在于当前包中：${input.entryPath}`)
    }

    const entryInStage = path.join(stage.filesDir, normalizedEntry)
    const entryStat = fs.lstatSync(entryInStage)
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      throw new Error("入口 HTML 文件无效")
    }
    if (entryStat.size > MAX_PACKAGE_HTML_BYTES) {
      throw new Error("入口 HTML 超过 5 MB 限制")
    }
    const html = fs.readFileSync(entryInStage, "utf8")
    if (!html.trim()) {
      throw new Error("入口 HTML 内容为空")
    }

    clearTimeout(stage.timer)
    this.staged.delete(stage.stageId)

    const { artifactsRoot } = this.ensureArtifactsRoot(input.workspacePath)
    const safeSessionDir = makeSafeDesignPackageId(`${input.sessionId}_design-main`)
    const artifactDir = path.join(artifactsRoot, safeSessionDir)
    const version = `pkg_${randomUUID().replace(/-/g, "").slice(0, 16)}`
    const versionDir = path.join(artifactDir, "packages", version)
    const installedFilesDir = path.join(versionDir, "files")
    const entryFilePath = path.join(installedFilesDir, normalizedEntry)

    await moveDirectorySafe(stage.stageDir, versionDir)

    const audit = auditPackageDependencies(installedFilesDir, normalizedEntry, stage.files)
    const missingAssets = Array.from(
      new Set([...(normalizedEntry === stage.defaultEntryPath ? stage.missingAssets : []), ...audit.missingAssets])
    )
    const outOfScopeAssets = Array.from(
      new Set([
        ...(normalizedEntry === stage.defaultEntryPath ? stage.outOfScopeAssets : []),
        ...audit.outOfScopeAssets
      ])
    )
    const warnings = Array.from(
      new Set([
        ...audit.warnings,
        ...(stage.sourceKind === "html" && outOfScopeAssets.length
          ? ["单选 HTML 无法读取上级目录或根路径资源，请使用 ZIP 导入。"]
          : [])
      ])
    )

    const assetCount = stage.files.filter((file) => file !== normalizedEntry).length
    return {
      packageRef: {
        version,
        entryPath: normalizedEntry,
        assetCount,
        sourceKind: stage.sourceKind
      },
      packageRoot: installedFilesDir,
      entryFilePath,
      html,
      missingAssets,
      outOfScopeAssets,
      warnings,
      rollback: async () => {
        await removeDirectoryWithRetry(versionDir).catch(() => undefined)
      }
    }
  }

  async stageAndBuildPixsoPackage(
    zipPath: string,
    sessionId: string,
    workspacePath: string
  ): Promise<PixsoPackageCommitResult> {
    const resolvedZip = path.resolve(zipPath)
    const stat = fs.lstatSync(resolvedZip)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`压缩包不存在：${resolvedZip}`)
    }
    if (stat.size > DESIGN_PROTOTYPE_ZIP_MAX_BYTES) {
      throw new Error("压缩包超过 120 MB 限制")
    }
    if (!/\.zip$/i.test(resolvedZip)) {
      throw new Error("目前仅支持 .zip 压缩包")
    }

    const { artifactsRoot } = this.ensureArtifactsRoot(workspacePath)
    const stageDir = path.join(artifactsRoot, `.import-staging-pixso-${randomUUID()}`)
    const filesDir = path.join(stageDir, "files")
    const screensDir = path.join(filesDir, "screens")
    fs.mkdirSync(screensDir, { recursive: true })

    try {
      const metadataScreens: PrototypeMetadataScreen[] = []
      let metadataCount = 0
      let metadataFileCount = 0
      let metadataBytes = 0
      let totalImageBytes = 0
      const pendingImages: Array<{
        zipPath: string
        fileName: string
        diskPath: string
        size: number
        mimeType: string
        dimensions: { width?: number; height?: number }
      }> = []

      await visitZipStreaming(resolvedZip, DEFAULT_PACKAGE_SIZE_LIMITS, async (entry) => {
        if (entry.isDirectory) return
        if (/\.json$/i.test(entry.relativePath)) {
          if (
            entry.headerSize > DESIGN_PROTOTYPE_ZIP_MAX_JSON_BYTES ||
            metadataFileCount >= DESIGN_PROTOTYPE_ZIP_MAX_JSON_FILES ||
            metadataBytes + entry.headerSize > DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_JSON_BYTES
          ) {
            return
          }
          metadataFileCount++
          const chunks: Buffer[] = []
          let size = 0
          const stream = await entry.openStream()
          for await (const raw of stream) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
            size += chunk.length
            if (
              size > DESIGN_PROTOTYPE_ZIP_MAX_JSON_BYTES ||
              metadataBytes + size > DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_JSON_BYTES
            ) {
              return
            }
            chunks.push(chunk)
          }
          metadataBytes += size
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
            metadataScreens.push(...extractPrototypeMetadataScreens(parsed))
            metadataCount++
          } catch {
            // Ignore non-prototype JSON files.
          }
          return
        }

        if (!isDesignPrototypeImagePath(entry.relativePath)) return
        if (pendingImages.length >= DESIGN_PROTOTYPE_ZIP_MAX_IMAGES) return
        if (entry.headerSize > DESIGN_PROTOTYPE_ZIP_MAX_ENTRY_BYTES) return

        const ext = path.extname(entry.relativePath).toLowerCase() || ".png"
        const fileName = `screen-${String(pendingImages.length + 1).padStart(3, "0")}${ext}`
        const diskPath = path.join(screensDir, fileName)
        const stream = await entry.openStream()
        const out = fs.createWriteStream(diskPath, { flags: "w" })
        let entrySize = 0
        const headerChunks: Buffer[] = []
        let headerBytes = 0

        await new Promise<void>((resolve, reject) => {
          let done = false
          const abort = (err?: unknown) => {
            if (done) return
            done = true
            const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void }
            destroyable.destroy?.()
            out.destroy()
            if (err) reject(err instanceof Error ? err : new Error(String(err)))
            else resolve()
          }
          stream.on("error", abort)
          out.on("error", abort)
          out.on("finish", () => {
            if (!done) {
              done = true
              resolve()
            }
          })
          stream.on("data", (raw: Buffer) => {
            entrySize += raw.length
            totalImageBytes += raw.length
            if (
              entrySize > DESIGN_PROTOTYPE_ZIP_MAX_ENTRY_BYTES ||
              totalImageBytes > DESIGN_PROTOTYPE_ZIP_MAX_TOTAL_IMAGE_BYTES
            ) {
              totalImageBytes -= entrySize
              abort(new Error("SKIP_OVER_LIMIT"))
              return
            }
            if (headerBytes < 65536) {
              headerChunks.push(raw.subarray(0, 65536 - headerBytes))
              headerBytes += raw.length
            }
            if (!out.write(raw)) {
              stream.pause()
              out.once("drain", () => {
                if (!done) stream.resume()
              })
            }
          })
          stream.on("end", () => {
            if (!done) out.end()
          })
        }).catch((err) => {
          if (err instanceof Error && err.message === "SKIP_OVER_LIMIT") {
            fs.rmSync(diskPath, { force: true })
            return
          }
          throw err
        })

        if (!fs.existsSync(diskPath)) return
        const mimeType = getDesignPrototypeMimeType(entry.relativePath)
        const dimensions = readPrototypeImageDimensions(Buffer.concat(headerChunks), mimeType)
        pendingImages.push({
          zipPath: entry.relativePath,
          fileName,
          diskPath,
          size: entrySize,
          mimeType,
          dimensions
        })
      })

      if (pendingImages.length === 0) {
        throw new Error("压缩包内没有可识别的原型图片（png/jpg/webp/gif/svg 等）")
      }

      pendingImages.sort((left, right) => naturalPrototypeSort(left.zipPath, right.zipPath))

      const screens: PrototypeImageScreen[] = pendingImages.map((item, idx) => {
        const metadata = metadataScreens.find((meta) => metadataMatchesImage(meta, item.zipPath))
        return {
          id: `screen-${idx + 1}`,
          metadataIds: metadata?.ids ?? [],
          name: metadata?.name || prototypeBaseName(item.zipPath) || `画板 ${idx + 1}`,
          zipPath: item.zipPath,
          mimeType: item.mimeType,
          imageSrc: `./screens/${item.fileName}`,
          size: item.size,
          width: metadata?.width || item.dimensions.width,
          height: metadata?.height || item.dimensions.height,
          hotspots: metadata?.hotspots ?? []
        }
      })

      for (const screen of screens) {
        screen.hotspots = screen.hotspots.map((hotspot) => ({
          ...hotspot,
          targetIndex: resolvePrototypeHotspotTarget(hotspot, screens, metadataScreens)
        }))
      }

      const title = path.basename(resolvedZip, path.extname(resolvedZip)) || "Pixso 原型"
      const html = buildPrototypeHtml(title, screens, metadataCount, path.basename(resolvedZip))
      fs.writeFileSync(path.join(filesDir, "index.html"), html, "utf8")

      const safeSessionDir = makeSafeDesignPackageId(`${sessionId}_design-main`)
      const artifactDir = path.join(artifactsRoot, safeSessionDir)
      const version = `pkg_${randomUUID().replace(/-/g, "").slice(0, 16)}`
      const versionDir = path.join(artifactDir, "packages", version)
      const installedFilesDir = path.join(versionDir, "files")
      await moveDirectorySafe(stageDir, versionDir)

      return {
        packageRef: {
          version,
          entryPath: "index.html",
          assetCount: screens.length,
          sourceKind: "prototype_zip"
        },
        packageRoot: installedFilesDir,
        entryFilePath: path.join(installedFilesDir, "index.html"),
        html,
        title,
        imageCount: screens.length,
        metadataCount,
        rollback: async () => {
          await removeDirectoryWithRetry(versionDir).catch(() => undefined)
        }
      }
    } catch (error) {
      await removeDirectoryWithRetry(stageDir).catch(() => undefined)
      throw error
    }
  }

  retirePackageRoot(filesRoot: string): void {
    const resolvedFiles = path.resolve(filesRoot)
    const versionDir = path.dirname(resolvedFiles)
    if (!isValidPackageVersion(path.basename(versionDir))) return
    this.retiredVersionDirs.set(resolvedFiles, versionDir)
    this.tryCleanupRetired(resolvedFiles)
  }

  async tryCleanupRetired(filesRoot?: string): Promise<void> {
    const targets = filesRoot
      ? [[path.resolve(filesRoot), this.retiredVersionDirs.get(path.resolve(filesRoot))] as const]
      : [...this.retiredVersionDirs.entries()]
    const cleanups: Array<Promise<void>> = []
    for (const [resolvedFiles, versionDir] of targets) {
      if (!versionDir) continue
      if (this.options.isPackageInUse?.(resolvedFiles)) continue
      this.retiredVersionDirs.delete(resolvedFiles)
      cleanups.push(removeDirectoryWithRetry(versionDir).catch(() => undefined))
    }
    if (cleanups.length > 0) {
      await Promise.all(cleanups)
    }
  }

  async migrateSessionArtifacts(input: {
    sessionId: string
    oldWorkspacePath: string
    newWorkspacePath: string
    artifactPackage?: DesignArtifactPackageRef | null
    artifactPath?: string | null
  }): Promise<{
    newArtifactPath: string | null
    commitCleanup: () => Promise<void>
    rollback: () => Promise<void>
  }> {
    const unlock = this.lockSession(input.sessionId, "migration")
    const cleanups: Array<() => Promise<void>> = []
    const rollbacks: Array<() => Promise<void>> = []
    let finished = false
    const finish = async (actions: Array<() => Promise<void>>) => {
      if (finished) return
      finished = true
      try {
        for (const action of actions) await action().catch(() => undefined)
      } finally {
        unlock()
      }
    }
    try {
      // A junction, symlink or different casing can name the same physical workspace.
      if (fs.existsSync(input.oldWorkspacePath) && sameDirectory(input.oldWorkspacePath, input.newWorkspacePath)) {
        let newArtifactPath = input.artifactPath ?? null
        if (input.artifactPackage) {
          newArtifactPath = resolveDesignArtifactLayout({
            sessionId: input.sessionId,
            workspacePath: input.newWorkspacePath,
            artifactPackage: input.artifactPackage,
            fallbackRootDir: input.newWorkspacePath
          }).entryFilePath
        } else if (input.artifactPath) {
          // Legacy entries may use a third spelling of the workspace path.
          let ancestor = path.dirname(path.resolve(input.artifactPath))
          while (ancestor !== path.dirname(ancestor)) {
            if (fs.existsSync(ancestor) && sameDirectory(ancestor, input.oldWorkspacePath)) {
              newArtifactPath = path.resolve(input.newWorkspacePath, path.relative(ancestor, input.artifactPath))
              break
            }
            ancestor = path.dirname(ancestor)
          }
        }
        return { newArtifactPath, commitCleanup: () => finish([]), rollback: () => finish([]) }
      }
      const oldRoot = path.resolve(input.oldWorkspacePath, DESIGN_ARTIFACTS_DIR)
      const newMeta = this.ensureArtifactsRoot(input.newWorkspacePath)
      const safeMain = makeSafeDesignPackageId(`${input.sessionId}_design-main`)
      const safeCtx = makeSafeDesignPackageId(input.sessionId)
      const oldMainDir = path.join(oldRoot, safeMain)
      const newMainDir = path.join(newMeta.artifactsRoot, safeMain)

      let newArtifactPath = input.artifactPath ?? null

      if (fs.existsSync(oldMainDir) && fs.statSync(oldMainDir).isDirectory()) {
        if (this.options.isExportInUse?.(oldMainDir)) {
          throw new Error("当前包正在导出，无法切换工作区")
        }
        const tempMainDir = path.join(
          newMeta.artifactsRoot,
          `.migrate-${safeMain}-${randomUUID().slice(0, 8)}`
        )
        rollbacks.push(() => removeDirectoryWithRetry(tempMainDir))
        await fsp.cp(oldMainDir, tempMainDir, { recursive: true })

        if (fs.existsSync(newMainDir)) {
          const backupDir = path.join(
            newMeta.artifactsRoot,
            `.migrate-backup-${safeMain}-${randomUUID().slice(0, 8)}`
          )
          await moveDirectorySafe(newMainDir, backupDir)
          cleanups.push(() => removeDirectoryWithRetry(backupDir))
          rollbacks.push(async () => {
            if (!fs.existsSync(newMainDir) && fs.existsSync(backupDir)) {
              await moveDirectorySafe(backupDir, newMainDir)
            }
          })
        }

        await moveDirectorySafe(tempMainDir, newMainDir)
        rollbacks.push(() => removeDirectoryWithRetry(newMainDir))
        cleanups.push(() => removeDirectoryWithRetry(oldMainDir))

        if (input.artifactPackage && isValidPackageVersion(input.artifactPackage.version)) {
          const entry = path.join(
            newMainDir,
            "packages",
            input.artifactPackage.version,
            "files",
            normalizePackageRelativePath(input.artifactPackage.entryPath)
          )
          if (!fs.existsSync(entry)) {
            throw new Error("迁移工作区后未找到入口 HTML 文件")
          }
          newArtifactPath = entry
        } else if (input.artifactPath) {
          const rel = path.relative(oldMainDir, path.resolve(input.artifactPath))
          if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
            newArtifactPath = path.join(newMainDir, rel)
          }
        }

        if (newArtifactPath) {
          const metaPath = path.join(newMainDir, "artifact.json")
          if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>
              if (meta && typeof meta === "object" && !Array.isArray(meta)) {
                meta.htmlPath = newArtifactPath
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8")
              }
            } catch {
              // Best-effort metadata update.
            }
          }
        }
      }

      const oldCtxDir = path.join(oldRoot, safeCtx)
      const newCtxDir = path.join(newMeta.artifactsRoot, safeCtx)
      if (fs.existsSync(oldCtxDir) && fs.statSync(oldCtxDir).isDirectory()) {
        const tempCtx = path.join(
          newMeta.artifactsRoot,
          `.migrate-${safeCtx}-${randomUUID().slice(0, 8)}`
        )
        rollbacks.push(() => removeDirectoryWithRetry(tempCtx))
        await fsp.cp(oldCtxDir, tempCtx, { recursive: true })
        if (!fs.existsSync(newCtxDir)) {
          await moveDirectorySafe(tempCtx, newCtxDir)
          rollbacks.push(() => removeDirectoryWithRetry(newCtxDir))
          cleanups.push(() => removeDirectoryWithRetry(oldCtxDir))
        } else {
          await removeDirectoryWithRetry(tempCtx)
        }
      }

      return {
        newArtifactPath,
        commitCleanup: () => finish(cleanups),
        rollback: () => finish(rollbacks.reverse())
      }
    } catch (error) {
      await finish(rollbacks.reverse())
      throw error
    }
  }
}
