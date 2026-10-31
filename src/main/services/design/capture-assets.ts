import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5"
import * as cssTree from "css-tree"
import type { DesignImportWarning } from "../../../shared/design-url-import"

type HtmlNode = DefaultTreeAdapterMap["node"]
type HtmlElement = DefaultTreeAdapterMap["element"]
interface SavedAsset {
  file: string
  content: Buffer
  mime: string
}

export interface CaptureAssetOptions {
  html: string
  pageUrl: string
  directory: string
  signal: AbortSignal
  fetch: (url: string, init: RequestInit) => Promise<Response>
  readBlob?: (url: string) => Promise<string | null>
  limits?: { count?: number; perFile?: number; total?: number }
}

/** Avoid persisting signed query strings, credentials or URL fragments in diagnostics. */
export function capturePublicUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return "未知资源"
  }
}

export async function localizeCaptureAssets(options: CaptureAssetOptions): Promise<{
  html: string
  warnings: DesignImportWarning[]
  resources: Array<{ source: string; file: string; bytes: number }>
}> {
  const failure = new AbortController()
  options = { ...options, signal: AbortSignal.any([options.signal, failure.signal]) }
  const warnings: DesignImportWarning[] = []
  const resources: Array<{ source: string; file: string; bytes: number }> = []
  const cache = new Map<string, Promise<SavedAsset | null>>()
  const files = new Set<string>()
  const dependencies = new Map<string, Set<string>>()
  const limit = {
    count: options.limits?.count ?? 500,
    perFile: options.limits?.perFile ?? 10 * 1024 * 1024,
    total: options.limits?.total ?? 50 * 1024 * 1024
  }
  let bytes = 0
  let downloads = 0
  const downloadQueue: Array<() => void> = []
  const download = async (
    url: string
  ): Promise<{ content: Buffer; mime: string; finalUrl: string }> => {
    if (downloads >= 4) await new Promise<void>((resolve) => downloadQueue.push(resolve))
    downloads++
    try {
      check()
      const response = await options.fetch(url, {
        signal: options.signal,
        credentials: "include",
        referrer: options.pageUrl,
        referrerPolicy: "strict-origin-when-cross-origin"
      })
      return {
        content: await readResponse(response),
        mime:
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ||
          "application/octet-stream",
        finalUrl: response.url || url
      }
    } finally {
      downloads--
      downloadQueue.shift()?.()
    }
  }
  const check = () => options.signal.throwIfAborted()
  const warn = (code: string, message: string) => {
    if (
      warnings.length < 80 &&
      !warnings.some((item) => item.code === code && item.message === message)
    )
      warnings.push({ code, message })
  }
  const extension = (mime: string) =>
    ({
      "text/css": ".css",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/svg+xml": ".svg",
      "image/webp": ".webp",
      "image/avif": ".avif",
      "image/x-icon": ".ico",
      "font/woff2": ".woff2",
      "font/woff": ".woff",
      "font/ttf": ".ttf",
      "font/otf": ".otf",
      "application/font-woff": ".woff"
    })[mime] ?? ".bin"
  const readResponse = async (response: Response): Promise<Buffer> => {
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}`)
    }
    if (Number(response.headers.get("content-length")) > limit.perFile) {
      await response.body?.cancel()
      throw new Error("单项资源超出大小限制")
    }
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        check()
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        bytes += next.value.byteLength
        if (size > limit.perFile || bytes > limit.total) throw new Error("资源超出大小限制")
        chunks.push(Buffer.from(next.value))
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }
  const rewriteCss = async (
    css: string,
    base: string,
    inAsset: boolean,
    parents: Set<string>,
    inline = false
  ): Promise<string> => {
    let ast: cssTree.CssNode
    try {
      ast = cssTree.parse(css, {
        parseCustomProperty: true,
        context: inline ? "declarationList" : "stylesheet"
      })
    } catch {
      warn("css_parse", "部分样式无法解析，已省略以避免残留远程引用。")
      return ""
    }
    const urls: Array<{ node: cssTree.Url | cssTree.StringNode; imported: boolean }> = []
    cssTree.walk(ast, {
      visit: "Atrule",
      enter(node) {
        if (node.name.toLowerCase() === "import" && node.prelude?.type === "AtrulePrelude") {
          const first = node.prelude.children.first
          if (first?.type === "String" || first?.type === "Url")
            urls.push({ node: first, imported: true })
        }
      }
    })
    cssTree.walk(ast, {
      visit: "Url",
      enter(node) {
        if (!urls.some((item) => item.node === node)) urls.push({ node, imported: false })
      }
    })
    for (const { node, imported } of urls) {
      check()
      if (!node.value || node.value.startsWith("#")) continue
      const resource = await load(node.value, base, parents, imported)
      node.value = resource
        ? inAsset
          ? path.posix.basename(resource.file)
          : resource.file
        : "data:,"
    }
    return cssTree.generate(ast)
  }
  const load = async (
    value: string,
    base: string,
    parents: Set<string>,
    critical = false
  ): Promise<SavedAsset | null> => {
    check()
    let url: URL
    try {
      url = new URL(value, base)
    } catch {
      return null
    }
    if (!["http:", "https:", "data:", "blob:"].includes(url.protocol)) return null
    const hash = url.hash
    url.hash = ""
    const key = url.href
    if (parents.has(key)) {
      warn("css_cycle", "已跳过循环引用的样式表。")
      return null
    }
    const parent = [...parents].at(-1)
    if (parent) {
      const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
        if (from === target) return true
        if (visited.has(from)) return false
        visited.add(from)
        return [...(dependencies.get(from) ?? [])].some((next) => reaches(next, target, visited))
      }
      if (reaches(key, parent)) {
        warn("css_cycle", "已跳过循环引用的样式表。")
        return null
      }
      if (!dependencies.has(parent)) dependencies.set(parent, new Set())
      dependencies.get(parent)!.add(key)
    }
    if (!cache.has(key)) {
      if (cache.size >= limit.count) {
        if (critical) throw new Error("样式资源数量超过限制，请缩小页面范围")
        warn("resource_limit", "资源数量达到上限，部分资源未保存。")
        return null
      }
      const promise = (async (): Promise<SavedAsset | null> => {
        try {
          let content: Buffer,
            mime: string,
            finalUrl = key
          if (url.protocol === "data:" || url.protocol === "blob:") {
            const data = url.protocol === "data:" ? key : await options.readBlob?.(key)
            if (!data) throw new Error("临时资源无法读取")
            const match = data.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i)
            if (!match) throw new Error("资源编码无效")
            mime = match[1] || "application/octet-stream"
            if (match[3].length > limit.perFile * 4) throw new Error("单项资源超出大小限制")
            content = match[2]
              ? Buffer.from(match[3], "base64")
              : Buffer.from(decodeURIComponent(match[3]))
            bytes += content.byteLength
            if (content.byteLength > limit.perFile || bytes > limit.total)
              throw new Error("资源超出大小限制")
          } else {
            const response = await download(key)
            mime = response.mime
            finalUrl = response.finalUrl
            content = response.content
          }
          if (mime === "text/html" || /javascript|ecmascript/.test(mime))
            throw new Error("资源返回了页面或脚本")
          if (critical && mime !== "text/css") throw new Error("样式表返回的类型不是 CSS")
          if (mime === "text/css")
            content = Buffer.from(
              await rewriteCss(content.toString("utf8"), finalUrl, true, new Set([...parents, key]))
            )
          check()
          const file = `assets/${createHash("sha256").update(content).digest("hex").slice(0, 24)}${extension(mime)}`
          if (!files.has(file)) {
            await fs.mkdir(path.join(options.directory, "assets"), { recursive: true })
            check()
            await fs.writeFile(path.join(options.directory, file), content, {
              signal: options.signal
            })
            files.add(file)
          }
          resources.push({
            source:
              url.protocol === "data:" || url.protocol === "blob:"
                ? url.protocol
                : capturePublicUrl(key),
            file,
            bytes: content.byteLength
          })
          return { file, content, mime }
        } catch (error) {
          check()
          if (critical) {
            const reason =
              error instanceof Error
                ? error.message.replace(/https?:\/\/[^\s'"<>)（），,]*/g, capturePublicUrl)
                : "下载失败"
            throw new Error(`无法保存关键样式：${capturePublicUrl(key)}（${reason}）`)
          }
          warn(
            "resource_missing",
            `资源未能保存：${url.protocol === "data:" || url.protocol === "blob:" ? "临时资源" : capturePublicUrl(key)}`
          )
          return null
        }
      })()
      cache.set(key, promise)
    }
    const resource = await cache.get(key)!
    if (critical && (!resource || resource.mime !== "text/css"))
      throw new Error("关键样式资源无法保存")
    return resource && hash ? { ...resource, file: resource.file + hash } : resource
  }
  const document = parse(options.html)
  const visit = async (node: HtmlNode): Promise<void> => {
    check()
    if ("tagName" in node) {
      const element = node as HtmlElement
      const attribute = (name: string) => element.attrs.find((item) => item.name === name)
      const stylesheet =
        element.tagName === "link" && attribute("rel")?.value.split(/\s+/).includes("stylesheet")
      for (const attr of [...element.attrs]) {
        if (attr.name === "style")
          attr.value = await rewriteCss(attr.value, options.pageUrl, false, new Set(), true)
        if (attr.name === "srcset") attr.value = "" // currentSrc has been frozen by the snapshotter.
        if (
          (attr.name === "src" && ["img", "input"].includes(element.tagName)) ||
          (attr.name === "poster" && element.tagName === "video") ||
          (attr.name === "href" &&
            (stylesheet || ["image", "use", "feImage"].includes(element.tagName)))
        ) {
          if (attr.value.startsWith("#")) continue
          const asset = await load(attr.value, options.pageUrl, new Set(), stylesheet)
          attr.value =
            asset?.file ??
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E"
        }
      }
      if (element.tagName === "style") {
        for (const child of element.childNodes) {
          if (child.nodeName === "#text")
            (child as DefaultTreeAdapterMap["textNode"]).value = await rewriteCss(
              (child as DefaultTreeAdapterMap["textNode"]).value,
              options.pageUrl,
              false,
              new Set()
            )
        }
      }
      if (element.tagName === "template") {
        const content = (element as DefaultTreeAdapterMap["template"]).content
        await Promise.all(content.childNodes.map(visit))
      }
    }
    if ("childNodes" in node) await Promise.all(node.childNodes.map(visit))
  }
  try {
    await visit(document)
  } catch (error) {
    failure.abort(error)
    await Promise.allSettled([...cache.values()])
    throw error
  }
  check()
  return { html: serialize(document), warnings, resources }
}
