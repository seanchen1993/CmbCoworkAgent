import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import AdmZip from "adm-zip"
import {
  DESIGN_MARKET_CATEGORIES,
  DESIGN_MARKET_SCENARIOS,
  DESIGN_MARKET_SYSTEM_MAX_BYTES,
  normalizeMarketAccountId,
  type DesignMarketActor,
  type DesignMarketCategory,
  type DesignMarketScenario,
  type MarketAssetStatus,
  type MarketAuditRecord,
  type MarketCatalogQuery,
  type MarketCatalogResponse,
  type MarketCreateSystemDraftInput,
  type MarketCreateTemplateDraftInput,
  type MarketGovernanceNotice,
  type MarketMyUploadsResponse,
  type MarketPublishSystemInput,
  type MarketPublishTemplateInput,
  type MarketSaveSystemDraftInput,
  type MarketSaveTemplateDraftInput,
  type MarketSystemDetail,
  type MarketSystemDraft,
  type MarketSystemPalette,
  type MarketSystemSummary,
  type MarketSystemVersionRecord,
  type MarketTemplateDetail,
  type MarketTemplateDraft,
  type MarketTemplateEffectiveStatus,
  type MarketTemplateSummary,
  type MarketTemplateVersionRecord,
  type MarketTemplateVisibility
} from "../../../shared/design-market"
import {
  compareSemVer,
  isHigherSemVer,
  isSystemVersionCompatible,
  normalizeSemVer
} from "../../../shared/design-market-semver"
import {
  buildFallbackTemplateCoverSvg,
  extractDesignSystemPalette,
  validatePalette,
  inspectTemplateZipBuffer,
  validateTemplateZipBuffer
} from "./market-validation"

export class MarketServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "OFFLINE",
    message: string,
    readonly conflictRevision?: number
  ) {
    super(message)
    this.name = "MarketServiceError"
  }
}

interface StoredSystemEntity {
  systemId: string
  name: string
  description: string
  category: DesignMarketCategory
  ownerId: string
  ownerName: string
  palette: MarketSystemPalette
  status: MarketAssetStatus
  statusBeforeAdminRemoval?: "published" | "unpublished"
  latestVersionId: string | null
  highestPublishedVersion: string | null
  versions: MarketSystemVersionRecord[]
  draft: MarketSystemDraft | null
  draftRevision: number
  createdAt: string
  updatedAt: string
}

interface StoredTemplateEntity {
  templateId: string
  systemId: string
  name: string
  description: string
  scenario: DesignMarketScenario
  ownerId: string
  ownerName: string
  status: MarketAssetStatus
  statusBeforeAdminRemoval?: "published" | "unpublished"
  visibility: MarketTemplateVisibility
  visibilityReason?: string
  latestVersionId: string | null
  highestPublishedVersion: string | null
  versions: MarketTemplateVersionRecord[]
  draft: MarketTemplateDraft | null
  draftRevision: number
  createdAt: string
  updatedAt: string
}

export type MarketplaceSystemSnapshot = Pick<
  StoredSystemEntity, "systemId" | "name" | "description" | "category" | "ownerId" | "ownerName" | "palette"
> & { record: MarketSystemVersionRecord }

export type MarketplaceTemplateSnapshot = Pick<
  StoredTemplateEntity, "templateId" | "systemId" | "name" | "description" | "scenario" | "ownerId" | "ownerName"
> & { record: MarketTemplateVersionRecord }

interface MarketStateFile {
  version: number
  systems: Record<string, StoredSystemEntity>
  templates: Record<string, StoredTemplateEntity>
  notices: MarketGovernanceNotice[]
  audits: MarketAuditRecord[]
}

export interface MarketBlobDescriptor {
  sha256: string
  bytes: number
  filePath: string
  filename: string
  versionId: string
  version: string
}

function assertCategory(raw: unknown): DesignMarketCategory {
  if (typeof raw === "string" && (DESIGN_MARKET_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as DesignMarketCategory
  }
  throw new MarketServiceError(
    422,
    "VALIDATION",
    `分类无效，仅支持：${DESIGN_MARKET_CATEGORIES.join("、")}`
  )
}

function assertScenario(raw: unknown): DesignMarketScenario {
  if (typeof raw === "string" && (DESIGN_MARKET_SCENARIOS as readonly string[]).includes(raw)) {
    return raw as DesignMarketScenario
  }
  throw new MarketServiceError(
    422,
    "VALIDATION",
    `场景无效，仅支持：${DESIGN_MARKET_SCENARIOS.join("、")}`
  )
}

function validateMarkdown(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new MarketServiceError(422, "VALIDATION", "设计规范内容不能为空")
  }
  if (Buffer.byteLength(raw, "utf8") > DESIGN_MARKET_SYSTEM_MAX_BYTES) {
    throw new MarketServiceError(422, "VALIDATION", "设计规范文件不能超过 1 MB")
  }
  if (raw.includes("\0") || raw.includes("\ufffd")) {
    throw new MarketServiceError(422, "VALIDATION", "设计规范必须是有效的 UTF-8 Markdown 文本")
  }
  return raw.replace(/^\uFEFF/, "")
}

function validateCoverDataUrl(raw: unknown): string {
  if (typeof raw !== "string" || !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
    throw new MarketServiceError(422, "VALIDATION", "模板封面必须是有效的静态图片")
  }
  if (Buffer.byteLength(raw, "utf8") > 3 * 1024 * 1024) {
    throw new MarketServiceError(422, "VALIDATION", "模板封面图片大小超出限制")
  }
  return raw
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    fs.renameSync(tmp, filePath)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function buildDemoHtml(title: string, accent: string, bg: string, bodyContent: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="./assets/theme.css" />
</head>
<body style="--accent:${accent};--bg:${bg};">
  <div class="shell">
    <header class="topbar"><strong>${title}</strong><span class="tag">静态示例</span></header>
    <main class="content">${bodyContent}</main>
  </div>
</body>
</html>`
}

export class DesignMarketService {
  private readonly statePath: string
  private readonly blobsDir: string
  private state: MarketStateFile

  constructor(
    readonly storageDir: string,
    options: { seedDemo?: boolean } = {}
  ) {
    this.statePath = path.join(storageDir, "state.json")
    this.blobsDir = path.join(storageDir, "blobs")
    fs.mkdirSync(this.blobsDir, { recursive: true })
    if (fs.existsSync(this.statePath)) {
      this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as MarketStateFile
    } else {
      this.state = {
        version: 1,
        systems: {},
        templates: {},
        notices: [],
        audits: []
      }
      if (options.seedDemo !== false) {
        this.seedDemoCatalog()
      }
      this.persist()
    }
  }

  synchronizeMarketplace(
    systems: MarketplaceSystemSnapshot[],
    templates: MarketplaceTemplateSnapshot[]
  ): void {
    const systemIds = new Set(systems.map((item) => item.systemId))
    const templateIds = new Set(templates.map((item) => item.templateId))
    for (const system of Object.values(this.state.systems)) {
      if (!systemIds.has(system.systemId)) system.status = "unpublished"
    }
    for (const template of Object.values(this.state.templates)) {
      if (!templateIds.has(template.templateId)) template.status = "unpublished"
    }
    for (const { record, ...system } of systems) {
      const prior = this.state.systems[system.systemId]
      const sameOwner = prior?.ownerId === system.ownerId
      const previous = sameOwner ? prior : undefined
      const sameVersion = previous?.versions.find((ver) => ver.versionId === record.versionId)
      this.state.systems[system.systemId] = Object.assign(previous ?? {}, {
        ...system,
        latestVersionId: record.versionId,
        highestPublishedVersion: record.version,
        status: "published" as const,
        versions: [{ ...record, markdown: sameVersion?.markdown || record.markdown }],
        draft: previous?.draft?.dirty || previous?.latestVersionId === record.versionId
          ? previous?.draft ?? null : null,
        draftRevision: previous?.draftRevision ?? 1,
        createdAt: previous?.createdAt ?? record.createdAt,
        updatedAt: record.createdAt
      })
    }
    for (const { record, ...template } of templates) {
      const prior = this.state.templates[template.templateId]
      const previous = prior?.ownerId === template.ownerId ? prior : undefined
      this.state.templates[template.templateId] = Object.assign(previous ?? {}, {
        ...template,
        latestVersionId: record.versionId,
        highestPublishedVersion: record.version,
        status: "published" as const,
        visibility: "visible" as const,
        versions: [record],
        draft: previous?.draft?.dirty || previous?.latestVersionId === record.versionId
          ? previous?.draft ?? null : null,
        draftRevision: previous?.draftRevision ?? 1,
        createdAt: previous?.createdAt ?? record.createdAt,
        updatedAt: record.createdAt
      })
    }
  }

  hydrateMarketplaceSystem(systemId: string, versionId: string, markdown: string): void {
    const version = this.state.systems[systemId]?.versions.find((item) => item.versionId === versionId)
    if (version) version.markdown = validateMarkdown(markdown)
  }

  marketplaceBlob(sha256: string): Buffer | undefined {
    const file = path.join(this.blobsDir, sha256)
    if (!/^[a-f0-9]{64}$/.test(sha256) || !fs.existsSync(file)) return undefined
    return this.readBlobBuffer(sha256)
  }

  cacheMarketplaceBlob(buffer: Buffer): void {
    this.writeBlobBuffer(buffer)
  }

  private persist(): void {
    atomicWriteJson(this.statePath, this.state)
  }

  private writeBlobBuffer(buffer: Buffer): { sha256: string; bytes: number } {
    const sha256 = createHash("sha256").update(buffer).digest("hex")
    const target = path.join(this.blobsDir, sha256)
    if (!fs.existsSync(target)) {
      const tmp = `${target}.${randomUUID()}.tmp`
      try {
        fs.writeFileSync(tmp, buffer)
        fs.renameSync(tmp, target)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
    return { sha256, bytes: buffer.byteLength }
  }

  private readBlobBuffer(sha256: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的市场文件")
    }
    const target = path.join(this.blobsDir, sha256)
    if (!fs.existsSync(target)) {
      throw new MarketServiceError(404, "NOT_FOUND", "市场资源文件已丢失")
    }
    return fs.readFileSync(target)
  }

  private blobPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的市场文件")
    }
    const target = path.join(this.blobsDir, sha256)
    if (!fs.existsSync(target)) {
      throw new MarketServiceError(404, "NOT_FOUND", "市场资源文件已丢失")
    }
    return target
  }

  private requireActor(actor: DesignMarketActor | null | undefined): DesignMarketActor {
    const normalizedId = normalizeMarketAccountId(actor?.userId)
    if (!actor || !normalizedId) {
      throw new MarketServiceError(401, "UNAUTHORIZED", "请先登录后再访问设计市场")
    }
    return {
      ...actor,
      userId: normalizedId,
      userName: actor.userName?.trim() || normalizedId,
      rawIds: Array.from(new Set([actor.userId, ...(actor.rawIds ?? [])].map((v) => normalizeMarketAccountId(v)).filter(Boolean)))
    }
  }

  private isOwner(ownerId: string, actor: DesignMarketActor): boolean {
    const normalizedOwner = normalizeMarketAccountId(ownerId)
    if (!normalizedOwner) return false
    if (normalizedOwner === actor.userId) return true
    return Boolean(actor.rawIds?.includes(normalizedOwner))
  }

  private effectiveTemplateStatus(
    tpl: StoredTemplateEntity,
    parent: StoredSystemEntity
  ): MarketTemplateEffectiveStatus {
    if (tpl.status === "admin_removed" || parent.status === "admin_removed") return "admin_removed"
    if (tpl.status === "unpublished") return "unpublished"
    if (parent.status === "unpublished") return "parent_unpublished"
    if (tpl.visibility === "hidden_by_system_owner") return "hidden_by_system_owner"
    return "published"
  }

  private summarizeSystem(
    sys: StoredSystemEntity,
    actor: DesignMarketActor,
    matchedTemplates?: MarketTemplateSummary[]
  ): MarketSystemSummary {
    const latest = sys.versions.find((v) => v.versionId === sys.latestVersionId) ?? null
    const canEdit = this.isOwner(sys.ownerId, actor)
    const publicTemplates = Object.values(this.state.templates).filter(
      (tpl) =>
        tpl.systemId === sys.systemId &&
        this.effectiveTemplateStatus(tpl, sys) === "published" &&
        tpl.latestVersionId !== null
    )
    return {
      systemId: sys.systemId,
      name: sys.name,
      description: sys.description,
      category: sys.category,
      ownerId: sys.ownerId,
      ownerName: sys.ownerName,
      palette: sys.palette,
      status: sys.status,
      latestVersion: latest?.version ?? null,
      latestVersionId: latest?.versionId ?? null,
      highestPublishedVersion: sys.highestPublishedVersion,
      templateCount: publicTemplates.length,
      updatedAt: sys.updatedAt,
      hasDraft: Boolean(sys.draft?.dirty),
      canEdit,
      canManageTemplates: canEdit,
      canModerate: Boolean(actor.isAdmin),
      matchedTemplates
    }
  }

  private summarizeTemplate(
    tpl: StoredTemplateEntity,
    parent: StoredSystemEntity,
    actor: DesignMarketActor
  ): MarketTemplateSummary {
    const latest = tpl.versions.find((v) => v.versionId === tpl.latestVersionId) ?? null
    const canEdit = this.isOwner(tpl.ownerId, actor)
    const canSystemOwnerManage = this.isOwner(parent.ownerId, actor)
    const effectiveStatus = this.effectiveTemplateStatus(tpl, parent)
    return {
      templateId: tpl.templateId,
      systemId: tpl.systemId,
      systemName: parent.name,
      name: tpl.name,
      description: tpl.description,
      scenario: tpl.scenario,
      ownerId: tpl.ownerId,
      ownerName: tpl.ownerName,
      status: tpl.status,
      visibility: tpl.visibility,
      visibilityReason: tpl.visibilityReason,
      parentStatus: parent.status,
      effectiveStatus,
      latestVersion: latest?.version ?? null,
      latestVersionId: latest?.versionId ?? null,
      highestPublishedVersion: tpl.highestPublishedVersion,
      minSystemVersion: latest?.minSystemVersion ?? tpl.draft?.minSystemVersion ?? "1.0.0",
      defaultEntryPath: latest?.defaultEntryPath ?? tpl.draft?.defaultEntryPath ?? "index.html",
      pages: latest?.pages ?? tpl.draft?.pages ?? [],
      framework: latest?.framework ?? tpl.draft?.framework ?? "HTML",
      totalBytes: latest?.bytes ?? tpl.draft?.totalBytes ?? 0,
      coverDataUrl: latest?.coverDataUrl ?? tpl.draft?.coverDataUrl ?? "",
      updatedAt: tpl.updatedAt,
      hasDraft: Boolean(tpl.draft?.dirty),
      canEdit,
      canSystemOwnerManage,
      canModerate: Boolean(actor.isAdmin)
    }
  }

  private noticesForAsset(assetId: string, actor: DesignMarketActor, ownerId: string): MarketGovernanceNotice[] {
    if (!actor.isAdmin && !this.isOwner(ownerId, actor)) return []
    return this.state.notices
      .filter((n) => n.assetId === assetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  listCatalog(query: MarketCatalogQuery = {}, rawActor: DesignMarketActor | null): MarketCatalogResponse {
    const actor = this.requireActor(rawActor)
    const search = (query.query || "").trim().toLowerCase()
    const categoryFilter = query.category && query.category !== "全部" ? query.category : null

    const publishedSystems = Object.values(this.state.systems).filter(
      (sys) => sys.status === "published" && sys.latestVersionId !== null
    )

    const categoryCounts: Record<string, number> = { 全部: 0 }
    for (const cat of DESIGN_MARKET_CATEGORIES) categoryCounts[cat] = 0

    const matchingSystems: Array<{ sys: StoredSystemEntity; matchedTemplates?: MarketTemplateSummary[] }> = []
    for (const sys of publishedSystems) {
      const publicTemplates = Object.values(this.state.templates)
        .filter(
          (tpl) =>
            tpl.systemId === sys.systemId &&
            this.effectiveTemplateStatus(tpl, sys) === "published" &&
            tpl.latestVersionId !== null
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

      const sysMatchesSearch =
        !search ||
        sys.name.toLowerCase().includes(search) ||
        sys.description.toLowerCase().includes(search) ||
        sys.ownerName.toLowerCase().includes(search) ||
        sys.category.toLowerCase().includes(search)

      const matchedTemplates = search
        ? publicTemplates
            .filter(
              (tpl) =>
                tpl.name.toLowerCase().includes(search) ||
                tpl.description.toLowerCase().includes(search) ||
                tpl.scenario.toLowerCase().includes(search) ||
                tpl.ownerName.toLowerCase().includes(search)
            )
            .map((tpl) => this.summarizeTemplate(tpl, sys, actor))
        : []

      if (!sysMatchesSearch && matchedTemplates.length === 0) continue

      categoryCounts["全部"] = (categoryCounts["全部"] || 0) + 1
      categoryCounts[sys.category] = (categoryCounts[sys.category] || 0) + 1

      if (categoryFilter && sys.category !== categoryFilter) continue
      matchingSystems.push({
        sys,
        matchedTemplates: matchedTemplates.length > 0 ? matchedTemplates : undefined
      })
    }

    const summaries = matchingSystems
      .map(({ sys, matchedTemplates }) => this.summarizeSystem(sys, actor, matchedTemplates))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return {
      actor,
      online: true,
      categories: DESIGN_MARKET_CATEGORIES,
      scenarios: DESIGN_MARKET_SCENARIOS,
      categoryCounts,
      systems: summaries
    }
  }

  getSystemDetail(systemId: string, rawActor: DesignMarketActor | null): MarketSystemDetail {
    const actor = this.requireActor(rawActor)
    const sys = this.state.systems[systemId]
    if (!sys) {
      throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的设计系统")
    }
    const canEdit = this.isOwner(sys.ownerId, actor)
    if ((sys.status !== "published" || !sys.latestVersionId) && !canEdit && !actor.isAdmin) {
      throw new MarketServiceError(403, "FORBIDDEN", "该设计系统尚未上架或已被下架")
    }
    const latest = sys.versions.find((v) => v.versionId === sys.latestVersionId)
    const markdown = latest?.markdown ?? sys.draft?.markdown ?? ""
    const templates = Object.values(this.state.templates)
      .filter((tpl) => tpl.systemId === sys.systemId)
      .filter((tpl) => {
        const eff = this.effectiveTemplateStatus(tpl, sys)
        if (eff === "published" && tpl.latestVersionId) return true
        if (this.isOwner(tpl.ownerId, actor)) return true
        if (canEdit && eff === "hidden_by_system_owner" && tpl.latestVersionId) return true
        if (actor.isAdmin) return true
        return false
      })
      .map((tpl) => this.summarizeTemplate(tpl, sys, actor))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return {
      system: this.summarizeSystem(sys, actor),
      markdown,
      versions: [...sys.versions].sort((a, b) => compareSemVer(b.version, a.version)),
      templates,
      draft: canEdit ? sys.draft : null,
      notices: this.noticesForAsset(sys.systemId, actor, sys.ownerId)
    }
  }

  getTemplateDetail(templateId: string, rawActor: DesignMarketActor | null): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[templateId]
    if (!tpl) {
      throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的市场模板")
    }
    const parent = this.state.systems[tpl.systemId]
    if (!parent) {
      throw new MarketServiceError(404, "NOT_FOUND", "模板所属设计系统不存在")
    }
    const canEdit = this.isOwner(tpl.ownerId, actor)
    const canSystemOwner = this.isOwner(parent.ownerId, actor)
    const eff = this.effectiveTemplateStatus(tpl, parent)
    if (
      (eff !== "published" || !tpl.latestVersionId) &&
      !canEdit &&
      !(canSystemOwner && eff === "hidden_by_system_owner") &&
      !actor.isAdmin
    ) {
      throw new MarketServiceError(403, "FORBIDDEN", "该模板当前未上架或已被隐藏")
    }

    return {
      template: this.summarizeTemplate(tpl, parent, actor),
      system: this.summarizeSystem(parent, actor),
      versions: [...tpl.versions].sort((a, b) => compareSemVer(b.version, a.version)),
      draft: canEdit ? tpl.draft : null,
      notices: this.noticesForAsset(tpl.templateId, actor, tpl.ownerId)
    }
  }

  listMyUploads(rawActor: DesignMarketActor | null): MarketMyUploadsResponse {
    const actor = this.requireActor(rawActor)
    const systems = Object.values(this.state.systems)
      .filter((sys) => this.isOwner(sys.ownerId, actor))
      .map((sys) => this.summarizeSystem(sys, actor))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const templates = Object.values(this.state.templates)
      .filter((tpl) => this.isOwner(tpl.ownerId, actor))
      .map((tpl) => {
        const parent = this.state.systems[tpl.systemId]
        return parent ? this.summarizeTemplate(tpl, parent, actor) : null
      })
      .filter((item): item is MarketTemplateSummary => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const myAssetIds = new Set([...systems.map((s) => s.systemId), ...templates.map((t) => t.templateId)])
    const notices = this.state.notices
      .filter((n) => myAssetIds.has(n.assetId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    return { actor, systems, templates, notices }
  }

  createSystemDraft(input: MarketCreateSystemDraftInput, rawActor: DesignMarketActor | null): MarketSystemDetail {
    const actor = this.requireActor(rawActor)
    const markdown = validateMarkdown(input.markdown)
    const titleFromMd = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
    const name = (input.name ?? titleFromMd ?? "").trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "设计系统名称不能为空，且不能超过 80 个字符")
    }
    const category = assertCategory(input.category ?? "企业应用")
    const palette = input.palette ? validatePalette(input.palette) : extractDesignSystemPalette(markdown)
    const version = normalizeSemVer(input.version ?? "1.0.0")
    const description =
      (input.description ??
        markdown
          .split(/\r?\n/)
          .find((line) => line.trim() && !line.startsWith("#"))
          ?.trim() ??
        name).slice(0, 160)
    const now = new Date().toISOString()
    const systemId = `msys_${randomUUID().slice(0, 12)}`
    const entity: StoredSystemEntity = {
      systemId,
      name,
      description,
      category,
      ownerId: actor.userId,
      ownerName: actor.userName,
      palette,
      status: "unpublished",
      latestVersionId: null,
      highestPublishedVersion: null,
      versions: [],
      draftRevision: 1,
      draft: {
        name,
        description,
        category,
        markdown,
        palette,
        version,
        changelog: (input.changelog ?? "首次发布设计规范").trim(),
        revision: 1,
        updatedAt: now,
        dirty: true
      },
      createdAt: now,
      updatedAt: now
    }
    this.state.systems[systemId] = entity
    this.persist()
    return this.getSystemDetail(systemId, actor)
  }

  saveSystemDraft(input: MarketSaveSystemDraftInput, rawActor: DesignMarketActor | null): MarketSystemDetail {
    const actor = this.requireActor(rawActor)
    const sys = this.state.systems[input.systemId]
    if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
    if (!this.isOwner(sys.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该设计系统的上传者可以编辑草稿")
    }
    if (input.expectedRevision !== sys.draftRevision) {
      throw new MarketServiceError(
        409,
        "CONFLICT",
        "草稿已在其他窗口修改，请刷新最新草稿后再保存",
        sys.draftRevision
      )
    }
    const name = input.name.trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "设计系统名称不能为空，且不能超过 80 个字符")
    }
    const category = assertCategory(input.category)
    const markdown = validateMarkdown(input.markdown)
    const palette = validatePalette(input.palette)
    const version = normalizeSemVer(input.version)
    if (sys.highestPublishedVersion && !isHigherSemVer(version, sys.highestPublishedVersion)) {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        `新版本号必须高于已发布最高版本 v${sys.highestPublishedVersion}`
      )
    }
    const now = new Date().toISOString()
    const nextRevision = sys.draftRevision + 1
    sys.draftRevision = nextRevision
    sys.draft = {
      name,
      description: input.description.trim().slice(0, 160) || name,
      category,
      markdown,
      palette,
      version,
      changelog: input.changelog.trim(),
      revision: nextRevision,
      updatedAt: now,
      dirty: true
    }
    sys.updatedAt = now
    this.persist()
    return this.getSystemDetail(sys.systemId, actor)
  }

  discardSystemDraft(systemId: string, rawActor: DesignMarketActor | null): MarketSystemDetail {
    const actor = this.requireActor(rawActor)
    const sys = this.state.systems[systemId]
    if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
    if (!this.isOwner(sys.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该设计系统的上传者可以放弃草稿")
    }
    const latest = sys.versions.find((v) => v.versionId === sys.latestVersionId)
    if (!latest) {
      throw new MarketServiceError(422, "VALIDATION", "尚未发布过版本，无法还原到线上版")
    }
    const now = new Date().toISOString()
    sys.draftRevision += 1
    sys.draft = {
      name: sys.name,
      description: sys.description,
      category: sys.category,
      markdown: latest.markdown,
      palette: latest.palette,
      version: suggestNextPatchVersion(sys.highestPublishedVersion),
      changelog: "",
      revision: sys.draftRevision,
      updatedAt: now,
      dirty: false
    }
    this.persist()
    return this.getSystemDetail(systemId, actor)
  }

  publishSystem(input: MarketPublishSystemInput, actor: DesignMarketActor | null): MarketSystemDetail {
    return this.prepareSystemPublication(input, actor).commit()
  }

  prepareSystemPublication(input: MarketPublishSystemInput, rawActor: DesignMarketActor | null) {
    const actor = this.requireActor(rawActor)
    const sys = this.state.systems[input.systemId]
    if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
    if (!this.isOwner(sys.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该设计系统的上传者可以发布版本")
    }
    if (sys.status === "admin_removed") {
      throw new MarketServiceError(403, "FORBIDDEN", "该设计系统已被平台管理员下架，暂不可发布")
    }
    if (input.expectedRevision !== sys.draftRevision) {
      throw new MarketServiceError(
        409,
        "CONFLICT",
        "草稿版本已变化，请刷新后再发布",
        sys.draftRevision
      )
    }
    const draft = sys.draft
    if (!draft) {
      throw new MarketServiceError(422, "VALIDATION", "没有可发布的草稿内容")
    }
    const version = normalizeSemVer(input.version ?? draft.version)
    if (sys.highestPublishedVersion && !isHigherSemVer(version, sys.highestPublishedVersion)) {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        `发布版本号（v${version}）必须高于当前最高发布版本（v${sys.highestPublishedVersion}）`
      )
    }
    const markdown = validateMarkdown(draft.markdown)
    const palette = validatePalette(draft.palette)
    const category = assertCategory(draft.category)
    const name = draft.name.trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "设计系统名称不能为空，且不能超过 80 个字符")
    }

    const blob = this.writeBlobBuffer(Buffer.from(markdown, "utf8"))
    const now = new Date().toISOString()
    const versionId = `msv_${randomUUID().slice(0, 12)}`
    const changelog = (input.changelog ?? draft.changelog).trim() || `发布 v${version}`

    const record: MarketSystemVersionRecord = {
      versionId,
      version,
      changelog,
      createdAt: now,
      createdById: actor.userId,
      createdByName: actor.userName,
      bytes: blob.bytes,
      sha256: blob.sha256,
      markdown,
      palette
    }

    return {
      record, name, category,
      description: draft.description.trim().slice(0, 160) || name,
      commit: (): MarketSystemDetail => {
        sys.versions = [...sys.versions.filter((item) => item.versionId !== record.versionId), record]
        sys.name = name
        sys.description = draft.description.trim().slice(0, 160) || name
        sys.category = category
        sys.palette = palette
        sys.status = "published"
        sys.latestVersionId = versionId
        sys.highestPublishedVersion = version
        sys.updatedAt = now
        if (sys.draftRevision === input.expectedRevision) {
          sys.draftRevision += 1
          sys.draft = {
            ...draft,
            version: suggestNextPatchVersion(version),
            changelog: "",
            revision: sys.draftRevision,
            updatedAt: now,
            dirty: false
          }
        }
        this.persist()
        return this.getSystemDetail(sys.systemId, actor)
      }
    }
  }

  setSystemStatus(
    systemId: string,
    status: "published" | "unpublished",
    rawActor: DesignMarketActor | null
  ): { detail: MarketSystemDetail; affectedTemplateCount: number } {
    const actor = this.requireActor(rawActor)
    const sys = this.state.systems[systemId]
    if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
    if (!this.isOwner(sys.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该设计系统的上传者可以上下架该系统")
    }
    if (sys.status === "admin_removed") {
      throw new MarketServiceError(403, "FORBIDDEN", "该设计系统已被平台管理员下架，无法自行上架")
    }
    if (status === "published" && !sys.latestVersionId) {
      throw new MarketServiceError(422, "VALIDATION", "请先发布一个版本后再上架")
    }

    const childTemplates = Object.values(this.state.templates).filter((tpl) => tpl.systemId === systemId)
    const affectedTemplateCount = childTemplates.filter(
      (tpl) => tpl.status === "published" && tpl.visibility === "visible" && tpl.latestVersionId !== null
    ).length

    const now = new Date().toISOString()
    sys.status = status
    sys.updatedAt = now
    for (const tpl of childTemplates) {
      if (tpl.status === "published" && tpl.visibility === "visible" && tpl.latestVersionId) {
        this.state.notices.push({
          id: `ntc_${randomUUID().slice(0, 10)}`,
          assetKind: "template",
          assetId: tpl.templateId,
          assetName: tpl.name,
          action: status === "unpublished" ? "parent_unpublished" : "parent_republished",
          reason:
            status === "unpublished"
              ? `所属设计系统「${sys.name}」已由作者下架`
              : `所属设计系统「${sys.name}」已重新上架，模板已恢复展示`,
          actorId: actor.userId,
          actorName: actor.userName,
          createdAt: now
        })
      }
    }
    this.persist()
    return { detail: this.getSystemDetail(systemId, actor), affectedTemplateCount }
  }

  stageTemplateBlob(zipBuffer: Buffer, rawActor: DesignMarketActor | null, preferredEntryPath?: string): {
    sha256: string
    bytes: number
    pages: string[]
    defaultEntryPath: string
    filesCount: number
    totalBytes: number
    framework: string
    warnings: string[]
  } {
    this.requireActor(rawActor)
    const validated = validateTemplateZipBuffer(zipBuffer, preferredEntryPath)
    const written = this.writeBlobBuffer(validated.zipBuffer)
    return {
      sha256: written.sha256,
      bytes: written.bytes,
      pages: validated.pages,
      defaultEntryPath: validated.defaultEntryPath,
      filesCount: validated.fileList.length,
      totalBytes: validated.totalBytes,
      framework: validated.framework,
      warnings: validated.warnings
    }
  }

  createTemplateDraft(input: MarketCreateTemplateDraftInput, rawActor: DesignMarketActor | null): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const parent = this.state.systems[input.systemId]
    if (!parent) throw new MarketServiceError(404, "NOT_FOUND", "所属设计系统不存在")
    if (parent.status !== "published" || !parent.latestVersionId) {
      throw new MarketServiceError(422, "VALIDATION", "只能在已上架的设计系统下上传模板")
    }
    const name = input.name.trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "模板名称不能为空，且不能超过 80 个字符")
    }
    const scenario = assertScenario(input.scenario)
    const minSystemVersion = normalizeSemVer(input.minSystemVersion)
    this.assertMinSystemVersionValidForParent(parent, minSystemVersion)
    const blobBuf = this.readBlobBuffer(input.stagedBlobSha256)
    const validated = inspectTemplateZipBuffer(blobBuf, input.defaultEntryPath)
    const coverDataUrl = validateCoverDataUrl(input.coverDataUrl)
    const version = normalizeSemVer(input.version ?? "1.0.0")
    const now = new Date().toISOString()
    const templateId = `mtpl_${randomUUID().slice(0, 12)}`

    const entity: StoredTemplateEntity = {
      templateId,
      systemId: parent.systemId,
      name,
      description: input.description.trim().slice(0, 200) || name,
      scenario,
      ownerId: actor.userId,
      ownerName: actor.userName,
      status: "unpublished",
      visibility: "visible",
      latestVersionId: null,
      highestPublishedVersion: null,
      versions: [],
      draftRevision: 1,
      draft: {
        name,
        description: input.description.trim().slice(0, 200) || name,
        scenario,
        minSystemVersion,
        defaultEntryPath: validated.defaultEntryPath,
        pages: validated.pages,
        filesCount: validated.fileList.length,
        totalBytes: validated.totalBytes,
        framework: validated.framework,
        packageFilename: input.packageFilename || "template.zip",
        stagedBlobSha256: input.stagedBlobSha256,
        coverDataUrl,
        version,
        changelog: (input.changelog ?? "首次发布模板").trim(),
        revision: 1,
        updatedAt: now,
        dirty: true
      },
      createdAt: now,
      updatedAt: now
    }
    this.state.templates[templateId] = entity
    this.persist()
    return this.getTemplateDetail(templateId, actor)
  }

  saveTemplateDraft(input: MarketSaveTemplateDraftInput, rawActor: DesignMarketActor | null): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[input.templateId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    if (!this.isOwner(tpl.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该模板的上传者可以编辑草稿")
    }
    const parent = this.state.systems[tpl.systemId]
    if (!parent) throw new MarketServiceError(404, "NOT_FOUND", "所属设计系统不存在")
    if (input.expectedRevision !== tpl.draftRevision) {
      throw new MarketServiceError(
        409,
        "CONFLICT",
        "模板草稿已在其他窗口修改，请刷新后再保存",
        tpl.draftRevision
      )
    }
    const name = input.name.trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "模板名称不能为空，且不能超过 80 个字符")
    }
    const scenario = assertScenario(input.scenario)
    const minSystemVersion = normalizeSemVer(input.minSystemVersion)
    this.assertMinSystemVersionValidForParent(parent, minSystemVersion)
    const latestVer = tpl.versions.find((v) => v.versionId === tpl.latestVersionId)
    const targetSha = input.stagedBlobSha256 || tpl.draft?.stagedBlobSha256 || latestVer?.sha256
    if (!targetSha) {
      throw new MarketServiceError(422, "VALIDATION", "缺少模板压缩包文件")
    }
    const validated = inspectTemplateZipBuffer(this.readBlobBuffer(targetSha), input.defaultEntryPath)
    const coverDataUrl = validateCoverDataUrl(input.coverDataUrl)
    const version = normalizeSemVer(input.version)
    if (tpl.highestPublishedVersion && !isHigherSemVer(version, tpl.highestPublishedVersion)) {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        `新版本号必须高于已发布最高版本 v${tpl.highestPublishedVersion}`
      )
    }
    const now = new Date().toISOString()
    const nextRevision = tpl.draftRevision + 1
    tpl.draftRevision = nextRevision
    tpl.draft = {
      name,
      description: input.description.trim().slice(0, 200) || name,
      scenario,
      minSystemVersion,
      defaultEntryPath: validated.defaultEntryPath,
      pages: validated.pages,
      filesCount: validated.fileList.length,
      totalBytes: validated.totalBytes,
      framework: validated.framework,
      packageFilename: input.packageFilename || tpl.draft?.packageFilename || "template.zip",
      stagedBlobSha256: targetSha,
      coverDataUrl,
      version,
      changelog: input.changelog.trim(),
      revision: nextRevision,
      updatedAt: now,
      dirty: true
    }
    tpl.updatedAt = now
    this.persist()
    return this.getTemplateDetail(tpl.templateId, actor)
  }

  discardTemplateDraft(templateId: string, rawActor: DesignMarketActor | null): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[templateId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    if (!this.isOwner(tpl.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该模板的上传者可以放弃草稿")
    }
    const latest = tpl.versions.find((v) => v.versionId === tpl.latestVersionId)
    if (!latest) {
      throw new MarketServiceError(422, "VALIDATION", "该模板尚未发布任何版本，无法还原")
    }
    const now = new Date().toISOString()
    tpl.draftRevision += 1
    tpl.draft = {
      name: tpl.name,
      description: tpl.description,
      scenario: tpl.scenario,
      minSystemVersion: latest.minSystemVersion,
      defaultEntryPath: latest.defaultEntryPath,
      pages: latest.pages,
      filesCount: latest.filesCount,
      totalBytes: latest.bytes,
      framework: latest.framework,
      packageFilename: `${tpl.name}.zip`,
      stagedBlobSha256: latest.sha256,
      coverDataUrl: latest.coverDataUrl,
      version: suggestNextPatchVersion(tpl.highestPublishedVersion),
      changelog: "",
      revision: tpl.draftRevision,
      updatedAt: now,
      dirty: false
    }
    this.persist()
    return this.getTemplateDetail(templateId, actor)
  }

  publishTemplate(input: MarketPublishTemplateInput, actor: DesignMarketActor | null): MarketTemplateDetail {
    return this.prepareTemplatePublication(input, actor).commit()
  }

  prepareTemplatePublication(input: MarketPublishTemplateInput, rawActor: DesignMarketActor | null) {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[input.templateId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    if (!this.isOwner(tpl.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该模板的上传者可以发布新版本")
    }
    if (tpl.status === "admin_removed") {
      throw new MarketServiceError(403, "FORBIDDEN", "该模板已被平台管理员下架，暂不可发布")
    }
    const parent = this.state.systems[tpl.systemId]
    if (!parent || parent.status !== "published" || !parent.latestVersionId) {
      throw new MarketServiceError(422, "VALIDATION", "所属设计系统当前已下架，请等待系统重新上架后再发布")
    }
    if (input.expectedRevision !== tpl.draftRevision) {
      throw new MarketServiceError(
        409,
        "CONFLICT",
        "模板草稿版本已变化，请刷新后再发布",
        tpl.draftRevision
      )
    }
    const draft = tpl.draft
    if (!draft) throw new MarketServiceError(422, "VALIDATION", "没有可发布的草稿")
    const version = normalizeSemVer(input.version ?? draft.version)
    if (tpl.highestPublishedVersion && !isHigherSemVer(version, tpl.highestPublishedVersion)) {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        `发布版本号（v${version}）必须高于当前最高发布版本（v${tpl.highestPublishedVersion}）`
      )
    }
    const minSystemVersion = normalizeSemVer(draft.minSystemVersion)
    this.assertMinSystemVersionValidForParent(parent, minSystemVersion)
    const latestVer = tpl.versions.find((v) => v.versionId === tpl.latestVersionId)
    const targetSha = draft.stagedBlobSha256 || latestVer?.sha256
    if (!targetSha) throw new MarketServiceError(422, "VALIDATION", "请先上传模板包后再发布")
    const zipBuffer = this.readBlobBuffer(targetSha)
    const validated = inspectTemplateZipBuffer(zipBuffer, draft.defaultEntryPath)
    const coverDataUrl = validateCoverDataUrl(draft.coverDataUrl)
    const scenario = assertScenario(draft.scenario)
    const name = draft.name.trim()
    if (!name || name.length > 80) {
      throw new MarketServiceError(422, "VALIDATION", "模板名称不能为空，且不能超过 80 个字符")
    }

    const now = new Date().toISOString()
    const versionId = `mtv_${randomUUID().slice(0, 12)}`
    const record: MarketTemplateVersionRecord = {
      versionId,
      version,
      changelog: (input.changelog ?? draft.changelog).trim() || `发布 v${version}`,
      createdAt: now,
      createdById: actor.userId,
      createdByName: actor.userName,
      bytes: zipBuffer.byteLength,
      sha256: targetSha,
      minSystemVersion,
      defaultEntryPath: validated.defaultEntryPath,
      pages: validated.pages,
      filesCount: validated.fileList.length,
      framework: validated.framework,
      coverDataUrl
    }

    return {
      record, name, scenario, systemId: tpl.systemId, zipBuffer,
      description: draft.description.trim().slice(0, 200) || name,
      commit: (): MarketTemplateDetail => {
        tpl.versions = [...tpl.versions.filter((item) => item.versionId !== record.versionId), record]
        tpl.name = name
        tpl.description = draft.description.trim().slice(0, 200) || name
        tpl.scenario = scenario
        tpl.status = "published"
        tpl.latestVersionId = versionId
        tpl.highestPublishedVersion = version
        tpl.updatedAt = now
        if (tpl.draftRevision === input.expectedRevision) {
          tpl.draftRevision += 1
          tpl.draft = {
            ...draft,
            version: suggestNextPatchVersion(version),
            changelog: "",
            revision: tpl.draftRevision,
            updatedAt: now,
            dirty: false
          }
        }
        this.persist()
        return this.getTemplateDetail(tpl.templateId, actor)
      }
    }
  }

  setTemplateStatus(
    templateId: string,
    status: "published" | "unpublished",
    rawActor: DesignMarketActor | null
  ): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[templateId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    if (!this.isOwner(tpl.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有该模板的上传者可以上下架该模板")
    }
    if (tpl.status === "admin_removed") {
      throw new MarketServiceError(403, "FORBIDDEN", "该模板已被平台管理员下架，无法自行上架")
    }
    const parent = this.state.systems[tpl.systemId]
    if (!parent) throw new MarketServiceError(404, "NOT_FOUND", "所属设计系统不存在")
    if (status === "published") {
      if (!tpl.latestVersionId) {
        throw new MarketServiceError(422, "VALIDATION", "请先发布版本后再上架模板")
      }
      if (parent.status !== "published") {
        throw new MarketServiceError(422, "VALIDATION", "所属设计系统未上架，无法重新上架该模板")
      }
    }
    tpl.status = status
    tpl.updatedAt = new Date().toISOString()
    this.persist()
    return this.getTemplateDetail(templateId, actor)
  }

  setTemplateVisibilityBySystemOwner(
    templateId: string,
    visibility: MarketTemplateVisibility,
    reason: string | undefined,
    rawActor: DesignMarketActor | null
  ): MarketTemplateDetail {
    const actor = this.requireActor(rawActor)
    const tpl = this.state.templates[templateId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    const parent = this.state.systems[tpl.systemId]
    if (!parent) throw new MarketServiceError(404, "NOT_FOUND", "所属设计系统不存在")
    if (!this.isOwner(parent.ownerId, actor)) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有所属设计系统的上传者可以管理模板展示状态")
    }
    const cleanReason = (reason || "").trim()
    if (visibility === "hidden_by_system_owner" && !cleanReason) {
      throw new MarketServiceError(422, "VALIDATION", "隐藏模板展示时必须填写原因")
    }

    const now = new Date().toISOString()
    tpl.visibility = visibility
    tpl.visibilityReason = visibility === "hidden_by_system_owner" ? cleanReason : undefined
    tpl.updatedAt = now
    const action = visibility === "hidden_by_system_owner" ? "hide_template" : "restore_template"
    const auditReason =
      visibility === "hidden_by_system_owner"
        ? cleanReason
        : cleanReason || "设计系统作者恢复展示"
    this.state.audits.push({
      id: `aud_${randomUUID().slice(0, 10)}`,
      assetKind: "template",
      assetId: tpl.templateId,
      action,
      reason: auditReason,
      actorId: actor.userId,
      actorName: actor.userName,
      createdAt: now
    })
    this.state.notices.push({
      id: `ntc_${randomUUID().slice(0, 10)}`,
      assetKind: "template",
      assetId: tpl.templateId,
      assetName: tpl.name,
      action,
      reason: auditReason,
      actorId: actor.userId,
      actorName: actor.userName,
      createdAt: now
    })
    this.persist()
    return this.getTemplateDetail(templateId, actor)
  }

  adminTakedown(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    rawActor: DesignMarketActor | null
  ): void {
    const actor = this.requireActor(rawActor)
    if (!actor.isAdmin) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有平台管理员可以执行应急下架")
    }
    const cleanReason = reason.trim()
    if (!cleanReason) {
      throw new MarketServiceError(422, "VALIDATION", "请填写下架原因")
    }
    const now = new Date().toISOString()
    if (kind === "system") {
      const sys = this.state.systems[assetId]
      if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
      if (sys.status !== "admin_removed") {
        sys.statusBeforeAdminRemoval = sys.status
      }
      sys.status = "admin_removed"
      sys.updatedAt = now
      this.state.audits.push({
        id: `aud_${randomUUID().slice(0, 10)}`,
        assetKind: "system",
        assetId,
        action: "admin_takedown",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
      this.state.notices.push({
        id: `ntc_${randomUUID().slice(0, 10)}`,
        assetKind: "system",
        assetId,
        assetName: sys.name,
        action: "admin_takedown",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
    } else {
      const tpl = this.state.templates[assetId]
      if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
      if (tpl.status !== "admin_removed") {
        tpl.statusBeforeAdminRemoval = tpl.status
      }
      tpl.status = "admin_removed"
      tpl.updatedAt = now
      this.state.audits.push({
        id: `aud_${randomUUID().slice(0, 10)}`,
        assetKind: "template",
        assetId,
        action: "admin_takedown",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
      this.state.notices.push({
        id: `ntc_${randomUUID().slice(0, 10)}`,
        assetKind: "template",
        assetId,
        assetName: tpl.name,
        action: "admin_takedown",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
    }
    this.persist()
  }

  adminRestore(
    kind: "system" | "template",
    assetId: string,
    reason: string,
    rawActor: DesignMarketActor | null
  ): void {
    const actor = this.requireActor(rawActor)
    if (!actor.isAdmin) {
      throw new MarketServiceError(403, "FORBIDDEN", "只有平台管理员可以恢复违规下架的资产")
    }
    const cleanReason = reason.trim() || "管理员审核恢复上架"
    const now = new Date().toISOString()
    if (kind === "system") {
      const sys = this.state.systems[assetId]
      if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
      sys.status = sys.latestVersionId ? (sys.statusBeforeAdminRemoval ?? "published") : "unpublished"
      sys.statusBeforeAdminRemoval = undefined
      sys.updatedAt = now
      this.state.audits.push({
        id: `aud_${randomUUID().slice(0, 10)}`,
        assetKind: "system",
        assetId,
        action: "admin_restore",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
      this.state.notices.push({
        id: `ntc_${randomUUID().slice(0, 10)}`,
        assetKind: "system",
        assetId,
        assetName: sys.name,
        action: "admin_restore",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
    } else {
      const tpl = this.state.templates[assetId]
      if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
      tpl.status = tpl.latestVersionId ? (tpl.statusBeforeAdminRemoval ?? "published") : "unpublished"
      tpl.statusBeforeAdminRemoval = undefined
      tpl.updatedAt = now
      this.state.audits.push({
        id: `aud_${randomUUID().slice(0, 10)}`,
        assetKind: "template",
        assetId,
        action: "admin_restore",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
      this.state.notices.push({
        id: `ntc_${randomUUID().slice(0, 10)}`,
        assetKind: "template",
        assetId,
        assetName: tpl.name,
        action: "admin_restore",
        reason: cleanReason,
        actorId: actor.userId,
        actorName: actor.userName,
        createdAt: now
      })
    }
    this.persist()
  }

  getAuditRecords(): MarketAuditRecord[] {
    return [...this.state.audits]
  }

  resolveDownloadBlob(
    kind: "system" | "template",
    assetId: string,
    versionId: string | undefined,
    rawActor: DesignMarketActor | null
  ): {
    blob: MarketBlobDescriptor
    system?: MarketSystemSummary
    systemVersion?: MarketSystemVersionRecord
    template?: MarketTemplateSummary
    templateVersion?: MarketTemplateVersionRecord
  } {
    const actor = this.requireActor(rawActor)
    if (kind === "system") {
      const sys = this.state.systems[assetId]
      if (!sys) throw new MarketServiceError(404, "NOT_FOUND", "设计系统不存在")
      if (sys.status !== "published" || !sys.latestVersionId) {
        throw new MarketServiceError(403, "FORBIDDEN", "该设计系统已下架，停止新增下载")
      }
      const targetId = versionId || sys.latestVersionId
      const ver = sys.versions.find((v) => v.versionId === targetId)
      if (!ver) throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的设计系统版本")
      return {
        blob: {
          sha256: ver.sha256,
          bytes: ver.bytes,
          filePath: this.blobPath(ver.sha256),
          filename: `${sys.name}-v${ver.version}.md`,
          versionId: ver.versionId,
          version: ver.version
        },
        system: this.summarizeSystem(sys, actor),
        systemVersion: ver
      }
    }

    const tpl = this.state.templates[assetId]
    if (!tpl) throw new MarketServiceError(404, "NOT_FOUND", "模板不存在")
    const parent = this.state.systems[tpl.systemId]
    if (!parent) throw new MarketServiceError(404, "NOT_FOUND", "所属设计系统不存在")
    const eff = this.effectiveTemplateStatus(tpl, parent)
    if (eff !== "published" || !tpl.latestVersionId) {
      const msg =
        eff === "hidden_by_system_owner"
          ? "该模板已被所属设计系统作者隐藏展示，暂不可下载"
          : eff === "parent_unpublished"
            ? "所属设计系统已下架，暂不可下载此模板"
            : "该模板已下架，暂不可下载"
      throw new MarketServiceError(403, "FORBIDDEN", msg)
    }
    const targetId = versionId || tpl.latestVersionId
    const ver = tpl.versions.find((v) => v.versionId === targetId)
    if (!ver) throw new MarketServiceError(404, "NOT_FOUND", "找不到对应的模板版本")
    return {
      blob: {
        sha256: ver.sha256,
        bytes: ver.bytes,
        filePath: this.blobPath(ver.sha256),
        filename: `${tpl.name}-v${ver.version}.zip`,
        versionId: ver.versionId,
        version: ver.version
      },
      system: this.summarizeSystem(parent, actor),
      template: this.summarizeTemplate(tpl, parent, actor),
      templateVersion: ver
    }
  }

  private assertMinSystemVersionValidForParent(parent: StoredSystemEntity, minSystemVersion: string): void {
    if (parent.versions.length === 0) {
      throw new MarketServiceError(422, "VALIDATION", "所属设计系统还没有已发布版本")
    }
    const hasCompatible = parent.versions.some((ver) =>
      isSystemVersionCompatible(ver.version, minSystemVersion)
    )
    const exactKnown = parent.versions.some((ver) => ver.version === minSystemVersion)
    if (!hasCompatible && !exactKnown) {
      throw new MarketServiceError(
        422,
        "VALIDATION",
        `最低适配版本 v${minSystemVersion} 在所属设计系统中不存在兼容的已发布版本`
      )
    }
  }

  private seedDemoCatalog(): void {
    const createSampleSystem = (input: {
      systemId: string
      name: string
      description: string
      category: DesignMarketCategory
      ownerId: string
      ownerName: string
      palette: MarketSystemPalette
      versions: Array<{ version: string; changelog: string; updatedAt: string }>
    }) => {
      const records: MarketSystemVersionRecord[] = input.versions.map((ver, idx) => {
        const md = `# ${input.name}\n\n${input.description}\n\n## 设计 Token\n\n\`\`\`css\n:root {\n  --accent: ${input.palette[0]};\n  --primary: ${input.palette[1]};\n  --surface: ${input.palette[2]};\n  --fg: ${input.palette[3]};\n}\n\`\`\`\n\n- 规范版本：v${ver.version}\n- 适用场景：${input.category}\n- 说明：${ver.changelog}\n`
        const blob = this.writeBlobBuffer(Buffer.from(md, "utf8"))
        return {
          versionId: `${input.systemId}_v${idx + 1}`,
          version: ver.version,
          changelog: ver.changelog,
          createdAt: ver.updatedAt,
          createdById: input.ownerId,
          createdByName: input.ownerName,
          bytes: blob.bytes,
          sha256: blob.sha256,
          markdown: md,
          palette: input.palette
        }
      })
      const latest = records[records.length - 1]
      this.state.systems[input.systemId] = {
        systemId: input.systemId,
        name: input.name,
        description: input.description,
        category: input.category,
        ownerId: input.ownerId,
        ownerName: input.ownerName,
        palette: input.palette,
        status: "published",
        latestVersionId: latest.versionId,
        highestPublishedVersion: latest.version,
        versions: records,
        draftRevision: 1,
        draft: null,
        createdAt: records[0].createdAt,
        updatedAt: latest.createdAt
      }
    }

    const createSampleTemplate = (input: {
      templateId: string
      systemId: string
      name: string
      description: string
      scenario: DesignMarketScenario
      ownerId: string
      ownerName: string
      accent: string
      bg: string
      entryPath: string
      versions: Array<{ version: string; minSystemVersion: string; changelog: string; updatedAt: string }>
    }) => {
      const records: MarketTemplateVersionRecord[] = input.versions.map((ver, idx) => {
        const zip = new AdmZip()
        zip.addFile(
          "assets/theme.css",
          Buffer.from(
            `body{margin:0;font-family:-apple-system,sans-serif;background:var(--bg,#f8fafc);color:#1f2937}.shell{max-width:1120px;margin:0 auto;padding:24px}.topbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:16px}.tag{font-size:12px;color:var(--accent,#2563eb);background:#eff6ff;padding:2px 8px;border-radius:999px}.content{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}`,
            "utf8"
          )
        )
        zip.addFile(
          input.entryPath,
          Buffer.from(
            buildDemoHtml(
              input.name,
              input.accent,
              input.bg,
              `<h2>${input.name}（v${ver.version}）</h2><p>${input.description}</p>`
            ),
            "utf8"
          )
        )
        const buf = zip.toBuffer()
        const blob = this.writeBlobBuffer(buf)
        return {
          versionId: `${input.templateId}_v${idx + 1}`,
          version: ver.version,
          changelog: ver.changelog,
          createdAt: ver.updatedAt,
          createdById: input.ownerId,
          createdByName: input.ownerName,
          bytes: blob.bytes,
          sha256: blob.sha256,
          minSystemVersion: ver.minSystemVersion,
          defaultEntryPath: input.entryPath,
          pages: [input.entryPath],
          filesCount: 2,
          framework: "HTML",
          coverDataUrl: buildFallbackTemplateCoverSvg(input.name, "HTML", input.entryPath)
        }
      })
      const latest = records[records.length - 1]
      this.state.templates[input.templateId] = {
        templateId: input.templateId,
        systemId: input.systemId,
        name: input.name,
        description: input.description,
        scenario: input.scenario,
        ownerId: input.ownerId,
        ownerName: input.ownerName,
        status: "published",
        visibility: "visible",
        latestVersionId: latest.versionId,
        highestPublishedVersion: latest.version,
        versions: records,
        draftRevision: 1,
        draft: null,
        createdAt: records[0].createdAt,
        updatedAt: latest.createdAt
      }
    }

    createSampleSystem({
      systemId: "msys_enterprise_workbench",
      name: "企业工作台",
      description: "面向企业后台的表单、列表与流程页面规范",
      category: "企业应用",
      ownerId: "demo-linan",
      ownerName: "林安",
      palette: ["#3B6BE0", "#7E9EF0", "#DAE5FA", "#182B59"],
      versions: [
        { version: "1.0.0", changelog: "初始企业工作台色彩与栅格规范", updatedAt: "2026-11-10T09:00:00.000Z" },
        { version: "1.2.0", changelog: "补充复杂表单分组与筛选表格状态规范", updatedAt: "2026-11-24T10:00:00.000Z" }
      ]
    })
    createSampleSystem({
      systemId: "msys_ops_console",
      name: "运营后台",
      description: "适合运营活动配置、审核流与数据报表的后台规范",
      category: "企业应用",
      ownerId: "demo-zhouning",
      ownerName: "周宁",
      palette: ["#9A7B64", "#D8B9A3", "#EFE2D5", "#43342D"],
      versions: [{ version: "1.1.0", changelog: "优化审批卡片与状态徽章对比度", updatedAt: "2026-11-23T09:00:00.000Z" }]
    })
    createSampleSystem({
      systemId: "msys_mobile_exp",
      name: "移动体验",
      description: "移动端卡片流、底部操作栏与安全区适配规范",
      category: "移动端",
      ownerId: "demo-xuqing",
      ownerName: "许青",
      palette: ["#367A57", "#8AB89F", "#DCECE2", "#1B402D"],
      versions: [{ version: "1.0.0", changelog: "发布移动端基础栅格与按钮触区规范", updatedAt: "2026-11-22T09:00:00.000Z" }]
    })
    createSampleSystem({
      systemId: "msys_data_board",
      name: "数据看板",
      description: "面向驾驶舱与实时指标趋势的深浅双主题图表规范",
      category: "数据展示",
      ownerId: "demo-lizhe",
      ownerName: "李哲",
      palette: ["#7E68AF", "#AC99D6", "#DFD9F2", "#3D2D66"],
      versions: [{ version: "1.3.0", changelog: "新增指标对比卡片与时序图配色", updatedAt: "2026-11-21T09:00:00.000Z" }]
    })
    createSampleSystem({
      systemId: "msys_common_base",
      name: "通用基础",
      description: "高兼容的基础排版、中性色板与表单控件原子规范",
      category: "通用",
      ownerId: "demo-linan",
      ownerName: "林安",
      palette: ["#546577", "#9AA7B4", "#DCE2E8", "#232F3D"],
      versions: [{ version: "1.2.0", changelog: "统一间距标尺与无障碍焦点样式", updatedAt: "2026-11-20T09:00:00.000Z" }]
    })
    createSampleSystem({
      systemId: "msys_form_spec",
      name: "表单规范",
      description: "高密度业务表单、多步骤校验与抽屉录入规范",
      category: "企业应用",
      ownerId: "demo-chenlu",
      ownerName: "陈璐",
      palette: ["#B59A5B", "#D8C58E", "#EDE5CC", "#4D3D1C"],
      versions: [{ version: "1.0.0", changelog: "首次发布企业表单校验与布局规则", updatedAt: "2026-11-19T09:00:00.000Z" }]
    })

    createSampleTemplate({
      templateId: "mtpl_filter_table",
      systemId: "msys_enterprise_workbench",
      name: "筛选表格",
      description: "适用于需要组合筛选、分页和批量操作的后台列表。",
      scenario: "列表",
      ownerId: "demo-chenlu",
      ownerName: "陈璐",
      accent: "#3B6BE0",
      bg: "#F5F8FF",
      entryPath: "filter-table.html",
      versions: [
        { version: "1.0.0", minSystemVersion: "1.0.0", changelog: "基础筛选栏与表格骨架", updatedAt: "2026-11-18T10:00:00.000Z" },
        { version: "1.1.0", minSystemVersion: "1.2.0", changelog: "补充批量操作条与列设置示例", updatedAt: "2026-11-24T12:00:00.000Z" }
      ]
    })
    createSampleTemplate({
      templateId: "mtpl_complex_form",
      systemId: "msys_enterprise_workbench",
      name: "复杂表单",
      description: "适用于字段分组和多步骤填写的企业后台表单。",
      scenario: "表单",
      ownerId: "demo-zhouning",
      ownerName: "周宁",
      accent: "#3B6BE0",
      bg: "#F8FAFC",
      entryPath: "complex-form.html",
      versions: [
        { version: "0.9.0", minSystemVersion: "1.0.0", changelog: "首次发布基础企业表单", updatedAt: "2026-11-16T10:00:00.000Z" },
        { version: "1.0.0", minSystemVersion: "1.2.0", changelog: "补充分组表单与提交前校验", updatedAt: "2026-11-23T12:00:00.000Z" }
      ]
    })
    createSampleTemplate({
      templateId: "mtpl_batch_import",
      systemId: "msys_enterprise_workbench",
      name: "批量导入",
      description: "支持文件上传、字段映射校验与导入结果汇总流程页。",
      scenario: "流程",
      ownerId: "demo-linan",
      ownerName: "林安",
      accent: "#3B6BE0",
      bg: "#F6F9FF",
      entryPath: "batch-import.html",
      versions: [
        { version: "1.2.0", minSystemVersion: "1.2.0", changelog: "新增模板下载与逐行错误提示", updatedAt: "2026-11-24T11:00:00.000Z" }
      ]
    })
  }
}

function suggestNextPatchVersion(version: string | null): string {
  if (!version) return "1.0.0"
  const parts = version.split(".").map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "1.0.1"
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}
