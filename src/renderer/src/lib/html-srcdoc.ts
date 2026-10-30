import { HTML_PREVIEW_MESSAGE_TYPE } from "../../../shared/html-preview-runtime"

export interface HtmlPreviewDocumentOptions {
  html: string
  htmlPath?: string
  runtimeId: string
  readTextFile?: (resolvedPath: string) => Promise<string | null>
}

export interface HtmlPreviewDocument {
  srcDoc: string
  issues: string[]
}

/** Dependencies may live beside or below the HTML; absolute paths and parent traversal are denied. */
export function resolveHtmlPreviewDependency(htmlPath: string, reference: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(reference.trim().split(/[?#]/, 1)[0]).replace(/\\/g, "/")
  } catch {
    return null
  }
  if (!relative || relative.startsWith("/") || relative.includes(":")) return null
  if (Array.from(relative).some((character) => character.charCodeAt(0) < 32)) return null
  const parts = relative.split("/").filter((part) => part !== ".")
  if (parts.length === 0 || parts.some((part) => !part || part === "..")) return null
  const normalizedHtml = htmlPath.replace(/\\/g, "/")
  const directory = normalizedHtml.slice(0, normalizedHtml.lastIndexOf("/") + 1)
  return `${directory}${parts.join("/")}`
}

function serializeDocument(doc: Document): string {
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

function escapeInlineStyleContent(content: string): string {
  // External CSS must not become HTML after serializing the raw-text element.
  return content.replace(/<\/style/gi, "\\3C /style")
}

function javascriptDataUrl(content: string): string {
  const bytes = new TextEncoder().encode(content)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return `data:text/javascript;base64,${btoa(binary)}`
}

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data:",
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

function hardenHtmlDocument(doc: Document): void {
  doc
    .querySelectorAll(
      "iframe, frame, fencedframe, object, embed, portal, webview, applet, base, link[href]"
    )
    .forEach((element) => element.remove())
  for (const meta of Array.from(doc.querySelectorAll<HTMLMetaElement>("meta[http-equiv]"))) {
    const directive = meta.getAttribute("http-equiv")?.trim().toLowerCase()
    if (directive === "refresh" || directive === "content-security-policy") meta.remove()
  }
  doc.querySelectorAll("a, area").forEach((element) => {
    // Preserve in-page anchors. Electron also guards dynamically created links and location changes.
    for (const attribute of ["href", "xlink:href"]) {
      if (!element.getAttribute(attribute)?.startsWith("#")) element.removeAttribute(attribute)
    }
    element.removeAttribute("ping")
    element.removeAttribute("target")
  })
  doc.querySelectorAll("form[action], button[formaction], input[formaction]").forEach((element) => {
    element.removeAttribute("action")
    element.removeAttribute("formaction")
  })
  doc.querySelectorAll("[autoplay]").forEach((element) => element.removeAttribute("autoplay"))
  const policy = doc.createElement("meta")
  policy.setAttribute("http-equiv", "Content-Security-Policy")
  policy.setAttribute("content", HTML_PREVIEW_CSP)
  doc.head.prepend(policy)
}

function runtimeMonitor(runtimeId: string): string {
  // No page data or errors cross this boundary: only bounded status messages, never a host API.
  const identity = JSON.stringify({ type: HTML_PREVIEW_MESSAGE_TYPE, id: runtimeId }).replace(
    /</g,
    "\\u003c"
  )
  return `(() => {
    const identity = ${identity};
    const sent = new Set();
    const send = (kind) => {
      if (sent.has(kind)) return;
      sent.add(kind);
      parent.postMessage({ ...identity, kind }, "*");
    };
    addEventListener("error", (event) => send(event instanceof ErrorEvent ? "error" : "blocked"), true);
    addEventListener("unhandledrejection", () => send("error"));
    addEventListener("securitypolicyviolation", () => send("blocked"));
    addEventListener("DOMContentLoaded", () => send("ready"), { once: true });
  })();`
}

/**
 * Build a complete document before mounting the opaque-origin, script-enabled iframe.
 * CSS is inlined; local scripts use data URLs so defer/async/module and parser order survive.
 * Scripts and event handlers are preserved. Network and host privileges remain unavailable.
 */
export async function buildHtmlPreviewDocument({
  html,
  htmlPath,
  runtimeId,
  readTextFile
}: HtmlPreviewDocumentOptions): Promise<HtmlPreviewDocument> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  const issues: string[] = []
  const cache = new Map<string, Promise<string | null>>()
  const readDependency = async (reference: string): Promise<string | null> => {
    const path = htmlPath ? resolveHtmlPreviewDependency(htmlPath, reference) : null
    if (!path || !readTextFile) return null
    let request = cache.get(path)
    if (!request) {
      request = readTextFile(path).catch(() => null)
      cache.set(path, request)
    }
    return request
  }

  // Read in document order: bounded file budgets must not choose dependencies by disk timing.
  for (const element of Array.from(
    doc.querySelectorAll("link[rel~='stylesheet'][href], script[src]")
  )) {
    const isScript = element.localName === "script"
    const reference = element.getAttribute(isScript ? "src" : "href") ?? ""
    const content = await readDependency(reference)
    if (content === null) {
      if (issues.length < 5)
        issues.push(`无法加载${isScript ? "脚本" : "样式"}：${reference.slice(0, 160)}`)
      element.remove()
    } else if (isScript) {
      element.setAttribute("src", javascriptDataUrl(content))
      element.removeAttribute("integrity")
      element.removeAttribute("crossorigin")
    } else {
      const style = doc.createElement("style")
      style.textContent = escapeInlineStyleContent(content)
      const media = element.getAttribute("media")
      if (media) style.setAttribute("media", media)
      element.replaceWith(style)
    }
  }

  const monitor = doc.createElement("script")
  monitor.textContent = runtimeMonitor(runtimeId)
  doc.head.prepend(monitor)

  // Reach a serialization fixed point before iframe parsing (including CSS raw-text breakouts).
  let currentDocument = doc
  let previous = ""
  for (let pass = 0; pass < 4; pass += 1) {
    hardenHtmlDocument(currentDocument)
    const serialized = serializeDocument(currentDocument)
    if (serialized === previous) return { srcDoc: serialized, issues }
    previous = serialized
    currentDocument = parser.parseFromString(serialized, "text/html")
  }
  throw new Error("HTML 预览文档无法安全解析")
}
