import type { FlowStep, HostFlowDefinition } from "./types"
import type { ClawActionIdentity } from "../claw-actions"

export type AutobizPreset = "review" | "review-test" | "repair-retest"
export const AUTOBIZ_PRESETS: readonly {
  id: AutobizPreset
  name: string
  description: string
}[] = [
  {
    id: "review",
    name: "通用开发 · 只检视",
    description: "只读检视真实仓库，汇报发现；不执行项目测试。"
  },
  {
    id: "review-test",
    name: "通用开发 · 检视与测试",
    description: "只读检视后执行真实项目单元测试，失败即停止。"
  },
  {
    id: "repair-retest",
    name: "通用开发 · 修复与复检",
    description: "先测试，仅失败时修改实现并复测；最多两次修复，不推进阶段。"
  }
]

/** Ownerless workflows; no invented plugin, grant, Feature, or stage transition. */
export function createAutobizPreset(preset: AutobizPreset, id: string): HostFlowDefinition {
  const selected = AUTOBIZ_PRESETS.find((item) => item.id === preset)
  if (!selected) throw Error("AUTOBIZ_PRESET_UNKNOWN")
  const review: FlowStep = {
    id: "review",
    name: "只读检视真实仓库",
    kind: "agent",
    agentType: "Explore",
    enabled: true,
    prompt:
      "读取项目约定、当前变更与相关源文件，列出有文件位置和依据的问题；没有 Git 变更时按本次目标检查相关文件。不要修改文件、执行测试或推进 Autobiz checkpoint。检视发现留给用户及后续修复步骤，不把意见称为原生测试结果。"
  }
  const steps: FlowStep[] = [review]
  if (preset !== "review")
    steps.push({
      id: "unit",
      name: "执行真实单元测试",
      kind: "check",
      check: "unit-test",
      enabled: true,
      ...(preset === "repair-retest"
        ? { onSuccess: "report", onFailure: { stepId: "repair", maxRetries: 1 } }
        : {})
    })
  if (preset === "repair-retest")
    steps.push(
      {
        id: "repair",
        name: "按失败证据修复实现",
        kind: "agent",
        enabled: true,
        prompt:
          "先读取前面真实测试的失败输出及相关源文件，再只修改满足原需求所必需的实现。不得删除、跳过或改弱原测试，不得改变检查配置、业务需求或 Autobiz checkpoint。后续原生测试负责证明修复结果；不要凭模型判断自称测试通过。"
      },
      {
        id: "retest",
        name: "原测试复检",
        kind: "check",
        check: "unit-test",
        enabled: true,
        onFailure: { stepId: "repair", maxRetries: 1 }
      }
    )
  steps.push(
    {
      id: "report",
      name: "汇报真实结果（可替换为插件动作）",
      kind: "agent",
      agentType: "Explore",
      enabled: true,
      prompt:
        "依据当前有效执行记录与必要的只读文件核对，汇报检视发现、实际修改、实际测试及限制。没有原生测试回执明确写未执行项目测试，跳过、失效和历史 PASS 不计入当前通过；未推进 checkpoint。不要修改文件或补跑测试。"
    },
    {
      id: "accept",
      name: "确认本次成果",
      kind: "approval",
      enabled: true,
      prompt:
        "请核对源文件改动、检视结果、真实测试回执及未执行项。确认本次成果不会自动推进 Autobiz 阶段。"
    }
  )
  return {
    schemaVersion: 2,
    execution: { kind: "host" },
    id,
    name: selected.name,
    goal: selected.description,
    timeoutMs: 1_800_000,
    maxExecutions: 24,
    steps
  }
}

/** Explicitly selected/authorized action identity; the host rechecks it before execution. */
export function withAutobizReportAction(
  definition: HostFlowDefinition,
  action: ClawActionIdentity,
  field = "text"
): HostFlowDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) =>
      step.id === "report"
        ? {
            id: step.id,
            name: "由所选插件汇报执行结果",
            enabled: step.enabled,
            kind: "plugin-action",
            ...action,
            input: {},
            evidenceInput: { field }
          }
        : step
    )
  }
}
