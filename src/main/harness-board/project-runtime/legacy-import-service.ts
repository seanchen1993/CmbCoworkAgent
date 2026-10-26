import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type {
  HostLegacyImportInput,
  HostLegacyImportReview,
  HostLegacyAdapterInput
} from "../../../shared/project-runtime/host-types"
import { workspacePathsOverlap } from "../../../shared/workspace-path"
import { hostRecord, hostStateError, hostText } from "./host-state-protocol"
import {
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity,
  runtimeRelativePath,
  readRuntimeScopedFile
} from "./safe-files"
import { readProjectActionLock } from "./action-input"
import type { HostProjectService } from "./host-service"
import type { LegacyProjectRuntimeService } from "./legacy-runtime-service"
import type { HostPackageSnapshot } from "./package-snapshots"
import { adaptLegacyImport, listLegacyImportAdapters } from "./legacy-import-adapter"

/** Shared by review and the desktop picker; declarations never replace execution authorization. */
export function reviewImportStageEligibility(
  snapshot: HostPackageSnapshot,
  reexecuteStageIds: readonly string[] = []
) {
  const lock = readProjectActionLock(snapshot.root, snapshot.manifest)
  return snapshot.manifest.stages.map((stage) => {
    const checks = stage.checkIds.map((id) =>
      snapshot.manifest.checks.find((check) => check.id === id)
    )
    let reason: string | undefined
    if (stage.actionIds.length && !reexecuteStageIds.includes(stage.id))
      reason = "IMPORT_STAGE_REQUIRES_CHECKS_AND_NEW_RESULT_APPROVAL"
    else if (!stage.checkIds.length || !stage.artifactIds.length || checks.some((check) => !check))
      reason = "IMPORT_STAGE_CHECKS_REQUIRED"
    else if (stage.artifactIds.some((id) => !checks.some((check) => check?.artifactId === id)))
      reason = "IMPORT_ARTIFACT_CHECK_REQUIRED"
    else if (
      checks.some(
        (check) =>
          check?.kind === "action" &&
          !lock.bindings.find((binding) => binding.id === check.actionId)?.platform
      )
    )
      reason = "IMPORT_CHECK_ADAPTER_REQUIRED"
    return { stageId: stage.id, eligible: !reason, ...(reason ? { reason } : {}) }
  })
}

export interface HostLegacyImportDependencies {
  /** Must inspect original durable Flow/workflow/PTY resources in both workspaces. */
  authorize(sourceWorkspace: string, targetWorkspace: string): Promise<{ assertCurrent(): void }>
}

/** One explicit migration boundary; freezes routing before copying, never rewrites legacy state. */
export class HostLegacyImportService {
  constructor(
    private readonly legacy: LegacyProjectRuntimeService,
    private readonly host: HostProjectService,
    private readonly deps: HostLegacyImportDependencies
  ) {}

  async listAdapters(installedPluginId: string) {
    const target = await this.host.reviewImportTarget(installedPluginId)
    const result = listLegacyImportAdapters(target.snapshot)
    target.assertCurrent()
    return result
  }

  async reviewAdapter(input: HostLegacyAdapterInput): Promise<HostLegacyImportReview> {
    return (await this.prepareAdapter(input)).review
  }

  private async prepareAdapter(input: HostLegacyAdapterInput) {
    hostRecord(input, ["sourceProjectId", "target", "adapterId", "parameters"])
    const source = await this.legacy.reviewImportSource(input.sourceProjectId)
    const target = await this.host.reviewImportTarget(input.target.installedPluginId)
    const adapted = adaptLegacyImport(
      target.snapshot,
      source.source.workspace,
      source.source.packageId,
      input
    )
    source.assertCurrent()
    target.assertCurrent()
    return this.prepare(
      {
        sourceProjectId: input.sourceProjectId,
        target: input.target,
        prefixStageIds: adapted.prefixStageIds,
        artifacts: adapted.artifacts
      },
      { input, adapted }
    )
  }

  private async prepare(
    input: HostLegacyImportInput,
    adapter?: {
      input: HostLegacyAdapterInput
      adapted: ReturnType<typeof adaptLegacyImport>
    }
  ) {
    hostRecord(input, ["sourceProjectId", "target", "prefixStageIds", "artifacts"])
    hostRecord(input.target, ["projectId", "name", "workspace", "installedPluginId", "goal"])
    input = structuredClone(input)
    for (const value of [input.sourceProjectId, ...Object.values(input.target)]) hostText(value)
    const source = await this.legacy.reviewImportSource(input.sourceProjectId)
    const workspace = runtimeDirectory(input.target.workspace)
    if (workspacePathsOverlap(source.source.workspace, workspace))
      hostStateError("IMPORT_WORKSPACE_OVERLAP")
    input.target.workspace = workspace
    const target = await this.host.reviewImportTarget(input.target.installedPluginId)
    const manifest = target.snapshot.manifest
    if (
      !Array.isArray(input.prefixStageIds) ||
      !input.prefixStageIds.length ||
      input.prefixStageIds.length > manifest.stages.length ||
      input.prefixStageIds.some((id, index) => id !== manifest.stages[index].id)
    )
      hostStateError("IMPORT_PREFIX_INVALID")
    const stages = manifest.stages.slice(0, input.prefixStageIds.length)
    const rejected = reviewImportStageEligibility(
      target.snapshot,
      adapter?.adapted.adaptation.reexecuteStageIds
    )
      .slice(0, stages.length)
      .find((stage) => !stage.eligible)
    if (rejected) hostStateError(rejected.reason!)
    const artifactIds = [
      ...new Set(
        stages
          .filter((stage) => !adapter?.adapted.adaptation.reexecuteStageIds.includes(stage.id))
          .flatMap((stage) => stage.artifactIds)
      )
    ]
    if (adapter) artifactIds.push("$legacy-source")
    if (
      !Array.isArray(input.artifacts) ||
      input.artifacts.length !== artifactIds.length ||
      new Set(input.artifacts.map((file) => file.artifactId)).size !== artifactIds.length ||
      input.artifacts.some((file) => !artifactIds.includes(file.artifactId))
    )
      hostStateError("IMPORT_ARTIFACT_MAPPING_INVALID")
    let total = 0
    const outputs = new Map<string, Buffer>(adapter?.adapted.outputs)
    const files = adapter
      ? adapter.adapted.files
      : artifactIds.map((artifactId) => {
          const mapped = input.artifacts.find((file) => file.artifactId === artifactId)!
          hostRecord(mapped, ["artifactId", "sourcePath"])
          const sourcePath = runtimeRelativePath(mapped.sourcePath)
          const file = readRuntimeScopedFile(source.source.workspace, sourcePath, 16 * 1024 * 1024)
          if (!file.bytes) hostStateError("IMPORT_ARTIFACT_MISSING")
          total += file.bytes.length
          if (total > 64 * 1024 * 1024) hostStateError("IMPORT_ARTIFACT_LIMIT")
          const targetPath = runtimeRelativePath(
            manifest.artifacts.find((file) => file.id === artifactId)!.path
          )
          outputs.set(targetPath, file.bytes)
          return {
            artifactId,
            sourcePath,
            targetPath,
            digest: runtimeDigest(file.bytes),
            bytes: file.bytes.length
          }
        })
    const scope = await this.deps.authorize(source.source.workspace, workspace)
    const sourceDirectory = runtimeDirectoryIdentity(source.source.workspace)
    const targetDirectory = runtimeDirectoryIdentity(workspace)
    const assertCurrent = () => {
      scope.assertCurrent()
      source.assertCurrent()
      target.assertCurrent()
      if (
        runtimeDirectoryIdentity(source.source.workspace) !== sourceDirectory ||
        runtimeDirectoryIdentity(workspace) !== targetDirectory
      )
        hostStateError("IMPORT_WORKSPACE_CHANGED")
      if (adapter) {
        const current = adaptLegacyImport(
          target.snapshot,
          source.source.workspace,
          source.source.packageId,
          adapter.input
        )
        if (
          JSON.stringify(current.adaptation) !== JSON.stringify(adapter.adapted.adaptation) ||
          JSON.stringify(current.files) !== JSON.stringify(files)
        )
          hostStateError("IMPORT_SOURCE_CHANGED")
      }
      for (const file of adapter?.adapted.adaptation.sourceFiles ?? files) {
        const current = readRuntimeScopedFile(
          source.source.workspace,
          file.sourcePath,
          16 * 1024 * 1024
        )
        if (!current.bytes || runtimeDigest(current.bytes) !== file.digest)
          hostStateError("IMPORT_SOURCE_CHANGED")
      }
    }
    assertCurrent()
    const payload = {
      ...input,
      protocol: "devclaw.host-legacy-import/v2" as const,
      source: source.source,
      historyDigest: source.historyDigest,
      targetDigest: target.snapshot.digest,
      files,
      ...(adapter ? { adaptation: adapter.adapted.adaptation } : {})
    }
    const review: HostLegacyImportReview = {
      ...payload,
      reviewDigest: runtimeDigest(JSON.stringify(payload))
    }
    return { review, assertCurrent, outputs }
  }

  async review(input: HostLegacyImportInput): Promise<HostLegacyImportReview> {
    return (await this.prepare(input)).review
  }

  async resumeReview(sourceProjectId: string): Promise<HostLegacyImportReview> {
    const frozen = this.legacy.importFreeze(hostText(sourceProjectId))
    if (!frozen) hostStateError("IMPORT_REVIEW_MISSING")
    if (!frozen.review) hostStateError("IMPORT_REVIEW_NOT_RECORDED")
    const review = frozen.review
    const completed = this.host.importedSource(review.target.projectId)
    if (completed) {
      if (JSON.stringify(completed.review) !== JSON.stringify(review))
        hostStateError("IMPORT_ALREADY_RECORDED")
      return structuredClone(review)
    }
    const prepared = review.adaptation
      ? await this.prepareAdapter({
          sourceProjectId,
          target: review.target,
          adapterId: review.adaptation.adapterId,
          parameters: review.adaptation.parameters
        })
      : await this.prepare({
          sourceProjectId,
          target: review.target,
          prefixStageIds: review.prefixStageIds,
          artifacts: review.artifacts
        })
    if (JSON.stringify(prepared.review) !== JSON.stringify(review))
      hostStateError("IMPORT_REVIEW_CHANGED")
    return structuredClone(review)
  }

  async confirm(review: HostLegacyImportReview) {
    const existing = this.host.importedSource(review.target.projectId)
    if (existing) {
      if (JSON.stringify(existing.review) !== JSON.stringify(review))
        hostStateError("IMPORT_ALREADY_RECORDED")
      return this.host.get(review.target.projectId)!
    }
    const prepared = review.adaptation
      ? await this.prepareAdapter({
          sourceProjectId: review.sourceProjectId,
          target: review.target,
          adapterId: review.adaptation.adapterId,
          parameters: review.adaptation.parameters
        })
      : await this.prepare({
          sourceProjectId: review.sourceProjectId,
          target: review.target,
          prefixStageIds: review.prefixStageIds,
          artifacts: review.artifacts
        })
    if (JSON.stringify(prepared.review) !== JSON.stringify(review))
      hostStateError("IMPORT_REVIEW_CHANGED")
    // No auto-unfreeze on any later failure: a retry must use the exact reviewed source identity.
    this.legacy.freezeForImport(
      review.sourceProjectId,
      review.reviewDigest,
      prepared.assertCurrent,
      review
    )
    for (const file of review.files) {
      prepared.assertCurrent()
      const existingFile = readRuntimeScopedFile(
        review.target.workspace,
        file.targetPath,
        16 * 1024 * 1024
      )
      if (existingFile.present) {
        if (!existingFile.bytes || runtimeDigest(existingFile.bytes) !== file.digest)
          hostStateError("IMPORT_TARGET_FILE_EXISTS")
        continue
      }
      const bytes = prepared.outputs.get(file.targetPath)
      if (!bytes || runtimeDigest(bytes) !== file.digest) hostStateError("IMPORT_SOURCE_CHANGED")
      let directory = review.target.workspace
      for (const part of dirname(file.targetPath)
        .split(/[\\/]/)
        .filter((part) => part !== ".")) {
        directory = join(directory, part)
        if (!existsSync(directory)) mkdirSync(directory)
        runtimeDirectory(directory)
      }
      prepared.assertCurrent()
      writeFileSync(join(review.target.workspace, file.targetPath), bytes, { flag: "wx" })
    }
    const assertCopiedCurrent = () => {
      prepared.assertCurrent()
      for (const file of review.files) {
        const current = readRuntimeScopedFile(
          review.target.workspace,
          file.targetPath,
          16 * 1024 * 1024
        )
        if (!current.bytes || runtimeDigest(current.bytes) !== file.digest)
          hostStateError("IMPORT_TARGET_CHANGED")
      }
    }
    assertCopiedCurrent()
    return this.host.localCreate(review.target, assertCopiedCurrent, {
      review,
      confirmedAt: Date.now(),
      actor: "desktop-user",
      historicalSuccess: "untrusted-source-only"
    })
  }
}
