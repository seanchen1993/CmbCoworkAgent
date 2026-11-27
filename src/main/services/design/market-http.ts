import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import {
  DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES,
  type DesignMarketActor,
  type MarketCatalogQuery,
  type MarketCatalogResponse,
  type MarketCreateSystemDraftInput,
  type MarketCreateTemplateDraftInput,
  type MarketMyUploadsResponse,
  type MarketPublishSystemInput,
  type MarketPublishTemplateInput,
  type MarketSaveSystemDraftInput,
  type MarketSaveTemplateDraftInput,
  type MarketSystemDetail,
  type MarketTemplateDetail,
  type MarketTemplateVisibility
} from "../../../shared/design-market"
import { MARKETPLACE_API_PATH, marketplaceApiUrl, marketplaceEndpoints } from "../../../shared/marketplace-api"
import { DesignMarketService, MarketServiceError } from "./market-service"

const DESIGN_ROUTE = "/design"
const SYSTEM_TYPE = "design-system"
const TEMPLATE_TYPE = "design-template"

function designMarketRoute(pathname: string): string | null {
  const route = pathname.startsWith(MARKETPLACE_API_PATH + "/")
    ? pathname.slice(MARKETPLACE_API_PATH.length) : ""
  if (route === marketplaceEndpoints.list(SYSTEM_TYPE)) return "/catalog"
  if (route.startsWith(DESIGN_ROUTE + "/")) return route.slice(DESIGN_ROUTE.length)
  const download = /^\/download\/(design-system|design-template)\/([^/]+)$/.exec(route)
  if (!download) return null
  const kind = download[1] === SYSTEM_TYPE ? "system" : "template"
  return `/${kind}/${download[2]}/download`
}

export type VerifyMarketCredential = (credential: string) =>
  DesignMarketActor | null | Promise<DesignMarketActor | null>

async function readJsonBody(request: http.IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) {
      throw new MarketServiceError(422, "VALIDATION", "请求体过大")
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text.trim() ? JSON.parse(text) : {}
}

async function readRawBody(request: http.IncomingMessage, maxBytes = DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > maxBytes) {
    throw new MarketServiceError(422, "VALIDATION", "上传文件体积超出限制")
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) {
      throw new MarketServiceError(422, "VALIDATION", "上传文件体积超出限制")
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength
  })
  response.end(body)
}

export function createDesignMarketHttpServer(
  service: DesignMarketService,
  verifyCredential: VerifyMarketCredential
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1")
      const pathname = designMarketRoute(url.pathname)
      if (!pathname) {
        sendJson(response, 404, { code: "NOT_FOUND", error: "接口不存在" })
        return
      }
      const method = (request.method || "GET").toUpperCase()
      const credential = request.headers.authorization?.trim()
      const actor = credential ? await verifyCredential(credential) : null
      if (!actor) throw new MarketServiceError(401, "UNAUTHORIZED", "请先登录后再访问设计市场")

      if (method === "GET" && pathname === "/catalog") {
        const query: MarketCatalogQuery = {
          query: url.searchParams.get("query") || undefined,
          category: (url.searchParams.get("category") as MarketCatalogQuery["category"]) || undefined,
          sort: "recent"
        }
        const { systems, ...catalog } = service.listCatalog(query, actor)
        sendJson(response, 200, { ...catalog, type: SYSTEM_TYPE, items: systems })
        return
      }

      if (method === "GET" && pathname === "/my-uploads") {
        sendJson(response, 200, service.listMyUploads(actor))
        return
      }

      const systemDetailMatch = /^\/systems\/([^/]+)$/.exec(pathname)
      if (method === "GET" && systemDetailMatch) {
        sendJson(response, 200, service.getSystemDetail(decodeURIComponent(systemDetailMatch[1]), actor))
        return
      }

      const templateDetailMatch = /^\/templates\/([^/]+)$/.exec(pathname)
      if (method === "GET" && templateDetailMatch) {
        sendJson(response, 200, service.getTemplateDetail(decodeURIComponent(templateDetailMatch[1]), actor))
        return
      }

      if (method === "POST" && pathname === "/systems/draft") {
        const body = (await readJsonBody(request)) as MarketCreateSystemDraftInput
        sendJson(response, 201, service.createSystemDraft(body, actor))
        return
      }

      const systemDraftMatch = /^\/systems\/([^/]+)\/draft$/.exec(pathname)
      if (systemDraftMatch && method === "PUT") {
        const body = (await readJsonBody(request)) as Omit<MarketSaveSystemDraftInput, "systemId">
        sendJson(
          response,
          200,
          service.saveSystemDraft({ ...body, systemId: decodeURIComponent(systemDraftMatch[1]) }, actor)
        )
        return
      }
      if (systemDraftMatch && method === "DELETE") {
        sendJson(response, 200, service.discardSystemDraft(decodeURIComponent(systemDraftMatch[1]), actor))
        return
      }

      const systemPublishMatch = /^\/systems\/([^/]+)\/publish$/.exec(pathname)
      if (systemPublishMatch && method === "POST") {
        const body = (await readJsonBody(request)) as Omit<MarketPublishSystemInput, "systemId">
        sendJson(
          response,
          200,
          service.publishSystem({ ...body, systemId: decodeURIComponent(systemPublishMatch[1]) }, actor)
        )
        return
      }

      const systemStatusMatch = /^\/systems\/([^/]+)\/status$/.exec(pathname)
      if (systemStatusMatch && method === "POST") {
        const body = (await readJsonBody(request)) as { status: "published" | "unpublished" }
        sendJson(
          response,
          200,
          service.setSystemStatus(decodeURIComponent(systemStatusMatch[1]), body.status, actor)
        )
        return
      }

      if (method === "POST" && pathname === "/templates/stage") {
        const zipBuffer = await readRawBody(request)
        const entry = url.searchParams.get("entryPath") || undefined
        sendJson(response, 200, service.stageTemplateBlob(zipBuffer, actor, entry))
        return
      }

      if (method === "POST" && pathname === "/templates/draft") {
        const body = (await readJsonBody(request)) as MarketCreateTemplateDraftInput
        sendJson(response, 201, service.createTemplateDraft(body, actor))
        return
      }

      const templateDraftMatch = /^\/templates\/([^/]+)\/draft$/.exec(pathname)
      if (templateDraftMatch && method === "PUT") {
        const body = (await readJsonBody(request)) as Omit<MarketSaveTemplateDraftInput, "templateId">
        sendJson(
          response,
          200,
          service.saveTemplateDraft({ ...body, templateId: decodeURIComponent(templateDraftMatch[1]) }, actor)
        )
        return
      }
      if (templateDraftMatch && method === "DELETE") {
        sendJson(response, 200, service.discardTemplateDraft(decodeURIComponent(templateDraftMatch[1]), actor))
        return
      }

      const templatePublishMatch = /^\/templates\/([^/]+)\/publish$/.exec(pathname)
      if (templatePublishMatch && method === "POST") {
        const body = (await readJsonBody(request)) as Omit<MarketPublishTemplateInput, "templateId">
        sendJson(
          response,
          200,
          service.publishTemplate({ ...body, templateId: decodeURIComponent(templatePublishMatch[1]) }, actor)
        )
        return
      }

      const templateStatusMatch = /^\/templates\/([^/]+)\/status$/.exec(pathname)
      if (templateStatusMatch && method === "POST") {
        const body = (await readJsonBody(request)) as { status: "published" | "unpublished" }
        sendJson(
          response,
          200,
          service.setTemplateStatus(decodeURIComponent(templateStatusMatch[1]), body.status, actor)
        )
        return
      }

      const templateVisMatch = /^\/templates\/([^/]+)\/visibility$/.exec(pathname)
      if (templateVisMatch && method === "POST") {
        const body = (await readJsonBody(request)) as { visibility: MarketTemplateVisibility; reason?: string }
        sendJson(
          response,
          200,
          service.setTemplateVisibilityBySystemOwner(
            decodeURIComponent(templateVisMatch[1]),
            body.visibility,
            body.reason,
            actor
          )
        )
        return
      }

      const adminMatch = /^\/admin\/(system|template)\/([^/]+)\/(takedown|restore)$/.exec(pathname)
      if (adminMatch && method === "POST") {
        const body = (await readJsonBody(request)) as { reason: string }
        const kind = adminMatch[1] as "system" | "template"
        const id = decodeURIComponent(adminMatch[2])
        if (adminMatch[3] === "takedown") {
          service.adminTakedown(kind, id, body.reason || "", actor)
        } else {
          service.adminRestore(kind, id, body.reason || "", actor)
        }
        sendJson(response, 200, { success: true })
        return
      }

      const downloadMatch = /^\/(system|template)\/([^/]+)\/download$/.exec(pathname)
      if (downloadMatch && method === "GET") {
        const kind = downloadMatch[1] as "system" | "template"
        const assetId = decodeURIComponent(downloadMatch[2])
        const versionId = url.searchParams.get("versionId") || undefined
        const resolved = service.resolveDownloadBlob(kind, assetId, versionId, actor)
        response.writeHead(200, {
          "content-type": kind === "system" ? "text/markdown; charset=utf-8" : "application/zip",
          "content-length": resolved.blob.bytes,
          "x-content-sha256": resolved.blob.sha256,
          "x-version-id": resolved.blob.versionId,
          "x-version": resolved.blob.version
        })
        fs.createReadStream(resolved.blob.filePath)
          .on("error", () => response.destroy())
          .pipe(response)
        return
      }

      sendJson(response, 404, { code: "NOT_FOUND", error: "接口不存在" })
    } catch (error) {
      if (error instanceof MarketServiceError) {
        sendJson(response, error.statusCode, {
          code: error.code,
          error: error.message,
          conflictRevision: error.conflictRevision
        })
        return
      }
      sendJson(response, 500, {
        code: "INTERNAL",
        error: error instanceof Error ? error.message : "服务内部错误"
      })
    }
  })
}

export interface DesignMarketBackendTransport {
  listCatalog(query: MarketCatalogQuery, actor: DesignMarketActor | null): Promise<MarketCatalogResponse>
  getSystemDetail(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail>
  getTemplateDetail(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail>
  listMyUploads(actor: DesignMarketActor | null): Promise<MarketMyUploadsResponse>
  createSystemDraft(input: MarketCreateSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail>
  saveSystemDraft(input: MarketSaveSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail>
  discardSystemDraft(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail>
  publishSystem(input: MarketPublishSystemInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail>
  setSystemStatus(
    systemId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<{ detail: MarketSystemDetail; affectedTemplateCount: number }>
  stageTemplateBlob(
    zipBuffer: Buffer,
    actor: DesignMarketActor | null,
    preferredEntryPath?: string
  ): Promise<{
    sha256: string
    bytes: number
    pages: string[]
    defaultEntryPath: string
    filesCount: number
    totalBytes: number
    framework: string
    warnings: string[]
  }>
  createTemplateDraft(input: MarketCreateTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail>
  saveTemplateDraft(input: MarketSaveTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail>
  discardTemplateDraft(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail>
  publishTemplate(input: MarketPublishTemplateInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail>
  setTemplateStatus(
    templateId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail>
  setTemplateVisibilityBySystemOwner(
    templateId: string,
    visibility: MarketTemplateVisibility,
    reason: string | undefined,
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail>
  adminTakedown(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void>
  adminRestore(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void>
  openDownloadStream(
    kind: "system" | "template",
    assetId: string,
    versionId: string | undefined,
    actor: DesignMarketActor | null,
    signal: AbortSignal
  ): Promise<{
    stream: NodeJS.ReadableStream
    expectedBytes: number
    expectedSha256: string
    versionId: string
    version: string
  }>
}

export class LocalDesignMarketTransport implements DesignMarketBackendTransport {
  constructor(private readonly service: DesignMarketService) {}

  async listCatalog(query: MarketCatalogQuery, actor: DesignMarketActor | null): Promise<MarketCatalogResponse> {
    return this.service.listCatalog(query, actor)
  }
  async getSystemDetail(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.service.getSystemDetail(systemId, actor)
  }
  async getTemplateDetail(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.service.getTemplateDetail(templateId, actor)
  }
  async listMyUploads(actor: DesignMarketActor | null): Promise<MarketMyUploadsResponse> {
    return this.service.listMyUploads(actor)
  }
  async createSystemDraft(input: MarketCreateSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.service.createSystemDraft(input, actor)
  }
  async saveSystemDraft(input: MarketSaveSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.service.saveSystemDraft(input, actor)
  }
  async discardSystemDraft(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.service.discardSystemDraft(systemId, actor)
  }
  async publishSystem(input: MarketPublishSystemInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.service.publishSystem(input, actor)
  }
  async setSystemStatus(
    systemId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<{ detail: MarketSystemDetail; affectedTemplateCount: number }> {
    return this.service.setSystemStatus(systemId, status, actor)
  }
  async stageTemplateBlob(
    zipBuffer: Buffer,
    actor: DesignMarketActor | null,
    preferredEntryPath?: string
  ) {
    return this.service.stageTemplateBlob(zipBuffer, actor, preferredEntryPath)
  }
  async createTemplateDraft(input: MarketCreateTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.service.createTemplateDraft(input, actor)
  }
  async saveTemplateDraft(input: MarketSaveTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.service.saveTemplateDraft(input, actor)
  }
  async discardTemplateDraft(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.service.discardTemplateDraft(templateId, actor)
  }
  async publishTemplate(input: MarketPublishTemplateInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.service.publishTemplate(input, actor)
  }
  async setTemplateStatus(
    templateId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail> {
    return this.service.setTemplateStatus(templateId, status, actor)
  }
  async setTemplateVisibilityBySystemOwner(
    templateId: string,
    visibility: MarketTemplateVisibility,
    reason: string | undefined,
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail> {
    return this.service.setTemplateVisibilityBySystemOwner(templateId, visibility, reason, actor)
  }
  async adminTakedown(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void> {
    this.service.adminTakedown(kind, assetId, reason, actor)
  }
  async adminRestore(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void> {
    this.service.adminRestore(kind, assetId, reason, actor)
  }
  async openDownloadStream(
    kind: "system" | "template",
    assetId: string,
    versionId: string | undefined,
    actor: DesignMarketActor | null,
    signal: AbortSignal
  ): ReturnType<DesignMarketBackendTransport["openDownloadStream"]> {
    if (signal.aborted) {
      throw new Error("下载已取消")
    }
    const resolved = this.service.resolveDownloadBlob(kind, assetId, versionId, actor)
    const stream = fs.createReadStream(resolved.blob.filePath)
    return {
      stream,
      expectedBytes: resolved.blob.bytes,
      expectedSha256: resolved.blob.sha256,
      versionId: resolved.blob.versionId,
      version: resolved.blob.version
    }
  }
}

export class DesignMarketHttpClient implements DesignMarketBackendTransport {
  private readonly baseUrl: string | null

  constructor(
    baseUrl: string | undefined,
    private readonly readCredential: (actor: DesignMarketActor) => string | null
  ) {
    this.baseUrl = marketplaceApiUrl(baseUrl)
  }

  private url(pathname: string): URL {
    if (!this.baseUrl) throw new MarketServiceError(503, "OFFLINE", "插件市场服务地址未配置")
    const url = new URL(this.baseUrl + pathname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
      throw new MarketServiceError(503, "OFFLINE", "插件市场服务必须使用 HTTPS")
    }
    return url
  }

  private headers(actor: DesignMarketActor | null, extra: Record<string, string> = {}): Record<string, string> {
    const credential = actor ? this.readCredential(actor)?.trim() : null
    if (!credential) throw new MarketServiceError(401, "UNAUTHORIZED", "请登录后访问设计市场")
    return { ...extra, Authorization: credential }
  }

  private async requestJson<T>(
    method: string,
    pathname: string,
    actor: DesignMarketActor | null,
    body?: unknown
  ): Promise<T> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const response = await fetch(this.url(pathname), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: this.headers(
        actor,
        payload !== undefined ? { "content-type": "application/json" } : {}
      ),
      body: payload
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text.trim() ? JSON.parse(text) : {}
    } catch {
      throw new MarketServiceError(response.status, "OFFLINE", "插件市场未返回可用的设计市场响应")
    }
    if (!response.ok) {
      throw new MarketServiceError(
        response.status,
        parsed.code || "VALIDATION",
        parsed.error || `请求失败 (${response.status})`,
        parsed.conflictRevision
      )
    }
    return parsed as T
  }

  async listCatalog(query: MarketCatalogQuery, actor: DesignMarketActor | null): Promise<MarketCatalogResponse> {
    const params = new URLSearchParams()
    if (query.query) params.set("query", query.query)
    if (query.category) params.set("category", query.category)
    if (query.sort) params.set("sort", query.sort)
    const qs = params.toString()
    const { items, ...catalog } = await this.requestJson<Omit<MarketCatalogResponse, "systems"> & {
      items?: MarketCatalogResponse["systems"]
    }>("GET", `${marketplaceEndpoints.list(SYSTEM_TYPE)}${qs ? `?${qs}` : ""}`, actor)
    if (!Array.isArray(items) || typeof catalog.online !== "boolean") {
      throw new MarketServiceError(503, "OFFLINE", "插件市场服务尚未启用设计市场")
    }
    return { ...catalog, systems: items }
  }
  getSystemDetail(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.requestJson("GET", `/design/systems/${encodeURIComponent(systemId)}`, actor)
  }
  getTemplateDetail(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.requestJson("GET", `/design/templates/${encodeURIComponent(templateId)}`, actor)
  }
  listMyUploads(actor: DesignMarketActor | null): Promise<MarketMyUploadsResponse> {
    return this.requestJson("GET", "/design/my-uploads", actor)
  }
  createSystemDraft(input: MarketCreateSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.requestJson("POST", "/design/systems/draft", actor, input)
  }
  saveSystemDraft(input: MarketSaveSystemDraftInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.requestJson(
      "PUT",
      `/design/systems/${encodeURIComponent(input.systemId)}/draft`,
      actor,
      input
    )
  }
  discardSystemDraft(systemId: string, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.requestJson("DELETE", `/design/systems/${encodeURIComponent(systemId)}/draft`, actor)
  }
  publishSystem(input: MarketPublishSystemInput, actor: DesignMarketActor | null): Promise<MarketSystemDetail> {
    return this.requestJson(
      "POST",
      `/design/systems/${encodeURIComponent(input.systemId)}/publish`,
      actor,
      input
    )
  }
  setSystemStatus(
    systemId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<{ detail: MarketSystemDetail; affectedTemplateCount: number }> {
    return this.requestJson(
      "POST",
      `/design/systems/${encodeURIComponent(systemId)}/status`,
      actor,
      { status }
    )
  }
  async stageTemplateBlob(zipBuffer: Buffer, actor: DesignMarketActor | null, preferredEntryPath?: string) {
    const qs = preferredEntryPath ? `?entryPath=${encodeURIComponent(preferredEntryPath)}` : ""
    const response = await fetch(this.url(`/design/templates/stage${qs}`), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: this.headers(actor, { "content-type": "application/zip" }),
      body: new Uint8Array(zipBuffer)
    })
    const parsed = await response.json()
    if (!response.ok) {
      throw new MarketServiceError(response.status, parsed.code || "VALIDATION", parsed.error || "暂存失败")
    }
    return parsed
  }
  createTemplateDraft(input: MarketCreateTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.requestJson("POST", "/design/templates/draft", actor, input)
  }
  saveTemplateDraft(input: MarketSaveTemplateDraftInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.requestJson(
      "PUT",
      `/design/templates/${encodeURIComponent(input.templateId)}/draft`,
      actor,
      input
    )
  }
  discardTemplateDraft(templateId: string, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.requestJson("DELETE", `/design/templates/${encodeURIComponent(templateId)}/draft`, actor)
  }
  publishTemplate(input: MarketPublishTemplateInput, actor: DesignMarketActor | null): Promise<MarketTemplateDetail> {
    return this.requestJson(
      "POST",
      `/design/templates/${encodeURIComponent(input.templateId)}/publish`,
      actor,
      input
    )
  }
  setTemplateStatus(
    templateId: string,
    status: "published" | "unpublished",
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail> {
    return this.requestJson(
      "POST",
      `/design/templates/${encodeURIComponent(templateId)}/status`,
      actor,
      { status }
    )
  }
  setTemplateVisibilityBySystemOwner(
    templateId: string,
    visibility: MarketTemplateVisibility,
    reason: string | undefined,
    actor: DesignMarketActor | null
  ): Promise<MarketTemplateDetail> {
    return this.requestJson(
      "POST",
      `/design/templates/${encodeURIComponent(templateId)}/visibility`,
      actor,
      { visibility, reason }
    )
  }
  async adminTakedown(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `/design/admin/${kind}/${encodeURIComponent(assetId)}/takedown`,
      actor,
      { reason }
    )
  }
  async adminRestore(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    actor: DesignMarketActor | null
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `/design/admin/${kind}/${encodeURIComponent(assetId)}/restore`,
      actor,
      { reason }
    )
  }
  openDownloadStream(
    kind: "system" | "template",
    assetId: string,
    versionId: string | undefined,
    actor: DesignMarketActor | null,
    signal: AbortSignal
  ): Promise<{
    stream: NodeJS.ReadableStream
    expectedBytes: number
    expectedSha256: string
    versionId: string
    version: string
  }> {
    const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""
    const type = kind === "system" ? SYSTEM_TYPE : TEMPLATE_TYPE
    const target = this.url(`${marketplaceEndpoints.download(type, assetId)}${qs}`)
    const requester = target.protocol === "https:" ? https.request : http.request
    return new Promise((resolve, reject) => {
      const req = requester(
        target,
        {
          method: "GET",
          headers: this.headers(actor),
          signal
        },
        (res) => {
          const status = res.statusCode || 500
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = []
            res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            res.on("end", () => {
              let msg = `下载失败 (${status})`
              let code: MarketServiceError["code"] = "VALIDATION"
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
                if (body?.error) msg = body.error
                if (body?.code) code = body.code
              } catch {
                // ignore parse error
              }
              reject(new MarketServiceError(status, code, msg))
            })
            return
          }
          resolve({
            stream: res,
            expectedBytes: Number(res.headers["content-length"] || 0),
            expectedSha256: String(res.headers["x-content-sha256"] || ""),
            versionId: String(res.headers["x-version-id"] || versionId || ""),
            version: String(res.headers["x-version"] || "")
          })
        }
      )
      req.on("error", reject)
      req.setTimeout(30_000, () => req.destroy(new Error("设计市场下载超时")))
      req.end()
    })
  }
}
