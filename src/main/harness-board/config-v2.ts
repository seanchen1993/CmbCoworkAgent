import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import {
  HARNESS_CONFIG_V2_STORE_MAX_BYTES,
  HARNESS_FEATURE_BINDING_MAX_ENTRIES,
  HARNESS_PROJECT_TEXT_MAX_CHARS
} from "./store-limits"
import { requireCompleteHarnessDeployUnitContext } from "./context-integrity"
import { HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES } from "./context-integrity"
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import type {
  HarnessDeployUnitConfig,
  HarnessDeployUnitMapping,
  HarnessFeatureDeployUnitBinding,
  HarnessSessionWorkspace,
  HarnessSessionContextInjectionSource
} from "../../shared/harness-board-types"
import {
  readHarnessJsonFileBounded,
  withHarnessStoreMutation,
  writeHarnessJsonFileAtomic
} from "./async-json-store"

export const DEPLOY_UNIT_V2_FILE = "harness-deployUnitId-mapping.v2.json"
export const FEATURE_V2_FILE = "harness-board-features.v2.json"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("项目模式配置格式无效")
  return value as Record<string, unknown>
}
function required(value: unknown, label: string, max = 8192): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}无效`)
  return value
}

export function validateDeployUnitConfigs(value: unknown): HarnessDeployUnitConfig[] {
  if (!Array.isArray(value) || value.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES)
    throw new Error("发布单元配置格式无效")
  const ids = new Set<string>()
  const units = new Set<string>()
  return value.map((raw) => {
    const row = object(raw)
    const id = required(row.deployUnitIdMapping, "发布单元配置 ID", 512)
    const unit = required(row.deployUnitId, "发布单元", 2048)
    if (ids.has(id) || units.has(unit)) throw new Error("发布单元配置重复")
    ids.add(id)
    units.add(unit)
    if (!Array.isArray(row.repositoryPaths) || !row.repositoryPaths.length)
      throw new Error("请选择发布单元代码库路径")
    if (row.repositoryPaths.length > 12) throw new Error("每个发布单元最多支持 12 个候选路径")
    const pathIds = new Set<string>()
    const paths = new Set<string>()
    const repositoryPaths = row.repositoryPaths.map((rawPath) => {
      const entry = object(rawPath)
      const pathId = required(entry.pathId, "候选路径 ID")
      const localRepoPath = required(entry.localRepoPath, "代码库路径")
      if (pathIds.has(pathId) || paths.has(localRepoPath)) throw new Error("发布单元候选路径重复")
      pathIds.add(pathId)
      paths.add(localRepoPath)
      return { pathId, localRepoPath }
    })
    if (
      row.description !== undefined &&
      (typeof row.description !== "string" || row.description.length > 4096)
    )
      throw new Error("发布单元描述无效")
    return {
      deployUnitIdMapping: id,
      deployUnitId: unit,
      repositoryPaths,
      ...(row.description !== undefined ? { description: row.description as string } : {})
    }
  })
}

function migrateDeployUnitV1(value: unknown): unknown {
  const store = object(value)
  if (store.version !== 1 || !Array.isArray(store.mappings))
    throw new Error("发布单元 v1 配置格式无效")
  const mappings = store.mappings.map((raw) => {
    const row = object(raw)
    return {
      deployUnitIdMapping: row.deployUnitIdMapping,
      deployUnitId: row.deployUnitId,
      description: row.description,
      repositoryPaths: [
        { pathId: randomUUID(), localRepoPath: required(row.localRepoPath, "代码库路径") }
      ]
    }
  })
  return { version: 2, mappings: validateDeployUnitConfigs(mappings) }
}

interface ValidatedFeatureBinding extends Record<string, unknown> {
  sessionWorkspace?: HarnessSessionWorkspace
}

function validateFeatureV2(value: unknown): ValidatedFeatureBinding[] {
  const store = object(value)
  if (
    store.version !== 2 ||
    !Array.isArray(store.bindings) ||
    store.bindings.length > HARNESS_FEATURE_BINDING_MAX_ENTRIES
  )
    throw new Error("特性 v2 配置格式无效")
  const keys = new Set<string>()
  const bindings: ValidatedFeatureBinding[] = []
  for (const raw of store.bindings) {
    const row = object(raw)
    const key = `${required(row.projectId, "项目 ID")}\0${required(row.featureId, "特性 ID")}`
    if (keys.has(key)) throw new Error("特性配置重复")
    keys.add(key)
    if (!Array.isArray(row.selectedDeployUnitMappings)) throw new Error("特性发布单元快照无效")
    if (row.selectedDeployUnitMappings.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES)
      throw new Error("特性发布单元数量超限")
    const units = new Set<string>()
    const mappingIds = new Set<string>()
    for (const snapshot of row.selectedDeployUnitMappings) {
      const item = object(snapshot)
      const mappingId = required(item.deployUnitIdMapping, "发布单元配置 ID", 512)
      if (mappingIds.has(mappingId)) throw new Error("特性发布单元配置 ID 重复")
      mappingIds.add(mappingId)
      const unit = required(item.deployUnitId, "发布单元", 2048)
      required(item.localRepoPath, "代码库路径")
      if (
        item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 4096)
      )
        throw new Error("特性发布单元描述无效")
      if (units.has(unit)) throw new Error("特性发布单元重复")
      units.add(unit)
    }
    let sessionWorkspace: HarnessSessionWorkspace | undefined
    if (row.sessionWorkspace !== undefined) {
      const workspace = object(row.sessionWorkspace)
      if (workspace.source === "directory") {
        sessionWorkspace = {
          ...workspace,
          source: "directory",
          path: required(workspace.path, "会话工作区")
        }
      } else if (workspace.source === "deployUnit") {
        if (!units.has(required(workspace.deployUnitId, "会话工作区发布单元")))
          throw new Error("会话工作区发布单元未选中")
        sessionWorkspace = {
          ...workspace,
          source: "deployUnit",
          deployUnitId: required(workspace.deployUnitId, "会话工作区发布单元")
        }
      } else throw new Error("会话工作区来源无效")
    }
    bindings.push({ ...row, sessionWorkspace })
  }
  return bindings
}

function migrateFeatureV1(value: unknown): unknown {
  const old = object(value)
  if (old.version !== 1 || !Array.isArray(old.bindings)) throw new Error("特性 v1 配置格式无效")
  const next = { ...old, version: 2 }
  parseFeatureV2(next)
  return next
}

let initializationError: Error | null = null

/** A failed startup disables project mode without preventing the rest of the app from starting. */
export function assertHarnessConfigAvailable(): void {
  if (initializationError) throw initializationError
}

/** Explicit startup/tool initialization only. Ordinary reads must never import legacy data. */
export async function initializeHarnessConfigV2(root: string): Promise<void> {
  try {
    await initializeStores(root)
    initializationError = null
  } catch (error) {
    initializationError = new Error(
      `项目模式配置初始化失败，请检查配置后重启：${error instanceof Error ? error.message : String(error)}`
    )
    throw initializationError
  }
}

async function initializeStores(root: string): Promise<void> {
  for (const [legacy, name, field, convert] of [
    ["harness-deployUnitId-mapping.json", DEPLOY_UNIT_V2_FILE, "mappings", migrateDeployUnitV1],
    ["harness-board-features.json", FEATURE_V2_FILE, "bindings", migrateFeatureV1]
  ] as const) {
    const path = join(root, name)
    await withHarnessStoreMutation(path, async () => {
      const current = await readHarnessJsonFileBounded(
        path,
        HARNESS_CONFIG_V2_STORE_MAX_BYTES,
        name
      )
      if (
        current === null &&
        (await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }))
      )
        throw new Error(`${name} 内容为空或无效`)
      if (current !== null) {
        const store = object(current)
        if (store.version !== 2) throw new Error(`${name} 版本不支持`)
        if (field === "mappings") validateDeployUnitConfigs(store.mappings)
        else parseFeatureV2(store)
        return
      }
      const old = await readHarnessJsonFileBounded(
        join(root, legacy),
        HARNESS_CONFIG_V2_STORE_MAX_BYTES,
        legacy
      )
      if (
        old === null &&
        (await stat(join(root, legacy)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }))
      )
        throw new Error(`${legacy} 内容为空或无效`)
      const next = old === null ? { version: 2, [field]: [] } : convert(old)
      await writeHarnessJsonFileAtomic(path, next, HARNESS_CONFIG_V2_STORE_MAX_BYTES, name)
    })
  }
}

const HARNESS_FEATURE_ID_MAX_CHARS = 2_048

const HARNESS_SESSION_CONTEXT_INJECTION_SOURCES = new Set<HarnessSessionContextInjectionSource>([
  "cmbdevclaw",
  "plugin"
])

export interface HarnessFeatureDeployUnitBindingRecord extends HarnessFeatureDeployUnitBinding {
  createdAt: string
  updatedAt?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalizeBoundedText(value: unknown, maxChars: number, label: string): string {
  const normalized = normalizeText(value).trim()
  if (normalized.length > maxChars) throw new Error(`${label}无效`)
  return normalized
}

function createUniqueDeployUnitMappingId(seenIds: Set<string>): string {
  let id = randomUUID()
  while (seenIds.has(id)) {
    id = randomUUID()
  }
  return id
}

export function normalizeDeployUnitMappings(
  value: unknown,
  options: { assignMissingOrDuplicateMappingId?: boolean } = {}
): HarnessDeployUnitMapping[] {
  if (!Array.isArray(value)) return []
  if (value.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES) {
    throw new Error(
      `发布单元映射超过 ${HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES} 条上限，` + `已拒绝不完整读取`
    )
  }
  const seen = new Set<string>()
  const seenIds = new Set<string>()
  const mappings: HarnessDeployUnitMapping[] = []
  for (const item of value) {
    if (mappings.length >= HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES) break
    if (!isObject(item)) continue
    const deployUnitId = normalizeBoundedText(item.deployUnitId, 2_048, "发布单元")
    const localRepoPath = normalizeBoundedText(item.localRepoPath, 8_192, "代码库路径")
    const description = normalizeBoundedText(item.description, 4_096, "发布单元描述")
    if (!deployUnitId || !localRepoPath || seen.has(deployUnitId)) continue

    let deployUnitIdMapping = normalizeBoundedText(item.deployUnitIdMapping, 512, "发布单元配置 ID")
    if (!deployUnitIdMapping || seenIds.has(deployUnitIdMapping)) {
      if (!options.assignMissingOrDuplicateMappingId) continue
      deployUnitIdMapping = createUniqueDeployUnitMappingId(seenIds)
    }

    seen.add(deployUnitId)
    seenIds.add(deployUnitIdMapping)
    mappings.push({
      deployUnitIdMapping,
      deployUnitId,
      localRepoPath,
      ...(description ? { description } : {})
    })
  }
  return mappings
}

export function normalizeSessionContextInjectionSource(
  value: unknown
): HarnessSessionContextInjectionSource {
  const source = normalizeText(value).trim()
  return HARNESS_SESSION_CONTEXT_INJECTION_SOURCES.has(
    source as HarnessSessionContextInjectionSource
  )
    ? (source as HarnessSessionContextInjectionSource)
    : "cmbdevclaw"
}

function normalizeFeatureDeployUnitBinding(
  value: ValidatedFeatureBinding
): HarnessFeatureDeployUnitBindingRecord | null {
  const projectId = normalizeText(value.projectId).trim()
  const featureId = normalizeText(value.featureId).trim()
  assertFeatureBindingKeyBudgets(projectId, featureId)
  const sessionContextInjectionSource = normalizeSessionContextInjectionSource(
    value.sessionContextInjectionSource
  )
  requireCompleteHarnessDeployUnitContext(
    Array.isArray(value.selectedDeployUnitMappings) ? value.selectedDeployUnitMappings.length : 0,
    sessionContextInjectionSource
  )
  const selectedDeployUnitMappings = normalizeDeployUnitMappings(value.selectedDeployUnitMappings)
  if (!projectId || !featureId) return null
  return {
    projectId,
    featureId,
    selectedDeployUnitMappings,
    sessionContextInjectionSource,
    ...(value.sessionWorkspace ? { sessionWorkspace: value.sessionWorkspace } : {}),
    ...(value.imManagementEnabled === true ? { imManagementEnabled: true } : {}),
    createdAt: normalizeText(value.createdAt).trim() || formatGmt8Timestamp(),
    updatedAt: normalizeText(value.updatedAt).trim() || undefined
  }
}

function normalizeFeatureDeployUnitBindings(
  value: ValidatedFeatureBinding[]
): HarnessFeatureDeployUnitBindingRecord[] {
  if (!Array.isArray(value)) return []
  if (value.length > HARNESS_FEATURE_BINDING_MAX_ENTRIES) {
    throw new Error(`特性发布单元绑定超过 ${HARNESS_FEATURE_BINDING_MAX_ENTRIES} 条上限`)
  }
  const seen = new Set<string>()
  const bindings: HarnessFeatureDeployUnitBindingRecord[] = []
  for (const item of value) {
    const binding = normalizeFeatureDeployUnitBinding(item)
    if (!binding) continue
    const key = `${binding.projectId}\0${binding.featureId}`
    if (seen.has(key)) continue
    seen.add(key)
    bindings.push(binding)
  }
  return bindings
}

export function assertFeatureBindingKeyBudgets(projectId: string, featureId: string): void {
  if (projectId.length > HARNESS_PROJECT_TEXT_MAX_CHARS) {
    throw new Error(`特性绑定项目 ID 超过 ${HARNESS_PROJECT_TEXT_MAX_CHARS} 字符上限`)
  }
  if (featureId.length > HARNESS_FEATURE_ID_MAX_CHARS) {
    throw new Error(`特性名称超过 ${HARNESS_FEATURE_ID_MAX_CHARS} 字符上限`)
  }
}

export function parseFeatureV2(value: unknown): {
  version: 2
  bindings: HarnessFeatureDeployUnitBindingRecord[]
} {
  return { version: 2, bindings: normalizeFeatureDeployUnitBindings(validateFeatureV2(value)) }
}

/** Missing/empty files are failures after startup, never a signal to recreate an empty store. */
export async function readHarnessConfigV2File(path: string): Promise<unknown> {
  assertHarnessConfigAvailable()
  const value = await readHarnessJsonFileBounded(path, HARNESS_CONFIG_V2_STORE_MAX_BYTES, path)
  if (value === null) {
    throw new Error(`项目模式配置缺失或为空，请检查文件并重启：${path}`)
  }
  return value
}
