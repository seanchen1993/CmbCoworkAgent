import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  AUTOBIZ_CONTEXT_MAX_BYTES,
  AUTOBIZ_CONTEXT_OUTPUT,
  type AutobizContextFile
} from "../../../shared/project-runtime/autobiz-handoff"
import type { CompositionCompletionProof } from "../../../shared/project-runtime/composition"
import { canonicalStageCheckJson } from "../../../shared/project-runtime/stage-check-receipt"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectory } from "./safe-files"
import type { SourceHandoffEvidence } from "./composition-source-handoff"
import { readPackageExtensionContract } from "../../plugins/extension-contract"

/** This reserved export must be explicitly opted into by the frozen source manifest. */
export function assertAutobizHandoffDeclaration(source: string): readonly string[] | undefined {
  const manifest = readRuntimeScopedFile(source, "devclaw.project-runtime.json", 256 * 1024)
  if (!manifest.bytes) throw Error("AUTOBIZ_HANDOFF_UNDECLARED")
  const parsed = parseProjectRuntimeManifest(JSON.parse(manifest.bytes.toString("utf8")))
  if (
    parsed.mode !== "legacy" ||
    !parsed.artifacts.some(
      (artifact) =>
        artifact.id === AUTOBIZ_CONTEXT_OUTPUT.id &&
        artifact.path === AUTOBIZ_CONTEXT_OUTPUT.path &&
        artifact.required
    )
  )
    throw Error("AUTOBIZ_HANDOFF_UNDECLARED")
  return readPackageExtensionContract(source)?.verifiedArtifacts?.artifactIds
}

export function encodeAutobizHandoff(
  context: CompositionExecutionContext,
  identity: { projectId: string; featureId: string },
  proof: CompositionCompletionProof,
  files: AutobizContextFile[],
  sourceChanges?: SourceHandoffEvidence
): Buffer {
  if (!files.length || files.length + (sourceChanges?.changes.length ?? 0) > 128)
    throw Error("AUTOBIZ_HANDOFF_OUTPUTS_REQUIRED")
  const bytes = Buffer.from(
    canonicalStageCheckJson({
      apiVersion: "devclaw.autobiz-context/v1",
      scope: "checked-business-design-reports; excludes source-code acceptance",
      producer: {
        compositionRunId: context.runId,
        unitId: context.unit.id,
        projectId: identity.projectId,
        featureId: identity.featureId,
        engineRunId: proof.engineRunId,
        source: context.unit.source,
        evidenceDigest: proof.evidenceDigest
      },
      files,
      ...(sourceChanges ? { sourceChanges } : {})
    }) + "\n"
  )
  if (bytes.length > AUTOBIZ_CONTEXT_MAX_BYTES) throw Error("AUTOBIZ_HANDOFF_SIZE_LIMIT")
  return bytes
}

/** No overwrite: interrupted/changed exports need investigation, never an implicit new version. */
export function materializeAutobizHandoff(
  workspace: string,
  bytes: Buffer,
  write: boolean
): string {
  const digest = runtimeDigest(bytes)
  let file = readRuntimeScopedFile(
    workspace,
    AUTOBIZ_CONTEXT_OUTPUT.path,
    AUTOBIZ_CONTEXT_MAX_BYTES
  )
  if (!file.present && write) {
    let directory = runtimeDirectory(workspace)
    for (const part of [".devclaw", "handoffs"]) {
      directory = join(directory, part)
      mkdirSync(directory, { recursive: true })
      runtimeDirectory(directory)
    }
    const temporary = join(directory, `.context-${randomUUID()}.tmp`)
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      try {
        writeFileSync(descriptor, bytes)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      linkSync(temporary, join(workspace, AUTOBIZ_CONTEXT_OUTPUT.path))
    } finally {
      unlinkSync(temporary)
    }
    file = readRuntimeScopedFile(workspace, AUTOBIZ_CONTEXT_OUTPUT.path, AUTOBIZ_CONTEXT_MAX_BYTES)
  }
  if (!file.bytes || runtimeDigest(file.bytes) !== digest)
    throw Error("AUTOBIZ_HANDOFF_EXPORT_CHANGED")
  return digest
}
