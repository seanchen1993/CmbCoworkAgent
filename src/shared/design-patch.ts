import type { DesignTweakValue } from "./design-protocol"

export interface DesignPatchTarget {
  artifactRevision?: number
  nodeId?: string
  sectionId?: string
  selector?: string
  tagName?: string
  text?: string
  instruction?: string
}
export interface DesignPatchRequest {
  targets: DesignPatchTarget[]
  variationId: string | null
  artifactRevision: number
  viewport?: { width: number; height: number }
  observations?: Array<{
    nodeId: string
    box: { width: number; height: number }
    computed: Record<string, string>
  }>
}
export type DesignPatchOperation =
  | { op: "set_text"; targetId: string; expectedHash: string; text: string }
  | {
      op: "set_style"
      targetId: string
      expectedHash: string
      declarations: Record<string, string>
      state?: "hover" | "focus-visible" | "disabled"
      maxWidth?: number
    }
  | { op: "set_attribute"; targetId: string; expectedHash: string; name: string; value: string }
  | { op: "replace_fragment"; targetId: string; expectedHash: string; html: string }
  | { op: "set_tweak"; key: string; value: DesignTweakValue }
export interface DesignPatchProposal {
  protocol: "design-patch/1"
  contextId: string
  baseArtifactRevision: number
  operations: DesignPatchOperation[]
  summary: string
}
export interface DesignAppliedPatch {
  id: string
  revision: number
  mode: "live" | "reload"
  targetIds: string[]
  summary: string
}
export interface DesignPatchStatus {
  phase: "locating" | "generating" | "validating" | "expanding" | "applied"
  message: string
}
export interface DesignPatchMetrics {
  usageReported?: boolean
  modelCalls: number
  inputTokens: number
  outputTokens: number
  contextBytes: number
  expansions: number
  repairs: number
  validationMs: number
  fallback?: string
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max
export const safeDesignNodeId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z][\w.-]{0,100}$/.test(v)

/** This boundary is shared by tool calls and strict-JSON model responses. */
export function parseDesignPatch(value: unknown): DesignPatchProposal {
  if (
    !record(value) ||
    value.protocol !== "design-patch/1" ||
    !bounded(value.contextId, 100) ||
    !Number.isSafeInteger(value.baseArtifactRevision) ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > 25 ||
    !bounded(value.summary, 500)
  )
    throw new Error("局部补丁格式无效")
  if (JSON.stringify(value).length > 100_000) throw new Error("局部补丁超过大小限制")
  for (const op of value.operations) {
    if (!record(op)) throw new Error("补丁操作无效")
    if (op.op === "set_tweak") {
      if (
        !safeDesignNodeId(op.key) ||
        !["string", "number", "boolean"].includes(typeof op.value) ||
        (typeof op.value === "number" && !Number.isFinite(op.value))
      )
        throw new Error("参数补丁无效")
      continue
    }
    if (!safeDesignNodeId(op.targetId) || !bounded(op.expectedHash, 80))
      throw new Error("补丁缺少目标或基线")
    if (op.op === "set_text" && bounded(op.text, 8000)) continue
    if (op.op === "replace_fragment" && bounded(op.html, 60_000)) continue
    if (op.op === "set_attribute" && bounded(op.name, 80) && bounded(op.value, 4000)) continue
    if (
      op.op === "set_style" &&
      record(op.declarations) &&
      Object.keys(op.declarations).length > 0 &&
      Object.keys(op.declarations).length <= 40 &&
      Object.entries(op.declarations).every(
        ([k, v]) => /^-?[a-z][a-z-]{0,79}$/.test(k) && bounded(v, 1000)
      ) &&
      (op.state === undefined ||
        ["hover", "focus-visible", "disabled"].includes(String(op.state))) &&
      (op.maxWidth === undefined ||
        (typeof op.maxWidth === "number" &&
          Number.isInteger(op.maxWidth) &&
          op.maxWidth >= 240 &&
          op.maxWidth <= 3840))
    )
      continue
    throw new Error(`不支持的局部操作：${String(op.op)}`)
  }
  return value as unknown as DesignPatchProposal
}

/** Broad changes retain the full design executor. Targeted requests enter the bounded executor. */
export function shouldUseDesignPatch(prompt: string, hasTargets = false): boolean {
  if (hasTargets) return true
  return !/(全[页站局部]|整体|整[页体站]|重新设计|重做|换.{0,4}(风格|主题)|global|redesign|new interaction|新增.{0,8}(交互|功能)|添加.{0,8}(交互|功能))/i.test(
    prompt
  )
}
