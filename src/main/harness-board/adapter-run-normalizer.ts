import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { basename, isAbsolute, relative, resolve } from "node:path"
import { serialize } from "node:v8"
import type {
  HarnessArtifact,
  HarnessArtifactStatus,
  HarnessEventStatus,
  HarnessFeatureStatus,
  HarnessNodeStatus,
  HarnessProjectMetadata,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessStatus,
  HarnessWatchRef,
  HarnessWorkflow,
  HarnessWorkflowArtifactDefinition
} from "../../shared/harness-board-types"
import {
  HarnessAdapterDetailParseError,
  normalizeHarnessAdapterWatchRefs,
  normalizeHarnessAdapterWorkflow,
  parseHarnessAdapterTopLevelJson
} from "./adapter-detail-normalizer"
import type {
  HarnessAdapterRunProjection,
  HarnessAdapterRunWorkerStats
} from "./adapter-detail-protocol"
import {
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES,
  HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES
} from "./adapter-detail-protocol"

type HookLogRef = HarnessRunDetailViewModel["run"]["hookLogRefs"][number]
type Hook = HarnessRunNode["hooks"][number]

interface HookLogEntry {
  nodeId: string
  hook: Hook
}

const MAX_HOOK_REFS = 32
const MAX_INLINE_HOOKS_PER_NODE = 512
const MAX_ARTIFACTS_PER_NODE = 512
const MAX_PATHS_PER_ARTIFACT = 128
const MAX_TEXT = 16_384

const NODE_STATUSES = new Set<HarnessNodeStatus>([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "warning",
  "error",
  "skipped",
  "archived",
  "unknown"
])
const FEATURE_STATUSES = new Set<HarnessFeatureStatus>(NODE_STATUSES)
const ARTIFACT_STATUSES = new Set<HarnessArtifactStatus>([
  "generated",
  "missing",
  "partial",
  "invalid",
  "unknown"
])
const EVENT_STATUSES = new Set<HarnessEventStatus>([
  "success",
  "blocked",
  "skipped",
  "error",
  "unknown"
])

const NODE_LABELS: Record<HarnessNodeStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "阻断",
  warning: "警告",
  error: "错误",
  skipped: "跳过",
  archived: "已归档",
  unknown: "未知"
}
const FEATURE_LABELS: Record<HarnessFeatureStatus, string> = NODE_LABELS
const NODE_KINDS: Record<HarnessNodeStatus, HarnessStatus["uiKind"]> = {
  not_started: "pending",
  in_progress: "active",
  done: "done",
  blocked: "blocked",
  warning: "warning",
  error: "error",
  skipped: "skipped",
  archived: "archived",
  unknown: "unknown"
}
const FEATURE_KINDS: Record<HarnessFeatureStatus, HarnessStatus["uiKind"]> = NODE_KINDS
const ARTIFACT_LABELS: Record<HarnessArtifactStatus, string> = {
  generated: "已生成",
  missing: "未生成",
  partial: "部分生成",
  invalid: "不可用",
  unknown: "未知"
}
const ARTIFACT_KINDS: Record<HarnessArtifactStatus, HarnessStatus["uiKind"]> = {
  generated: "ok",
  missing: "warning",
  partial: "warning",
  invalid: "error",
  unknown: "unknown"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function isCancelled(cancelFlag?: Int32Array): boolean {
  return Boolean(cancelFlag && Atomics.load(cancelFlag, 0) !== 0)
}

function throwIfCancelled(cancelFlag?: Int32Array): void {
  if (!isCancelled(cancelFlag)) return
  throw new HarnessAdapterDetailParseError(
    "HARNESS_ADAPTER_DETAIL_CANCELLED",
    "Harness run detail request was superseded"
  )
}

function status<T extends HarnessNodeStatus | HarnessFeatureStatus>(
  value: T,
  label: string,
  labels: Record<T, string>,
  kinds: Record<T, HarnessStatus["uiKind"]>
): HarnessStatus {
  return { label: label.trim() || labels[value], uiKind: kinds[value] }
}

function normalizeNodeStatus(value: unknown): HarnessNodeStatus {
  const normalized = text(value)
  return NODE_STATUSES.has(normalized as HarnessNodeStatus)
    ? (normalized as HarnessNodeStatus)
    : "unknown"
}

function normalizeFeatureStatus(value: unknown): HarnessFeatureStatus | null {
  const normalized = text(value)
  return FEATURE_STATUSES.has(normalized as HarnessFeatureStatus)
    ? (normalized as HarnessFeatureStatus)
    : null
}

function deriveFeatureStatus(
  current: HarnessNodeStatus,
  currentIndex: number,
  nodeCount: number
): HarnessFeatureStatus {
  if (current !== "done") return current
  return currentIndex >= 0 && currentIndex < nodeCount - 1 ? "in_progress" : "done"
}

function isInsideDirectory(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath))
  return (
    relativePath === "" ||
    (Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function projectDirectoryPath(project: HarnessProjectMetadata): string {
  const workspacePath = resolve(project.workspacePath)
  const projectDir = project.projectDir.trim() || project.projectCode.trim()
  const projectPath = resolve(workspacePath, projectDir)
  if (
    projectPath === workspacePath ||
    basename(projectPath) !== projectDir ||
    !isInsideDirectory(workspacePath, projectPath)
  ) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_INVALID_PROJECT_PATH",
      `Project dir resolves outside workspace: ${projectDir}`
    )
  }
  return projectPath
}

function normalizeAdapterPath(project: HarnessProjectMetadata, value: unknown): string | null {
  const rawPath = text(value).trim()
  if (!rawPath) return null
  const projectPath = projectDirectoryPath(project)
  const normalizedPath = rawPath.replace(/\\/g, "/")
  const target = isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : resolve(projectPath, normalizedPath)
  if (!isInsideDirectory(projectPath, target)) return null
  return relative(projectPath, target).replace(/\\/g, "/") || "."
}

function absoluteAdapterPath(project: HarnessProjectMetadata, value: unknown): string | null {
  const relativePath = normalizeAdapterPath(project, value)
  return relativePath ? resolve(projectDirectoryPath(project), relativePath) : null
}

function normalizeArtifactStatus(value: unknown): HarnessArtifactStatus {
  const normalized = text(value)
  return ARTIFACT_STATUSES.has(normalized as HarnessArtifactStatus)
    ? (normalized as HarnessArtifactStatus)
    : "unknown"
}

function workflowArtifactDefinitions(
  workflow: HarnessWorkflow
): Map<string, Map<string, HarnessWorkflowArtifactDefinition>> {
  return new Map(
    workflow.nodes.map((node) => [
      node.id,
      new Map((node.artifactDefinitions ?? []).map((artifact) => [artifact.id, artifact]))
    ])
  )
}

function normalizeArtifact(
  project: HarnessProjectMetadata,
  value: unknown,
  definition?: HarnessWorkflowArtifactDefinition
): HarnessArtifact | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (!id) return null
  const artifactStatus = normalizeArtifactStatus(value.artifactStatus)
  const artifactStatusLabel = text(value.artifactStatusLabel).trim()
  const paths = Array.isArray(value.paths)
    ? value.paths
        .slice(0, MAX_PATHS_PER_ARTIFACT)
        .map((path) => normalizeAdapterPath(project, path))
        .filter((path): path is string => path !== null)
    : []
  return {
    id,
    artifactLabel: text(value.artifactLabel).trim() || id,
    artifactType: definition?.artifactType ?? "unknown",
    path: paths.length > 0 ? null : normalizeAdapterPath(project, value.path),
    ...(Array.isArray(value.paths) ? { paths } : {}),
    required: definition?.required ?? false,
    artifactStatus,
    ...(artifactStatusLabel ? { artifactStatusLabel } : {}),
    status: {
      label: artifactStatusLabel || ARTIFACT_LABELS[artifactStatus],
      uiKind: ARTIFACT_KINDS[artifactStatus]
    }
  }
}

function normalizeEventStatus(value: unknown): HarnessEventStatus {
  const normalized = text(value)
  return EVENT_STATUSES.has(normalized as HarnessEventStatus)
    ? (normalized as HarnessEventStatus)
    : "unknown"
}

function normalizeHook(value: unknown): Hook | null {
  if (!isRecord(value)) return null
  const eventId = text(value.eventId)
  if (!eventId) return null
  return {
    ts: text(value.ts, 256),
    source: text(value.source, 2_048),
    sessionId: text(value.sessionId, 2_048),
    pluginId: text(value.pluginId, 2_048),
    featureId: text(value.featureId, 2_048),
    eventId,
    eventStatus: normalizeEventStatus(value.eventStatus),
    message: text(value.message),
    nodeId: text(value.nodeId, 2_048)
  }
}

function normalizeRunNodes(
  project: HarnessProjectMetadata,
  value: unknown,
  workflow: HarnessWorkflow
): HarnessRunNode[] {
  const runNodes = new Map<string, Record<string, unknown>>()
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isRecord(row)) continue
      const id = text(row.id)
      if (id) runNodes.set(id, row)
    }
  }
  const definitions = workflowArtifactDefinitions(workflow)
  return workflow.nodes.map((definition) => {
    const row = runNodes.get(definition.id)
    const nodeStatus = normalizeNodeStatus(row?.nodeStatus)
    const nodeStatusLabel = text(row?.nodeStatusLabel).trim()
    const artifactDefinitions = definitions.get(definition.id)
    return {
      id: definition.id,
      label: definition.label,
      ...(definition.group ? { group: definition.group } : {}),
      nodeStatus,
      ...(nodeStatusLabel ? { nodeStatusLabel } : {}),
      status: status(nodeStatus, nodeStatusLabel, NODE_LABELS, NODE_KINDS),
      artifacts: Array.isArray(row?.artifacts)
        ? row.artifacts
            .slice(0, MAX_ARTIFACTS_PER_NODE)
            .map((artifact) => {
              const artifactId = isRecord(artifact) ? text(artifact.id) : ""
              return normalizeArtifact(
                project,
                artifact,
                artifactId ? artifactDefinitions?.get(artifactId) : undefined
              )
            })
            .filter((artifact): artifact is HarnessArtifact => artifact !== null)
        : [],
      hooks: Array.isArray(row?.hooks)
        ? row.hooks
            .slice(-MAX_INLINE_HOOKS_PER_NODE)
            .map((hook) => normalizeHook(hook))
            .filter((hook): hook is Hook => hook !== null)
        : []
    }
  })
}

function normalizeHookLogRefs(project: HarnessProjectMetadata, value: unknown): HookLogRef[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_HOOK_REFS)
    .map((row): HookLogRef | null => {
      if (!isRecord(row)) return null
      const path = normalizeAdapterPath(project, row.path)
      if (!path) return null
      return {
        id: text(row.id, 2_048) || "default",
        path,
        format: text(row.format, 128) || "ndjson"
      }
    })
    .filter((ref): ref is HookLogRef => ref !== null)
}

function hookTimestamp(hook: Hook): number {
  const value = Date.parse(hook.ts.trim().replace(" ", "T"))
  return Number.isFinite(value) ? value : 0
}

function compareHookEntries(a: HookLogEntry, b: HookLogEntry): number {
  const diff = hookTimestamp(b.hook) - hookTimestamp(a.hook)
  return diff || b.hook.ts.localeCompare(a.hook.ts)
}

function readRecentHookEntries(
  project: HarnessProjectMetadata,
  refs: HookLogRef[],
  maxBytes: number,
  maxEntries: number,
  cancelFlag?: Int32Array
): { entries: HookLogEntry[]; bytesRead: number; truncated: boolean } {
  const ndjsonRefs = refs.filter((ref) => ref.format === "ndjson")
  const entries: HookLogEntry[] = []
  let remainingBytes = maxBytes
  let bytesRead = 0
  let truncated = false

  for (let refIndex = 0; refIndex < ndjsonRefs.length; refIndex += 1) {
    throwIfCancelled(cancelFlag)
    const filePath = absoluteAdapterPath(project, ndjsonRefs[refIndex].path)
    if (!filePath || !existsSync(filePath) || remainingBytes <= 0) {
      if (remainingBytes <= 0) truncated = true
      continue
    }
    let fileSize = 0
    try {
      fileSize = statSync(filePath).size
    } catch {
      continue
    }
    const refsLeft = ndjsonRefs.length - refIndex
    const budget = Math.max(1, Math.floor(remainingBytes / refsLeft))
    const readLength = Math.min(fileSize, budget)
    if (readLength < fileSize) truncated = true
    if (readLength <= 0) continue

    const buffer = Buffer.allocUnsafeSlow(readLength)
    let descriptor: number | null = null
    let actual = 0
    try {
      descriptor = openSync(filePath, "r")
      actual = readSync(descriptor, buffer, 0, readLength, fileSize - readLength)
    } catch {
      actual = 0
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
    remainingBytes -= actual
    bytesRead += actual
    if (actual <= 0) continue

    let raw = buffer.subarray(0, actual).toString("utf8")
    if (readLength < fileSize) {
      const firstNewline = raw.indexOf("\n")
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : ""
    }
    let acceptedFromFile = 0
    let scannedLines = 0
    let lineEnd = raw.length
    while (lineEnd > 0) {
      if ((scannedLines & 127) === 0) throwIfCancelled(cancelFlag)
      const newlineIndex = raw.lastIndexOf("\n", lineEnd - 1)
      const line = raw.slice(newlineIndex + 1, lineEnd).trim()
      lineEnd = newlineIndex >= 0 ? newlineIndex : 0
      scannedLines += 1
      if (scannedLines > maxEntries * 16) {
        truncated = true
        break
      }
      if (!line) continue
      try {
        const hook = normalizeHook(JSON.parse(line) as unknown)
        if (!hook) continue
        entries.push({ nodeId: hook.nodeId, hook })
        acceptedFromFile += 1
        if (acceptedFromFile >= maxEntries * 2) {
          truncated = true
          break
        }
      } catch {
        // Malformed NDJSON lines are intentionally ignored.
      }
    }
  }

  entries.sort(compareHookEntries)
  if (entries.length > maxEntries) truncated = true
  return { entries: entries.slice(0, maxEntries), bytesRead, truncated }
}

function applyHookEntries(
  nodes: HarnessRunNode[],
  entries: HookLogEntry[]
): { nodes: HarnessRunNode[]; unmatchedHooks: Hook[] } {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const hooksByNode = new Map<string, Hook[]>()
  const unmatchedHooks: Hook[] = []
  for (const entry of entries) {
    if (entry.nodeId && nodeIds.has(entry.nodeId)) {
      const hooks = hooksByNode.get(entry.nodeId)
      if (hooks) hooks.push(entry.hook)
      else hooksByNode.set(entry.nodeId, [entry.hook])
    } else {
      unmatchedHooks.push(entry.hook)
    }
  }
  return {
    nodes: nodes.map((node) => ({
      ...node,
      hooks: [...node.hooks, ...(hooksByNode.get(node.id) ?? [])]
    })),
    unmatchedHooks
  }
}

export function normalizeHarnessAdapterRun(
  buffer: Buffer,
  project: HarnessProjectMetadata,
  fallbackSlug: string,
  options: {
    maxOutputBytes?: number
    maxHookLogBytes?: number
    maxHookEntries?: number
    cancelFlag?: Int32Array
  } = {}
): { result: HarnessAdapterRunProjection; stats: HarnessAdapterRunWorkerStats } {
  const startedAt = performance.now()
  const maxOutputBytes = Math.min(
    HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
    Math.max(1, Math.floor(options.maxOutputBytes ?? HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES))
  )
  const maxHookLogBytes = Math.min(
    HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES,
    Math.max(0, Math.floor(options.maxHookLogBytes ?? HARNESS_ADAPTER_RUN_MAX_HOOK_LOG_BYTES))
  )
  const maxHookEntries = Math.min(
    HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES,
    Math.max(0, Math.floor(options.maxHookEntries ?? HARNESS_ADAPTER_RUN_MAX_HOOK_ENTRIES))
  )
  throwIfCancelled(options.cancelFlag)
  const snapshot = parseHarnessAdapterTopLevelJson(buffer)
  throwIfCancelled(options.cancelFlag)
  const workflow = normalizeHarnessAdapterWorkflow(snapshot.workflow)
  const run = isRecord(snapshot.run) ? snapshot.run : {}
  const featureSlug = text(run.featureId) || text(run.featureName) || text(fallbackSlug)
  const title = text(run.featureName) || featureSlug
  const currentNodeId = text(run.currentNodeId)
  const baseNodes = normalizeRunNodes(project, run.nodes, workflow)
  const currentNodeIndex = workflow.nodes.findIndex((node) => node.id === currentNodeId)
  const currentNodeStatus =
    baseNodes.find((node) => node.id === currentNodeId)?.nodeStatus ?? "unknown"
  const explicitFeatureStatus = normalizeFeatureStatus(run.featureStatus)
  const featureStatus =
    explicitFeatureStatus ??
    deriveFeatureStatus(currentNodeStatus, currentNodeIndex, workflow.nodes.length)
  const featureStatusLabel = explicitFeatureStatus ? text(run.featureStatusLabel).trim() : ""
  const overallStatus = status(featureStatus, featureStatusLabel, FEATURE_LABELS, FEATURE_KINDS)
  const hookLogRefs = normalizeHookLogRefs(project, run.hookLogRefs)
  const hookLogs = readRecentHookEntries(
    project,
    hookLogRefs,
    maxHookLogBytes,
    maxHookEntries,
    options.cancelFlag
  )
  const watchRefs = normalizeHarnessAdapterWatchRefs(project, run.watchRefs, [
    { path: ".autobizdevops/STATE.md", purpose: "run-state" },
    { path: `.autobizdevops/features/${featureSlug}`, purpose: "artifacts" },
    { path: `.autobizdevops/features/${featureSlug}/hooks.ndjson`, purpose: "hook-log" }
  ] satisfies HarnessWatchRef[])

  let externalEntries = hookLogs.entries
  let result: HarnessAdapterRunProjection
  let outputBytes = 0
  while (true) {
    const withHooks = applyHookEntries(baseNodes, externalEntries)
    result = {
      workflow,
      run: {
        id: featureSlug,
        kind: "feature",
        slug: featureSlug,
        title,
        featureStatus,
        ...(featureStatusLabel ? { featureStatusLabel } : {}),
        overallStatus,
        hookLogRefs,
        watchRefs,
        currentNodeId,
        nodes: withHooks.nodes,
        unmatchedHooks: withHooks.unmatchedHooks
      }
    }
    outputBytes = serialize(result).byteLength
    if (outputBytes <= maxOutputBytes) break
    if (externalEntries.length === 0) {
      throw new HarnessAdapterDetailParseError(
        "HARNESS_ADAPTER_DETAIL_RESULT_TOO_LARGE",
        `Inspect adapter normalized run result exceeded IPC limit (${maxOutputBytes} bytes)`
      )
    }
    externalEntries = externalEntries.slice(0, Math.floor(externalEntries.length / 2))
    hookLogs.truncated = true
  }

  throwIfCancelled(options.cancelFlag)
  return {
    result,
    stats: {
      durationMs: Math.max(0, performance.now() - startedAt),
      inputBytes: buffer.byteLength,
      outputBytes,
      projectCount: 1,
      hookLogBytesRead: hookLogs.bytesRead,
      hookLogEntries: externalEntries.length,
      hookLogsTruncated: hookLogs.truncated,
      cancelled: false
    }
  }
}
