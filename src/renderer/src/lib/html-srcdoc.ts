export interface InlineHtmlSiblingAssetsOptions {
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

/**
 * 判断一个资源引用是否满足“HTML 所在目录下的相对资源”条件。
 * 允许示例：
 * - `a.css`
 * - `./app.js`
 * - `assets/app.js`
 *
 * 不允许示例：
 * - `/assets/a.css`（根路径）
 * - `../a.css`（上级目录）
 * - `https://...`、`//...`（协议路径）
 * - `#anchor`（锚点）
 *
 * 设计目的：
 * - 严格收敛读取范围到 HTML 所在目录及其子目录，降低越界读取风险。
 * - 覆盖技能生成 `index.html + assets/*.js` 的多文件预览场景。
 *
 * @param value 资源引用字符串
 * @returns 是否为可内联的本地相对资源路径
 */
function isLocalRelativeAssetPath(value: string): boolean {
  // 只内联 HTML 所在目录下的相对依赖：例如 ./a.css、a.js、assets/app.js。
  // 主动跳过绝对路径、协议路径、锚点、上级目录，避免越界读取与意外行为。
  const normalized = normalizeSlashes(stripQueryAndHash(value.trim()))
  if (!normalized) return false
  if (normalized.startsWith("#")) return false
  if (normalized.startsWith("/")) return false
  if (hasProtocol(normalized)) return false

  const withoutDotPrefix = normalized.startsWith("./") ? normalized.slice(2) : normalized
  if (!withoutDotPrefix) return false
  if (withoutDotPrefix.startsWith("../")) return false

  const decoded = normalizeSlashes(safeDecodeUri(withoutDotPrefix))
  if (!decoded || decoded.startsWith("/") || decoded.startsWith("../")) return false

  const segments = decoded.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/**
 * 将 HTML 文件路径与依赖引用拼出本地相对依赖的绝对（或工作区内规范）路径。
 * 处理流程：
 * 1. 先校验依赖是否为本地相对资源路径，不符合则直接返回 `null`。
 * 2. 提取 HTML 所在目录。
 * 3. 将目录与依赖文件名拼接。
 *
 * 注意：
 * - 该函数不会处理 `../`、根路径、远程 URL 等越界路径；这些在前置校验中已被拒绝。
 *
 * @param htmlPath 当前 HTML 文件路径
 * @param dependencyPath HTML 中引用的 `href/src`
 * @returns 可读取的依赖路径；若不满足规则则返回 `null`
 */
function resolveLocalAssetPath(htmlPath: string, dependencyPath: string): string | null {
  if (!isLocalRelativeAssetPath(dependencyPath)) return null

  const normalizedHtmlPath = normalizeSlashes(
    stripQueryAndHash(normalizeHtmlPathInput(htmlPath))
  )
  const normalizedDependencyPath = normalizeSlashes(stripQueryAndHash(dependencyPath)).replace(
    /^\.\/+/,
    ""
  )
  if (!normalizedDependencyPath) return null

  // 再做一次“解码后校验”，防止 `%2F`、`%5C` 等编码在解码后引入路径层级。
  const decodedDependencyPath = normalizeSlashes(safeDecodeUri(normalizedDependencyPath))
  if (!isLocalRelativeAssetPath(decodedDependencyPath)) return null

  const slashIndex = normalizedHtmlPath.lastIndexOf("/")
  if (slashIndex < 0) return decodedDependencyPath
  const directoryPath = normalizedHtmlPath.slice(0, slashIndex)

  return `${directoryPath}/${decodedDependencyPath}`
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
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>
): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*?))\s*\)/gi

  for (const match of css.matchAll(urlPattern)) {
    if (match.index === undefined) continue
    const rawValue = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!rawValue) continue

    const resolvedPath = resolveLocalAssetPath(cssBasePath, rawValue)
    if (!resolvedPath) continue

    const dataUrl = await readDataUrlWithCache(resolvedPath)
    if (!dataUrl) continue

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `url(${cssUrlQuote(dataUrl)})`,
    })
  }

  return applyStringReplacements(css, replacements)
}

function jsStringQuote(quote: string, value: string): string {
  const safe = value.replace(/\\/g, "\\\\")
  return quote === "'" ? `'${safe.replace(/'/g, "\\'")}'` : `"${safe.replace(/"/g, '\\"')}"`
}

async function inlineFetchLiteralUrls(
  js: string,
  jsBasePath: string,
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>
): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const fetchPattern = /\bfetch\s*\(\s*(["'])([^"']+)\1/g

  for (const match of js.matchAll(fetchPattern)) {
    if (match.index === undefined) continue
    const quote = match[1]
    const rawValue = match[2]?.trim()
    if (!rawValue) continue

    const resolvedPath = resolveLocalAssetPath(jsBasePath, rawValue)
    if (!resolvedPath) continue

    const dataUrl = await readDataUrlWithCache(resolvedPath)
    if (!dataUrl) continue

    const urlStart = match.index + match[0].lastIndexOf(quote)
    const urlEnd = urlStart + quote.length + match[2].length + quote.length
    replacements.push({
      start: urlStart,
      end: urlEnd,
      value: jsStringQuote(quote, dataUrl),
    })
  }

  return applyStringReplacements(js, replacements)
}

function splitSrcset(value: string): string[] {
  const parts: string[] = []
  let current = ""
  let parenDepth = 0

  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === "(") parenDepth += 1
    if (char === ")" && parenDepth > 0) parenDepth -= 1

    if (char === "," && parenDepth === 0 && !current.trimStart().toLowerCase().startsWith("data:")) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

async function inlineSrcsetUrls(
  value: string,
  htmlPath: string,
  readDataUrlWithCache: (resolvedPath: string) => Promise<string | null>
): Promise<string> {
  const parts = splitSrcset(value)
  if (parts.length === 0) return value

  const inlined = await Promise.all(parts.map(async (part) => {
    const match = part.match(/^(\S+)([\s\S]*)$/)
    const rawUrl = match?.[1]?.trim()
    if (!rawUrl) return part

    const resolvedPath = resolveLocalAssetPath(htmlPath, rawUrl)
    if (!resolvedPath) return part

    const dataUrl = await readDataUrlWithCache(resolvedPath)
    if (!dataUrl) return part

    return `${dataUrl}${match?.[2] ?? ""}`
  }))

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
 * 将 HTML 中“本地相对 css/js 依赖”内联成 `style/script`，返回可直接渲染的 srcDoc。
 *
 * 目标：
 * - 在 Electron 预览中彻底绕开 `file://` 外链限制。
 * - 仍然保持 HTML 主体结构不变，尽可能只替换依赖标签本身。
 *
 * 行为约束：
 * - 仅处理 HTML 所在目录下的相对路径依赖（由 `isLocalRelativeAssetPath` 定义）。
 * - 读取失败时静默跳过该依赖，不中断整体预览。
 * - 通过缓存避免同一依赖重复读取，降低 IPC/磁盘开销。
 *
 * @param options.html 原始 HTML 内容
 * @param options.htmlPath 当前 HTML 文件路径（用于解析同级依赖）
 * @param options.readTextFile 由调用方注入的读文件能力（通常来自 preload API）
 * @returns 内联后的 HTML；若缺少必要上下文则返回原始 HTML
 */
export async function inlineHtmlSiblingAssets({
  html,
  htmlPath,
  readTextFile,
  readDataUrlFile
}: InlineHtmlSiblingAssetsOptions): Promise<string> {
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
    doc.querySelectorAll<HTMLElement>("img[src], source[src], video[src], audio[src], track[src], input[src]")
  )
  const posterElements = Array.from(doc.querySelectorAll<HTMLElement>("video[poster]"))
  const srcsetElements = Array.from(doc.querySelectorAll<HTMLElement>("img[srcset], source[srcset]"))
  const svgImageElements = Array.from(doc.querySelectorAll<SVGElement>("image[href], image[xlink\\:href]"))

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

  await Promise.all([
    ...stylesheetLinks.map(async (link) => {
      const href = link.getAttribute("href")
      if (!href || !readTextFile) return

      const resolvedPath = resolveLocalAssetPath(htmlPath, href)
      if (!resolvedPath) return

      const cssContent = await readWithCache(resolvedPath)
      if (cssContent == null) return

      const styleTag = doc.createElement("style")
      styleTag.setAttribute("data-inline-from", href)
      styleTag.textContent = await inlineCssAssetUrls(cssContent, resolvedPath, readDataUrlWithCache)
      link.replaceWith(styleTag)
    }),
    ...scriptTags.map(async (script) => {
      const src = script.getAttribute("src")
      if (!src || !readTextFile) return

      const resolvedPath = resolveLocalAssetPath(htmlPath, src)
      if (!resolvedPath) return

      const jsContent = await readWithCache(resolvedPath)
      if (jsContent == null) return

      const inlineScript = doc.createElement("script")
      const type = script.getAttribute("type")
      if (type) inlineScript.setAttribute("type", type)
      if (script.hasAttribute("nomodule")) inlineScript.setAttribute("nomodule", "")
      inlineScript.setAttribute("data-inline-from", src)
      // 防止脚本内容中的 </script> 提前截断标签。
      const patchedJs = await inlineFetchLiteralUrls(jsContent, resolvedPath, readDataUrlWithCache)
      inlineScript.textContent = escapeInlineScriptContent(patchedJs)
      script.replaceWith(inlineScript)
    }),
    ...styleTags.map(async (style) => {
      const cssContent = style.textContent ?? ""
      if (!cssContent.trim()) return
      style.textContent = await inlineCssAssetUrls(cssContent, htmlPath, readDataUrlWithCache)
    }),
    ...styledElements.map(async (element) => {
      const styleValue = element.getAttribute("style")
      if (!styleValue) return
      element.setAttribute("style", await inlineCssAssetUrls(styleValue, htmlPath, readDataUrlWithCache))
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
        await inlineFetchLiteralUrls(jsContent, htmlPath, readDataUrlWithCache)
      )
    }),
  ])

  return serializeDocument(doc)
}
