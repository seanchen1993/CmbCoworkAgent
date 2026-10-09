import { parse, type Node } from "acorn"

// Design previews execute page interactions and editor scripts. Keep this
// builder separate from the static workspace file preview policy.
export interface DesignHtmlPreviewDocumentOptions {
  html: string
  htmlPath?: string
  readTextFile?: (resolvedPath: string) => Promise<string | null>
  readDataUrlFile?: (resolvedPath: string) => Promise<string | null>
}

/**
 * 统一路径分隔符为 `/`。
 * 作用：
 * - 兼容 Windows 路径（`\`）与 Web URL 风格路径（`/`）。
 * - 让后续字符串规则（如 startsWith、includes、lastIndexOf）只处理一种格式，避免分支复杂化。
 *
 * @param value 任意路径或资源引用字符串
 * @returns 归一化后的路径字符串
 */
function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/")
}

/**
 * 去除资源引用中的 query/hash 部分，仅保留“文件路径主体”。
 * 作用：
 * - 把 `a.css?v=1#x` 归一为 `a.css`，便于做本地文件解析。
 * - 避免把版本号或锚点当成真实文件名导致读取失败。
 *
 * @param value 资源引用（可能包含 `?` 或 `#`）
 * @returns 去除查询参数和锚点后的路径
 */
function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf("?")
  const hashIndex = value.indexOf("#")
  let end = value.length

  if (queryIndex >= 0) end = Math.min(end, queryIndex)
  if (hashIndex >= 0) end = Math.min(end, hashIndex)

  return value.slice(0, end)
}

/**
 * 安全解码 URI 路径片段。
 * 说明：
 * - 对 `foo%20bar.css` 这类编码路径做解码，提升本地文件命中率。
 * - 若输入不是合法编码（例如孤立 `%`），不抛错，直接返回原值。
 *
 * @param value 可能被 URI 编码的路径
 * @returns 解码后的路径；解码失败时返回原始字符串
 */
function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 将 `file://` URL 规范化为平台无关的“路径样式字符串”。
 * 支持场景：
 * - Linux/macOS：`file:///home/u/a/index.html` -> `/home/u/a/index.html`
 * - Windows 盘符：`file:///C:/work/a/index.html` -> `C:/work/a/index.html`
 * - Windows UNC：`file://server/share/a/index.html` -> `//server/share/a/index.html`
 *
 * 非 `file://` 输入会原样返回，交由后续逻辑处理。
 *
 * @param value 原始 HTML 路径（可能是普通路径，也可能是 file URL）
 * @returns 归一化后的路径样式字符串
 */
function normalizeHtmlPathInput(value: string): string {
  const trimmed = value.trim()
  if (!/^file:\/\//i.test(trimmed)) {
    return trimmed
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "file:") return trimmed

    const decodedPathname = safeDecodeUri(parsed.pathname)
    if (parsed.host) {
      // file://server/share/path -> UNC 路径样式 //server/share/path
      return `//${parsed.host}${decodedPathname}`
    }

    // file:///C:/path 在 URL 里 pathname 为 /C:/path，需要去掉前导 /
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) {
      return decodedPathname.slice(1)
    }

    return decodedPathname
  } catch {
    return trimmed
  }
}

/**
 * 判断资源引用是否带协议（例如 `http:`、`https:`、`data:`）或协议相对地址（`//cdn...`）。
 * 作用：
 * - 识别“非本地相对路径”资源，后续直接跳过内联。
 * - 防止把远程 URL 误当作本地文件路径去读取。
 *
 * @param value 资源引用字符串
 * @returns `true` 表示带协议或协议相对地址；否则为 `false`
 */
function hasProtocol(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//")
}

/** Resolve paths against a dependency file while keeping every read within the
 * HTML directory. CSS may use ../images when its own file is in assets/css. */
function resolveLocalAssetPath(
  basePath: string,
  dependencyPath: string,
  htmlPath: string = basePath
): string | null {
  const dependency = normalizeSlashes(safeDecodeUri(stripQueryAndHash(dependencyPath.trim())))
  if (
    !dependency ||
    dependency.startsWith("/") ||
    dependency.startsWith("#") ||
    hasProtocol(dependency)
  )
    return null
  const normalize = (value: string): string | null => {
    const segments: string[] = []
    for (const segment of value.split("/")) {
      if (segment === ".") continue
      if (segment === "..") {
        if (!segments.length || (segments.length === 1 && segments[0] === "")) return null
        segments.pop()
      } else segments.push(segment)
    }
    return segments.join("/")
  }
  const normalizedHtml = normalizeSlashes(normalizeHtmlPathInput(htmlPath))
  const root = normalizedHtml.slice(0, Math.max(0, normalizedHtml.lastIndexOf("/")))
  const normalizedBase = normalizeSlashes(normalizeHtmlPathInput(basePath))
  const directory = normalizedBase.slice(0, Math.max(0, normalizedBase.lastIndexOf("/")))
  const resolved = normalize(directory ? `${directory}/${dependency}` : dependency)
  if (!resolved) return null
  const windowsPath = /^[a-zA-Z]:/.test(root) || root.startsWith("//")
  const comparedPath = windowsPath ? resolved.toLowerCase() : resolved
  const comparedRoot = windowsPath ? root.toLowerCase() : root
  if (root && !comparedPath.startsWith(`${comparedRoot}/`)) return null
  return resolved
}

/**
 * 转义内联脚本中的 `</script>` 片段，防止浏览器提前闭合 script 标签。
 * 典型场景：
 * - JS 字符串里出现 `</script>`（如模板字符串、HTML 片段）会破坏 DOM 结构。
 *
 * @param content JS 源码文本
 * @returns 适合放入 `<script>` 标签文本节点的安全内容
 */
function escapeInlineScriptContent(content: string): string {
  return content.replace(/<\/script/gi, "<\\/script")
}

function escapeInlineStyleContent(content: string): string {
  return content.replace(/<\/style/gi, "\\3C /style")
}

function encodeBase64(content: string): string {
  const bytes = new TextEncoder().encode(content)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Replace async string ranges without letting earlier replacements shift later
 * match offsets.
 */
function applyStringReplacements(
  input: string,
  replacements: Array<{ start: number; end: number; value: string }>
): string {
  if (replacements.length === 0) return input
  const sorted = [...replacements].sort((left, right) => right.start - left.start)
  return sorted.reduce((current, replacement) => {
    return `${current.slice(0, replacement.start)}${replacement.value}${current.slice(replacement.end)}`
  }, input)
}

function cssUrlQuote(value: string): string {
  return value.includes('"') ? `'${value.replace(/'/g, "\\'")}'` : `"${value}"`
}

async function inlineCssAssetUrls(
  css: string,
  cssBasePath: string,
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>,
  htmlPath: string = cssBasePath
): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*?))\s*\)/gi

  for (const match of css.matchAll(urlPattern)) {
    if (match.index === undefined) continue
    const rawValue = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!rawValue) continue

    const resolvedPath = resolveLocalAssetPath(cssBasePath, rawValue, htmlPath)
    if (!resolvedPath) continue

    const dataUrl = await readDataUrlWithCache(resolvedPath)
    if (!dataUrl) continue

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `url(${cssUrlQuote(dataUrl)})`
    })
  }

  return applyStringReplacements(css, replacements)
}

function* walkNodes(tree: Node): Generator<Node> {
  const pending: Node[] = [tree]
  while (pending.length) {
    const node = pending.pop()!
    yield node
    for (const value of Object.values(node)) {
      const children = Array.isArray(value) ? value : [value]
      for (const child of children) {
        if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string" &&
          typeof child.start === "number"
        )
          pending.push(child as Node)
      }
    }
  }
}

async function inlineFetchLiteralUrls(
  js: string,
  htmlPath: string,
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>
): Promise<string> {
  if (!/\bfetch\s*\(/.test(js)) return js
  let tree: Node
  try {
    tree = parse(js, { ecmaVersion: "latest", sourceType: "module" })
  } catch {
    // Data scripts and invalid JS must be left intact; browser diagnostics own
    // syntax errors. Never rewrite fetch-like text in strings or comments.
    return js
  }
  const replacements: Array<{ start: number; end: number; value: string }> = []
  for (const node of walkNodes(tree)) {
    const call = node as Node & {
      callee?: { type: string; name?: string }
      arguments?: Array<Node & { value?: unknown }>
    }
    const argument = call.arguments?.[0]
    if (
      node.type === "CallExpression" &&
      call.callee?.type === "Identifier" &&
      call.callee.name === "fetch" &&
      argument?.type === "Literal" &&
      typeof argument.value === "string"
    ) {
      const resolved = resolveLocalAssetPath(htmlPath, argument.value, htmlPath)
      const dataUrl = resolved ? await readDataUrlWithCache(resolved) : null
      if (dataUrl)
        replacements.push({
          start: argument.start,
          end: argument.end,
          value: JSON.stringify(dataUrl)
        })
    }
  }
  return applyStringReplacements(js, replacements)
}

function splitSrcset(value: string): string[] {
  // URLs end at whitespace, not at the comma inside a data URL.
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
    parts.push(value.slice(start, index).trim())
  }
  return parts
}

async function inlineSrcsetUrls(
  value: string,
  htmlPath: string,
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>
): Promise<string> {
  const parts = splitSrcset(value)
  if (parts.length === 0) return value

  const inlined = await Promise.all(
    parts.map(async (part) => {
      const match = part.match(/^(\S+)([\s\S]*)$/)
      const rawUrl = match?.[1]?.trim()
      if (!rawUrl) return part

      const resolvedPath = resolveLocalAssetPath(htmlPath, rawUrl)
      if (!resolvedPath) return part

      const dataUrl = await readDataUrlWithCache(resolvedPath)
      if (!dataUrl) return part

      return `${dataUrl}${match?.[2] ?? ""}`
    })
  )

  return inlined.join(", ")
}

/**
 * 把 DOM 文档序列化回 HTML 字符串，并尽量保留标准文档形态。
 * 设计点：
 * - 优先保留 doctype，避免渲染进入 quirks mode。
 * - 若 `documentElement` 不存在（极少数异常输入），回退到 `body` 内容。
 *
 * @param doc 解析后的 HTML Document
 * @returns 可直接用于 `iframe.srcDoc` 的完整 HTML 字符串
 */
function serializeDocument(doc: Document): string {
  // 明确保留 doctype，避免样式/布局进入 quirks mode。
  const doctype = doc.doctype?.name ? `<!DOCTYPE ${doc.doctype.name}>` : "<!DOCTYPE html>"
  const htmlElement = doc.documentElement
  if (!htmlElement) return doc.body?.innerHTML ?? ""
  return `${doctype}\n${htmlElement.outerHTML}`
}

/**
 * 将 HTML 中的本地 CSS、JS 和其他依赖转换为 srcDoc 可加载的资源，返回可直接渲染的 srcDoc。
 *
 * 目标：
 * - 在 Electron 预览中彻底绕开 `file://` 外链限制。
 * - 仍然保持 HTML 主体结构不变，尽可能只替换依赖标签本身。
 *
 * 行为约束：
 * - 仅处理 HTML 所在目录下的相对路径依赖，且不允许读取目录之外的文件。
 * - 读取失败时静默跳过该依赖，不中断整体预览。
 * - 通过缓存避免同一依赖重复读取，降低 IPC/磁盘开销。
 *
 * @param options.html 原始 HTML 内容
 * @param options.htmlPath 当前 HTML 文件路径（用于解析同级依赖）
 * @param options.readTextFile 由调用方注入的读文件能力（通常来自 preload API）
 * @returns 内联后的 HTML；若缺少必要上下文则返回原始 HTML
 */
export async function buildDesignHtmlPreviewDocument({
  html,
  htmlPath,
  readTextFile,
  readDataUrlFile
}: DesignHtmlPreviewDocumentOptions): Promise<string> {
  if (!htmlPath || (!readTextFile && !readDataUrlFile)) return html

  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  const stylesheetLinks = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')
  )
  const scriptTags = Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))
  const inlineScriptTags = Array.from(doc.querySelectorAll<HTMLScriptElement>("script:not([src])"))
  const styleTags = Array.from(doc.querySelectorAll<HTMLStyleElement>("style"))
  const styledElements = Array.from(doc.querySelectorAll<HTMLElement>("[style]"))
  const srcElements = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "img[src], source[src], video[src], audio[src], track[src], input[src]"
    )
  )
  const posterElements = Array.from(doc.querySelectorAll<HTMLElement>("video[poster]"))
  const srcsetElements = Array.from(
    doc.querySelectorAll<HTMLElement>("img[srcset], source[srcset]")
  )
  const svgImageElements = Array.from(
    doc.querySelectorAll<SVGElement>("image[href], image[xlink\\:href]")
  )

  const readCache = new Map<string, Promise<string | null>>()
  /**
   * 带缓存的文本读取器。
   * 说明：
   * - 返回 Promise 而不是原始文本，保证并发调用时可复用同一个进行中的读取任务。
   * - 读取异常统一转为 `null`，让上层按“该资源不可用”处理即可。
   */
  const readWithCache = (resolvedPath: string): Promise<string | null> => {
    if (!readTextFile) return Promise.resolve(null)
    // 同一个依赖可能被多次引用，做一次缓存避免重复 IPC/磁盘读取。
    const cached = readCache.get(resolvedPath)
    if (cached) return cached
    const request = readTextFile(resolvedPath).catch(() => null)
    readCache.set(resolvedPath, request)
    return request
  }

  const dataUrlCache = new Map<string, Promise<string | null>>()
  const readDataUrlWithCache = (resolvedPath: string): Promise<string | null> => {
    if (!readDataUrlFile) return Promise.resolve(null)
    const cached = dataUrlCache.get(resolvedPath)
    if (cached) return cached
    const request = readDataUrlFile(resolvedPath).catch(() => null)
    dataUrlCache.set(resolvedPath, request)
    return request
  }

  const modulePaths = new Map<string, string>()
  const moduleImports: Record<string, string> = {}
  const moduleRoots: Array<{ script: HTMLScriptElement; key: string }> = []
  const registerModule = (filePath: string): string => {
    const key = `cmb-design-module:${encodeURIComponent(filePath)}`
    modulePaths.set(filePath, key)
    return key
  }
  const rewriteModuleReferences = (js: string, basePath: string): string => {
    if (!/\b(?:import|export)\b/.test(js)) return js
    let tree: Node
    try {
      tree = parse(js, { ecmaVersion: "latest", sourceType: "module" })
    } catch {
      return js
    }
    const replacements: Array<{ start: number; end: number; value: string }> = []
    for (const node of walkNodes(tree)) {
      if (
        ![
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression"
        ].includes(node.type)
      )
        continue
      const source = (node as Node & { source?: Node & { value?: unknown } }).source
      if (
        source?.type !== "Literal" ||
        typeof source.value !== "string" ||
        !/^\.\.?\//.test(source.value)
      )
        continue
      const resolved = resolveLocalAssetPath(basePath, source.value, htmlPath)
      if (!resolved) continue
      replacements.push({
        start: source.start,
        end: source.end,
        value: JSON.stringify(registerModule(resolved))
      })
    }
    return applyStringReplacements(js, replacements)
  }

  const inlineStylesheet = async (
    css: string,
    basePath: string,
    ancestors = new Set<string>([basePath])
  ): Promise<string> => {
    const replacements: Array<{ start: number; end: number; value: string }> = []
    const imports =
      /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi
    for (const match of css.matchAll(imports)) {
      const reference = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
      const condition = match[6].trim()
      // Preserve advanced layer/supports rules for the browser.
      if (/\b(?:layer|supports)\b/i.test(condition)) continue
      const resolved = resolveLocalAssetPath(basePath, reference, htmlPath)
      if (!resolved) continue
      let value = ""
      if (!ancestors.has(resolved)) {
        const importedCss = await readWithCache(resolved)
        if (importedCss == null) continue
        const inlined = await inlineStylesheet(
          importedCss,
          resolved,
          new Set([...ancestors, resolved])
        )
        value = condition ? `@media ${condition}{${inlined}}` : inlined
      }
      replacements.push({ start: match.index!, end: match.index! + match[0].length, value })
    }
    return inlineCssAssetUrls(
      applyStringReplacements(css, replacements),
      basePath,
      readDataUrlWithCache,
      htmlPath
    )
  }

  await Promise.all([
    ...stylesheetLinks.map(async (link) => {
      const href = link.getAttribute("href")
      if (!href || !readTextFile) return

      const resolvedPath = resolveLocalAssetPath(htmlPath, href)
      if (!resolvedPath) return

      const cssContent = await readWithCache(resolvedPath)
      if (cssContent == null) return

      // Keep the link node: media conditions, disabled, IDs and theme-switching
      // code depend on its native stylesheet interface.
      link.href = `data:text/css;base64,${encodeBase64(await inlineStylesheet(cssContent, resolvedPath))}`
      link.setAttribute("data-inline-from", href)
      link.removeAttribute("integrity")
    }),
    ...scriptTags.map(async (script) => {
      const src = script.getAttribute("src")
      if (!src || !readTextFile) return

      const resolvedPath = resolveLocalAssetPath(htmlPath, src)
      if (!resolvedPath) return

      const jsContent = await readWithCache(resolvedPath)
      if (jsContent == null) return

      if (script.getAttribute("type")?.trim().toLowerCase() === "module") {
        moduleRoots.push({ script, key: registerModule(resolvedPath) })
        script.setAttribute("data-inline-from", src)
        script.removeAttribute("integrity")
        return
      }

      // Retain external-script scheduling: turning a deferred head script into
      // inline code would run it before the controls it binds to exist.
      const patchedJs = await inlineFetchLiteralUrls(jsContent, htmlPath, readDataUrlWithCache)
      script.setAttribute(
        "src",
        `data:text/javascript;base64,${encodeBase64(rewriteModuleReferences(patchedJs, resolvedPath))}`
      )
      script.setAttribute("data-inline-from", src)
      script.removeAttribute("integrity")
    }),
    ...styleTags.map(async (style) => {
      const cssContent = style.textContent ?? ""
      if (!cssContent.trim()) return
      style.textContent = escapeInlineStyleContent(await inlineStylesheet(cssContent, htmlPath))
    }),
    ...styledElements.map(async (element) => {
      const styleValue = element.getAttribute("style")
      if (!styleValue) return
      element.setAttribute(
        "style",
        await inlineCssAssetUrls(styleValue, htmlPath, readDataUrlWithCache)
      )
    }),
    ...srcElements.map(async (element) => {
      const src = element.getAttribute("src")
      if (!src) return
      const resolvedPath = resolveLocalAssetPath(htmlPath, src)
      if (!resolvedPath) return
      const dataUrl = await readDataUrlWithCache(resolvedPath)
      if (dataUrl) element.setAttribute("src", dataUrl)
    }),
    ...posterElements.map(async (element) => {
      const poster = element.getAttribute("poster")
      if (!poster) return
      const resolvedPath = resolveLocalAssetPath(htmlPath, poster)
      if (!resolvedPath) return
      const dataUrl = await readDataUrlWithCache(resolvedPath)
      if (dataUrl) element.setAttribute("poster", dataUrl)
    }),
    ...srcsetElements.map(async (element) => {
      const srcset = element.getAttribute("srcset")
      if (!srcset) return
      element.setAttribute("srcset", await inlineSrcsetUrls(srcset, htmlPath, readDataUrlWithCache))
    }),
    ...svgImageElements.map(async (element) => {
      for (const attr of ["href", "xlink:href"]) {
        const href = element.getAttribute(attr)
        if (!href) continue
        const resolvedPath = resolveLocalAssetPath(htmlPath, href)
        if (!resolvedPath) continue
        const dataUrl = await readDataUrlWithCache(resolvedPath)
        if (dataUrl) element.setAttribute(attr, dataUrl)
      }
    }),
    ...inlineScriptTags.map(async (script) => {
      const jsContent = script.textContent ?? ""
      if (!jsContent.trim()) return
      script.textContent = escapeInlineScriptContent(
        rewriteModuleReferences(
          await inlineFetchLiteralUrls(jsContent, htmlPath, readDataUrlWithCache),
          htmlPath
        )
      )
    })
  ])

  // Import maps preserve module identity, including cycles, when local module
  // files are converted to data URLs. Process newly discovered imports once.
  for (const [filePath, key] of modulePaths) {
    const source = await readWithCache(filePath)
    if (source == null) continue
    const patched = rewriteModuleReferences(
      await inlineFetchLiteralUrls(source, htmlPath, readDataUrlWithCache),
      filePath
    )
    moduleImports[key] = `data:text/javascript;base64,${encodeBase64(patched)}`
  }
  if (Object.keys(moduleImports).length) {
    const importMap = doc.createElement("script")
    importMap.type = "importmap"
    importMap.textContent = escapeInlineScriptContent(JSON.stringify({ imports: moduleImports }))
    doc.head.prepend(importMap)
  }
  for (const { script, key } of moduleRoots) {
    if (moduleImports[key]) script.src = moduleImports[key]
  }

  return serializeDocument(doc)
}
