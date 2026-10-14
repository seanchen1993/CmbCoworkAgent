import type { FlowRecoveryReason } from "../../../shared/mods/flows/recovery"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type { FlowRecoveryObservation } from "./recovery"

type ReadResult<T> = T | Promise<T>
type ObservationResult<T> = { read: true; value: T } | { read: false }
interface ModelObservation {
  fingerprint: string
  available: boolean
}
interface PluginObservation {
  state: "ready" | "disabled" | "needs-approval" | "invalid"
  digest?: string
  actionIds: readonly string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validPlan(value: unknown): value is NonNullable<FlowRun["executionPlan"]> {
  if (!record(value) || !record(value.models) || !Array.isArray(value.actions)) return false
  if (
    Object.values(value.models).some(
      (pin) =>
        !record(pin) ||
        typeof pin.ref !== "string" ||
        !pin.ref ||
        typeof pin.fingerprint !== "string" ||
        !pin.fingerprint
    )
  )
    return false
  if (
    value.modelPolicy !== undefined &&
    (!record(value.modelPolicy) ||
      Object.values(value.modelPolicy).some((digest) => typeof digest !== "string" || !digest))
  )
    return false
  if (
    [value.skills, value.mcpTools, value.components].some(
      (item) => item !== undefined && !record(item)
    )
  )
    return false
  if (
    value.defaultModelRef !== undefined &&
    value.defaultModelRef !== null &&
    typeof value.defaultModelRef !== "string"
  )
    return false
  return value.actions.every(
    (action) =>
      record(action) &&
      [action.pluginId, action.plugin, action.digest, action.actionId].every(
        (field) => typeof field === "string" && !!field
      )
  )
}

/** Callbacks must only read existing host state, without preparing sessions or connections. */
export interface LegacyFlowRecoveryDependencies {
  readDefinitionDigest?(): ReadResult<string | undefined>
  readModel?(ref: string): ReadResult<ModelObservation | undefined>
  readDefaultModelRef?(): ReadResult<string | null>
  readPlugin?(pluginId: string): ReadResult<PluginObservation | undefined>
}

/** Old fingerprints lack their durable binding. Matching partial facts never authorizes reuse. */
export async function observeLegacyFlowRecovery(
  run: FlowRun,
  dependencies: LegacyFlowRecoveryDependencies
): Promise<FlowRecoveryObservation> {
  const reasons: FlowRecoveryReason[] = [
    { code: "legacy-binding-unverified", message: "旧记录未保存可重新核验的产物绑定。" },
    { code: "thread-incarnation-unverified", message: "旧记录未保存原会话实例身份。" },
    { code: "harness-config-unverified", message: "旧记录未保存完整 Harness 与运行配置快照。" }
  ]
  let unavailable = false
  const add = (code: string, message: string, stepId?: string) => {
    if (reasons.length < 63) reasons.push({ code, message, ...(stepId ? { stepId } : {}) })
    else if (reasons.length === 63)
      reasons.push({ code: "observation-limit", message: "诊断数量达到上限，其余依赖未验证。" })
  }
  const read = async <T>(
    operation: (() => ReadResult<T>) | undefined
  ): Promise<ObservationResult<T>> => {
    if (!operation) return { read: false }
    try {
      return { read: true, value: await operation() }
    } catch {
      return { read: false }
    }
  }
  const definition = await read(dependencies.readDefinitionDigest)
  const definitionDigest =
    definition.read && typeof definition.value === "string" ? definition.value : undefined
  if (!definitionDigest) add("definition-unverified", "当前流程版本不存在或无法只读核对。")
  else if (definitionDigest !== run.flow.digest)
    add("definition-changed", "当前保存的流程版本与本次历史不同。")

  const plan = run.executionPlan
  if (!plan) add("execution-plan-unverified", "旧记录没有执行配置计划。")
  else if (!validPlan(plan)) add("invalid-history", "历史执行配置结构不完整，依赖无法核对。")
  else {
    const models = Object.entries(plan.models ?? {})
    const policies = Object.entries(plan.modelPolicy ?? {})
    const actions = plan.actions ?? []
    if (models.length + policies.length + actions.length > 128) {
      add("observation-limit", "历史依赖数量超出只读观察上限，未验证执行配置。")
    } else {
      const modelCache = new Map<string, ObservationResult<ModelObservation | undefined>>()
      for (const [stepId, pin] of [
        ...models,
        ...policies.map(([ref, fingerprint]) => [undefined, { ref, fingerprint }] as const)
      ]) {
        if (
          !pin ||
          typeof pin.ref !== "string" ||
          !pin.ref ||
          typeof pin.fingerprint !== "string" ||
          !pin.fingerprint
        ) {
          add("model-unverified", "历史模型身份或配置摘要不完整。", stepId)
          continue
        }
        let current = modelCache.get(pin.ref)
        if (!current) {
          current = await read(dependencies.readModel && (() => dependencies.readModel!(pin.ref)))
          modelCache.set(pin.ref, current)
        }
        if (!current.read) add("model-unverified", "当前模型配置无法只读核对。", stepId)
        else if (!current.value || current.value.available === false) {
          unavailable = true
          add("model-unavailable", "历史使用的模型当前不可用。", stepId)
        } else if (!current.value.fingerprint || current.value.available !== true)
          add("model-unverified", "当前模型配置观察不完整。", stepId)
        else if (current.value.fingerprint !== pin.fingerprint)
          add("model-changed", "模型配置已改变。", stepId)
      }
      if (plan.defaultModelRef !== undefined) {
        const current = await read(dependencies.readDefaultModelRef)
        if (!current.read) add("default-model-unverified", "当前默认模型无法只读核对。")
        else if (current.value !== plan.defaultModelRef)
          add("default-model-changed", "默认模型选择已改变。")
      }
      const pluginCache = new Map<string, ObservationResult<PluginObservation | undefined>>()
      for (const action of actions) {
        if (!action || typeof action.pluginId !== "string" || !action.pluginId) {
          add("action-unverified", "历史动作来源身份不完整。")
          continue
        }
        let current = pluginCache.get(action.pluginId)
        if (!current) {
          current = await read(
            dependencies.readPlugin && (() => dependencies.readPlugin!(action.pluginId))
          )
          pluginCache.set(action.pluginId, current)
        }
        if (!current.read) add("action-unverified", "当前动作来源无法只读核对。")
        else if (!current.value || current.value.state !== "ready") {
          unavailable = true
          add("action-unavailable", "动作来源已禁用、撤权或不可用。")
        } else if (current.value.digest !== action.digest)
          add("action-source-changed", "动作来源版本已改变。")
        else if (!current.value.actionIds.includes(action.actionId))
          add("action-removed", "历史动作已不再由当前来源导出。")
        else add("action-runtime-unverified", "动作声明仍在，运行时注册与旧配置尚未验证。")
      }
    }
    if (Object.keys(plan.skills ?? {}).length)
      add("skills-unverified", "Skill 来源与附属依赖尚未完成只读版本核对。")
    if (Object.keys(plan.mcpTools ?? {}).length)
      add("mcp-unverified", "MCP 工具 schema 和连接代次未验证；查看历史不会连接服务。")
    if (Object.keys(plan.components ?? {}).length)
      add("components-unverified", "组件选择、参数和已应用版本尚未完成核对。")
  }
  return {
    authority: unavailable ? "unavailable" : "unverified",
    ...(definitionDigest ? { definitionDigest } : {}),
    reasons
  }
}
