import fs from "node:fs"
import path from "node:path"
import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"
import {
  DEFAULT_PACKAGE_SIZE_LIMITS,
  normalizePackageRelativePath,
  type PackageSizeLimits
} from "./streaming-zip"

export interface ExtractedReference {
  reference: string
  documentRelative: boolean
}

export interface SingleHtmlCopyResult {
  files: string[]
  totalBytes: number
  missingAssets: string[]
  outOfScopeAssets: string[]
}

export interface PackageDependencyAuditResult {
  missingAssets: string[]
  outOfScopeAssets: string[]
  warnings: string[]
}

function insideRealPath(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function splitSrcsetUrls(value: string): string[] {
  const parts: string[] = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1
    const start = index
    while (index < value.length && !/\s/.test(value[index])) index += 1
    if (index === start) break
    const url = value.slice(start, index)
    if (url.endsWith(",")) {
      parts.push(url.replace(/,+$/, ""))
      continue
    }
    while (index < value.length && value[index] !== ",") index += 1
    parts.push(url)
  }
  return parts.filter(Boolean)
}

export function extractCssReferences(css: string): string[] {
  const refs: string[] = []
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s][^)]*?))\s*\)/gi)) {
    const ref = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (ref) refs.push(ref)
  }
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)) {
    const ref = match[1]?.trim()
    if (ref) refs.push(ref)
  }
  return refs
}

export function extractJsReferences(js: string): ExtractedReference[] {
  const refs: ExtractedReference[] = []
  for (const match of js.matchAll(
    /\b(?:fetch|import)\s*\(\s*["']([^"']+)["']|\b(?:from|import)\s+["']([^"']+)["']/g
  )) {
    const reference = (match[1] ?? match[2] ?? "").trim()
    if (!reference) continue
    const isFetch = /^fetch\b/.test(match[0])
    if (!isFetch && !/^(?:\.\.?\/|\/)/.test(reference)) continue
    refs.push({ reference, documentRelative: isFetch })
  }
  for (const match of js.matchAll(
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g
  )) {
    const reference = match[1]?.trim()
    if (reference) refs.push({ reference, documentRelative: false })
  }
  return refs
}

export function extractHtmlReferences(html: string): ExtractedReference[] {
  const refs: ExtractedReference[] = []
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      for (const attr of node.attrs) {
        if (attr.name === "src" || attr.name === "poster") {
          refs.push({ reference: attr.value, documentRelative: true })
        } else if (
          (attr.name === "href" || attr.name === "xlink:href") &&
          ["link", "image", "use", "feimage"].includes(node.tagName)
        ) {
          refs.push({ reference: attr.value, documentRelative: true })
        } else if (attr.name === "data" && node.tagName === "object") {
          refs.push({ reference: attr.value, documentRelative: true })
        } else if (attr.name === "srcset") {
          for (const url of splitSrcsetUrls(attr.value)) {
            refs.push({ reference: url, documentRelative: true })
          }
        } else if (attr.name === "style") {
          for (const url of extractCssReferences(attr.value)) {
            refs.push({ reference: url, documentRelative: true })
          }
        }
      }
      const textContent = node.childNodes
        .map((child) => ("value" in child ? child.value : ""))
        .join("")
      if (node.tagName === "style" && textContent.trim()) {
        for (const url of extractCssReferences(textContent)) {
          refs.push({ reference: url, documentRelative: true })
        }
      } else if (
        node.tagName === "script" &&
        !node.attrs.some((a) => a.name === "src") &&
        textContent.trim()
      ) {
        const scriptType =
          node.attrs.find((a) => a.name === "type")?.value.trim().toLowerCase() ?? ""
        if (
          [
            "",
            "module",
            "text/javascript",
            "application/javascript",
            "text/babel",
            "text/jsx"
          ].includes(scriptType)
        ) {
          refs.push(...extractJsReferences(textContent))
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit)
  }
  visit(parse(html))
  return refs
}

function stripReferenceQueryAndDecode(reference: string): {
  skip: boolean
  remote: boolean
  cleanPath: string
} {
  const trimmed = reference.trim()
  if (!trimmed || trimmed.startsWith("#")) {
    return { skip: true, remote: false, cleanPath: "" }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { skip: true, remote: true, cleanPath: "" }
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(trimmed)) {
    return { skip: true, remote: false, cleanPath: "" }
  }
  const withoutQuery = trimmed.split(/[?#]/)[0]
  if (!withoutQuery) {
    return { skip: true, remote: false, cleanPath: "" }
  }
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    decoded = withoutQuery
  }
  return { skip: false, remote: false, cleanPath: decoded.replace(/\\/g, "/") }
}

function resolvePackageRelativeReference(
  baseFile: string,
  cleanPath: string
): { status: "ok"; relative: string } | { status: "out_of_scope" } {
  if (cleanPath.startsWith("/")) {
    const normalized = path.posix.normalize(cleanPath.slice(1))
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
      return { status: "out_of_scope" }
    }
    return { status: "ok", relative: normalized }
  }
  const baseDir = path.posix.dirname(baseFile)
  const joined = baseDir === "." ? cleanPath : path.posix.join(baseDir, cleanPath)
  const normalized = path.posix.normalize(joined)
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return { status: "out_of_scope" }
  }
  return { status: "ok", relative: normalized }
}

/**
 * Copy a single selected HTML file and its transitive local dependencies inside the HTML's
 * directory into `targetFilesDir`, while listing missing or out-of-scope references.
 */
export function copySingleHtmlWithDependencies(
  sourceHtmlPath: string,
  targetFilesDir: string,
  limits: PackageSizeLimits = DEFAULT_PACKAGE_SIZE_LIMITS
): SingleHtmlCopyResult {
  const source = path.resolve(sourceHtmlPath)
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("请选择普通 HTML 文件")
  }
  if (!/\.html?$/i.test(source)) {
    throw new Error("请选择 .html 或 .htm 文件")
  }

  const sourceRoot = path.dirname(source)
  const realSourceRoot = fs.realpathSync(sourceRoot)
  const entryName = path.basename(source)
  fs.mkdirSync(targetFilesDir, { recursive: true })
  const realTargetRoot = fs.realpathSync(targetFilesDir)

  const files: string[] = []
  const seenLower = new Set<string>()
  const visited = new Set<string>()
  const missingAssets = new Set<string>()
  const outOfScopeAssets = new Set<string>()
  let totalBytes = 0

  const copyOne = (relative: string): boolean => {
    const safeRelative = normalizePackageRelativePath(relative)
    const key = safeRelative.toLowerCase()
    if (seenLower.has(key)) return true

    const srcFile = path.join(sourceRoot, safeRelative)
    if (!fs.existsSync(srcFile)) return false

    const fileStat = fs.lstatSync(srcFile)
    if (fileStat.isSymbolicLink()) {
      outOfScopeAssets.add(relative)
      return false
    }
    const realSrcFile = fs.realpathSync(srcFile)
    if (!insideRealPath(realSourceRoot, realSrcFile)) {
      outOfScopeAssets.add(relative)
      return false
    }
    if (!fileStat.isFile()) return false

    if (files.length >= limits.maxFiles) {
      throw new Error(`依赖文件数超过 ${limits.maxFiles} 个限制`)
    }
    if (fileStat.size > limits.maxFileBytes) {
      throw new Error(
        `依赖文件超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB 限制：${safeRelative}`
      )
    }
    if (/\.html?$/i.test(safeRelative) && fileStat.size > limits.maxHtmlBytes) {
      throw new Error(
        `HTML 文件超过 ${Math.round(limits.maxHtmlBytes / 1024 / 1024)} MB 限制：${safeRelative}`
      )
    }
    if (totalBytes + fileStat.size > limits.maxTotalBytes) {
      throw new Error(
        `项目总大小超过 ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB 限制`
      )
    }

    const targetFile = path.join(targetFilesDir, safeRelative)
    fs.mkdirSync(path.dirname(targetFile), { recursive: true })
    if (!insideRealPath(realTargetRoot, fs.realpathSync(path.dirname(targetFile)))) {
      throw new Error(`目标目录越界：${safeRelative}`)
    }
    fs.copyFileSync(realSrcFile, targetFile)
    seenLower.add(key)
    files.push(safeRelative)
    totalBytes += fileStat.size
    return true
  }

  const pending: string[] = [entryName]
  while (pending.length > 0) {
    const current = pending.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    if (!copyOne(current)) continue
    if (!/\.(?:html?|css|js|mjs|jsx|json)$/i.test(current)) continue

    const text = fs.readFileSync(path.join(targetFilesDir, current), "utf8")
    const refs: ExtractedReference[] = /\.html?$/i.test(current)
      ? extractHtmlReferences(text)
      : /\.css$/i.test(current)
        ? extractCssReferences(text).map((reference) => ({ reference, documentRelative: false }))
        : /\.(?:js|mjs|jsx)$/i.test(current)
          ? extractJsReferences(text)
          : []

    for (const ref of refs) {
      const parsed = stripReferenceQueryAndDecode(ref.reference)
      if (parsed.skip) continue
      if (parsed.cleanPath.startsWith("/")) {
        outOfScopeAssets.add(ref.reference)
        continue
      }
      const base = ref.documentRelative ? entryName : current
      const resolved = resolvePackageRelativeReference(base, parsed.cleanPath)
      if (resolved.status === "out_of_scope") {
        outOfScopeAssets.add(ref.reference)
        continue
      }
      const diskPath = path.join(sourceRoot, resolved.relative)
      if (!fs.existsSync(diskPath)) {
        missingAssets.add(resolved.relative)
        continue
      }
      pending.push(resolved.relative)
    }
  }

  files.sort()
  return {
    files,
    totalBytes,
    missingAssets: [...missingAssets],
    outOfScopeAssets: [...outOfScopeAssets]
  }
}

export function auditPackageDependencies(
  filesRoot: string,
  entryPath: string,
  files: string[]
): PackageDependencyAuditResult {
  const fileSet = new Set(files)
  const fileLower = new Set(files.map((item) => item.toLowerCase()))
  const missingAssets = new Set<string>()
  const outOfScopeAssets = new Set<string>()
  const warnings = new Set<string>()

  const visitedCss = new Set<string>()
  const scanCss = (cssRelativePath: string, depth: number) => {
    if (depth > 5 || visitedCss.has(cssRelativePath)) return
    visitedCss.add(cssRelativePath)
    const full = path.join(filesRoot, cssRelativePath)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return
    const cssText = fs.readFileSync(full, "utf8")
    for (const rawRef of extractCssReferences(cssText)) {
      const parsed = stripReferenceQueryAndDecode(rawRef)
      if (parsed.remote) {
        warnings.add("页面包含远程资源，离线预览可能无法加载。")
        continue
      }
      if (parsed.skip) continue
      const resolved = resolvePackageRelativeReference(cssRelativePath, parsed.cleanPath)
      if (resolved.status === "out_of_scope") {
        outOfScopeAssets.add(rawRef)
        continue
      }
      if (!fileSet.has(resolved.relative) && !fileLower.has(resolved.relative.toLowerCase())) {
        missingAssets.add(rawRef)
        continue
      }
      if (/\.css$/i.test(resolved.relative)) {
        scanCss(resolved.relative, depth + 1)
      }
    }
  }

  const entryFile = path.join(filesRoot, entryPath)
  if (fs.existsSync(entryFile) && fs.statSync(entryFile).isFile()) {
    const html = fs.readFileSync(entryFile, "utf8")
    for (const item of extractHtmlReferences(html)) {
      const parsed = stripReferenceQueryAndDecode(item.reference)
      if (parsed.remote) {
        warnings.add("页面包含远程资源，离线预览可能无法加载。")
        continue
      }
      if (parsed.skip) continue
      const resolved = resolvePackageRelativeReference(entryPath, parsed.cleanPath)
      if (resolved.status === "out_of_scope") {
        outOfScopeAssets.add(item.reference)
        continue
      }
      if (!fileSet.has(resolved.relative) && !fileLower.has(resolved.relative.toLowerCase())) {
        missingAssets.add(item.reference)
        continue
      }
      if (/\.css$/i.test(resolved.relative)) {
        scanCss(resolved.relative, 1)
      }
    }
  }

  for (const item of missingAssets) warnings.add(`缺失资源：${item}`)
  for (const item of outOfScopeAssets) warnings.add(`超出包目录范围的资源：${item}`)

  return {
    missingAssets: [...missingAssets],
    outOfScopeAssets: [...outOfScopeAssets],
    warnings: [...warnings]
  }
}
