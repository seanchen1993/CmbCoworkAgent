import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import {
  DESIGN_MARKET_CATEGORIES,
  DESIGN_MARKET_SCENARIOS,
  DESIGN_MARKET_SYSTEM_MAX_BYTES,
  DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES,
  normalizeMarketAccountId,
  type DesignMarketActor,
  type MarketCatalogQuery,
  type MarketCreateTemplateDraftInput,
  type MarketPublishSystemInput,
  type MarketPublishTemplateInput,
  type MarketSaveTemplateDraftInput,
  type MarketSystemDetail,
  type MarketSystemVersionRecord,
  type MarketTemplateDetail,
  type MarketTemplateVersionRecord,
  type MarketVersionRecord
} from "../../../shared/design-market"
import { normalizeSemVer, parseSemVer } from "../../../shared/design-market-semver"
import { marketplaceApiUrl, marketplaceEndpoints } from "../../../shared/marketplace-api"
import { LocalDesignMarketTransport } from "./market-http"
import {
  DesignMarketService,
  MarketServiceError,
  type MarketplaceSystemSnapshot,
  type MarketplaceTemplateSnapshot
} from "./market-service"
import { validatePalette } from "./market-validation"

const resourceTypes = { system: "design-system", template: "design-template" } as const
type Kind = keyof typeof resourceTypes
type Actor = DesignMarketActor | null
type MarketMetadata =
  | Omit<MarketSystemVersionRecord, keyof MarketVersionRecord | "markdown">
  | (Omit<MarketTemplateVersionRecord, keyof MarketVersionRecord> & { systemId: string })

interface MarketplaceItem {
  name?: string
  chinese_name?: string
  description?: string
  category?: string
  user_id?: string
  version?: string
  created_at?: string
  updated_at?: string
  extra_json?: string
  canDelete?: boolean
}

type MarketplaceCatalog = Record<Kind, MarketplaceItem[]>

function checkMetadata(item: MarketplaceItem, maxBytes: number) {
  const version = parseSemVer(item.version)
  const ownerId = normalizeMarketAccountId(item.user_id)
  if (!item.name || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.name) || !version || !ownerId) return null
  try {
    const data = JSON.parse(item.extra_json || "{}").designMarket
    if (
      !data ||
      typeof data.versionId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(data.versionId) ||
      !Number.isSafeInteger(data.bytes) ||
      data.bytes <= 0 ||
      data.bytes > maxBytes ||
      typeof data.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.sha256)
    )
      return null
    const ownerName = item.user_id?.split("/")[1]?.trim() || ownerId
    const record: MarketVersionRecord = {
      versionId: data.versionId,
      version: normalizeSemVer(item.version),
      bytes: data.bytes,
      sha256: data.sha256,
      changelog: typeof data.changelog === "string" ? data.changelog : "",
      createdAt: item.updated_at || item.created_at || "",
      createdById: ownerId,
      createdByName: ownerName
    }
    return { data, record, ownerId, ownerName }
  } catch {
    return null
  }
}

function readSystem(item: MarketplaceItem): MarketplaceSystemSnapshot | null {
  const parsed = checkMetadata(item, DESIGN_MARKET_SYSTEM_MAX_BYTES)
  const category = DESIGN_MARKET_CATEGORIES.find((value) => value === item.category)
  if (!parsed || !category) return null
  try {
    const palette = validatePalette(parsed.data.palette)
    return {
      systemId: item.name!,
      name: item.chinese_name || item.name!,
      description: item.description || "",
      category,
      ownerId: parsed.ownerId,
      ownerName: parsed.ownerName,
      palette,
      record: { ...parsed.record, markdown: "", palette }
    }
  } catch {
    return null
  }
}

function readTemplate(item: MarketplaceItem): MarketplaceTemplateSnapshot | null {
  const parsed = checkMetadata(item, DESIGN_MARKET_TEMPLATE_ZIP_MAX_BYTES)
  const scenario = DESIGN_MARKET_SCENARIOS.find((value) => value === item.category)
  if (!parsed || !scenario) return null
  const {
    systemId,
    minSystemVersion,
    defaultEntryPath,
    pages,
    filesCount,
    framework,
    coverDataUrl
  } = parsed.data
  if (
    typeof systemId !== "string" ||
    typeof minSystemVersion !== "string" ||
    !parseSemVer(minSystemVersion) ||
    typeof defaultEntryPath !== "string" ||
    !Array.isArray(pages) ||
    !pages.includes(defaultEntryPath) ||
    !pages.every((entry) => typeof entry === "string") ||
    !Number.isSafeInteger(filesCount) ||
    typeof framework !== "string" ||
    typeof coverDataUrl !== "string" ||
    (coverDataUrl &&
      !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(coverDataUrl))
  )
    return null
  return {
    templateId: item.name!,
    name: item.chinese_name || item.name!,
    description: item.description || "",
    scenario,
    systemId,
    ownerId: parsed.ownerId,
    ownerName: parsed.ownerName,
    record: {
      ...parsed.record,
      minSystemVersion,
      defaultEntryPath,
      pages,
      filesCount,
      framework,
      coverDataUrl
    }
  }
}

/** Drafts and validation stay local. Only published assets are stored by the shared marketplace. */
export class DesignMarketplaceTransport extends LocalDesignMarketTransport {
  private readonly baseUrl: string | null
  private readonly publishing = new Set<string>()
  private pendingCatalog?: { account: string; result: Promise<MarketplaceCatalog> }

  constructor(
    baseUrl: string | undefined,
    private readonly drafts: DesignMarketService,
    private readonly credential: (actor: DesignMarketActor) => string | null
  ) {
    super(drafts)
    this.baseUrl = marketplaceApiUrl(baseUrl)
  }

  private async request(route: string, actor: Actor, options: RequestInit = {}): Promise<Response> {
    if (!this.baseUrl) throw new MarketServiceError(503, "OFFLINE", "插件市场服务地址未配置")
    const token = actor && this.credential(actor)
    if (!token) throw new MarketServiceError(401, "UNAUTHORIZED", "请登录后访问设计市场")
    const url = new URL(this.baseUrl + route)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
      throw new MarketServiceError(503, "OFFLINE", "插件市场服务必须使用 HTTPS")
    }
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(30_000),
      headers: { Authorization: token }
    })
    if (!response.ok) {
      await response.body?.cancel()
      const code =
        response.status === 401
          ? "UNAUTHORIZED"
          : response.status === 403
            ? "FORBIDDEN"
            : response.status === 404
              ? "NOT_FOUND"
              : "VALIDATION"
      throw new MarketServiceError(response.status, code, `插件市场请求失败（${response.status}）`)
    }
    return response
  }

  private async list(kind: Kind, actor: Actor): Promise<MarketplaceItem[]> {
    const resourceType = resourceTypes[kind]
    const response = await this.request(marketplaceEndpoints.list(resourceType), actor)
    const listing = (await response.json()) as { type?: string; items?: MarketplaceItem[] }
    if (!Array.isArray(listing?.items) || (listing.type && listing.type !== resourceType)) {
      throw new MarketServiceError(503, "OFFLINE", "现有插件市场未返回此设计资源的列表")
    }
    return listing.items.filter((item) => item && typeof item === "object")
  }

  private refresh(actor: Actor): Promise<MarketplaceCatalog> {
    const account = actor?.userId ?? ""
    if (this.pendingCatalog?.account === account) return this.pendingCatalog.result
    const request = { account, result: this.loadCatalog(actor) }
    this.pendingCatalog = request
    return request.result.finally(() => {
      if (this.pendingCatalog === request) this.pendingCatalog = undefined
    })
  }

  private async loadCatalog(actor: Actor): Promise<MarketplaceCatalog> {
    const [systemRows, templateRows] = await Promise.all([
      this.list("system", actor),
      this.list("template", actor)
    ])
    const systems = systemRows.flatMap((item) => readSystem(item) ?? [])
    const templates = templateRows.flatMap((item) => readTemplate(item) ?? [])
    this.drafts.synchronizeMarketplace(systems, templates)
    return { system: systemRows, template: templateRows }
  }

  override async listCatalog(query: MarketCatalogQuery, actor: Actor) {
    await this.refresh(actor)
    const catalog = await super.listCatalog(query, actor)
    for (const item of catalog.systems) item.canManageTemplates = false
    return catalog
  }

  override async listMyUploads(actor: Actor) {
    await this.refresh(actor).catch(() => undefined)
    return { ...(await super.listMyUploads(actor)), notices: [] }
  }

  override async getSystemDetail(id: string, actor: Actor): Promise<MarketSystemDetail> {
    await this.refresh(actor)
    const detail = this.drafts.getSystemDetail(id, actor)
    const version = detail.versions.find((item) => item.versionId === detail.system.latestVersionId)
    if (version && detail.system.status === "published" && !version.markdown) {
      const bytes = await this.readAsset("system", id, version, actor)
      this.drafts.hydrateMarketplaceSystem(id, version.versionId, bytes.toString("utf8"))
    }
    const fresh = this.drafts.getSystemDetail(id, actor)
    if (fresh.system.canEdit && fresh.markdown && !fresh.draft) {
      return this.systemDetail(this.drafts.discardSystemDraft(id, actor))
    }
    return this.systemDetail(fresh)
  }

  private systemDetail(detail: MarketSystemDetail): MarketSystemDetail {
    detail.system.canManageTemplates = false
    detail.templates = detail.templates.map((item) => ({ ...item, canSystemOwnerManage: false }))
    detail.notices = []
    return detail
  }

  override async getTemplateDetail(id: string, actor: Actor): Promise<MarketTemplateDetail> {
    await this.refresh(actor)
    const detail = this.drafts.getTemplateDetail(id, actor)
    return detail.template.canEdit && detail.template.latestVersionId && !detail.draft
      ? this.drafts.discardTemplateDraft(id, actor)
      : detail
  }

  override async createTemplateDraft(input: MarketCreateTemplateDraftInput, actor: Actor) {
    await this.refresh(actor)
    return super.createTemplateDraft(input, actor)
  }

  override async saveTemplateDraft(input: MarketSaveTemplateDraftInput, actor: Actor) {
    const detail = this.drafts.getTemplateDetail(input.templateId, actor)
    const sha = input.stagedBlobSha256 || detail.draft?.stagedBlobSha256
    const version = detail.versions.find((item) => item.sha256 === sha)
    if (detail.template.canEdit && version && !this.drafts.marketplaceBlob(version.sha256)) {
      this.drafts.cacheMarketplaceBlob(
        await this.readAsset("template", input.templateId, version, actor)
      )
    }
    return super.saveTemplateDraft(input, actor)
  }

  private authorizeWrite(kind: Kind, id: string, actor: Actor, rows: MarketplaceCatalog) {
    const current = rows[kind].find((item) => item.name === id)
    if (
      !actor ||
      (current &&
        (normalizeMarketAccountId(current.user_id) !== actor.userId || current.canDelete === false))
    ) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有市场资产的上传者可以修改或下架")
    }
    return current
  }

  private async mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.publishing.has(id))
      throw new MarketServiceError(409, "CONFLICT", "此资产正在提交，请重试")
    this.publishing.add(id)
    try {
      return await action()
    } finally {
      this.publishing.delete(id)
    }
  }

  private async upload(
    kind: Kind,
    id: string,
    existing: boolean,
    actor: Actor,
    fields: {
      name: string
      description: string
      category: string
      record: MarketVersionRecord
      metadata: MarketMetadata
      file: Buffer
    }
  ): Promise<void> {
    const { name, description, category, record, metadata, file } = fields
    const form = new FormData()
    form.set("resource_type", resourceTypes[kind])
    form.set("name", id)
    form.set("chinese_name", name)
    form.set("description", description)
    form.set("category", category)
    form.set("version", record.version)
    form.set(
      "user_id",
      [actor?.userId, actor?.userName, actor?.orgName].filter(Boolean).join(" / ")
    )
    form.set(
      "extra_json",
      JSON.stringify({
        designMarket: {
          ...metadata,
          versionId: record.versionId,
          sha256: record.sha256,
          bytes: record.bytes,
          changelog: record.changelog
        }
      })
    )
    form.set(
      "file",
      new Blob([new Uint8Array(file)]),
      kind === "system" ? "DESIGN.md" : "template.zip"
    )
    const response = await this.request(existing ? this.itemRoute(kind, id) : "/upload", actor, {
      method: existing ? "PUT" : "POST",
      body: form,
      signal: AbortSignal.timeout(120_000)
    })
    await this.checkMutationResponse(response)
  }

  private async checkMutationResponse(response: Response): Promise<void> {
    const result = await response.text()
    const body = result.trim() ? JSON.parse(result) : null
    const status = typeof body?.status === "string" ? body.status.trim().toLowerCase() : ""
    if (body?.success === false || body?.ok === false || status === "fail" || status === "error") {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        body.error || body.detail || body.message || "插件市场提交失败"
      )
    }
  }

  private itemRoute(kind: Kind, id: string): string {
    return `/${resourceTypes[kind]}/${encodeURIComponent(id)}`
  }

  override publishSystem(
    input: MarketPublishSystemInput,
    actor: Actor
  ): Promise<MarketSystemDetail> {
    return this.mutate(input.systemId, async () => {
      const current = this.authorizeWrite(
        "system",
        input.systemId,
        actor,
        await this.refresh(actor)
      )
      const publication = this.drafts.prepareSystemPublication(input, actor)
      await this.upload("system", input.systemId, !!current, actor, {
        ...publication,
        metadata: { palette: publication.record.palette },
        file: Buffer.from(publication.record.markdown)
      })
      return this.systemDetail(publication.commit())
    })
  }

  override publishTemplate(
    input: MarketPublishTemplateInput,
    actor: Actor
  ): Promise<MarketTemplateDetail> {
    return this.mutate(input.templateId, async () => {
      const current = this.authorizeWrite(
        "template",
        input.templateId,
        actor,
        await this.refresh(actor)
      )
      const publication = this.drafts.prepareTemplatePublication(input, actor)
      const { minSystemVersion, defaultEntryPath, pages, filesCount, framework, coverDataUrl } =
        publication.record
      await this.upload("template", input.templateId, !!current, actor, {
        ...publication,
        category: publication.scenario,
        file: publication.zipBuffer,
        metadata: {
          systemId: publication.systemId,
          minSystemVersion,
          defaultEntryPath,
          pages,
          filesCount,
          framework,
          coverDataUrl
        }
      })
      return publication.commit()
    })
  }

  override async setSystemStatus(id: string, status: "unpublished" | "published", actor: Actor) {
    return this.mutate(id, async () => {
      await this.unpublish("system", id, status, actor)
      const result = await super.setSystemStatus(id, status, actor)
      return { ...result, detail: this.systemDetail(result.detail) }
    })
  }

  override async setTemplateStatus(id: string, status: "unpublished" | "published", actor: Actor) {
    return this.mutate(id, async () => {
      await this.unpublish("template", id, status, actor)
      return super.setTemplateStatus(id, status, actor)
    })
  }

  private async unpublish(
    kind: Kind,
    id: string,
    status: "unpublished" | "published",
    actor: Actor
  ) {
    if (status === "published") {
      throw new MarketServiceError(422, "VALIDATION", "请通过发布新版重新上架")
    }
    const current = this.authorizeWrite(kind, id, actor, await this.refresh(actor))
    if (!current) return
    const response = await this.request(this.itemRoute(kind, id), actor, { method: "DELETE" })
    await this.checkMutationResponse(response)
  }

  override async setTemplateVisibilityBySystemOwner(): Promise<MarketTemplateDetail> {
    throw new MarketServiceError(403, "FORBIDDEN", "现有市场接口仅支持上传者管理自己的资产")
  }

  override async adminTakedown(): Promise<void> {
    throw new MarketServiceError(403, "FORBIDDEN", "请通过插件市场的管理入口操作")
  }

  override async adminRestore(): Promise<void> {
    throw new MarketServiceError(403, "FORBIDDEN", "请通过插件市场的管理入口操作")
  }

  private async readAsset(
    kind: Kind,
    id: string,
    version: MarketVersionRecord,
    actor: Actor
  ): Promise<Buffer> {
    const response = await this.request(
      marketplaceEndpoints.download(resourceTypes[kind], id),
      actor
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error("市场文件为空")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > version.bytes) throw new Error("市场文件超过公布大小")
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const bytes = Buffer.concat(chunks)
    if (
      size !== version.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== version.sha256
    ) {
      throw new Error("市场文件与所选版本不一致，请刷新后重试")
    }
    return bytes
  }

  override async openDownloadStream(
    kind: Kind,
    id: string,
    versionId: string | undefined,
    actor: Actor,
    signal: AbortSignal
  ) {
    const rows = await this.refresh(actor)
    const item = rows[kind].find((entry) => entry.name === id)
    const version =
      item && (kind === "system" ? readSystem(item)?.record : readTemplate(item)?.record)
    if (!version || (versionId && version.versionId !== versionId)) {
      throw new MarketServiceError(404, "NOT_FOUND", "市场上的版本已更新，请刷新后重试")
    }
    if (
      kind === "template" &&
      this.drafts.getTemplateDetail(id, actor).template.effectiveStatus !== "published"
    ) {
      throw new MarketServiceError(403, "FORBIDDEN", "所属设计系统尚未上架")
    }
    const response = await this.request(
      marketplaceEndpoints.download(resourceTypes[kind], id),
      actor,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      }
    )
    if (!response.body) throw new Error("市场文件为空")
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      expectedBytes: version.bytes,
      expectedSha256: version.sha256,
      version: version.version,
      versionId: version.versionId
    }
  }
}
