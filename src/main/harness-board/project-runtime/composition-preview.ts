import { randomUUID } from "node:crypto"
import type {
  ProjectCompositionCatalog,
  ProjectCompositionPreview,
  ProjectCompositionScope
} from "../../../shared/project-runtime/composition-api"
import { parseProjectComposition } from "../../../shared/project-runtime/composition"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import {
  compositionSourceKey,
  type CompositionCatalogSnapshot
} from "../../plugins/project-composition-catalog"

interface ScopeCapture {
  identity: string
  projectName: string
  assertCurrent(): void
}
interface CatalogLease {
  capture: ScopeCapture
  scope: ProjectCompositionScope
  snapshot: CompositionCatalogSnapshot
  expires: number
}
interface PreviewLease {
  catalog: CatalogLease
  preview: ProjectCompositionPreview
  requestId?: string
}

/** Renderer proposals never become executable definitions without a frozen, host-owned preview. */
export class ProjectCompositionPreviews {
  private readonly catalogs = new Map<string, CatalogLease>()
  private readonly previews = new Map<string, PreviewLease>()
  constructor(private readonly now = () => Date.now()) {}
  remember(
    scope: ProjectCompositionScope,
    capture: ScopeCapture,
    snapshot: CompositionCatalogSnapshot
  ): ProjectCompositionCatalog {
    capture.assertCurrent()
    this.prune()
    if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!)
    const lease = {
      scope: structuredClone(scope),
      capture,
      snapshot: structuredClone(snapshot),
      expires: this.now() + 600_000
    }
    this.catalogs.set(this.key(scope), lease)
    return {
      revision: snapshot.revision,
      contextKey: capture.identity,
      projectName: capture.projectName,
      entries: structuredClone(snapshot.sources.map((source) => source.entry)),
      diagnostics: [...snapshot.diagnostics]
    }
  }
  preview(
    scope: ProjectCompositionScope,
    revision: string,
    value: unknown,
    optionalOmissions: NonNullable<ProjectCompositionPreview["optionalOmissions"]> = [],
    entryInputFallbacks: NonNullable<ProjectCompositionPreview["entryInputFallbacks"]> = []
  ): ProjectCompositionPreview {
    const catalog = this.requireCatalog(scope, revision)
    const definition = parseProjectComposition(value)
    if (
      definition.parentProjectId !== scope.projectId ||
      !isSameWorkspacePath(definition.workspace, scope.expectedWorkspace)
    )
      throw Error("COMPOSITION_PROJECT_CHANGED")
    definition.workspace = scope.expectedWorkspace
    const issues: string[] = []
    const selected = new Set<string>()
    const sources = new Map(
      catalog.snapshot.sources.map((source) => [compositionSourceKey(source.entry.source), source])
    )
    for (const unit of definition.units) {
      const source = sources.get(compositionSourceKey(unit.source))
      if (!source || !source.entry.available || source.entry.kind !== unit.kind) {
        issues.push(`${unit.id}：能力已变更或暂不能组合，请重新选择。`)
        continue
      }
      if (
        JSON.stringify(unit.outputs) !==
        JSON.stringify(source.entry.outputs.map(({ id, path }) => ({ id, path })))
      )
        issues.push(`${source.entry.title}：结果文件已变更，请重新选择。`)
      if (unit.workflow) {
        const workflow = source.entry.workflow
        const template = workflow?.config.templates.find((item) =>
          item.id === unit.workflow!.templateId && item.templateType === "custom")
        if (!template || source.capability.kind !== "flow" || source.capability.runtimeMode !== "legacy" ||
          !template.requiredNodes.every((id) => unit.workflow!.nodeIds.includes(id)) ||
          unit.workflow.nodeIds.some((id) => !workflow!.config.nodes.some((node) => node.id === id)))
          issues.push(`${source.entry.title}：所选步骤已变更，请重新检查原流程依赖。`)
      }
      if (
        unit.inputs.some(
          (input) => !source.entry.inputs.some((entry) => entry.id === input.inputId)
        )
      )
        issues.push(`${source.entry.title}：接收的结果未在能力中声明。`)
      for (const input of source.entry.inputs)
        if (input.required && !unit.inputs.some((mapping) => mapping.inputId === input.id))
          issues.push(`${source.entry.title}：请指定“${input.title}”的来源结果。`)
      for (const dependency of source.capability.dependsOn) {
        if (!selected.has(JSON.stringify([source.plugin.id, dependency])))
          issues.push(`${source.entry.title}：请先添加所需能力 ${dependency}。`)
      }
      selected.add(JSON.stringify([source.plugin.id, source.capability.id]))
    }
    const preview = {
      id: randomUUID(),
      contextKey: catalog.capture.identity,
      definition,
      addedUnitIds: [],
      issues,
      ...(optionalOmissions.length ? { optionalOmissions: structuredClone(optionalOmissions) } : {}),
      ...(entryInputFallbacks.length ? { entryInputFallbacks: structuredClone(entryInputFallbacks) } : {})
    }
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(preview.id, { catalog, preview })
    return structuredClone(preview)
  }
  requireCatalog(scope: ProjectCompositionScope, revision: string): CatalogLease {
    this.prune()
    const catalog = this.catalogs.get(this.key(scope))
    if (!catalog || catalog.snapshot.revision !== revision)
      throw Error("COMPOSITION_CATALOG_CHANGED")
    catalog.capture.assertCurrent()
    return catalog
  }
  consume(scope: ProjectCompositionScope, previewId: string, requestId?: string): PreviewLease {
    this.prune()
    const lease = this.previews.get(previewId)
    if (!lease || this.key(scope) !== this.key(lease.catalog.scope))
      throw Error("COMPOSITION_PREVIEW_EXPIRED")
    lease.catalog.capture.assertCurrent()
    if (lease.preview.issues.length) throw Error("COMPOSITION_PREVIEW_INVALID")
    if (requestId !== undefined) {
      if (lease.requestId !== undefined && lease.requestId !== requestId)
        throw Error("COMPOSITION_PREVIEW_ALREADY_USED")
      lease.requestId = requestId
    }
    // Keep the immutable preview for idempotent retry after an uncertain IPC response.
    return { catalog: lease.catalog, preview: structuredClone(lease.preview) }
  }
  private key(scope: ProjectCompositionScope): string {
    return JSON.stringify([scope.threadId, scope.projectId, scope.expectedWorkspace])
  }
  private prune(): void {
    for (const [key, value] of this.catalogs)
      if (value.expires <= this.now()) this.catalogs.delete(key)
    for (const [key, value] of this.previews)
      if (value.catalog.expires <= this.now()) this.previews.delete(key)
  }
}
