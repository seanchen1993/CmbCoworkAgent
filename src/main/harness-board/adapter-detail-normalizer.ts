import { isAbsolute, relative, resolve } from "node:path"
import { serialize } from "node:v8"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import type {
  HarnessFeatureStatus,
  HarnessFeatureSummary,
  HarnessNodeStatus,
  HarnessProjectMetadata,
  HarnessStatus,
  HarnessWatchRef,
  HarnessWorkflow,
  HarnessWorkflowArtifactDefinition,
  HarnessWorkflowNextAction
} from "../../shared/harness-board-types"
import type {
  HarnessAdapterDetailBatchResult,
  HarnessAdapterDetailProjectInput,
  HarnessAdapterDetailWorkerStats
} from "./adapter-detail-protocol"
import {
  HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH
} from "./adapter-detail-protocol"
import { HARNESS_WATCH_REF_MAX_REFS } from "./watch-ref-protocol"

const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192
const OUTPUT_PREVIEW_CHARS = 4_096

const HARNESS_NODE_STATUSES = new Set<HarnessNodeStatus>([
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

const HARNESS_FEATURE_STATUSES = new Set<HarnessFeatureStatus>([
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

const DEFAULT_FEATURE_STATUS_LABELS: Record<HarnessFeatureStatus, string> = {
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

const FEATURE_STATUS_UI_KIND: Record<HarnessFeatureStatus, HarnessStatus["uiKind"]> = {
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

const HARNESS_ARTIFACT_TYPES = new Set<HarnessWorkflowArtifactDefinition["artifactType"]>([
  "file",
  "directory",
  "markdown",
  "text",
  "log",
  "yaml",
  "json",
  "report",
  "external",
  "virtual",
  "unknown"
])

export class HarnessAdapterDetailParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly preview?: string
  ) {
    super(message)
    this.name = "HarnessAdapterDetailParseError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function uniqueStringsInOrder(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeText(value).trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function isValidUtf8Buffer(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

function detectAdapterOutputEncoding(buffer: Buffer): string {
  if (buffer.length === 0 || isValidUtf8Buffer(buffer)) return "utf-8"

  const detected = chardet.detect(buffer.subarray(0, CHARDET_SAMPLE_BYTES))
  const encoding = typeof detected === "string" ? detected : detected?.encoding
  const confidence = typeof detected === "object" ? detected.confidence : 1
  if (
    encoding &&
    encoding.toLowerCase() !== "ascii" &&
    iconv.encodingExists(encoding) &&
    confidence >= CHARDET_CONFIDENCE_THRESHOLD
  ) {
    return encoding
  }
  return process.platform === "win32" ? "gb18030" : "utf-8"
}

function decodeAdapterBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ""
  const encoding = detectAdapterOutputEncoding(buffer)
  try {
    return iconv.decode(buffer, encoding)
  } catch {
    return buffer.toString("utf-8")
  }
}

function normalizeNodeStatus(value: unknown): HarnessNodeStatus {
  const status = normalizeText(value)
  return HARNESS_NODE_STATUSES.has(status as HarnessNodeStatus)
    ? (status as HarnessNodeStatus)
    : "unknown"
}

function normalizeFeatureStatus(value: unknown): HarnessFeatureStatus | null {
  const status = normalizeText(value)
  return HARNESS_FEATURE_STATUSES.has(status as HarnessFeatureStatus)
    ? (status as HarnessFeatureStatus)
    : null
}

function statusFromFeatureStatus(
  featureStatus: HarnessFeatureStatus,
  label?: string
): HarnessStatus {
  return {
    label: label?.trim() || DEFAULT_FEATURE_STATUS_LABELS[featureStatus],
    uiKind: FEATURE_STATUS_UI_KIND[featureStatus]
  }
}

function deriveFeatureStatusFromCurrentNode(
  currentNodeStatus: HarnessNodeStatus,
  currentNodeIndex: number,
  workflowNodeCount: number
): HarnessFeatureStatus {
  if (currentNodeStatus !== "done") return currentNodeStatus
  if (currentNodeIndex >= 0 && currentNodeIndex < workflowNodeCount - 1) return "in_progress"
  return "done"
}

function normalizeWorkflowNextAction(value: unknown): HarnessWorkflowNextAction | undefined {
  if (!isObject(value)) return undefined
  const slashSkill = normalizeText(value.slashSkill).trim()
  const userMessage = normalizeText(value.userMessage).trim()
  const dialogTips = normalizeText(value.dialogTips).trim()
  const nextAction = {
    ...(slashSkill ? { slashSkill } : {}),
    ...(userMessage ? { userMessage } : {}),
    ...(dialogTips ? { dialogTips } : {})
  }
  return Object.keys(nextAction).length > 0 ? nextAction : undefined
}

function normalizeWorkflowStateDefinition(
  value: unknown
): NonNullable<HarnessWorkflow["nodes"][number]["states"]>[number] | null {
  if (!isObject(value)) return null
  const nodeStatusValue = normalizeText(value.nodeStatus)
  if (!HARNESS_NODE_STATUSES.has(nodeStatusValue as HarnessNodeStatus)) return null
  const nodeStatus = nodeStatusValue as HarnessNodeStatus
  const nextAction = normalizeWorkflowNextAction(value.nextAction)
  return {
    nodeStatus,
    ...(nextAction ? { nextAction } : {})
  }
}

function normalizeWorkflowArtifactDefinition(
  value: unknown
): HarnessWorkflowArtifactDefinition | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const artifactType = normalizeText(value.artifactType)
  return {
    id,
    required: typeof value.required === "boolean" ? value.required : false,
    artifactType: HARNESS_ARTIFACT_TYPES.has(
      artifactType as HarnessWorkflowArtifactDefinition["artifactType"]
    )
      ? (artifactType as HarnessWorkflowArtifactDefinition["artifactType"])
      : "unknown"
  }
}

function normalizeWorkflowNodeDefinition(value: unknown): HarnessWorkflow["nodes"][number] | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const group = normalizeText(value.group)
  return {
    id,
    label: normalizeText(value.label) || id,
    ...(group ? { group } : {}),
    description: normalizeText(value.description) || undefined,
    states: Array.isArray(value.states)
      ? value.states
          .map((state) => normalizeWorkflowStateDefinition(state))
          .filter((state): state is NonNullable<typeof state> => state !== null)
      : undefined,
    artifactDefinitions: Array.isArray(value.artifactDefinitions)
      ? value.artifactDefinitions
          .map((artifact) => normalizeWorkflowArtifactDefinition(artifact))
          .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
      : undefined,
    hookDefinitions: Array.isArray(value.hookDefinitions)
      ? value.hookDefinitions
          .map((hook) => {
            if (!isObject(hook)) return null
            const hookId = normalizeText(hook.id)
            if (!hookId) return null
            return {
              id: hookId,
              label: normalizeText(hook.label) || hookId,
              event: normalizeText(hook.event),
              required: typeof hook.required === "boolean" ? hook.required : false
            }
          })
          .filter((hook): hook is NonNullable<typeof hook> => hook !== null)
      : undefined
  }
}

function normalizeWorkflow(value: unknown): HarnessWorkflow {
  const workflow = isObject(value) ? value : {}
  return {
    display: isObject(workflow.display)
      ? {
          mode: normalizeText(workflow.display.mode) || "ordered_nodes",
          groupBy: normalizeText(workflow.display.groupBy) || undefined
        }
      : {
          mode: "ordered_nodes",
          groupBy: "group"
        },
    states: Array.isArray(workflow.states)
      ? workflow.states
          .map((state) => normalizeWorkflowStateDefinition(state))
          .filter((state): state is NonNullable<typeof state> => state !== null)
      : undefined,
    nodes: Array.isArray(workflow.nodes)
      ? workflow.nodes
          .map((node) => normalizeWorkflowNodeDefinition(node))
          .filter((node): node is HarnessWorkflow["nodes"][number] => node !== null)
      : []
  }
}

function workflowFromNodeIds(workflow: HarnessWorkflow, nodeIds: string[]): HarnessWorkflow {
  if (nodeIds.length === 0) return workflow
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const nodes = nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is HarnessWorkflow["nodes"][number] => Boolean(node))
  return { ...workflow, nodes }
}

function normalizeProjectRun(
  value: unknown,
  defaultWorkflow: HarnessWorkflow
): HarnessFeatureSummary | null {
  if (!isObject(value)) return null
  const slug = normalizeText(value.featureId) || normalizeText(value.featureName)
  if (!slug) return null

  const nodeIds = uniqueStringsInOrder(value.nodeIds)
  const workflow = workflowFromNodeIds(defaultWorkflow, nodeIds)
  const currentNodeId = normalizeText(value.currentNodeId) || "unknown"
  const currentNodeStatus = normalizeNodeStatus(value.currentNodeStatus)
  const currentNodeStatusLabel = normalizeText(value.currentNodeStatusLabel).trim()
  const currentNodeIndex = workflow.nodes.findIndex((node) => node.id === currentNodeId)
  const currentNodeDefinition = currentNodeIndex >= 0 ? workflow.nodes[currentNodeIndex] : undefined
  const explicitFeatureStatus = normalizeFeatureStatus(value.featureStatus)
  const featureStatus =
    explicitFeatureStatus ??
    deriveFeatureStatusFromCurrentNode(currentNodeStatus, currentNodeIndex, workflow.nodes.length)
  const featureStatusLabel = explicitFeatureStatus
    ? normalizeText(value.featureStatusLabel).trim()
    : ""
  const status = statusFromFeatureStatus(featureStatus, featureStatusLabel)
  const currentNodeLabel = currentNodeDefinition?.label ?? currentNodeId
  const summaryText = currentNodeLabel ? `${currentNodeLabel} · ${status.label}` : status.label

  return {
    id: slug,
    kind: "feature",
    slug,
    title: normalizeText(value.featureName) || slug,
    location: status.uiKind === "archived" ? "archived" : "active",
    featureStatus,
    ...(featureStatusLabel ? { featureStatusLabel } : {}),
    overallStatus: status,
    nodeIds,
    currentNodeId,
    currentNodeStatus,
    ...(currentNodeStatusLabel ? { currentNodeStatusLabel } : {}),
    summary: {
      text: summaryText,
      updatedAt: ""
    }
  }
}

function normalizeProjectRuns(
  snapshot: Record<string, unknown>,
  workflow: HarnessWorkflow
): HarnessFeatureSummary[] {
  if (!Array.isArray(snapshot.runs)) return []
  return snapshot.runs
    .map((run) => normalizeProjectRun(run, workflow))
    .filter((run): run is HarnessFeatureSummary => run !== null)
}

function isInsideDirectory(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath))
  return (
    relativePath === "" ||
    (Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function normalizeAdapterPath(project: HarnessProjectMetadata, value: unknown): string | null {
  const rawPath = normalizeText(value).trim()
  if (!rawPath) return null
  const normalizedPath = rawPath.replace(/\\/g, "/")
  const projectPath = resolve(project.workspacePath, project.projectDir || project.projectCode)
  const resolvedPath = isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : resolve(projectPath, normalizedPath)
  if (!isInsideDirectory(projectPath, resolvedPath)) return null
  return relative(projectPath, resolvedPath).replace(/\\/g, "/") || "."
}

function normalizeWatchRefs(
  project: HarnessProjectMetadata,
  refs: unknown,
  fallback: HarnessWatchRef[]
): HarnessWatchRef[] {
  const boundedFallback = fallback.slice(0, HARNESS_WATCH_REF_MAX_REFS)
  if (!Array.isArray(refs)) return boundedFallback
  const normalized: HarnessWatchRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (normalized.length >= HARNESS_WATCH_REF_MAX_REFS) break
    if (!isObject(ref)) continue
    const path = normalizeAdapterPath(project, ref.path)
    if (!path) continue
    const purpose = normalizeText(ref.purpose) || "artifacts"
    const key = `${path}\0${purpose}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ path, purpose })
  }
  return normalized.length > 0 ? normalized : boundedFallback
}

function throwIfDetailCancelled(cancelFlag?: Int32Array): void {
  if (cancelFlag && Atomics.load(cancelFlag, 0) !== 0) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_CANCELLED",
      "Harness adapter detail request was superseded"
    )
  }
}

function parseTopLevelJson(
  buffer: Buffer,
  cancelFlag?: Int32Array
): Record<string, unknown> {
  throwIfDetailCancelled(cancelFlag)
  if (buffer.byteLength > HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_INPUT_TOO_LARGE",
      `Inspect adapter output exceeded ${HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES} bytes`
    )
  }
  const raw = decodeAdapterBuffer(buffer).trim()
  if (!raw) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_EMPTY",
      "Inspect adapter returned empty output"
    )
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    throwIfDetailCancelled(cancelFlag)
    if (!isObject(parsed)) throw new Error("top-level JSON is not an object")
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const preview =
      raw.length <= OUTPUT_PREVIEW_CHARS ? raw : `${raw.slice(0, OUTPUT_PREVIEW_CHARS)}…`
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_INVALID_JSON",
      `Inspect adapter returned invalid JSON: ${message}`,
      preview
    )
  }
}

export {
  decodeAdapterBuffer as decodeHarnessAdapterBuffer,
  normalizeWatchRefs as normalizeHarnessAdapterWatchRefs,
  normalizeWorkflow as normalizeHarnessAdapterWorkflow,
  parseTopLevelJson as parseHarnessAdapterTopLevelJson
}

export function normalizeHarnessAdapterDetailBatch(
  buffer: Buffer,
  projectInputs: HarnessAdapterDetailProjectInput[],
  maxOutputBytes = HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  cancelFlag?: Int32Array
): { result: HarnessAdapterDetailBatchResult; stats: HarnessAdapterDetailWorkerStats } {
  const startedAt = performance.now()
  if (projectInputs.length > HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_BATCH_TOO_LARGE",
      `Inspect adapter detail batch exceeded ${HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH} projects`
    )
  }
  throwIfDetailCancelled(cancelFlag)
  const snapshot = parseTopLevelJson(buffer, cancelFlag)
  const workflow = normalizeWorkflow(snapshot.workflow)
  if (!isObject(snapshot.projects)) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_INVALID_BATCH",
      "Inspect adapter returned invalid batch JSON: projects is not an object"
    )
  }

  const projects: HarnessAdapterDetailBatchResult["projects"] = {}
  for (const input of projectInputs) {
    throwIfDetailCancelled(cancelFlag)
    const projectData = snapshot.projects[input.projectDir]
    projects[input.projectDir] = isObject(projectData)
      ? {
          runs: normalizeProjectRuns(projectData, workflow),
          watchRefs: normalizeWatchRefs(
            input.project,
            projectData.watchRefs,
            input.fallbackWatchRefs
          )
        }
      : null
  }

  const result = { workflow, projects }
  throwIfDetailCancelled(cancelFlag)
  // This is a closer upper-bound for Node/Electron structured clone than JSON byte length:
  // it includes properties whose value is undefined and object-reference metadata.
  const outputBytes = serialize(result).byteLength
  const boundedOutputBytes = Math.min(
    HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
    Math.max(1, Math.floor(maxOutputBytes))
  )
  if (outputBytes > boundedOutputBytes) {
    throw new HarnessAdapterDetailParseError(
      "HARNESS_ADAPTER_DETAIL_RESULT_TOO_LARGE",
      `Inspect adapter normalized result exceeded IPC limit (${boundedOutputBytes} bytes)`
    )
  }
  return {
    result,
    stats: {
      durationMs: performance.now() - startedAt,
      inputBytes: buffer.byteLength,
      outputBytes,
      projectCount: projectInputs.length
    }
  }
}
