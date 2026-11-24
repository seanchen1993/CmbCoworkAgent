import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { session, type Session } from "electron"
import { parse } from "parse5"
import {
  DESIGN_ASSET_RUNTIME_PATH,
  DESIGN_ASSET_SCHEME,
  type DesignAssetPreviewTicket
} from "../../../shared/design-package"
import { decorateDesignNodes, designAttr } from "../../../shared/design-node-ids"
import { applyHtmlSourceEdits, htmlElements } from "../../../shared/design-html-mutations"
import { parseMediaByteRange } from "../../workspace-file-preview/media-protocol"
import { normalizePackageRelativePath } from "./streaming-zip"
import { buildDesignCanvasRuntimeScript } from "./canvas-runtime-script"

const ASSET_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
}

export type DesignAssetTokenKind = "canvas" | "draft" | "validation"

export interface DesignAssetTokenEntry {
  token: string
  ownerId: number
  sessionId: string
  kind: DesignAssetTokenKind
  packageRoot: string
  entryPath: string
  previewInstanceId: string
  revision: number
  draft?: { runId: string; revision: number }
  getEntryHtml: () => string | null
}

function insideRealRoot(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget)
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export function preparePreviewEntryHtml(
  rawHtml: string,
  options: {
    kind: DesignAssetTokenKind
    previewInstanceId: string
    revision: number
    origin?: string
    draft?: { runId: string; revision: number }
  }
): string {
  if (options.kind === "validation") {
    return rawHtml
  }

  let html = options.kind === "canvas" ? decorateDesignNodes(rawHtml) : rawHtml
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const all = htmlElements(doc)
  const edits: Array<{ start: number; end: number; value: string }> = []

  if (options.kind === "draft") {
    for (const el of all) {
      const loc = el.sourceCodeLocation
      if (!loc) continue
      const isForbiddenScript =
        el.tagName === "script" &&
        designAttr(el, "type") !== "application/design-tweaks+json"
      const isForbiddenTag = ["iframe", "object", "embed"].includes(el.tagName)
      const isMetaEquiv = el.tagName === "meta" && designAttr(el, "http-equiv") !== undefined
      const isFileBase =
        el.tagName === "base" && /^file:/i.test((designAttr(el, "href") ?? "").trim())
      if (isForbiddenScript || isForbiddenTag || isMetaEquiv || isFileBase) {
        edits.push({ start: loc.startOffset, end: loc.endOffset, value: "" })
        continue
      }
      for (const attr of el.attrs) {
        if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value.trim())) {
          const attrLoc = loc.attrs?.[attr.name]
          if (attrLoc) edits.push({ start: attrLoc.startOffset, end: attrLoc.endOffset, value: "" })
        }
      }
    }
  } else {
    for (const el of all) {
      const loc = el.sourceCodeLocation
      if (!loc) continue
      const isCspMeta =
        el.tagName === "meta" &&
        (designAttr(el, "http-equiv") ?? "").trim().toLowerCase() === "content-security-policy"
      const isFileBase =
        el.tagName === "base" && /^file:/i.test((designAttr(el, "href") ?? "").trim())
      const isOldHostRuntime =
        el.tagName === "script" && designAttr(el, "data-design-host-runtime") !== undefined
      if (isCspMeta || isFileBase || isOldHostRuntime) {
        edits.push({ start: loc.startOffset, end: loc.endOffset, value: "" })
      }
    }
  }

  const rootEl = all.find((el) => el.tagName === "html")
  const hasExplicitHtmlTag = Boolean(rootEl?.sourceCodeLocation?.startTag)
  const previewAttrs = [
    `data-design-preview-instance="${options.previewInstanceId}"`,
    `data-design-artifact-revision="${options.revision}"`,
    ...(options.kind === "draft" && options.draft
      ? [
          `data-design-preview-draft="1"`,
          `data-design-preview-run="${options.draft.runId.replace(/"/g, "")}"`,
          `data-design-preview-revision="${options.draft.revision}"`
        ]
      : [])
  ].join(" ")
  const scriptSrc = `${options.origin ?? ""}/${DESIGN_ASSET_RUNTIME_PATH}`
  const scriptTag = `<script data-design-host-runtime="canvas" src="${scriptSrc}"></script>`

  if (!hasExplicitHtmlTag) {
    html = applyHtmlSourceEdits(html, edits)
    return `<!DOCTYPE html><html ${previewAttrs}><head></head><body>${html}${scriptTag}</body></html>`
  }

  if (rootEl?.sourceCodeLocation?.startTag) {
    const startTag = rootEl.sourceCodeLocation.startTag
    const existingPreviewAttrs = rootEl.attrs.filter((a) =>
      a.name.startsWith("data-design-preview") || a.name === "data-design-artifact-revision"
    )
    for (const attr of existingPreviewAttrs) {
      const attrLoc = rootEl.sourceCodeLocation.attrs?.[attr.name]
      if (attrLoc) edits.push({ start: attrLoc.startOffset, end: attrLoc.endOffset, value: "" })
    }
    const insertAt = startTag.endOffset - (html[startTag.endOffset - 2] === "/" ? 2 : 1)
    edits.push({ start: insertAt, end: insertAt, value: ` ${previewAttrs}` })
  }

  const bodyEl = all.find((el) => el.tagName === "body")
  if (bodyEl?.sourceCodeLocation?.endTag) {
    const offset = bodyEl.sourceCodeLocation.endTag.startOffset
    edits.push({ start: offset, end: offset, value: scriptTag })
  } else if (rootEl?.sourceCodeLocation?.endTag) {
    const offset = rootEl.sourceCodeLocation.endTag.startOffset
    edits.push({ start: offset, end: offset, value: scriptTag })
  } else {
    edits.push({ start: html.length, end: html.length, value: scriptTag })
  }

  return applyHtmlSourceEdits(html, edits)
}

export class DesignAssetRegistry {
  private readonly entries = new Map<string, DesignAssetTokenEntry>()
  private readonly packageRefs = new Map<string, number>()
  private onPackageReleased?: (packageRoot: string) => void

  setOnPackageReleased(listener: (packageRoot: string) => void): void {
    this.onPackageReleased = listener
  }

  issue(input: {
    ownerId: number
    sessionId: string
    kind: DesignAssetTokenKind
    packageRoot: string
    entryPath: string
    revision: number
    draft?: { runId: string; revision: number }
    getEntryHtml: () => string | null
  }): DesignAssetPreviewTicket {
    // Token MUST be lowercase hex because standard schemes normalize hostnames to lowercase.
    const token = randomUUID().replace(/-/g, "").toLowerCase()
    const previewInstanceId = randomUUID()
    const resolvedRoot = path.resolve(input.packageRoot)
    const entryPath = normalizePackageRelativePath(input.entryPath)

    const entry: DesignAssetTokenEntry = {
      token,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      kind: input.kind,
      packageRoot: resolvedRoot,
      entryPath,
      previewInstanceId,
      revision: input.revision,
      draft: input.draft,
      getEntryHtml: input.getEntryHtml
    }
    this.entries.set(token, entry)
    this.packageRefs.set(resolvedRoot, (this.packageRefs.get(resolvedRoot) ?? 0) + 1)

    const origin = `${DESIGN_ASSET_SCHEME}://${token}`
    const encodedPath = entryPath.split("/").map(encodeURIComponent).join("/")
    return {
      url: `${origin}/${encodedPath}`,
      origin,
      token,
      previewInstanceId,
      revision: input.revision
    }
  }

  get(token: string): DesignAssetTokenEntry | null {
    return this.entries.get(token.toLowerCase()) ?? null
  }

  revoke(token: string): boolean {
    const normalized = token.toLowerCase()
    const entry = this.entries.get(normalized)
    if (!entry) return false
    this.entries.delete(normalized)
    const next = (this.packageRefs.get(entry.packageRoot) ?? 1) - 1
    if (next <= 0) {
      this.packageRefs.delete(entry.packageRoot)
      this.onPackageReleased?.(entry.packageRoot)
    } else {
      this.packageRefs.set(entry.packageRoot, next)
    }
    return true
  }

  revokeOwner(ownerId: number): void {
    for (const [token, entry] of [...this.entries.entries()]) {
      if (entry.ownerId === ownerId) this.revoke(token)
    }
  }

  revokeSession(sessionId: string, kind?: DesignAssetTokenKind, ownerId?: number): void {
    for (const [token, entry] of [...this.entries.entries()]) {
      if (
        entry.sessionId === sessionId &&
        (kind === undefined || entry.kind === kind) &&
        (ownerId === undefined || entry.ownerId === ownerId)
      ) {
        this.revoke(token)
      }
    }
  }

  isPackageInUse(dirPath: string): boolean {
    const resolved = path.resolve(dirPath)
    for (const activeRoot of this.packageRefs.keys()) {
      if (activeRoot === resolved || activeRoot.startsWith(resolved + path.sep)) return true
    }
    return false
  }

  isAuthorizedEntryNavigation(rawUrl: string, ownerId: number): boolean {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== `${DESIGN_ASSET_SCHEME}:`) return false
      const entry = this.get(parsed.hostname)
      if (!entry || entry.ownerId !== ownerId) return false
      const requestedRelative = normalizePackageRelativePath(
        decodeURIComponent(parsed.pathname).replace(/^\/+/, "")
      )
      return requestedRelative === entry.entryPath
    } catch {
      return false
    }
  }

  clear(): void {
    this.entries.clear()
    this.packageRefs.clear()
  }
}

export const designAssetRegistry = new DesignAssetRegistry()

let protocolRegistered = false
const registeredSessions = new WeakSet<Session>()

export async function handleDesignAssetProtocolRequest(
  request: Request,
  registry: DesignAssetRegistry = designAssetRegistry
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 })
  }

  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return new Response("Invalid design asset URL", { status: 400 })
  }
  if (parsed.protocol !== `${DESIGN_ASSET_SCHEME}:`) {
    return new Response("Unsupported scheme", { status: 400 })
  }

  const entry = registry.get(parsed.hostname)
  if (!entry) {
    return new Response("Asset session expired", { status: 410 })
  }

  let relativePath: string
  try {
    relativePath = normalizePackageRelativePath(
      decodeURIComponent(parsed.pathname).replace(/^\/+/, "")
    )
  } catch {
    return new Response("Invalid asset path", { status: 404 })
  }

  if (relativePath === DESIGN_ASSET_RUNTIME_PATH) {
    const script = buildDesignCanvasRuntimeScript()
    const bytes = Buffer.from(script, "utf8")
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff"
      }
    })
  }

  if (relativePath === entry.entryPath) {
    const sourceHtml = entry.getEntryHtml()
    if (!sourceHtml) {
      return new Response("Entry HTML unavailable", { status: 404 })
    }
    const prepared = preparePreviewEntryHtml(sourceHtml, {
      kind: entry.kind,
      previewInstanceId: entry.previewInstanceId,
      revision: entry.revision,
      origin: `${DESIGN_ASSET_SCHEME}://${entry.token}`,
      draft: entry.draft
    })
    const bytes = Buffer.from(prepared, "utf8")
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
      }
    })
  }

  let realRoot: string
  let realFile: string
  let stat: fs.Stats
  try {
    realRoot = fs.realpathSync(entry.packageRoot)
    const candidate = path.join(entry.packageRoot, relativePath)
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      return new Response("Symbolic links not allowed", { status: 404 })
    }
    realFile = fs.realpathSync(candidate)
    if (!insideRealRoot(realRoot, realFile)) {
      return new Response("Forbidden", { status: 404 })
    }
    stat = fs.statSync(realFile)
    if (!stat.isFile()) {
      return new Response("Not found", { status: 404 })
    }
  } catch {
    return new Response("Not found", { status: 404 })
  }

  const range = parseMediaByteRange(request.headers.get("range"), stat.size)
  if (range && "invalid" in range) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${stat.size}`, "accept-ranges": "bytes" }
    })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, stat.size - 1)
  const contentLength = stat.size === 0 ? 0 : end - start + 1
  const mimeType = ASSET_MIME[path.extname(realFile).toLowerCase()] ?? "application/octet-stream"

  const headers = new Headers()
  headers.set("content-type", mimeType)
  headers.set("content-length", String(contentLength))
  headers.set("accept-ranges", "bytes")
  if (range && !("invalid" in range)) {
    headers.set("content-range", `bytes ${start}-${end}/${stat.size}`)
  }
  headers.set("cache-control", "no-store")
  headers.set("access-control-allow-origin", "*")
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "no-referrer")

  const body =
    request.method === "HEAD" || stat.size === 0
      ? null
      : (Readable.toWeb(fs.createReadStream(realFile, { start, end })) as ReadableStream)

  return new Response(body, {
    status: range ? 206 : 200,
    headers
  })
}

export function registerDesignAssetProtocolOnSession(targetSession: Session): void {
  if (registeredSessions.has(targetSession)) return
  registeredSessions.add(targetSession)
  targetSession.protocol.handle(DESIGN_ASSET_SCHEME, (request) =>
    handleDesignAssetProtocolRequest(request)
  )
}

export function registerDesignAssetProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  registerDesignAssetProtocolOnSession(session.defaultSession)
}

export function closeDesignAssetProtocol(): void {
  designAssetRegistry.clear()
  if (protocolRegistered) {
    try {
      session.defaultSession.protocol.unhandle(DESIGN_ASSET_SCHEME)
    } catch {
      // Ignore if session already torn down.
    }
  }
  protocolRegistered = false
}
