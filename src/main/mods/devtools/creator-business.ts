import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import type {
  BusinessModAssemblyRequest,
  BusinessModCatalog,
  BusinessModInspection,
  BusinessModPreview
} from "../../../shared/business-mods"
import type { DevelopmentBusinessStatus } from "../../../shared/mods/development"
import type { PluginMetadata } from "../../types"
import type { DevelopmentContext } from "./development-service"
import type { DevelopmentScope } from "../v2/development-session"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { BusinessModAssemblyService } from "../../plugins/business-mod-assembly-service"
import {
  businessModCatalog,
  businessModPath,
  parseBusinessModCatalog
} from "../../plugins/business-mod-manifest"
import { BUSINESS_MOD_MANIFEST } from "../../../shared/business-mods"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  derivationContentIdentity
} from "../../plugins/derivation-source"
import {
  CreatorBusinessDrafts,
  businessCreatorScopeKey,
  type BusinessDraftSettings,
  type CreatorBusinessDraft
} from "./creator-business-draft"
import {
  bundledBusinessModExamples,
  readBundledBusinessModExample
} from "../../plugins/business-mod-examples"
import type { CreatorBusinessTrials, BusinessTrialCandidate } from "./creator-business-trial"

type Review = NonNullable<DevelopmentBusinessStatus["review"]>
type Source = { pluginId: string; directory: string; identity: string; digest: string }
interface Inspection {
  scope: string
  source: Source
  view: BusinessModInspection
  catalog: BusinessModCatalog
}
interface Preview {
  scope: string
  previewId: string
  view: BusinessModPreview
  sources: Source[]
  drafts: Array<{ id: string; revision: number; digest: string }>
}
interface Record {
  version: 1
  scope: DevelopmentScope
  review: Review
  sources: Source[]
  drafts: Preview["drafts"]
  turnId?: string
  settled: boolean
  effect?: { kind: "install" } | { kind: "export"; output: string }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const pluginIdentity = (plugin: PluginMetadata) =>
  sha([plugin.id, plugin.path, plugin.version, plugin.updatedAt, plugin.enabled])
function sourceText(path: string, bytes: Buffer) {
  const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!path.endsWith(".json")) return { text: original, redacted: false }
  let redacted = false
  const value = JSON.parse(original, (key, input: unknown) => {
    if (
      typeof input === "string" &&
      /(?:token|secret|password|api[-_]?key|authorization)/i.test(key) &&
      input.trim() &&
      !/^\$\{[^}]+\}$/.test(input)
    ) {
      redacted = true
      return "[redacted]"
    }
    return input
  }) as unknown
  return { text: redacted ? JSON.stringify(value, null, 2) : original, redacted }
}

/** Author documents and native review only. The original assembly service remains the only publisher. */
export class CreatorBusinessService {
  private trials?: CreatorBusinessTrials
  private readonly drafts: CreatorBusinessDrafts
  private readonly inspections = new Map<string, Inspection>()
  private readonly previews = new Map<string, Preview>()
  private readonly live = new Set<string>()
  private readonly writing = new Set<string>()
  private readonly stopSettlement: () => void
  private readonly stopIdle?: () => void
  private closed = false
  constructor(
    private readonly deps: {
      root: string
      settings: BusinessDraftSettings
      assembly: BusinessModAssemblyService
      plugins(): PluginMetadata[]
      context(threadId: string): DevelopmentContext
      readContext(threadId: string): DevelopmentContext
      busy(threadId: string): boolean
      onIdle?(listener: (threadId: string) => void): () => void
      changed(threadId: string): void
    }
  ) {
    this.drafts = new CreatorBusinessDrafts(deps.settings)
    this.stopIdle = deps.onIdle?.((threadId) => {
      if (this.closed) return
      try {
        const record = this.record(this.context(threadId, false).scope)
        if (record && this.live.has(record.review.planId)) deps.changed(threadId)
      } catch {
        /* Idle events can outlive a removed conversation. */
      }
    })
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      try {
        const context = deps.readContext(event.threadId)
        const record = this.record(context.scope)
        if (
          !record ||
          !this.live.has(record.review.planId) ||
          record.turnId !== event.turnId ||
          !same(record.scope.incarnation, event.incarnation)
        )
          return
        record.settled = event.outcome === "completed"
        if (!record.settled) record.review.phase = "cancelled"
        this.persist(record, context.assertCurrent)
      } catch {
        /* Deleted or replaced conversations cannot inherit a review. */
      }
    })
  }
  private key(scope: DevelopmentScope) {
    return `mods-creator-business-review-v1:${businessCreatorScopeKey(scope)}`
  }
  configureTrials(trials: CreatorBusinessTrials) {
    if (this.trials) throw Error("BUSINESS_TRIAL_ALREADY_CONFIGURED")
    this.trials = trials
  }
  trialService() {
    if (!this.trials) throw Error("BUSINESS_TRIAL_UNAVAILABLE")
    return this.trials
  }
  assertTrialSources(sources: BusinessTrialCandidate["sources"]) {
    for (const source of sources) this.assertSource(source)
  }
  async trialCandidate(
    scope: DevelopmentScope,
    candidate: BusinessTrialCandidate,
    guard: () => void
  ) {
    const context = this.context(scope.threadId, false)
    if (!same(context.scope, scope)) throw Error("BUSINESS_TRIAL_SCOPE_CHANGED")
    this.assertTrialSources(candidate.sources)
    const source = await this.deps.assembly.readCheckedSource(
      this.owner(scope),
      candidate.copyId,
      candidate.digest,
      guard
    )
    guard()
    this.assertTrialSources(candidate.sources)
    return { root: source.root, contentIdentity: derivationContentIdentity(source.files) }
  }
  async requestTrial(
    threadId: string,
    workspace: string,
    input: { planId: string; digest: string; goal: string },
    turn?: { id: string; assertCurrent(): void }
  ) {
    const context = this.context(threadId, false),
      record = this.record(context.scope)
    if (
      context.scope.workspace !== workspace ||
      !record ||
      record.review.planId !== input.planId ||
      record.review.digest !== input.digest ||
      !this.live.has(input.planId) ||
      !["needs-approval", "installed", "exported"].includes(record.review.phase)
    )
      throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
    if (turn) turn.assertCurrent()
    else if (!record.settled || this.deps.busy(threadId)) throw Error("BUSINESS_CREATOR_BUSY")
    await this.assertInputs(context, record)
    turn?.assertCurrent()
    await this.trialService().request(
      context.scope,
      input.planId,
      {
        copyId: record.review.copyId,
        digest: input.digest,
        name: record.review.name,
        version: record.review.version,
        sources: structuredClone(record.sources)
      },
      input.goal,
      turn?.id,
      turn?.id ?? record.turnId
    )
    return this.status(threadId)
  }
  async requestTrialPreview(
    threadId: string,
    previewId: string,
    goal: string,
    turnId: string,
    assertTurn: () => void
  ) {
    const before = this.context(threadId)
    const previous = this.trialService().status(before.scope)
    if (previous && !["completed", "failed", "cancelled"].includes(previous.phase))
      throw Error("BUSINESS_TRIAL_OUTCOME_UNCONFIRMED")
    await this.requestReview(threadId, previewId, turnId, assertTurn)
    const context = this.context(threadId),
      record = this.record(context.scope)!
    return this.requestTrial(
      threadId,
      context.scope.workspace,
      { planId: record.review.planId, digest: record.review.digest, goal },
      { id: turnId, assertCurrent: assertTurn }
    )
  }
  private owner(scope: DevelopmentScope) {
    return `creator-business:${businessCreatorScopeKey(scope)}`
  }
  private context(threadId: string, author = true) {
    if (this.closed) throw Error("BUSINESS_CREATOR_CLOSED")
    const context = (author ? this.deps.context : this.deps.readContext)(threadId)
    context.assertCurrent()
    return context
  }
  private record(scope: DevelopmentScope): Record | undefined {
    const raw = this.deps.settings.getSetting(this.key(scope), "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("BUSINESS_CREATOR_REVIEW_INVALID")
    const record = JSON.parse(raw) as Record
    if (
      record.version !== 1 ||
      !same(record.scope, scope) ||
      !record.review ||
      !/^[a-f0-9-]{36}$/.test(record.review.planId) ||
      !/^[a-f0-9]{64}$/.test(record.review.digest) ||
      !Array.isArray(record.sources) ||
      record.sources.length > 8 ||
      !Array.isArray(record.drafts) ||
      record.drafts.length > 4 ||
      (record.effect !== undefined &&
        (!record.effect ||
          typeof record.effect !== "object" ||
          Array.isArray(record.effect) ||
          (record.effect.kind === "install"
            ? Object.keys(record.effect).length !== 1
            : record.effect.kind !== "export" ||
              typeof record.effect.output !== "string" ||
              record.effect.output.length > 32768 ||
              resolve(record.effect.output) !== record.effect.output ||
              Object.keys(record.effect).some((key) => !["kind", "output"].includes(key))))) ||
      ![
        "needs-approval",
        "installing",
        "exporting",
        "installed",
        "exported",
        "failed",
        "unknown",
        "cancelled"
      ].includes(record.review.phase)
    )
      throw Error("BUSINESS_CREATOR_REVIEW_INVALID")
    return record
  }
  private persist(record: Record, guard: () => void) {
    guard()
    const key = this.key(record.scope),
      before = this.deps.settings.getSetting(key, "")
    if (before) {
      const previous = JSON.parse(before) as Record
      if (
        previous.review.planId !== record.review.planId &&
        this.writing.has(record.scope.threadId)
      )
        throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
    }
    if (!this.deps.settings.compareAndSetSetting(key, before || undefined, JSON.stringify(record)))
      throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
    this.deps.changed(record.scope.threadId)
  }
  status(threadId: string): DevelopmentBusinessStatus {
    const context = this.context(threadId, false),
      record = this.record(context.scope)
    const review = record ? structuredClone(record.review) : undefined
    if (review) {
      if (!this.live.has(review.planId) && review.phase === "needs-approval")
        review.phase = "needs-review"
      if (!this.live.has(review.planId) && ["installing", "exporting"].includes(review.phase))
        review.phase = "unknown"
      review.canConfirm =
        this.live.has(review.planId) &&
        record!.settled &&
        !this.deps.busy(threadId) &&
        ["needs-approval", "installed", "exported"].includes(review.phase)
      review.canReconcile =
        review.phase === "unknown" && !this.writing.has(threadId) && !this.deps.busy(threadId)
    }
    let trial: DevelopmentBusinessStatus["trial"], trialDiagnostic: string | undefined
    try {
      trial = this.trials?.status(context.scope)
    } catch {
      trialDiagnostic =
        "业务试用记录或来源无法核对。原草稿与发布记录仍保留；试用操作已阻止，请核对原任务，不会恢复旧批准或重放。"
    }
    return {
      drafts: this.drafts.list(context.scope).map((draft) => ({
        id: draft.id,
        name: draft.name,
        revision: draft.revision,
        digest: draft.digest,
        modIds: [...draft.catalog.modules, ...(draft.catalog.extensions ?? [])].map((mod) => mod.id)
      })),
      ...(review ? { review } : {}),
      ...(trial ? { trial } : {}),
      ...(trialDiagnostic ? { trialDiagnostic } : {})
    }
  }
  catalog(threadId: string) {
    this.context(threadId)
    return {
      bundledExamples: structuredClone(bundledBusinessModExamples),
      sources: this.deps.plugins().map((plugin) => ({
        pluginId: plugin.id,
        name: plugin.name,
        version: plugin.version,
        enabled: plugin.enabled,
        businessMods: plugin.businessModCount ?? 0,
        functionMods: plugin.businessExtensionCount ?? 0
      })),
      ...this.status(threadId)
    }
  }
  async example(threadId: string, exampleId: string) {
    const context = this.context(threadId)
    const result = await readBundledBusinessModExample(exampleId, __dirname)
    context.assertCurrent()
    return result
  }
  async inspect(threadId: string, pluginId: string) {
    const context = this.context(threadId),
      plugin = this.deps.plugins().find((item) => item.id === pluginId)
    if (!plugin) throw Error("BUSINESS_CREATOR_SOURCE_MISSING")
    const source: Source = {
      pluginId,
      directory: plugin.path,
      identity: pluginIdentity(plugin),
      digest: ""
    }
    const view = await this.deps.assembly.inspect(
      plugin.path,
      this.owner(context.scope),
      context.assertCurrent
    )
    const snapshot = await snapshotDerivationSource(plugin.path)
    context.assertCurrent()
    if (snapshot.digest !== view.sourceDigest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    source.digest = snapshot.digest
    this.assertSource(source)
    if (this.inspections.size >= 64) this.inspections.delete(this.inspections.keys().next().value!)
    this.inspections.set(view.id, {
      scope: businessCreatorScopeKey(context.scope),
      source,
      view,
      catalog: businessModCatalog(snapshot)
    })
    return { ...view, catalog: businessModCatalog(snapshot) }
  }
  private assertSource(source: Source) {
    const plugin = this.deps.plugins().find((item) => item.id === source.pluginId)
    if (!plugin || pluginIdentity(plugin) !== source.identity)
      throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
  }
  private inspection(scope: DevelopmentScope, id: string) {
    const value = this.inspections.get(id)
    if (!value || value.scope !== businessCreatorScopeKey(scope))
      throw Error("BUSINESS_CREATOR_INSPECT_FIRST")
    this.assertSource(value.source)
    return value
  }
  async inspectionPage(threadId: string, inspectionId: string) {
    const context = this.context(threadId),
      inspected = this.inspection(context.scope, inspectionId)
    const snapshot = await snapshotDerivationSource(inspected.source.directory)
    context.assertCurrent()
    this.assertSource(inspected.source)
    if (snapshot.digest !== inspected.source.digest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    return structuredClone(inspected.view)
  }
  async readMod(threadId: string, inspectionId: string, modId: string) {
    await this.inspectionPage(threadId, inspectionId)
    const context = this.context(threadId),
      inspected = this.inspection(context.scope, inspectionId)
    const mod = [...inspected.catalog.modules, ...(inspected.catalog.extensions ?? [])].find(
      (item) => item.id === modId
    )
    if (!mod) throw Error("BUSINESS_CREATOR_MOD_UNAVAILABLE")
    return {
      inspectionId,
      sourceDigest: inspected.source.digest,
      mod: structuredClone(mod),
      untrustedSource: true
    }
  }
  async readAsset(threadId: string, inspectionId: string, path: string) {
    const context = this.context(threadId),
      inspected = this.inspection(context.scope, inspectionId)
    const snapshot = await snapshotDerivationSource(inspected.source.directory)
    context.assertCurrent()
    this.assertSource(inspected.source)
    if (snapshot.digest !== inspected.source.digest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    const catalog = inspected.catalog
    const allowed = [
      BUSINESS_MOD_MANIFEST,
      ...(catalog.kernel ? [...catalog.kernel.resources, catalog.kernel.boardConfigPath] : []),
      ...catalog.modules.flatMap((mod) => [
        mod.skill.entry,
        ...mod.skill.resources,
        ...mod.resources
      ]),
      ...(catalog.extensions ?? []).flatMap((mod) => [
        mod.entry,
        ...mod.resources,
        ...(mod.skills ?? [])
      ])
    ]
    businessModPath(path)
    const file = allowed.some((entry) => path === entry || path.startsWith(`${entry}/`))
      ? snapshot.files.find((file) => file.path === path)
      : undefined
    if (!file || file.bytes.length > 64 * 1024) throw Error("BUSINESS_CREATOR_ASSET_UNAVAILABLE")
    return {
      path,
      digest: file.digest,
      ...sourceText(path, file.bytes),
      untrustedSource: true,
      originalPreserved: true
    }
  }
  async assets(threadId: string, inspectionId: string, cursor = 0) {
    const context = this.context(threadId),
      inspected = this.inspection(context.scope, inspectionId)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("BUSINESS_CREATOR_CURSOR_INVALID")
    const snapshot = await snapshotDerivationSource(inspected.source.directory)
    context.assertCurrent()
    this.assertSource(inspected.source)
    if (snapshot.digest !== inspected.source.digest) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    const catalog = inspected.catalog
    const roots = [
      BUSINESS_MOD_MANIFEST,
      ...(catalog.kernel ? [...catalog.kernel.resources, catalog.kernel.boardConfigPath] : []),
      ...catalog.modules.flatMap((mod) => [
        mod.skill.entry,
        ...mod.skill.resources,
        ...mod.resources
      ]),
      ...(catalog.extensions ?? []).flatMap((mod) => [
        mod.entry,
        ...mod.resources,
        ...(mod.skills ?? [])
      ])
    ]
    const files = snapshot.files.filter((file) =>
      roots.some((root) => file.path === root || file.path.startsWith(`${root}/`))
    )
    return {
      sourceDigest: snapshot.digest,
      total: files.length,
      files: files
        .slice(cursor, cursor + 64)
        .map((file) => ({ path: file.path, digest: file.digest, bytes: file.bytes.length })),
      ...(cursor + 64 < files.length ? { nextCursor: cursor + 64 } : {})
    }
  }
  save(
    threadId: string,
    input: {
      id: string
      name: string
      revision: number
      baseInspectionId: string
      modules: unknown
      extensions?: unknown
      files: CreatorBusinessDraft["files"]
    }
  ) {
    const context = this.context(threadId),
      base = this.inspection(context.scope, input.baseInspectionId)
    if (!base.catalog.kernel) throw Error("BUSINESS_DRAFT_KERNEL_SOURCE_REQUIRED")
    const kernel = base.catalog.kernel ?? base.catalog.kernelRef!
    const draft = this.drafts.save(
      context.scope,
      {
        ...input,
        revision: input.revision + 1,
        baseSource: { pluginId: base.source.pluginId, digest: base.source.digest },
        catalog: parseBusinessModCatalog({
          apiVersion: "devclaw.business-mods/v1",
          kind: "catalog",
          kernelRef: { id: kernel.id, version: kernel.version },
          modules: input.modules,
          ...(input.extensions === undefined ? {} : { extensions: input.extensions })
        })
      },
      input.revision,
      context.assertCurrent
    )
    this.deps.changed(threadId)
    return draft
  }
  read(threadId: string, id: string) {
    const context = this.context(threadId)
    return this.drafts.read(context.scope, id)
  }
  async preview(
    threadId: string,
    input: Omit<BusinessModAssemblyRequest, "sources"> & {
      sources: BusinessModAssemblyRequest["sources"]
      drafts?: Array<{ id: string; revision: number; modIds: string[] }>
    }
  ) {
    const context = this.context(threadId),
      owner = this.owner(context.scope)
    const sources = input.sources.map(
      (item) => this.inspection(context.scope, item.inspectionId).source
    )
    const request = { ...input, sources: [...input.sources] }
    const draftRefs: Preview["drafts"] = []
    if ((input.drafts?.length ?? 0) > 4) throw Error("BUSINESS_DRAFT_LIMIT")
    for (const ref of input.drafts ?? []) {
      const draft = this.drafts.read(context.scope, ref.id)
      if (draft.revision !== ref.revision) throw Error("BUSINESS_DRAFT_REVISION_CHANGED")
      if (
        !sources.some(
          (source) =>
            source.pluginId === draft.baseSource.pluginId &&
            source.digest === draft.baseSource.digest
        )
      )
        throw Error("BUSINESS_DRAFT_BASE_CHANGED")
      await mkdir(this.deps.root, { recursive: true })
      const directory = await mkdtemp(join(this.deps.root, "draft-"))
      const files = [
        {
          path: "plugin.json",
          text: JSON.stringify({ name: `creator-${draft.id}`, version: "0.1.0" })
        },
        { path: BUSINESS_MOD_MANIFEST, text: JSON.stringify(draft.catalog) },
        ...draft.files
      ].map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.text),
        mode: process.platform === "win32" ? 0o666 : 0o644,
        digest: createHash("sha256").update(file.text).digest("hex")
      }))
      await writeDerivationFiles(directory, files)
      context.assertCurrent()
      const inspected = await this.deps.assembly.inspect(directory, owner, context.assertCurrent)
      request.sources.push({ inspectionId: inspected.id, modIds: ref.modIds })
      draftRefs.push({ id: ref.id, revision: ref.revision, digest: draft.digest })
    }
    const view = await this.deps.assembly.preview(owner, request, context.assertCurrent)
    context.assertCurrent()
    for (const source of sources) this.assertSource(source)
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(view.previewId, {
      scope: businessCreatorScopeKey(context.scope),
      previewId: view.previewId,
      view: structuredClone(view),
      sources,
      drafts: draftRefs
    })
    return view
  }
  async previewDetails(threadId: string, previewId: string) {
    const context = this.context(threadId),
      preview = this.previews.get(previewId)
    if (!preview || preview.scope !== businessCreatorScopeKey(context.scope))
      throw Error("BUSINESS_CREATOR_PREVIEW_REQUIRED")
    await this.assertInputs(context, preview)
    return structuredClone(preview.view)
  }
  async requestReview(threadId: string, previewId: string, turnId: string, assertTurn: () => void) {
    assertTurn()
    const context = this.context(threadId),
      previous = this.record(context.scope)
    if (
      this.writing.has(threadId) ||
      (previous && ["unknown", "installing", "exporting"].includes(previous.review.phase))
    )
      throw Error("BUSINESS_CREATOR_OUTCOME_UNCONFIRMED")
    const preview = this.previews.get(previewId)
    if (!preview || preview.scope !== businessCreatorScopeKey(context.scope))
      throw Error("BUSINESS_CREATOR_PREVIEW_REQUIRED")
    await this.assertInputs(context, preview)
    assertTurn()
    const owner = this.owner(context.scope)
    // Re-review unchanged, already materialized bytes rather than creating a conflicting name.
    const retained = this.deps.assembly
      .list(owner)
      .find(
        (copy) =>
          copy.digest === preview.view.digest &&
          copy.name === preview.view.name &&
          copy.version === preview.view.version
      )
    const copy =
      retained ??
      (await this.deps.assembly.create(owner, previewId, randomUUID(), context.assertCurrent, {
        allowInstalledNameForExport: true
      }))
    await this.deps.assembly.check(owner, copy.copyId, copy.digest, context.assertCurrent)
    assertTurn()
    const record: Record = {
      version: 1,
      scope: context.scope,
      sources: preview.sources,
      drafts: preview.drafts,
      turnId,
      settled: false,
      review: {
        planId: randomUUID(),
        phase: copy.status === "installed" ? "installed" : "needs-approval",
        name: copy.name,
        version: copy.version,
        digest: copy.digest,
        copyId: copy.copyId,
        steps: preview.view.steps,
        ...(copy.pluginId ? { pluginId: copy.pluginId } : {}),
        ...(copy.exportOnly ? { exportOnly: true } : {}),
        ...(preview.view.extensions ? { extensions: preview.view.extensions } : {}),
        diagnostics: [
          ...preview.view.diagnostics,
          copy.exportOnly
            ? "此候选仅供导出更新包；请通过原安装插件入口确认ZIP更新，保留原UUID和配置，权限变化重新确认。尚未更新已安装插件或执行业务阶段。"
            : copy.status === "installed"
              ? "此精确副本已有原生安装记录；本次重审未新增授权或执行实际业务阶段。"
              : "已完成原生组装与包检查；尚未安装、授权或执行实际业务阶段。"
        ],
        canConfirm: false
      }
    }
    if (previous) this.live.delete(previous.review.planId)
    if (this.live.size >= 64) throw Error("BUSINESS_CREATOR_REVIEW_CAPACITY")
    this.live.add(record.review.planId)
    this.persist(record, context.assertCurrent)
    return this.status(threadId)
  }
  private async assertInputs(
    context: DevelopmentContext,
    input: Pick<Record, "sources" | "drafts">
  ) {
    for (const source of input.sources) {
      this.assertSource(source)
      if ((await snapshotDerivationSource(source.directory)).digest !== source.digest)
        throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
      context.assertCurrent()
    }
    for (const ref of input.drafts) {
      const draft = this.drafts.read(context.scope, ref.id)
      if (draft.revision !== ref.revision || draft.digest !== ref.digest)
        throw Error("BUSINESS_DRAFT_REVISION_CHANGED")
    }
  }
  private trusted(threadId: string, workspace: string, input: { planId: string; digest: string }) {
    const context = this.context(threadId, false),
      record = this.record(context.scope)
    if (
      context.scope.workspace !== workspace ||
      !record ||
      record.review.planId !== input.planId ||
      record.review.digest !== input.digest
    )
      throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
    if (!this.live.has(input.planId) || !record.settled)
      throw Error("BUSINESS_CREATOR_REVIEW_REQUIRED")
    if (this.writing.has(threadId) || this.deps.busy(threadId)) throw Error("BUSINESS_CREATOR_BUSY")
    return { context, record }
  }
  async approve(threadId: string, workspace: string, input: { planId: string; digest: string }) {
    const { context, record } = this.trusted(threadId, workspace, input)
    if (!["needs-approval", "exported"].includes(record.review.phase))
      throw Error("BUSINESS_CREATOR_REVIEW_REQUIRED")
    if (record.review.exportOnly) throw Error("BUSINESS_MOD_NATIVE_ZIP_UPDATE_REQUIRED")
    this.writing.add(threadId)
    let effects = false
    try {
      await this.assertInputs(context, record)
      record.review.phase = "installing"
      record.effect = { kind: "install" }
      delete record.review.reconciliation
      this.persist(record, context.assertCurrent)
      effects = true
      const copy = await this.deps.assembly.install(
        this.owner(context.scope),
        record.review.copyId,
        record.review.digest,
        context.assertCurrent
      )
      context.assertCurrent()
      record.review.phase = "installed"
      record.review.pluginId = copy.pluginId
      this.persist(record, context.assertCurrent)
    } catch {
      record.review.phase = effects ? "unknown" : "failed"
      record.review.error = effects
        ? "BUSINESS_CREATOR_INSTALL_UNCONFIRMED"
        : "BUSINESS_CREATOR_INPUT_CHANGED"
      this.live.delete(record.review.planId)
      this.persist(record, context.assertCurrent)
    } finally {
      this.writing.delete(threadId)
    }
    return this.status(threadId)
  }
  async exportTrusted(
    threadId: string,
    workspace: string,
    input: { planId: string; digest: string },
    output: string
  ) {
    const { context, record } = this.trusted(threadId, workspace, input)
    if (!["needs-approval", "installed", "exported"].includes(record.review.phase))
      throw Error("BUSINESS_CREATOR_REVIEW_REQUIRED")
    this.writing.add(threadId)
    let effects = false
    const beforePhase = record.review.phase
    try {
      await this.assertInputs(context, record)
      record.review.phase = "exporting"
      record.effect = { kind: "export", output: resolve(output) }
      delete record.review.reconciliation
      this.persist(record, context.assertCurrent)
      effects = true
      const result = await this.deps.assembly.export(
        this.owner(context.scope),
        record.review.copyId,
        record.review.digest,
        output,
        context.assertCurrent
      )
      context.assertCurrent()
      record.review.phase = record.review.pluginId ? "installed" : "exported"
      record.review.output = result.output
      this.persist(record, context.assertCurrent)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        record.review.phase = beforePhase
        record.review.error = "BUSINESS_CREATOR_EXPORT_EXISTS"
      } else {
        record.review.phase = effects ? "unknown" : "failed"
        record.review.error = effects
          ? "BUSINESS_CREATOR_EXPORT_UNCONFIRMED"
          : "BUSINESS_CREATOR_INPUT_CHANGED"
        this.live.delete(record.review.planId)
      }
      this.persist(record, context.assertCurrent)
    } finally {
      this.writing.delete(threadId)
    }
    return this.status(threadId)
  }
  /** Native readback observes a journaled attempt; it grants no fresh install/export authority. */
  async reconcile(threadId: string, workspace: string, input: { planId: string; digest: string }) {
    const context = this.context(threadId, false),
      record = this.record(context.scope)
    if (
      context.scope.workspace !== workspace ||
      !record ||
      record.review.planId !== input.planId ||
      record.review.digest !== input.digest
    )
      throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
    if (this.writing.has(threadId) || this.deps.busy(threadId)) throw Error("BUSINESS_CREATOR_BUSY")
    if (this.status(threadId).review?.phase !== "unknown")
      throw Error("BUSINESS_CREATOR_OUTCOME_NOT_UNKNOWN")
    this.writing.add(threadId)
    try {
      const effect =
        record.effect ??
        (record.review.phase === "installing"
          ? { kind: "install" as const }
          : record.review.phase === "exporting" && record.review.output
            ? { kind: "export" as const, output: record.review.output }
            : undefined)
      const observation = effect
        ? await this.deps.assembly.observe(
            this.owner(context.scope),
            record.review.copyId,
            input.digest,
            effect,
            context.assertCurrent
          )
        : { outcome: "unknown" as const, reason: "BUSINESS_CREATOR_EFFECT_IDENTITY_MISSING" }
      context.assertCurrent()
      const current = this.record(context.scope)
      if (
        !current ||
        current.review.planId !== input.planId ||
        current.review.digest !== input.digest
      )
        throw Error("BUSINESS_CREATOR_REVIEW_CHANGED")
      record.review.reconciliation = {
        outcome: observation.outcome,
        checkedAt: Date.now(),
        ...(observation.outcome === "unknown" ? { reason: observation.reason } : {})
      }
      this.live.delete(input.planId)
      record.settled = false
      if (observation.outcome === "installed") {
        record.review.phase = "installed"
        record.review.pluginId = observation.pluginId
        delete record.review.error
      } else if (observation.outcome === "exported") {
        // ZIP readback proves the artifact only; it does not revalidate a previous installation.
        record.review.phase = "exported"
        record.review.output = observation.output
        delete record.review.error
      } else {
        record.review.phase = "unknown"
        record.review.error = observation.reason
      }
      this.persist(record, context.assertCurrent)
    } finally {
      this.writing.delete(threadId)
    }
    return this.status(threadId)
  }
  close() {
    this.trials?.close()
    this.closed = true
    this.live.clear()
    this.stopSettlement()
    this.stopIdle?.()
  }
}
let service: CreatorBusinessService | undefined
export function setCreatorBusinessService(value: CreatorBusinessService | undefined) {
  service = value
}
export function getCreatorBusinessService() {
  return service
}
