import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { SOURCE_HANDOFF_PATH } from "../../../shared/project-runtime/autobiz-handoff"
import { canonicalStageCheckJson } from "../../../shared/project-runtime/stage-check-receipt"
import {
  compositionDigest,
  compositionRelativePath
} from "../../../shared/project-runtime/composition"
import { readRuntimeScopedFileAsync } from "./safe-files-async"
import { runtimeDigest } from "./safe-files"
import { artifactObserver } from "./composition-legacy-proof"

export interface SourceHandoffContract {
  apiVersion: "devclaw.source-handoff/v1"
  scopes: string[]
}
export interface SourceHandoffBaseline {
  apiVersion: "devclaw.source-baseline/v1"
  packageDigest: string
  contractDigest: string
  files: Array<{ path: string; digest: string }>
}
export interface SourceHandoffEvidence {
  apiVersion: "devclaw.source-evidence/v1"
  scope: "host-observed-source-changes; not per-file acceptance"
  scopes: string[]
  baselineDigest: string
  changes: Array<{
    path: string
    change: "added" | "modified" | "deleted"
    beforeDigest?: string
    digest?: string
    content?: string
  }>
}
export async function readSourceHandoffContract(
  source: string
): Promise<SourceHandoffContract | undefined> {
  const file = await readRuntimeScopedFileAsync(source, SOURCE_HANDOFF_PATH, 8192)
  if (!file.bytes) return undefined
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  if (
    !value ||
    value.apiVersion !== "devclaw.source-handoff/v1" ||
    Object.keys(value).some((key) => !["apiVersion", "scopes"].includes(key)) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.length ||
    value.scopes.length > 8 ||
    value.scopes.some(
      (scope: unknown) => typeof scope !== "string" || !/^[a-zA-Z0-9][\w-]{0,79}$/.test(scope)
    ) ||
    new Set(value.scopes.map((scope: string) => scope.toLowerCase())).size !== value.scopes.length
  )
    throw Error("SOURCE_HANDOFF_CONTRACT_INVALID")
  return { apiVersion: value.apiVersion, scopes: [...value.scopes].sort() }
}
export function parseSourceHandoffBaseline(value: unknown): SourceHandoffBaseline {
  const item = value as SourceHandoffBaseline
  if (
    !item ||
    item.apiVersion !== "devclaw.source-baseline/v1" ||
    Object.keys(item).some(
      (key) => !["apiVersion", "packageDigest", "contractDigest", "files"].includes(key)
    ) ||
    !Array.isArray(item.files) ||
    item.files.length > 128
  )
    throw Error("SOURCE_HANDOFF_BASELINE_INVALID")
  compositionDigest(item.packageDigest)
  compositionDigest(item.contractDigest)
  const paths = new Set<string>()
  for (const file of item.files) {
    if (!file || Object.keys(file).some((key) => !["path", "digest"].includes(key)))
      throw Error("SOURCE_HANDOFF_BASELINE_INVALID")
    compositionRelativePath(file.path)
    compositionDigest(file.digest)
    if (paths.has(file.path.toLowerCase())) throw Error("SOURCE_HANDOFF_BASELINE_INVALID")
    paths.add(file.path.toLowerCase())
  }
  return item
}
async function observeSourceFiles(workspace: string, contract: SourceHandoffContract) {
  const observer = await artifactObserver(workspace),
    files = new Map<string, string>()
  for (const scope of contract.scopes) {
    try {
      await lstat(join(workspace, scope))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const [path, digest] of await observer.entries(scope))
      if (digest !== "directory") {
        if ([...files.keys()].some((old) => old.toLowerCase() === path.toLowerCase()))
          throw Error("SOURCE_HANDOFF_PATH_CONFLICT")
        files.set(path, digest)
      }
  }
  await observer.verify()
  return { observer, files }
}
export async function captureSourceHandoffBaseline(
  workspace: string,
  packageDigest: string,
  contract: SourceHandoffContract
): Promise<SourceHandoffBaseline> {
  const { files } = await observeSourceFiles(workspace, contract)
  return {
    apiVersion: "devclaw.source-baseline/v1",
    packageDigest,
    contractDigest: runtimeDigest(canonicalStageCheckJson(contract)),
    files: [...files].map(([path, digest]) => ({ path, digest }))
  }
}
export async function collectSourceHandoffEvidence(
  workspace: string,
  packageDigest: string,
  contract: SourceHandoffContract,
  value: SourceHandoffBaseline | undefined
): Promise<SourceHandoffEvidence> {
  if (!value) throw Error("SOURCE_HANDOFF_BASELINE_REQUIRED")
  const baseline = parseSourceHandoffBaseline(value)
  if (
    baseline.packageDigest !== packageDigest ||
    baseline.contractDigest !== runtimeDigest(canonicalStageCheckJson(contract)) ||
    baseline.files.some(
      (file) =>
        !contract.scopes.some((scope) => file.path === scope || file.path.startsWith(scope + "/"))
    )
  )
    throw Error("SOURCE_HANDOFF_BASELINE_CHANGED")
  const { observer, files } = await observeSourceFiles(workspace, contract)
  const before = new Map(baseline.files.map((file) => [file.path, file.digest]))
  const changes: SourceHandoffEvidence["changes"] = []
  for (const path of [...new Set([...before.keys(), ...files.keys()])].sort()) {
    const old = before.get(path),
      digest = files.get(path)
    if (old === digest) continue
    if (!digest) {
      changes.push({ path, change: "deleted", beforeDigest: old })
      continue
    }
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await observer.content(path)
      )
    } catch {
      throw Error("SOURCE_HANDOFF_TEXT_REQUIRED")
    }
    if (content.includes("\0")) throw Error("SOURCE_HANDOFF_TEXT_REQUIRED")
    changes.push({
      path,
      change: old ? "modified" : "added",
      ...(old ? { beforeDigest: old } : {}),
      digest,
      content
    })
  }
  await observer.verify()
  if (!changes.length) throw Error("SOURCE_HANDOFF_CHANGES_REQUIRED")
  return {
    apiVersion: "devclaw.source-evidence/v1",
    scope: "host-observed-source-changes; not per-file acceptance",
    scopes: contract.scopes,
    baselineDigest: runtimeDigest(canonicalStageCheckJson(baseline)),
    changes
  }
}
