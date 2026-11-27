import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import AdmZip from "adm-zip"
import { parse, type DefaultTreeAdapterMap } from "parse5"
import {
  DESIGN_MARKET_COVER_MAX_BYTES,
  DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES,
  type MarketSystemPalette
} from "../../../shared/design-market"
import { rankTemplateEntryPages, templateRelativePath } from "./template-packages"
import { DesignTemplatePreview } from "./template-preview"

const MAX_FILES = 5000
const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_HTML_BYTES = 5 * 1024 * 1024
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX", ".env", ".npmrc"])

const DEFAULT_PALETTE: MarketSystemPalette = ["#3B6BE0", "#7E9EF0", "#DAE5FA", "#182B59"]

function isTransientArtifactName(name: string): boolean {
  return (
    name.startsWith(".draft-") ||
    name.startsWith(".source-") ||
    name.startsWith(".direct-") ||
    name.startsWith(".patch-") ||
    name.includes(".projection-")
  )
}

function createTemplateFileCollector() {
  const files = new Map<string, Buffer>()
  const names = new Set<string>()
  let bytes = 0
  return {
    files,
    add(rawPath: string, size: number, read: () => Buffer): Buffer | undefined {
      const relative = templateRelativePath(rawPath)
      if (relative.split("/").some((part) => SKIP_DIR_NAMES.has(part) || isTransientArtifactName(part))) return
      const key = relative.toLowerCase()
      if (names.has(key)) throw new Error(`模板包含重复路径：${relative}`)
      if (!Number.isSafeInteger(size) || size < 0 || files.size >= MAX_FILES ||
          size > MAX_FILE_BYTES || bytes + size > MAX_TOTAL_BYTES) {
        throw new Error("模板超出限制：最多 5000 个文件，单文件 30 MB，解压总计 200 MB")
      }
      if (/\.html?$/i.test(relative) && size > MAX_HTML_BYTES) {
        throw new Error(`模板 HTML ${relative} 超过 5 MB 限制`)
      }
      const content = read()
      if (content.byteLength !== size) throw new Error(`模板文件大小异常：${relative}`)
      files.set(relative, content)
      names.add(key)
      bytes += size
      return content
    }
  }
}

function collectTemplateZipFiles(zip: AdmZip): Map<string, Buffer> {
  const collector = createTemplateFileCollector()
  const entries = zip.getEntries()
  if (entries.length > MAX_FILES * 2) throw new Error("模板 ZIP 文件数量过多")
  for (const entry of entries) {
    const cleanName = entry.entryName.replace(/\/$/, "")
    if (cleanName) templateRelativePath(cleanName)
    if (((entry.attr >>> 16) & 0xf000) === 0xa000) {
      throw new Error(`模板 ZIP 不支持符号链接：${entry.entryName}`)
    }
    if (entry.isDirectory) continue
    if (entry.header.flags & 1) throw new Error("模板 ZIP 不支持加密条目")
    collector.add(entry.entryName, entry.header.size, () => {
      // AdmZip caps synchronous inflation at the declared size when it is positive.
      // A zero-size deflate entry needs a separate bound before reading its contents.
      if (entry.header.size === 0 && entry.header.method === 8) {
        return inflateRawSync(entry.getCompressedData(), { maxOutputLength: 1 })
      }
      return entry.getData()
    })
  }
  return collector.files
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function normalizeHexColor(raw: string): string | null {
  const value = raw.trim()
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(value)
  if (hex6) return `#${hex6[1].toUpperCase()}`
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(value)
  if (hex3) {
    const [r, g, b] = hex3[1].split("")
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/i.exec(value)
  if (rgb) {
    const clamp = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0").toUpperCase()
    return `#${clamp(Number(rgb[1]))}${clamp(Number(rgb[2]))}${clamp(Number(rgb[3]))}`
  }
  return null
}

export function extractDesignSystemPalette(markdown: string): MarketSystemPalette {
  const found: string[] = []
  const pushColor = (raw: string | undefined) => {
    if (!raw) return
    const normalized = normalizeHexColor(raw)
    if (normalized && !found.includes(normalized)) {
      found.push(normalized)
    }
  }

  const priorityVars = [
    "accent",
    "primary",
    "brand",
    "secondary",
    "surface",
    "bg",
    "background",
    "fg",
    "text",
    "border",
    "muted"
  ]
  for (const name of priorityVars) {
    const re = new RegExp(`--[a-z0-9_-]*${name}[a-z0-9_-]*\\s*:\\s*([^;\\n\\r}]+)`, "gi")
    for (const match of markdown.matchAll(re)) {
      pushColor(match[1])
      if (found.length >= 4) return [found[0], found[1], found[2], found[3]]
    }
  }

  for (const match of markdown.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    pushColor(match[0])
    if (found.length >= 4) return [found[0], found[1], found[2], found[3]]
  }

  for (const match of markdown.matchAll(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)/gi)) {
    pushColor(match[0])
    if (found.length >= 4) return [found[0], found[1], found[2], found[3]]
  }

  for (const fallback of DEFAULT_PALETTE) {
    if (found.length >= 4) break
    if (!found.includes(fallback)) found.push(fallback)
  }

  return [
    found[0] ?? DEFAULT_PALETTE[0],
    found[1] ?? DEFAULT_PALETTE[1],
    found[2] ?? DEFAULT_PALETTE[2],
    found[3] ?? DEFAULT_PALETTE[3]
  ]
}

export function validatePalette(palette: unknown): MarketSystemPalette {
  if (!Array.isArray(palette) || palette.length !== 4) {
    throw new Error("展示色板必须包含 4 个颜色值")
  }
  const normalized = palette.map((color) => {
    if (typeof color !== "string") throw new Error("展示色板颜色值无效")
    const hex = normalizeHexColor(color)
    if (!hex) throw new Error(`无效的色板颜色：${color}，请使用 #RRGGBB 格式`)
    return hex
  })
  return [normalized[0], normalized[1], normalized[2], normalized[3]]
}

function detectFramework(html: string): string {
  return /react(?:-dom)?[./-]|\bReactDOM\b/i.test(html)
    ? /antd/i.test(html)
      ? "React + Ant Design"
      : "React"
    : /vue[./-]|\bVue\b/i.test(html)
      ? "Vue"
      : "HTML"
}

interface ParsedAssetRef {
  ref: string
  kind: "asset" | "hyperlink"
}

function collectHtmlAssetRefs(html: string): ParsedAssetRef[] {
  const refs: ParsedAssetRef[] = []
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase()
      const relAttr = node.attrs.find((attr) => attr.name.toLowerCase() === "rel")?.value.toLowerCase() ?? ""
      for (const attr of node.attrs) {
        const attrName = attr.name.toLowerCase()
        if (attrName === "src" || attrName === "poster") {
          refs.push({ ref: attr.value, kind: "asset" })
        } else if (attrName === "srcset") {
          for (const part of attr.value.split(",")) {
            const url = part.trim().split(/\s+/)[0]
            if (url) refs.push({ ref: url, kind: "asset" })
          }
        } else if (attrName === "href") {
          if (tag === "a" || tag === "area") {
            refs.push({ ref: attr.value, kind: "hyperlink" })
          } else if (
            tag === "link" &&
            (/\b(stylesheet|icon|shortcut|apple-touch-icon|preload|modulepreload|manifest)\b/.test(relAttr) ||
              !relAttr)
          ) {
            refs.push({ ref: attr.value, kind: "asset" })
          } else if (tag === "image" || tag === "use") {
            refs.push({ ref: attr.value, kind: "asset" })
          }
        }
      }
    }
    if ("childNodes" in node) {
      node.childNodes.forEach(visit)
    }
  }
  visit(parse(html))
  return refs
}

function collectCssAssetRefs(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const refs: string[] = []
  for (const match of stripped.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) {
    refs.push(match[1])
  }
  for (const match of stripped.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) {
    refs.push(match[1])
  }
  return refs
}

function isNonNetworkScheme(ref: string): boolean {
  const trimmed = ref.trim()
  if (!trimmed || trimmed.startsWith("#")) return true
  if (/^(?:data|blob|about|mailto|tel|javascript):/i.test(trimmed)) return true
  return false
}

function resolveRelativeWithinPackage(baseFile: string, ref: string): { ok: true; target: string } | { ok: false; reason: string } {
  const cleaned = ref.trim().split(/[?#]/)[0]
  if (!cleaned) return { ok: true, target: baseFile }
  let decoded: string
  try {
    decoded = decodeURIComponent(cleaned)
  } catch {
    return { ok: false, reason: "路径编码无效" }
  }
  decoded = decoded.replace(/\\/g, "/")
  const baseDir = path.posix.dirname(baseFile)
  const joined = baseDir === "." ? decoded : path.posix.join(baseDir, decoded)
  const normalized = path.posix.normalize(joined)
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return { ok: false, reason: "相对路径超出模板包根目录" }
  }
  return { ok: true, target: normalized }
}

function validateFileReferences(
  file: string,
  refs: ParsedAssetRef[],
  fileSet: Set<string>,
  errors: string[],
  warnings: string[]
): void {
  for (const { ref, kind } of refs) {
    const trimmed = ref.trim()
    if (!trimmed || isNonNetworkScheme(trimmed)) continue
    if (kind === "hyperlink") {
      if (/^https?:\/\//i.test(trimmed)) continue
      if (trimmed.startsWith("/") && !trimmed.startsWith("//")) continue
      const resolved = resolveRelativeWithinPackage(file, trimmed)
      if (resolved.ok && /\.html?$/i.test(resolved.target) && !fileSet.has(resolved.target)) {
        warnings.push(`${file} 中的页面链接 ${trimmed} 在包内不存在`)
      }
      continue
    }
    if (/^(?:https?:)?\/\//i.test(trimmed)) {
      errors.push(`文件 ${file} 引用了需要联网加载的外部资源 ${trimmed}，请替换为包内本地资源`)
      continue
    }
    if (trimmed.startsWith("/")) {
      errors.push(`文件 ${file} 使用了站点根路径 ${trimmed}，请改为相对路径`)
      continue
    }
    const resolved = resolveRelativeWithinPackage(file, trimmed)
    if (!resolved.ok) {
      errors.push(`文件 ${file} 的资源路径越界：${trimmed}`)
      continue
    }
    if (!fileSet.has(resolved.target)) {
      errors.push(`文件 ${file} 缺少引用的本地资源：${trimmed}（解析为 ${resolved.target}）`)
    }
  }
}

export interface ValidatedTemplateArchive {
  files: Map<string, Buffer>
  fileList: string[]
  pages: string[]
  defaultEntryPath: string
  totalBytes: number
  framework: string
  zipBuffer: Buffer
  sha256: string
  warnings: string[]
}

type InspectedTemplateFiles = Omit<ValidatedTemplateArchive, "zipBuffer" | "sha256">

function inspectTemplateFiles(
  files: Map<string, Buffer>,
  preferredEntryPath?: string
): InspectedTemplateFiles {
  const totalBytes = [...files.values()].reduce((total, file) => total + file.byteLength, 0)

  const fileList = [...files.keys()].sort()
  const pages = rankTemplateEntryPages(fileList)
  if (pages.length === 0) {
    throw new Error("未找到 HTML 入口。只有框架资源时请补充示例页面；源码工程请先构建为静态目录。")
  }

  const defaultEntryPath = preferredEntryPath ? templateRelativePath(preferredEntryPath) : pages[0]
  if (!pages.includes(defaultEntryPath)) {
    throw new Error(`指定的入口页面不存在：${defaultEntryPath}`)
  }

  const fileSet = new Set(fileList)
  const errors: string[] = []
  const warnings: string[] = []

  // Validate the selected entry page, linked template pages outside dependency subtrees, and authored CSS.
  const pagesToValidate = new Set<string>([defaultEntryPath])
  for (const page of pages) {
    if (!page.startsWith("template/")) {
      pagesToValidate.add(page)
    }
  }
  for (const page of pagesToValidate) {
    const html = files.get(page)!.toString("utf8")
    validateFileReferences(page, collectHtmlAssetRefs(html), fileSet, errors, warnings)
  }

  for (const file of fileList) {
    if (!/\.css$/i.test(file)) continue
    // Skip checking inside vendored/minified third-party font/icon CSS URLs unless missing?
    // Still check CSS @import / url() but skip template/ vendored packages only if needed? No, check all non-minified CSS cleanly:
    if (/\.min\.css$/i.test(file)) continue
    const css = files.get(file)!.toString("utf8")
    const cssRefs = collectCssAssetRefs(css).map((ref) => ({ ref, kind: "asset" as const }))
    validateFileReferences(file, cssRefs, fileSet, errors, warnings)
  }

  if (errors.length > 0) {
    throw new Error(errors.slice(0, 5).join("；"))
  }

  const entryHtml = files.get(defaultEntryPath)!.toString("utf8")
  return { files, fileList, pages, defaultEntryPath, totalBytes, framework: detectFramework(entryHtml), warnings }
}

function packTemplateFiles(inspected: InspectedTemplateFiles): ValidatedTemplateArchive {
  const zip = new AdmZip()
  for (const rel of inspected.fileList) {
    zip.addFile(rel, inspected.files.get(rel)!)
  }
  const zipBuffer = zip.toBuffer()
  if (zipBuffer.byteLength > DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES) {
    throw new Error("打包后的模板 ZIP 超过 120 MB 限制")
  }
  return { ...inspected, zipBuffer, sha256: createHash("sha256").update(zipBuffer).digest("hex") }
}

function collectSingleHtmlGraph(sourceFile: string): Map<string, Buffer> {
  const sourceRoot = path.dirname(sourceFile)
  const realRoot = fs.realpathSync(sourceRoot)
  const collector = createTemplateFileCollector()
  const pending = [path.basename(sourceFile)]
  const visited = new Set<string>()
  const entryBase = path.basename(sourceFile)

  while (pending.length > 0) {
    const relative = pending.shift()!
    if (visited.has(relative)) continue
    visited.add(relative)
    if (relative.startsWith("../") || !inside(sourceRoot, path.resolve(sourceRoot, relative))) {
      continue
    }
    const full = path.join(sourceRoot, relative)
    if (!fs.existsSync(full)) continue
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`模板不支持符号链接：${relative}`)
    if (!inside(realRoot, fs.realpathSync(full))) throw new Error(`模板资源目录越界：${relative}`)
    if (!stat.isFile()) continue
    const buf = collector.add(relative, stat.size, () => fs.readFileSync(full))
    if (!buf || !/\.(?:html?|css|js|mjs|jsx|json)$/i.test(relative)) continue
    const text = buf.toString("utf8")
    if (/\.html?$/i.test(relative)) {
      for (const item of collectHtmlAssetRefs(text)) {
        if (item.kind !== "asset" || isNonNetworkScheme(item.ref)) continue
        if (/^(?:https?:)?\/\//i.test(item.ref) || item.ref.startsWith("/")) continue
        const resolved = resolveRelativeWithinPackage(relative, item.ref)
        if (resolved.ok) pending.push(resolved.target)
      }
    } else if (/\.css$/i.test(relative)) {
      for (const ref of collectCssAssetRefs(text)) {
        if (isNonNetworkScheme(ref) || /^(?:https?:)?\/\//i.test(ref) || ref.startsWith("/")) continue
        const resolved = resolveRelativeWithinPackage(relative, ref)
        if (resolved.ok) pending.push(resolved.target)
      }
    } else {
      for (const match of text.matchAll(/(?:fetch|import)\(\s*["']([^"']+)["']/g)) {
        const ref = match[1]
        if (isNonNetworkScheme(ref) || /^(?:https?:)?\/\//i.test(ref) || ref.startsWith("/")) continue
        const resolved = resolveRelativeWithinPackage(entryBase, ref)
        if (resolved.ok) pending.push(resolved.target)
      }
    }
  }
  return collector.files
}

export function validateAndPackTemplateSource(
  sourcePath: string,
  preferredEntryPath?: string
): ValidatedTemplateArchive & { packageFilename: string } {
  const source = path.resolve(sourcePath)
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error("请选择实际文件或目录，不支持符号链接")
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("请选择 HTML、ZIP 或静态模板目录")

  let inspected: InspectedTemplateFiles
  if (stat.isFile()) {
    if (/\.zip$/i.test(source)) {
      inspected = inspectTemplateZipFile(source, preferredEntryPath)
    } else if (/\.html?$/i.test(source)) {
      inspected = inspectTemplateFiles(collectSingleHtmlGraph(source), preferredEntryPath || path.basename(source))
    } else {
      throw new Error("请选择 HTML、ZIP 或模板文件夹")
    }
  } else {
    const collector = createTemplateFileCollector()
    const realRoot = fs.realpathSync(source)
    const visit = (dir: string, depth: number) => {
      if (depth > 30) throw new Error("模板目录层级过深")
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR_NAMES.has(entry.name) || isTransientArtifactName(entry.name)) continue
        const full = path.join(dir, entry.name)
        const rel = templateRelativePath(path.relative(source, full).replace(/\\/g, "/"))
        if (entry.isSymbolicLink()) throw new Error(`模板不支持符号链接：${rel}`)
        if (!inside(realRoot, fs.realpathSync(full))) throw new Error(`模板资源目录越界：${rel}`)
        if (entry.isDirectory()) {
          visit(full, depth + 1)
        } else if (entry.isFile()) {
          collector.add(rel, fs.statSync(full).size, () => fs.readFileSync(full))
        }
      }
    }
    visit(source, 0)
    inspected = inspectTemplateFiles(collector.files, preferredEntryPath)
  }

  const packed = packTemplateFiles(inspected)
  const baseName = path.basename(source, path.extname(source)) || "template"
  return {
    ...packed,
    packageFilename: /\.zip$/i.test(source) ? path.basename(source) : `${baseName}.zip`
  }
}

function assertTemplateZipSize(bytes: number): void {
  if (bytes > DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES) {
    throw new Error("模板 ZIP 超过 120 MB 限制")
  }
}

export function inspectTemplateZipFile(file: string, preferredEntryPath?: string): InspectedTemplateFiles {
  assertTemplateZipSize(fs.statSync(file).size)
  return inspectTemplateFiles(collectTemplateZipFiles(new AdmZip(file)), preferredEntryPath)
}

export function inspectTemplateZipBuffer(zipBuffer: Buffer, preferredEntryPath?: string): InspectedTemplateFiles {
  assertTemplateZipSize(zipBuffer.byteLength)
  return inspectTemplateFiles(collectTemplateZipFiles(new AdmZip(zipBuffer)), preferredEntryPath)
}

export function validateTemplateZipBuffer(zipBuffer: Buffer, preferredEntryPath?: string): ValidatedTemplateArchive {
  return packTemplateFiles(inspectTemplateZipBuffer(zipBuffer, preferredEntryPath))
}

export function buildFallbackTemplateCoverSvg(
  title: string,
  framework: string,
  entryPath: string
): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <rect width="800" height="500" fill="#F6F5F2"/>
  <rect x="28" y="24" width="744" height="452" rx="14" fill="#FFFFFF" stroke="#E5E1D8" stroke-width="2"/>
  <rect x="28" y="24" width="744" height="48" rx="14" fill="#FAF8F4"/>
  <circle cx="56" cy="48" r="6" fill="#E5A287"/>
  <circle cx="76" cy="48" r="6" fill="#E6C987"/>
  <circle cx="96" cy="48" r="6" fill="#99C2A2"/>
  <text x="128" y="53" font-family="sans-serif" font-size="14" fill="#6E6A61">${escape(entryPath)}</text>
  <rect x="56" y="96" width="160" height="350" rx="10" fill="#F7F5F0" stroke="#ECE7DE"/>
  <rect x="74" y="118" width="124" height="16" rx="4" fill="#D8CFC2"/>
  <rect x="74" y="150" width="96" height="12" rx="4" fill="#E8E2D7"/>
  <rect x="74" y="174" width="110" height="12" rx="4" fill="#E8E2D7"/>
  <rect x="236" y="96" width="508" height="72" rx="10" fill="#FBF8F3" stroke="#ECE7DE"/>
  <text x="260" y="128" font-family="sans-serif" font-size="22" font-weight="600" fill="#1F1E1C">${escape(title.slice(0, 32))}</text>
  <text x="260" y="154" font-family="sans-serif" font-size="13" fill="#78716C">${escape(framework)} · 静态封面预览</text>
  <rect x="236" y="186" width="508" height="260" rx="10" fill="#FFFFFF" stroke="#ECE7DE"/>
  <rect x="256" y="210" width="140" height="24" rx="6" fill="#B97843" fill-opacity="0.18"/>
  <rect x="410" y="210" width="140" height="24" rx="6" fill="#F2EFE9"/>
  <rect x="256" y="254" width="468" height="34" rx="6" fill="#FAF8F5"/>
  <rect x="256" y="302" width="468" height="34" rx="6" fill="#FFFFFF" stroke="#F0ECE4"/>
  <rect x="256" y="350" width="468" height="34" rx="6" fill="#FAF8F5"/>
  <rect x="256" y="398" width="468" height="34" rx="6" fill="#FFFFFF" stroke="#F0ECE4"/>
</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`
}

export async function generateOfflineTemplateCover(options: {
  rootDir: string
  entryPath: string
  files: string[]
  title: string
  framework: string
}): Promise<{ coverDataUrl: string; warnings: string[] }> {
  const warnings: string[] = []
  try {
    const electron = await import("electron")
    const BrowserWindow = electron.BrowserWindow
    const sessionApi = electron.session
    if (BrowserWindow && sessionApi && electron.app?.isReady?.()) {
      const preview = new DesignTemplatePreview()
      const previewUrl = await preview.url({
        id: "tpl_00000000-0000-0000-0000-000000000000",
        name: options.title,
        sourceKind: "directory",
        importedAt: new Date().toISOString(),
        entryPath: options.entryPath,
        pages: [options.entryPath],
        files: options.files,
        totalBytes: 0,
        framework: options.framework,
        rootDir: options.rootDir,
        html: "",
        warnings: []
      })
      const allowedOrigin = new URL(previewUrl).origin
      const isolatedSession = sessionApi.fromPartition(`design-market-cover-${Date.now()}`)
      const blockedExternal: string[] = []
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith(allowedOrigin) || details.url.startsWith("data:") || details.url.startsWith("blob:")) {
          callback({})
          return
        }
        blockedExternal.push(details.url)
        callback({ cancel: true })
      })
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        useContentSize: true,
        webPreferences: {
          session: isolatedSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true
        }
      })
      try {
        await win.loadURL(previewUrl)
        await new Promise((resolve) => setTimeout(resolve, 600))
        const image = await win.webContents.capturePage()
        const resized = image.resize({ width: 800, height: 500 })
        const png = resized.toPNG()
        if (blockedExternal.length > 0) {
          warnings.push(`断网预览拦截了 ${blockedExternal.length} 个外部请求，请确认模板可离线展示`)
        }
        return {
          coverDataUrl: `data:image/png;base64,${png.toString("base64")}`,
          warnings
        }
      } finally {
        if (!win.isDestroyed()) win.destroy()
        preview.close()
      }
    }
  } catch {
    // Headless / test environment without Electron BrowserWindow falls back to deterministic SVG cover.
  }

  return {
    coverDataUrl: buildFallbackTemplateCoverSvg(options.title, options.framework, options.entryPath),
    warnings
  }
}

export function validateManualCoverImage(filePath: string): string {
  const resolved = path.resolve(filePath)
  const stat = fs.lstatSync(resolved)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("封面图片必须是普通图片文件")
  }
  if (stat.size <= 0 || stat.size > DESIGN_MARKET_COVER_MAX_BYTES) {
    throw new Error("封面图片大小必须在 1 字节到 2 MB 之间")
  }
  const buf = fs.readFileSync(resolved)
  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  const isWebp = buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP"
  const mime = isPng ? "image/png" : isJpeg ? "image/jpeg" : isWebp ? "image/webp" : null
  if (!mime) {
    throw new Error("封面图片仅支持 PNG、JPEG 或 WebP 格式")
  }
  return `data:${mime};base64,${buf.toString("base64")}`
}
