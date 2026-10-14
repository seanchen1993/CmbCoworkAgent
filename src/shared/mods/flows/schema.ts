import { COMPLETION_CHECKS } from "../v2/completion-policy-values"
import type { FlowCatalog, FlowCondition, FlowDefinition, FlowStep, FlowStepBase } from "./types"
import { clawActionObject, parseClawActionIdentity, parseClawOutputPointer } from "../claw-actions"
import type { ClawSourceReference } from "../claw"

export function isFlowOutputStep(
  step: FlowStep
): step is Extract<FlowStep, { kind: "plugin-action" | "mcp-tool" }> {
  return step.kind === "plugin-action" || step.kind === "mcp-tool"
}

/** UI eligibility only. The runtime must independently validate authority and every source. */
export function flowRunnableInCatalog(flow: FlowDefinition, catalog?: FlowCatalog | null): boolean {
  if (!catalog?.available) return false
  return flow.schemaVersion === 2
    ? catalog.hostAvailable === true
    : catalog.plugins.some((plugin) => plugin.id === flow.plugin && plugin.authorized)
}

function sourceReference(input: unknown): ClawSourceReference {
  const value = object(input, "来源身份")
  const sourceId = text(value.id, "来源 ID", 1024)
  // eslint-disable-next-line no-control-regex -- Reject controls in source identities.
  if (/[\u0000-\u001f]/.test(sourceId)) throw Error("来源 ID 无效")
  return { id: sourceId, name: text(value.name, "来源名称", 256), digest: digest(value.digest) }
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("来源或工具 schema 摘要无效")
  return value
}

export const FLOW_MAX_STEPS = 64
export const FLOW_MAX_EXECUTIONS = 256
export const FLOW_MAX_DEFINITION_BYTES = 128 * 1024
export const FLOW_MAX_TASK_CHARS = 16000

export function parseFlowTaskGoal(value: unknown): string {
  return text(value, "本次流程任务", FLOW_MAX_TASK_CHARS).trim()
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error(`${label} 不能为空且不能超过 ${max} 字符`)
  return value
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 64)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result))
    throw Error(`${label} 只能包含字母、数字、点、下划线和连字符`)
  return result
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw Error(`${label} 必须是 ${min}–${max} 的整数`)
  return value
}

/** Explicit reconstruction keeps unknown fields and executable expressions out of the contract. */
export function parseFlowDefinition(input: unknown): FlowDefinition {
  const raw = object(input, "流程")
  let profile: "prompt-only-v1" | "workspace-files-v1" | undefined
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw Error("不支持的流程版本")
  if (raw.schemaVersion === 2) {
    const execution = object(raw.execution, "流程运行方式")
    if (
      execution.kind !== "host" ||
      Object.keys(execution).some((key) => key !== "kind" && key !== "profile") ||
      Object.hasOwn(raw, "plugin") ||
      Object.hasOwn(raw, "authority") ||
      Object.hasOwn(raw, "grant")
    )
      throw Error("宿主流程只能使用应用运行方式，不能声明插件或授权身份")
    if (Object.hasOwn(execution, "profile")) {
      if (execution.profile !== "prompt-only-v1" && execution.profile !== "workspace-files-v1") throw Error("不支持的流程执行配置")
      profile = execution.profile
    }
  } else if (Object.hasOwn(raw, "execution")) {
    throw Error("旧版流程不能声明新的运行方式，请保留原授权来源")
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > FLOW_MAX_STEPS)
    throw Error(`流程必须有 1–${FLOW_MAX_STEPS} 个步骤`)
  const steps = raw.steps.map((value): FlowStep => {
    const step = object(value, "步骤")
    if (typeof step.enabled !== "boolean") throw Error("步骤启用状态无效")
    const base: FlowStepBase = {
      id: id(step.id, "步骤 ID"),
      name: text(step.name, "步骤名称"),
      enabled: step.enabled,
      ...(step.when === undefined
        ? {}
        : {
            when: ((): FlowCondition => {
              const when = object(step.when, "条件")
              if (when.outcome !== "passed" && when.outcome !== "failed")
                throw Error("条件只能引用业务通过或业务不通过")
              return { stepId: id(when.stepId, "条件来源"), outcome: when.outcome }
            })()
          }),
      ...(step.onSuccess === undefined ? {} : { onSuccess: id(step.onSuccess, "成功路线") }),
      ...(step.onFailure === undefined
        ? {}
        : {
            onFailure: (() => {
              const route = object(step.onFailure, "失败路线")
              return {
                stepId: id(route.stepId, "失败路线目标"),
                maxRetries: integer(route.maxRetries, "最大回退次数", 1, 10)
              }
            })()
          })
    }
    if (step.kind === "agent" || step.kind === "skill")
      return {
        ...base,
        ...(step.kind === "skill"
          ? { kind: "skill" as const, skill: sourceReference(step.skill) }
          : { kind: "agent" as const }),
        prompt: text(step.prompt, "步骤目标", 8000),
        ...(step.agentType ? { agentType: text(step.agentType, "Agent", 256) } : {}),
        ...(step.modelId ? { modelId: text(step.modelId, "模型", 256) } : {}),
        ...(step.modelRole ? { modelRole: id(step.modelRole, "模型角色") } : {})
      }
    if (step.kind === "plugin-action" || step.kind === "mcp-tool") {
      if (step.kind === "mcp-tool" && step.onFailure) throw Error("MCP 工具禁止自动重试或失败回退")
      const inputFrom =
        step.inputFrom === undefined ? undefined : object(step.inputFrom, "动作输入来源")
      const evidenceInput =
        step.evidenceInput === undefined ? undefined : object(step.evidenceInput, "执行结果输入")
      if (evidenceInput && (step.kind !== "plugin-action" || inputFrom))
        throw Error("执行结果输入仅支持插件动作，不能同时引用另一动作输出")
      if (
        evidenceInput &&
        (typeof evidenceInput.field !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(evidenceInput.field) ||
          ["constructor", "prototype"].includes(evidenceInput.field) ||
          Object.keys(evidenceInput).some((key) => key !== "field"))
      )
        throw Error("执行结果输入需要合法的顶层文本字段")
      return {
        ...base,
        ...(step.kind === "mcp-tool"
          ? {
              kind: "mcp-tool" as const,
              provider: sourceReference(step.provider),
              toolName: text(step.toolName, "MCP 工具名称", 256),
              schemaDigest: digest(step.schemaDigest)
            }
          : {
              kind: "plugin-action" as const,
              ...parseClawActionIdentity({
                pluginId: step.pluginId,
                plugin: step.plugin,
                digest: step.digest,
                actionId: step.actionId
              })
            }),
        input: clawActionObject(step.input ?? {}),
        ...(step.kind !== "plugin-action" || step.config === undefined
          ? {}
          : { config: clawActionObject(step.config) }),
        ...(evidenceInput ? { evidenceInput: { field: evidenceInput.field as string } } : {}),
        ...(inputFrom === undefined
          ? {}
          : {
              inputFrom: {
                stepId: id(inputFrom.stepId, "动作输入步骤"),
                ...(inputFrom.path === undefined
                  ? {}
                  : { path: parseClawOutputPointer(inputFrom.path) })
              }
            })
      }
    }
    if (step.kind === "approval") {
      if (step.onFailure) throw Error("人工拒绝必须停止，不能配置失败回退")
      return { ...base, kind: "approval", prompt: text(step.prompt, "确认说明", 4000) }
    }
    if (step.kind === "check") {
      if (!COMPLETION_CHECKS.includes(step.check as (typeof COMPLETION_CHECKS)[number]))
        throw Error("检查类型不可用")
      return { ...base, kind: "check", check: step.check as (typeof COMPLETION_CHECKS)[number] }
    }
    if (step.kind === "autobiz-stage") {
      if (step.when || step.onSuccess || step.onFailure)
        throw Error("阶段提交必须是无条件终端动作；失败必须停止")
      return { ...base, kind: "autobiz-stage" }
    }
    throw Error("步骤类型不可用")
  })
  const ids = new Set(steps.map((step) => step.id))
  if (
    profile &&
    steps.some(
      (step) =>
        !["agent", "check", "approval"].includes(step.kind) ||
        step.when !== undefined ||
        step.onSuccess !== undefined ||
        step.onFailure !== undefined
    )
  )
    throw Error("可恢复文本流程仅支持无条件、无跳转的 Agent、检查与确认步骤")
  if (ids.size !== steps.length) throw Error("步骤 ID 不能重复")
  const enabled = steps.filter((step) => step.enabled)
  if (!enabled.length) throw Error("至少启用一个步骤")
  const targets = new Map(enabled.map((step) => [step.id, steps.indexOf(step)]))
  for (const step of enabled) {
    const index = steps.indexOf(step)
    if (isFlowOutputStep(step) && step.inputFrom) {
      const from = targets.get(step.inputFrom.stepId)
      if (from === undefined || from >= index || !isFlowOutputStep(steps[from]))
        throw Error(`${step.name} 的输入必须引用前面已启用的插件动作或 MCP 工具`)
    }
    if (step.when && (!targets.has(step.when.stepId) || targets.get(step.when.stepId)! >= index))
      throw Error(`${step.name} 的条件必须引用前面已启用的步骤`)
    if (step.onSuccess && (!targets.has(step.onSuccess) || targets.get(step.onSuccess)! <= index))
      throw Error(`${step.name} 的成功路线必须指向后面已启用的步骤`)
    if (step.onFailure && !targets.has(step.onFailure.stepId))
      throw Error(`${step.name} 的失败路线目标不存在或已禁用`)
    if (step.onFailure) {
      const target = targets.get(step.onFailure.stepId)!
      if (
        target <= index &&
        steps.slice(target, index + 1).some((item) => item.enabled && item.kind === "mcp-tool")
      )
        throw Error(`${step.name} 的失败回退不能跨过 MCP 工具，避免重复外部操作`)
    }
  }
  const stages = enabled.filter((step) => step.kind === "autobiz-stage")
  if (stages.length > 1 || (stages.length && enabled.at(-1) !== stages[0]))
    throw Error("Autobiz 阶段提交最多一个，且必须是最后启用的步骤")
  if (
    raw.schemaVersion === 2 &&
    steps.some(
      (step) =>
        step.kind === "autobiz-stage" ||
        (step.kind === "check" && step.check !== "unit-test" && step.check !== "e2e")
    )
  )
    throw Error(
      "宿主流程仅支持单元测试和 E2E 真实检查；代码检视请用 Agent 任务，Autobiz 阶段请使用旧版流程"
    )
  const definition = {
    schemaVersion: raw.schemaVersion,
    id: id(raw.id, "流程 ID"),
    name: text(raw.name, "流程名称"),
    ...(raw.schemaVersion === 1
      ? { plugin: text(raw.plugin, "Mods 插件", 256) }
      : { execution: { kind: "host" as const, ...(profile ? { profile } : {}) } }),
    goal: text(raw.goal, "业务目标", 8000),
    ...(raw.feature ? { feature: id(raw.feature, "Feature ID") } : {}),
    ...(raw.stageStart ? { stageStart: id(raw.stageStart, "阶段起点") } : {}),
    timeoutMs: integer(raw.timeoutMs, "总运行时间", 1000, 3_600_000),
    maxExecutions: integer(raw.maxExecutions, "最大步骤执行次数", 1, FLOW_MAX_EXECUTIONS),
    steps
  } as FlowDefinition
  if (stages.length && (!definition.feature || !definition.stageStart))
    throw Error("阶段提交需要真实 Feature 和当前阶段起点")
  if (
    enabled.some((step) => step.kind === "check" && step.check === "autobiz-validator") &&
    !definition.feature
  )
    throw Error("Autobiz 业务验收需要 Feature ID")
  if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > FLOW_MAX_DEFINITION_BYTES)
    throw Error("流程定义超过大小限制")
  return definition
}
