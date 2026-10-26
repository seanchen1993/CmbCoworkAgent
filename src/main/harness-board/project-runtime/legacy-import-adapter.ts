import { opendirSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type {
  HostLegacyAdapterDescription,
  HostLegacyAdapterInput,
  HostLegacyImportReview
} from "../../../shared/project-runtime/host-types"
import { hostStateError } from "./host-state-protocol"
import type { HostPackageSnapshot } from "./package-snapshots"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeRelativePath
} from "./safe-files"

const text = z.string().min(1).max(512)
const list = z.array(text).min(1).max(128)
const adapterSchema = z
  .object({
    id: text,
    title: text,
    sourcePackageIds: list,
    parameters: z.array(z.object({ id: text, label: text }).strict()).max(8),
    checkpoint: z
      .object({ sourcePath: text, pointers: z.array(z.array(text).min(1).max(16)).min(1).max(4) })
      .strict(),
    stablePoints: z
      .array(
        z
          .object({ value: text, prefixStageIds: list, reexecuteStageIds: z.array(text).max(128) })
          .strict()
      )
      .min(1)
      .max(128),
    artifacts: z
      .array(
        z
          .object({
            artifactId: text,
            stageId: text,
            fields: z.record(z.string(), z.string().max(512)),
            files: z
              .array(
                z
                  .object({
                    sourcePath: text,
                    path: text,
                    optional: z.boolean().optional(),
                    materialOnly: z.boolean().optional()
                  })
                  .strict()
              )
              .max(128),
            trees: z
              .array(
                z
                  .object({
                    sourcePath: text,
                    targetPrefix: text,
                    suffix: text,
                    optional: z.boolean().optional()
                  })
                  .strict()
              )
              .max(8)
          })
          .strict()
      )
      .max(128)
  })
  .strict()
const descriptorSchema = z
  .object({
    protocol: z.literal("devclaw.legacy-import-adapter/v1"),
    adapters: z.array(adapterSchema).min(1).max(16)
  })
  .strict()

function descriptor(snapshot: HostPackageSnapshot) {
  const file = readRuntimeScopedFile(snapshot.root, "devclaw.legacy-import.json", 256 * 1024)
  if (!file.present) return undefined
  if (!file.bytes) hostStateError("IMPORT_ADAPTER_INVALID")
  const parsed = descriptorSchema.parse(JSON.parse(file.bytes.toString("utf8")))
  if (new Set(parsed.adapters.map((value) => value.id)).size !== parsed.adapters.length)
    hostStateError("IMPORT_ADAPTER_INVALID")
  const unique = (values: readonly string[]) => new Set(values).size === values.length
  for (const adapter of parsed.adapters) {
    if (
      !unique(adapter.sourcePackageIds) ||
      !unique(adapter.parameters.map((value) => value.id)) ||
      !unique(adapter.stablePoints.map((value) => value.value)) ||
      !unique(adapter.artifacts.map((value) => value.artifactId)) ||
      !unique(adapter.checkpoint.pointers.map((value) => JSON.stringify(value))) ||
      adapter.stablePoints.some(
        (point) =>
          !unique(point.prefixStageIds) ||
          !unique(point.reexecuteStageIds) ||
          point.reexecuteStageIds.some((id) => !point.prefixStageIds.includes(id))
      )
    )
      hostStateError("IMPORT_ADAPTER_INVALID")
  }
  return { ...parsed, digest: runtimeDigest(file.bytes) }
}

export function listLegacyImportAdapters(
  snapshot: HostPackageSnapshot
): HostLegacyAdapterDescription[] {
  return (
    descriptor(snapshot)?.adapters.map(({ id, title, parameters }) => ({
      id,
      title,
      parameters
    })) ?? []
  )
}

/** Only bounded declarative text bundles; no adapter scripts or renderer-provided output bytes. */
export function adaptLegacyImport(
  snapshot: HostPackageSnapshot,
  sourceWorkspace: string,
  sourcePackageId: string,
  input: HostLegacyAdapterInput
) {
  const document = descriptor(snapshot)
  const adapter = document?.adapters.find((value) => value.id === input.adapterId)
  if (!document || !adapter || !adapter.sourcePackageIds.includes(sourcePackageId))
    hostStateError("IMPORT_ADAPTER_UNAVAILABLE")
  if (
    !input.parameters ||
    typeof input.parameters !== "object" ||
    Array.isArray(input.parameters) ||
    Object.keys(input.parameters).length !== adapter.parameters.length ||
    adapter.parameters.some(
      ({ id }) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.parameters[id] ?? "")
    )
  )
    hostStateError("IMPORT_ADAPTER_PARAMETERS_INVALID")
  const expand = (value: string) => {
    const result = value.replace(/\{([^{}]+)\}/g, (_, id: string) => {
      if (!adapter.parameters.some((parameter) => parameter.id === id))
        hostStateError("IMPORT_ADAPTER_INVALID")
      return input.parameters[id]
    })
    if (/[{}]/.test(result)) hostStateError("IMPORT_ADAPTER_INVALID")
    return result
  }
  const sources = new Map<string, { digest: string; bytes: Buffer }>()
  const materialSizes = new Map<string, number>()
  let decodedBytes = 0
  const read = (path: string, optional = false) => {
    path = runtimeRelativePath(path)
    const file = readRuntimeScopedFile(sourceWorkspace, path, 256 * 1024)
    if (!file.present && optional) return undefined
    if (!file.bytes || !file.bytes.length) hostStateError("IMPORT_SOURCE_MISSING")
    decodedBytes += file.bytes.length
    if (decodedBytes > 64 * 1024 * 1024) hostStateError("IMPORT_ADAPTER_LIMIT")
    // TextDecoder rejects byte replacement: original evidence must survive the JSON transform.
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes)
    materialSizes.set(
      path,
      Buffer.byteLength(JSON.stringify(path)) + Buffer.byteLength(JSON.stringify(value)) + 16
    )
    if ([...materialSizes.values()].reduce((sum, size) => sum + size, 0) > 16 * 1024 * 1024 - 65536)
      hostStateError("IMPORT_ADAPTER_LIMIT")
    sources.set(path, { digest: runtimeDigest(file.bytes), bytes: file.bytes })
    if (
      sources.size > 256 ||
      [...sources.values()].reduce((sum, file) => sum + file.bytes.length, 0) > 4 * 1024 * 1024
    )
      hostStateError("IMPORT_ADAPTER_LIMIT")
    return value
  }
  const checkpointPath = runtimeRelativePath(expand(adapter.checkpoint.sourcePath))
  const state: unknown = JSON.parse(read(checkpointPath)!)
  const checkpoints = adapter.checkpoint.pointers.flatMap((template) => {
    const pointer = template.map(expand)
    let value: unknown = state
    for (const key of pointer) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key))
        return []
      value = (value as Record<string, unknown>)[key]
    }
    return typeof value === "string" ? [{ pointer, value }] : []
  })
  if (!checkpoints.length || checkpoints.some((value) => value.value !== checkpoints[0].value))
    hostStateError("IMPORT_CHECKPOINT_UNKNOWN")
  const point = adapter.stablePoints.find((value) => value.value === checkpoints[0].value)
  if (
    !point ||
    new Set(point.prefixStageIds).size !== point.prefixStageIds.length ||
    new Set(point.reexecuteStageIds).size !== point.reexecuteStageIds.length ||
    point.reexecuteStageIds.some((id) => !point.prefixStageIds.includes(id))
  )
    hostStateError("IMPORT_CHECKPOINT_UNSUPPORTED")
  const outputs = new Map<string, Buffer>()
  const files: HostLegacyImportReview["files"] = []
  const artifacts: HostLegacyImportReview["artifacts"] = []
  let visitedEntries = 0
  let visitedDirectories = 0
  let expandedBytes = 0
  let outputBytes = 0
  const accountOutput = (bytes: Buffer) => {
    outputBytes += bytes.length
    if (bytes.length > 16 * 1024 * 1024 || outputBytes > 64 * 1024 * 1024)
      hostStateError("IMPORT_ADAPTER_LIMIT")
  }
  const visitTree = (path: string, suffix: string, depth = 0): string[] => {
    if (depth > 8 || ++visitedDirectories > 256) hostStateError("IMPORT_ADAPTER_LIMIT")
    const directory = runtimeDirectory(join(sourceWorkspace, runtimeRelativePath(path)))
    const handle = opendirSync(directory)
    const entries: Dirent[] = []
    try {
      let entry: Dirent | null
      while ((entry = handle.readSync())) {
        if (++visitedEntries > 2048 || entries.length >= 256) hostStateError("IMPORT_ADAPTER_LIMIT")
        entries.push(entry)
      }
    } finally {
      handle.closeSync()
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return entries.flatMap((entry) => {
      if (entry.isSymbolicLink()) hostStateError("IMPORT_SOURCE_LINK")
      const child = runtimeRelativePath(`${path}/${entry.name}`)
      if (entry.isDirectory()) return visitTree(child, suffix, depth + 1)
      if (!entry.isFile()) hostStateError("IMPORT_SOURCE_INVALID")
      return suffix === "*" || child.endsWith(suffix) ? [child] : []
    })
  }
  for (const recipe of adapter.artifacts.filter((value) =>
    point.prefixStageIds.includes(value.stageId)
  )) {
    const bundleFiles: Record<string, string> = Object.create(null)
    let bundleBytes = 0
    const add = (sourcePath: string, targetPath: string, optional = false) => {
      const content = read(sourcePath, optional)
      if (content === undefined) return
      targetPath = runtimeRelativePath(targetPath)
      if (Object.hasOwn(bundleFiles, targetPath)) hostStateError("IMPORT_ADAPTER_COLLISION")
      const size =
        Buffer.byteLength(JSON.stringify(content)) +
        Buffer.byteLength(JSON.stringify(targetPath)) +
        16
      bundleBytes += size
      expandedBytes += size
      if (bundleBytes > 16 * 1024 * 1024 - 65536 || expandedBytes > 64 * 1024 * 1024)
        hostStateError("IMPORT_ADAPTER_LIMIT")
      bundleFiles[targetPath] = content
    }
    for (const file of recipe.files) {
      if (file.materialOnly) read(expand(file.sourcePath), file.optional)
      else add(expand(file.sourcePath), expand(file.path), file.optional)
    }
    for (const tree of recipe.trees) {
      const path = runtimeRelativePath(expand(tree.sourcePath))
      let entries: string[]
      try {
        entries = visitTree(path, tree.suffix)
      } catch (error) {
        if (tree.optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      for (const sourcePath of entries)
        add(sourcePath, `${expand(tree.targetPrefix)}/${sourcePath.slice(path.length + 1)}`)
    }
    if (point.reexecuteStageIds.includes(recipe.stageId)) continue
    const artifact = snapshot.manifest.artifacts.find((value) => value.id === recipe.artifactId)
    const stage = snapshot.manifest.stages.find((value) => value.id === recipe.stageId)
    if (
      !artifact ||
      artifact.id === "$legacy-source" ||
      artifact.path === ".devclaw/import-source.json" ||
      !stage?.artifactIds.includes(recipe.artifactId) ||
      !Object.keys(bundleFiles).length ||
      outputs.has(artifact.path)
    )
      hostStateError("IMPORT_ADAPTER_MAPPING_INVALID")
    const fields = Object.fromEntries(
      Object.entries(recipe.fields).map(([key, value]) => [key, expand(value)])
    )
    if (Object.hasOwn(fields, "files")) hostStateError("IMPORT_ADAPTER_INVALID")
    const bytes = Buffer.from(JSON.stringify({ ...fields, files: bundleFiles }, null, 2) + "\n")
    accountOutput(bytes)
    const sourcePath = checkpointPath
    outputs.set(runtimeRelativePath(artifact.path), bytes)
    artifacts.push({ artifactId: artifact.id, sourcePath })
    files.push({
      artifactId: artifact.id,
      sourcePath,
      targetPath: artifact.path,
      digest: runtimeDigest(bytes),
      bytes: bytes.length
    })
  }
  const materialPath = ".devclaw/import-source.json"
  const sourceFiles = [...sources]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourcePath, file]) => ({ sourcePath, digest: file.digest, bytes: file.bytes.length }))
  const material = Buffer.from(
    JSON.stringify(
      {
        protocol: "devclaw.legacy-source-material/v1",
        historicalSuccess: "untrusted-source-only",
        sourcePackageId,
        checkpoint: checkpoints[0],
        files: Object.fromEntries(
          [...sources]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, file]) => [path, file.bytes.toString("utf8")])
        )
      },
      null,
      2
    ) + "\n"
  )
  accountOutput(material)
  outputs.set(materialPath, material)
  artifacts.push({ artifactId: "$legacy-source", sourcePath: checkpointPath })
  files.push({
    artifactId: "$legacy-source",
    sourcePath: checkpointPath,
    targetPath: materialPath,
    digest: runtimeDigest(material),
    bytes: material.length
  })
  return {
    prefixStageIds: point.prefixStageIds,
    artifacts,
    files,
    outputs,
    adaptation: {
      adapterId: adapter.id,
      parameters: structuredClone(input.parameters),
      descriptorDigest: document.digest,
      checkpoint: {
        sourcePath: checkpointPath,
        ...checkpoints[0],
        digest: sources.get(checkpointPath)!.digest
      },
      sourceFiles,
      reexecuteStageIds: point.reexecuteStageIds,
      materialPath
    } satisfies NonNullable<HostLegacyImportReview["adaptation"]>
  }
}
