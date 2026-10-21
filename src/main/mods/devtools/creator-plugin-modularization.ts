import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { PluginModularizationStatus } from "../../../shared/plugin-modularization"
import type { BusinessModCatalog, BusinessModInspection } from "../../../shared/business-mods"
import type { PluginMetadata } from "../../types"
import type { DevelopmentContext } from "./development-service"
import type { DevelopmentScope } from "../v2/development-session"
import { businessCreatorScopeKey } from "./creator-business-draft"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import {
  createPluginModularizationCandidate,
  inspectPluginModularization
} from "../../plugins/plugin-modularization"
import { businessModPath } from "../../plugins/business-mod-manifest"
import { redactPluginSourceCredentials } from "../../plugins/plugin-source-redaction"
import { BusinessModCatalogValidationError } from "../../plugins/business-mod-catalog-schema"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  type DerivationSnapshot
} from "../../plugins/derivation-source"

export interface ModularizationSource {
  pluginId: string
  directory: string
  identity: string
  digest: string
}
interface RawInspection {
  scope: string
  source: ModularizationSource
  id: string
}
interface Request {
  scope: DevelopmentScope
  rawId: string
  catalog: BusinessModCatalog
  modularizationFiles: Array<{ path: string; text: string }>
  status: PluginModularizationStatus
  settled: boolean
  turnId: string
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** Native-only additive migration transactions. Approval and source grants never come from a tool. */
export class CreatorPluginModularization {
  private readonly raw = new Map<string, RawInspection>()
  private readonly requests = new Map<string, Request>()
  private readonly anchors = new Map<string, { original: ModularizationSource; digest: string }>()
  private readonly stopSettlement: () => void
  private closed = false
  constructor(
    private readonly deps: {
      root: string
      plugins(): PluginMetadata[]
      identity(plugin: PluginMetadata): string
      context(threadId: string, author?: boolean): DevelopmentContext
      busy(threadId: string): boolean
      changed(threadId: string): void
      register(
        scope: DevelopmentScope,
        source: ModularizationSource,
        snapshot: DerivationSnapshot
      ): Promise<BusinessModInspection>
    }
  ) {
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      for (const request of this.requests.values()) {
        if (
          request.scope.threadId !== event.threadId ||
          request.turnId !== event.turnId ||
          !same(request.scope.incarnation, event.incarnation) ||
          request.status.phase !== "needs-confirmation"
        )
          continue
        request.settled = event.outcome === "completed"
        if (!request.settled) request.status.phase = "cancelled"
        this.deps.changed(event.threadId)
      }
    })
  }
  private current(threadId: string, author = true) {
    if (this.closed) throw Error("BUSINESS_CREATOR_CLOSED")
    const context = this.deps.context(threadId, author)
    context.assertCurrent()
    return context
  }
  private identity(source: ModularizationSource) {
    const plugin = this.deps.plugins().find((item) => item.id === source.pluginId)
    if (
      !plugin ||
      this.deps.identity(plugin) !== source.identity ||
      resolve(plugin.path) !== resolve(source.directory)
    )
      throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
  }
  /** A persisted candidate cannot inherit a live approval or anchor after restart. */
  assertSource(source: ModularizationSource, installedPath: string) {
    if (resolve(source.directory) === resolve(installedPath)) return
    const anchor = this.anchors.get(source.directory)
    if (
      !anchor ||
      anchor.digest !== source.digest ||
      anchor.original.pluginId !== source.pluginId ||
      anchor.original.identity !== source.identity
    )
      throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    this.identity(anchor.original)
  }
  async verifyOriginal(source: ModularizationSource, guard: () => void) {
    const anchor = this.anchors.get(source.directory)
    if (!anchor) return
    this.identity(anchor.original)
    const original = await snapshotDerivationSource(anchor.original.directory)
    guard()
    this.identity(anchor.original)
    if (original.digest !== anchor.original.digest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
  }
  private async rawSnapshot(scope: DevelopmentScope, id: string) {
    const record = this.raw.get(id)
    if (!record || record.scope !== businessCreatorScopeKey(scope))
      throw Error("PLUGIN_MODULARIZATION_INSPECT_FIRST")
    this.identity(record.source)
    const snapshot = await snapshotDerivationSource(record.source.directory)
    const context = this.current(scope.threadId)
    if (!same(context.scope, scope)) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    context.assertCurrent()
    this.identity(record.source)
    if (snapshot.digest !== record.source.digest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    return { record, snapshot }
  }
  async inspectRaw(threadId: string, pluginId: string) {
    const context = this.current(threadId)
    const plugin = this.deps.plugins().find((item) => item.id === pluginId)
    if (!plugin) throw Error("BUSINESS_CREATOR_SOURCE_MISSING")
    const source = {
      pluginId,
      directory: plugin.path,
      identity: this.deps.identity(plugin),
      digest: ""
    }
    const snapshot = await snapshotDerivationSource(plugin.path)
    context.assertCurrent()
    source.digest = snapshot.digest
    this.identity(source)
    const view = inspectPluginModularization(snapshot)
    const id = randomUUID()
    if (this.raw.size >= 64) this.raw.delete(this.raw.keys().next().value!)
    this.raw.set(id, { scope: businessCreatorScopeKey(context.scope), source, id })
    return {
      rawInspectionId: id,
      ...view,
      schemaAction: "modularization_schema(cursor)",
      untrustedSource: true
    }
  }
  async readRawInspection(threadId: string, rawInspectionId: string) {
    const context = this.current(threadId)
    const { snapshot } = await this.rawSnapshot(context.scope, rawInspectionId)
    return {
      rawInspectionId,
      ...inspectPluginModularization(snapshot),
      schemaAction: "modularization_schema(cursor)",
      untrustedSource: true
    }
  }
  async readRawAsset(threadId: string, rawInspectionId: string, path: string) {
    const context = this.current(threadId)
    const { snapshot } = await this.rawSnapshot(context.scope, rawInspectionId)
    businessModPath(path)
    const file = snapshot.files.find((item) => item.path === path)
    // Tool transport pages the redacted document; larger reviewed source must remain inspectable.
    if (!file || file.bytes.length > 1024 * 1024) throw Error("BUSINESS_CREATOR_ASSET_UNAVAILABLE")
    const original = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    // Schema-aware JSON and conservative assignment redaction affect display only, never source bytes.
    let redacted = false
    let text = original
    if (/\.json$/i.test(path)) {
      const projection = redactPluginSourceCredentials(JSON.parse(original))
      redacted = projection.redacted
      if (redacted) text = JSON.stringify(projection.value, null, 2)
    } else {
      text = original.replace(
        /((?:["']?)(?:[\w.-]*(?:token|secret|password|api[_-]?key|authorization)[\w.-]*)(?:["']?)\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,
        (match, prefix: string, quote: string, value: string) => {
          if (!value.trim() || /^\$\{[^}]+\}$/.test(value)) return match
          redacted = true
          return prefix + quote + "[redacted]" + quote
        }
      )
    }
    return {
      path,
      digest: file.digest,
      sourceDigest: snapshot.digest,
      text,
      redacted,
      untrustedSource: true,
      originalPreserved: true
    }
  }
  async requestModularization(
    threadId: string,
    input: {
      rawInspectionId: string
      sourceDigest: string
      catalog?: unknown
      modularizationFiles?: Array<{ path: string; text: string }>
    },
    turnId: string,
    assertTurn: () => void
  ) {
    assertTurn()
    const context = this.current(threadId)
    const previous = this.requests.get(businessCreatorScopeKey(context.scope))
    if (previous?.status.phase === "preparing") throw Error("BUSINESS_CREATOR_BUSY")
    const { snapshot } = await this.rawSnapshot(context.scope, input.rawInspectionId)
    if (snapshot.digest !== input.sourceDigest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    const candidate = createPluginModularizationCandidate(snapshot, {
      sourceDigest: input.sourceDigest,
      confirmed: true,
      catalog: input.catalog,
      modularizationFiles: input.modularizationFiles
    })
    assertTurn()
    context.assertCurrent()
    if (this.requests.size >= 64 && !this.requests.has(businessCreatorScopeKey(context.scope)))
      throw Error("PLUGIN_MODULARIZATION_CAPACITY")
    const status: PluginModularizationStatus = {
      requestId: randomUUID(),
      sourceDigest: snapshot.digest,
      sourceName: snapshot.name,
      phase: "needs-confirmation",
      summary: "保留原插件，生成独立模块化候选；确认后可继续组合、试用和保存新插件。",
      resources: candidate.files.length - 1,
      mods: candidate.catalog.modules.map(({ id, title }) => ({ id, title })),
      diagnostics: [
        ...candidate.inspection.warnings,
        ...(candidate.addedFiles.length
          ? [
              `本次仅新增 ${candidate.addedFiles.length} 个包内文本文件；原源摘要 ${snapshot.digest} 未改变。模型变更新增文件后必须重新请求本卡审查。`,
              ...candidate.addedFiles.map(
                (file) => `新增：${file.path}（${file.bytes} 字节，SHA-256 ${file.digest}）`
              )
            ]
          : []),
        "此确认仅生成私有源码候选，不安装、不授权、不执行项目。试用和最终安装/导出仍需分别确认。"
      ],
      canConfirm: false
    }
    this.requests.set(businessCreatorScopeKey(context.scope), {
      scope: structuredClone(context.scope),
      rawId: input.rawInspectionId,
      catalog: candidate.catalog,
      modularizationFiles: structuredClone(candidate.modularizationFiles),
      status,
      settled: false,
      turnId
    })
    this.deps.changed(threadId)
    return this.status(context.scope)
  }
  status(scope: DevelopmentScope) {
    const request = this.requests.get(businessCreatorScopeKey(scope))
    if (!request) return undefined
    const status = structuredClone(request.status)
    status.canConfirm =
      status.phase === "needs-confirmation" && request.settled && !this.deps.busy(scope.threadId)
    return status
  }
  async approveModularization(
    threadId: string,
    workspace: string,
    input: { requestId: string; sourceDigest: string }
  ) {
    const context = this.current(threadId, false)
    const request = this.requests.get(businessCreatorScopeKey(context.scope))
    if (
      !request ||
      context.scope.workspace !== workspace ||
      request.status.requestId !== input.requestId ||
      request.status.sourceDigest !== input.sourceDigest ||
      request.status.phase !== "needs-confirmation" ||
      !request.settled
    )
      throw Error("PLUGIN_MODULARIZATION_CONFIRMATION_REQUIRED")
    if (this.deps.busy(threadId)) throw Error("BUSINESS_CREATOR_BUSY")
    request.status.phase = "preparing"
    this.deps.changed(threadId)
    try {
      const { snapshot, record } = await this.rawSnapshot(context.scope, request.rawId)
      const candidate = createPluginModularizationCandidate(snapshot, {
        sourceDigest: input.sourceDigest,
        confirmed: true,
        catalog: request.catalog,
        modularizationFiles: request.modularizationFiles
      })
      const root = join(this.deps.root, "modularization")
      await mkdir(root, { recursive: true })
      const directory = await mkdtemp(join(root, "candidate-"))
      await writeDerivationFiles(directory, candidate.files)
      context.assertCurrent()
      await this.rawSnapshot(context.scope, request.rawId)
      const retained = await snapshotDerivationSource(directory)
      context.assertCurrent()
      const source = { ...record.source, directory, digest: retained.digest }
      if (this.anchors.size >= 64) throw Error("PLUGIN_MODULARIZATION_CAPACITY")
      this.anchors.set(directory, { original: { ...record.source }, digest: retained.digest })
      const inspection = await this.deps.register(context.scope, source, retained)
      context.assertCurrent()
      await this.rawSnapshot(context.scope, request.rawId)
      request.status.phase = "ready"
      request.status.inspectionId = inspection.id
      request.status.summary =
        "模块化源码候选已就绪。继续组合选择步骤，先试用核对产物与检查，再保存安装或导出为新插件。"
    } catch (error) {
      request.status.phase = "failed"
      request.status.error = "PLUGIN_MODULARIZATION_INPUT_CHANGED_OR_INVALID"
      request.status.diagnostics.push(
        "原插件未修改。来源或契约无法核对，请重新检查原插件并生成新的确认请求。"
      )
      if (error instanceof BusinessModCatalogValidationError)
        request.status.diagnostics.push(
          ...error.diagnostics.map(({ path, code, message }) => `${path}: ${code} — ${message}`)
        )
    }
    this.deps.changed(threadId)
    return this.status(context.scope)
  }
  close() {
    this.closed = true
    this.stopSettlement()
    this.requests.clear()
    this.raw.clear()
    this.anchors.clear()
  }
}
