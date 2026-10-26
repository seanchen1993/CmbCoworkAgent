import { isAbsolute } from "node:path"
import type { HostLegacyImportReceipt } from "../../../shared/project-runtime/host-types"
import {
  hostDigest,
  hostInteger,
  hostRecord,
  hostStateError,
  hostText
} from "./host-state-protocol"
import { parseLegacyProjectRuntimeBinding } from "./legacy-operation-store"
import { runtimeDigest, runtimeRelativePath } from "./safe-files"

/** A corrupt import receipt must never remove the original validation-only prefix. */
export function parseHostLegacyImportReceipt(value: unknown): HostLegacyImportReceipt {
  const receipt = hostRecord(value, ["review", "confirmedAt", "actor", "historicalSuccess"])
  if (receipt.actor !== "desktop-user" || receipt.historicalSuccess !== "untrusted-source-only")
    hostStateError("IMPORT_RECEIPT_INVALID")
  hostInteger(receipt.confirmedAt)
  const review = hostRecord(receipt.review, [
    "sourceProjectId",
    "target",
    "prefixStageIds",
    "artifacts",
    "protocol",
    "source",
    "historyDigest",
    "targetDigest",
    "files",
    "reviewDigest",
    ...(receipt.review &&
    typeof receipt.review === "object" &&
    Object.hasOwn(receipt.review, "adaptation")
      ? ["adaptation"]
      : [])
  ])
  if (
    !["devclaw.host-legacy-import/v1", "devclaw.host-legacy-import/v2"].includes(
      String(review.protocol)
    )
  )
    hostStateError("IMPORT_RECEIPT_INVALID")
  const target = hostRecord(review.target, [
    "projectId",
    "name",
    "workspace",
    "installedPluginId",
    "goal"
  ])
  Object.values(target).forEach((value) => hostText(value))
  const source = parseLegacyProjectRuntimeBinding(review.source)
  if (
    source.projectId !== hostText(review.sourceProjectId) ||
    !isAbsolute(source.workspace) ||
    !isAbsolute(String(target.workspace))
  )
    hostStateError("IMPORT_RECEIPT_INVALID")
  for (const digest of [review.historyDigest, review.targetDigest, review.reviewDigest])
    hostDigest(digest)
  if (
    !Array.isArray(review.prefixStageIds) ||
    !review.prefixStageIds.length ||
    review.prefixStageIds.length > 128 ||
    new Set(review.prefixStageIds).size !== review.prefixStageIds.length
  )
    hostStateError("IMPORT_RECEIPT_INVALID")
  review.prefixStageIds.forEach((id) => hostText(id))
  if (review.adaptation !== undefined) {
    if (review.protocol !== "devclaw.host-legacy-import/v2")
      hostStateError("IMPORT_RECEIPT_INVALID")
    const adaptation = hostRecord(review.adaptation, [
      "adapterId",
      "parameters",
      "descriptorDigest",
      "checkpoint",
      "sourceFiles",
      "reexecuteStageIds",
      "materialPath"
    ])
    hostText(adaptation.adapterId)
    hostDigest(adaptation.descriptorDigest)
    if (
      !adaptation.parameters ||
      typeof adaptation.parameters !== "object" ||
      Array.isArray(adaptation.parameters) ||
      Object.keys(adaptation.parameters).length > 8
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
    for (const [id, value] of Object.entries(adaptation.parameters)) {
      hostText(id)
      hostText(value)
    }
    const checkpoint = hostRecord(adaptation.checkpoint, [
      "sourcePath",
      "pointer",
      "value",
      "digest"
    ])
    runtimeRelativePath(hostText(checkpoint.sourcePath))
    hostDigest(checkpoint.digest)
    hostText(checkpoint.value)
    if (
      !Array.isArray(checkpoint.pointer) ||
      !checkpoint.pointer.length ||
      checkpoint.pointer.length > 16
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
    checkpoint.pointer.forEach((value) => hostText(value))
    if (
      !Array.isArray(adaptation.reexecuteStageIds) ||
      new Set(adaptation.reexecuteStageIds).size !== adaptation.reexecuteStageIds.length ||
      adaptation.reexecuteStageIds.some((id) => !(review.prefixStageIds as unknown[]).includes(id))
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
    if (
      !Array.isArray(adaptation.sourceFiles) ||
      !adaptation.sourceFiles.length ||
      adaptation.sourceFiles.length > 256
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
    const sourcePaths = new Set<string>()
    let sourceBytes = 0
    for (const value of adaptation.sourceFiles) {
      const file = hostRecord(value, ["sourcePath", "digest", "bytes"])
      const path = runtimeRelativePath(hostText(file.sourcePath))
      hostDigest(file.digest)
      sourceBytes += hostInteger(file.bytes)
      if (sourcePaths.has(path) || Number(file.bytes) > 256 * 1024 || sourceBytes > 4 * 1024 * 1024)
        hostStateError("IMPORT_RECEIPT_INVALID")
      sourcePaths.add(path)
    }
    if (
      !adaptation.sourceFiles.some(
        (value) => value.sourcePath === checkpoint.sourcePath && value.digest === checkpoint.digest
      ) ||
      adaptation.materialPath !== ".devclaw/import-source.json" ||
      !Array.isArray(review.files) ||
      !review.files.some(
        (value) =>
          value.artifactId === "$legacy-source" && value.targetPath === adaptation.materialPath
      )
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
  }
  if (
    !Array.isArray(review.artifacts) ||
    !Array.isArray(review.files) ||
    !review.files.length ||
    review.files.length > 256 ||
    review.files.length !== review.artifacts.length
  )
    hostStateError("IMPORT_RECEIPT_INVALID")
  const artifacts = review.artifacts.map((value) => {
    const artifact = hostRecord(value, ["artifactId", "sourcePath"])
    return {
      artifactId: hostText(artifact.artifactId),
      sourcePath: runtimeRelativePath(hostText(artifact.sourcePath, 32768))
    }
  })
  const ids = new Set<string>(),
    paths = new Set<string>()
  let total = 0
  for (const value of review.files) {
    const file = hostRecord(value, ["artifactId", "sourcePath", "targetPath", "digest", "bytes"])
    const id = hostText(file.artifactId),
      sourcePath = runtimeRelativePath(hostText(file.sourcePath, 32768))
    const targetPath = runtimeRelativePath(hostText(file.targetPath, 32768))
    hostDigest(file.digest)
    const size = hostInteger(file.bytes)
    total += size
    if (
      size > 16 * 1024 * 1024 ||
      total > 64 * 1024 * 1024 ||
      ids.has(id) ||
      paths.has(targetPath) ||
      artifacts.filter((item) => item.artifactId === id && item.sourcePath === sourcePath)
        .length !== 1
    )
      hostStateError("IMPORT_RECEIPT_INVALID")
    ids.add(id)
    paths.add(targetPath)
  }
  const { reviewDigest, ...payload } = review
  if (runtimeDigest(JSON.stringify(payload)) !== reviewDigest)
    hostStateError("IMPORT_RECEIPT_CHANGED")
  return structuredClone(value) as HostLegacyImportReceipt
}
