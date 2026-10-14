import { SOURCE } from "./source.generated.ts"
import type { AutobizSdk } from "./sdk-types"

export const MAX_SOURCE_CHARS = 4000
export const MAX_REVIEW_CHARS = 4000
export const STATE_SCHEMA = "autobizdevops.state.read.v1"

export interface ProjectLocation {
  cwd: string
  parent: string
  project: string
  identity: string
}

export interface NormalizedRecord extends Record<string, unknown> {
  feature: string
  checkpoint: string
  stage: string
  workflowNodes?: string[]
}

export interface StateSnapshot {
  records: Record<string, NormalizedRecord>
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
}

function segment(value: string): boolean {
  return (
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:<>"|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
}

export function featureId(value: unknown): string {
  if (!text(value, 160) || value.trim() !== value || !segment(value))
    throw Error("AUTOBIZ_FEATURE_REQUIRED: 请明确指定真实 Feature ID。")
  return value
}

export function commandFeature(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value !== "string") throw Error("AUTOBIZ_FEATURE_ARGUMENT")
  const clean = value.trim()
  return clean ? featureId(clean) : undefined
}

export function projectRelativePath(value: unknown): string {
  if (!text(value, 240) || value.trim() !== value) throw Error("AUTOBIZ_FILE_PATH")
  const path = value.replace(/\\/g, "/")
  const parts = path.split("/")
  if (parts.some((part) => !part || !segment(part))) throw Error("AUTOBIZ_FILE_PATH")
  const protectedNames = new Set(["state.json", "state.md", "hooks.ndjson", ".plan.lock"])
  if (parts.some((part) => protectedNames.has(part.toLowerCase())))
    throw Error("AUTOBIZ_PROTECTED_STATE: 状态与日志只能通过原状态读取入口获取。")
  return path
}

export function projectLocation(value: unknown): ProjectLocation {
  if (!text(value, 8192) || value.trim() !== value) throw Error("AUTOBIZ_PROJECT_ROOT")
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  const drive = /^[A-Za-z]:\//.test(normalized)
  const unc = normalized.startsWith("//")
  if (!drive && !normalized.startsWith("/")) throw Error("AUTOBIZ_PROJECT_ROOT")
  const prefixLength = drive ? 3 : unc ? 2 : 1
  const parts = normalized.slice(prefixLength).split("/")
  if (
    !parts.length ||
    parts.some((part) => !text(part, 255) || !segment(part)) ||
    (unc && parts.length < 3)
  )
    throw Error("AUTOBIZ_PROJECT_ROOT: 请选项目目录，不能选文件系统根目录。")
  const split = normalized.lastIndexOf("/")
  const parent = normalized.slice(0, split) || "/"
  const project = parts[parts.length - 1]
  return {
    cwd: value,
    parent: drive && split === 2 ? normalized.slice(0, 3) : parent,
    project,
    identity: drive || unc ? normalized.toLowerCase() : normalized
  }
}

export function normalizedState(value: unknown, location: ProjectLocation): StateSnapshot {
  if (!object(value) || value.exitCode !== 0 || typeof value.stdout !== "string")
    throw Error("AUTOBIZ_STATE_PROCESS_FAILED")
  if (!value.stdout.trim() || value.stdout.length > 262144) throw Error("AUTOBIZ_STATE_OUTPUT")
  const payload: unknown = JSON.parse(value.stdout)
  if (
    !object(payload) ||
    payload.schemaVersion !== STATE_SCHEMA ||
    payload.ok !== true ||
    payload.exists !== true ||
    payload.source !== "state.json" ||
    !Array.isArray(payload.errors) ||
    payload.errors.length !== 0 ||
    !object(payload.records) ||
    !object(payload.recordErrors)
  )
    throw Error("AUTOBIZ_STATE_PAYLOAD_INVALID")
  if (projectLocation(payload.workspace).identity !== location.identity)
    throw Error("AUTOBIZ_STATE_WORKSPACE_CHANGED")
  if (Object.keys(payload.recordErrors).length) throw Error("AUTOBIZ_RECORD_ERRORS")
  const entries = Object.entries(payload.records)
  if (entries.length > 256) throw Error("AUTOBIZ_STATE_RECORD_LIMIT")
  const records: Record<string, NormalizedRecord> = Object.create(null)
  for (const [feature, row] of entries) {
    featureId(feature)
    if (
      !object(row) ||
      row.feature !== feature ||
      !text(row.checkpoint, 240) ||
      !text(row.stage, 240) ||
      (row.workflowNodes !== undefined &&
        (!Array.isArray(row.workflowNodes) ||
          row.workflowNodes.length > 64 ||
          row.workflowNodes.some((node) => !text(node, 240))))
    )
      throw Error("AUTOBIZ_STATE_RECORD_INVALID")
    records[feature] = row as NormalizedRecord
  }
  return { records }
}

export function selectedRecord(snapshot: StateSnapshot, feature: string): NormalizedRecord {
  const id = featureId(feature)
  if (!Object.hasOwn(snapshot.records, id))
    throw Error("AUTOBIZ_FEATURE_NOT_FOUND: 该 Feature 不在当前项目的规范状态中。")
  return snapshot.records[id]
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 16) throw Error("AUTOBIZ_STATE_RECORD_INVALID")
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1))
  if (!object(value)) throw Error("AUTOBIZ_STATE_RECORD_INVALID")
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1)
  return result
}

export function recordFingerprint(record: NormalizedRecord): string {
  return JSON.stringify(canonical(record))
}

export function boundedSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_CHARS)
    throw Error("AUTOBIZ_FILE_CONTENT: 文件必须非空且不超过 4000 字符。")
  return value
}

export function boundedReview(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_REVIEW_CHARS)
    throw Error("AUTOBIZ_MODEL_RESULT: legacy-v1 模型必须返回非空且不超过 4000 字符的文本。")
  return value
}

export function actionInput(args: unknown): { feature: string; path: string } {
  if (typeof args !== "string" || args.length > 65536) throw Error("CLAW_ACTION_ENVELOPE_INVALID")
  const request: unknown = JSON.parse(args)
  if (!object(request) || request.version !== 1 || !object(request.input))
    throw Error("CLAW_ACTION_ENVELOPE_INVALID")
  if (Object.keys(request.input).some((key) => key !== "feature" && key !== "path"))
    throw Error("AUTOBIZ_REVIEW_INPUT_FIELDS")
  return {
    feature: featureId(request.input.feature),
    path: projectRelativePath(request.input.path)
  }
}

export async function readState(sdk: AutobizSdk): Promise<StateSnapshot> {
  const location = projectLocation(await sdk.session.root())
  const result = await sdk.process.run(
    ["python", "-B", "-X", "utf8", sdk.plugin.root + "/read_state_json.py"],
    {
      cwd: location.cwd,
      env: {
        PLUGIN_WORKSPACE: location.parent,
        PROJECT_DIR: location.project,
        PYTHONIOENCODING: "utf-8",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      timeoutMs: 30000
    }
  )
  return normalizedState(result, location)
}

export function recordSummary(record: NormalizedRecord): string {
  const nodes = record.workflowNodes?.length
    ? record.workflowNodes.join("、")
    : "原状态未提供选定节点；不推断流程。"
  return `Feature：${record.feature}\ncheckpoint：${record.checkpoint}\n阶段：${record.stage}\n选定节点：${nodes}`
}

export function sourceDescription(): string {
  return `来源分支：${SOURCE.branch}\n提交：${SOURCE.commit}\n原版本：${SOURCE.upstreamVersion}`
}
