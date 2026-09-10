export interface StaticHtmlPreviewDocumentOptions {
  html: string
  htmlPath?: string
  readTextFile?: (resolvedPath: string) => Promise<string | null>
}

/** Compatibility adapter for design previews. The static builder preserves the
 * sibling-asset behavior while applying the UAT preview safety policy. */
export interface InlineHtmlSiblingAssetsOptions extends StaticHtmlPreviewDocumentOptions {
  readDataUrlFile?: (resolvedPath: string) => Promise<string | null>
}

export async function inlineHtmlSiblingAssets(
  options: InlineHtmlSiblingAssetsOptions
): Promise<string> {
  return buildStaticHtmlPreviewDocument(options)
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
 * 判断一个资源引用是否满足“同级相对路径”条件。
 * 允许示例：
 * - `a.css`
 * - `./app.js`
 *
 * 不允许示例：
 * - `/assets/a.css`（根路径）
 * - `../a.css`（上级目录）
 * - `dir/a.css`（子目录）
 * - `https://...`、`//...`（协议路径）
 * - `#anchor`（锚点）
 *
 * 设计目的：
 * - 严格收敛读取范围到 HTML 所在目录，降低越界读取风险。
 * - 符合“仅内联同级依赖”的产品约束，避免过度解析路径规则。
 *
 * @param value 资源引用字符串
 * @returns 是否为可内联的同级相对路径
 */
function isSameLevelRelativePath(value: string): boolean {
  // 只内联“同级相对路径”依赖：例如 ./a.css 或 a.js
  // 主动跳过绝对路径、协议路径、锚点、上级目录，避免越界读取与意外行为。
  const normalized = normalizeSlashes(stripQueryAndHash(value.trim()))
  if (!normalized) return false
  if (normalized.startsWith("#")) return false
  if (normalized.startsWith("/")) return false
  if (hasProtocol(normalized)) return false

  const withoutDotPrefix = normalized.startsWith("./") ? normalized.slice(2) : normalized
  if (!withoutDotPrefix) return false
  if (withoutDotPrefix.startsWith("../")) return false

  return !withoutDotPrefix.includes("/")
}

/**
 * 将 HTML 文件路径与依赖引用拼出“同级依赖”的绝对（或工作区内规范）路径。
 * 处理流程：
 * 1. 先校验依赖是否为同级相对路径，不符合则直接返回 `null`。
 * 2. 提取 HTML 所在目录。
 * 3. 将目录与依赖文件名拼接。
 *
 * 注意：
 * - 该函数不会处理 `../`、子目录、远程 URL 等复杂路径；这些在前置校验中已被拒绝。
 *
 * @param htmlPath 当前 HTML 文件路径
 * @param dependencyPath HTML 中引用的 `href/src`
 * @returns 可读取的依赖路径；若不满足规则则返回 `null`
 */
function resolveSiblingPath(htmlPath: string, dependencyPath: string): string | null {
  if (!isSameLevelRelativePath(dependencyPath)) return null

  const normalizedHtmlPath = normalizeSlashes(
    stripQueryAndHash(normalizeHtmlPathInput(htmlPath))
  )
  const normalizedDependencyPath = normalizeSlashes(stripQueryAndHash(dependencyPath)).replace(
    /^\.\/+/,
    ""
  )
  if (!normalizedDependencyPath || normalizedDependencyPath.includes("/")) return null

  // 再做一次“解码后校验”，防止 `%2F`、`%5C` 等编码在解码后引入路径层级。
  const decodedDependencyPath = normalizeSlashes(safeDecodeUri(normalizedDependencyPath))
  if (!decodedDependencyPath || decodedDependencyPath.includes("/")) return null

  const slashIndex = normalizedHtmlPath.lastIndexOf("/")
  if (slashIndex < 0) return decodedDependencyPath
  const directoryPath = normalizedHtmlPath.slice(0, slashIndex)

  return `${directoryPath}/${decodedDependencyPath}`
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

function escapeInlineStyleContent(content: string): string {
  // `style` is an HTML raw-text element. Escape a closing tag before serializing so CSS cannot
  // become markup only when the final srcDoc is parsed for a second time.
  return content.replace(/<\/style/gi, "\\3C /style")
}

const STATIC_HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ")

function hardenStaticHtmlDocument(doc: Document): void {
  doc
    .querySelectorAll(
      "script, iframe, frame, fencedframe, object, embed, portal, webview, applet, base, link[href]"
    )
    .forEach((element) => element.remove())
  for (const meta of Array.from(doc.querySelectorAll<HTMLMetaElement>("meta[http-equiv]"))) {
    const directive = meta.getAttribute("http-equiv")?.trim().toLowerCase()
    if (directive === "refresh" || directive === "content-security-policy") meta.remove()
  }
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  doc.querySelectorAll("a, area").forEach((element) => {
    element.removeAttribute("href")
    element.removeAttribute("xlink:href")
    element.removeAttribute("ping")
  })
  doc
    .querySelectorAll("form[action], button[formaction], input[formaction]")
    .forEach((element) => {
      element.removeAttribute("action")
      element.removeAttribute("formaction")
    })
  doc.querySelectorAll("[autoplay]").forEach((element) => element.removeAttribute("autoplay"))

  const policy = doc.createElement("meta")
  policy.setAttribute("http-equiv", "Content-Security-Policy")
  policy.setAttribute("content", STATIC_HTML_PREVIEW_CSP)
  doc.head.prepend(policy)
}

/**
 * 为工作目录文件标签构建静态 HTML 预览文档。
 *
 * 目标：
 * - 同级 CSS 通过受控文件读取内联，保留页面 UI 样式。
 * - 不执行脚本，也不允许网络、导航、表单、嵌套页面或插件内容。
 * - 永远返回已加固文档，调用方不得先把原始 HTML 放进 iframe。
 *
 * 行为约束：
 * - 仅处理同级相对 CSS（由 `isSameLevelRelativePath` 定义）。
 * - 读取失败时静默跳过该依赖，不中断整体预览。
 * - 所有 script 和其他主动内容都会在序列化前移除。
 *
 * @param options.html 原始 HTML 内容
 * @param options.htmlPath 当前 HTML 文件路径（用于解析同级依赖）
 * @param options.readTextFile 由调用方注入的读文件能力（通常来自 preload API）
 * @returns 可安全放入受限 iframe.srcDoc 的静态 HTML
 */
export async function buildStaticHtmlPreviewDocument({
  html,
  htmlPath,
  readTextFile
}: StaticHtmlPreviewDocumentOptions): Promise<string> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")

  // Only same-directory stylesheets may be loaded through the bounded workspace reader.
  const stylesheetLinks = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')
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
    const cached = readCache.get(resolvedPath)
    if (cached) return cached
    const request = readTextFile(resolvedPath).catch(() => null)
    readCache.set(resolvedPath, request)
    return request
  }

  if (htmlPath && readTextFile) {
    await Promise.all(
      stylesheetLinks.map(async (link) => {
        const href = link.getAttribute("href")
        if (!href) return

        const resolvedPath = resolveSiblingPath(htmlPath, href)
        if (!resolvedPath) return

        const cssContent = await readWithCache(resolvedPath)
        if (cssContent == null) return

        const styleTag = doc.createElement("style")
        styleTag.setAttribute("data-inline-from", href)
        styleTag.textContent = escapeInlineStyleContent(cssContent)
        link.replaceWith(styleTag)
      })
    )
  }

  // Reparse until serialization is stable. This closes mutation-XSS gaps where markup only
  // appears after a sanitized DOM is serialized and parsed again by iframe.srcDoc.
  let currentDocument = doc
  let previous = ""
  for (let pass = 0; pass < 4; pass += 1) {
    hardenStaticHtmlDocument(currentDocument)
    const serialized = serializeDocument(currentDocument)
    if (serialized === previous) return serialized
    previous = serialized
    currentDocument = parser.parseFromString(serialized, "text/html")
  }
  throw new Error("Static HTML preview did not reach a safe serialization fixed point")
}
