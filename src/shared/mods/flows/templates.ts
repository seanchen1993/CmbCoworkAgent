import type { LegacyFlowDefinition, HostFlowDefinition } from "./types"

export function createReviewFlow(plugin: string, id: string): LegacyFlowDefinition {
  return {
    schemaVersion: 1,
    id,
    name: "代码检视与确认",
    plugin,
    goal: "检视当前项目的未提交改动，找出有依据的问题并给出修复建议。仅检视，不修改文件。",
    timeoutMs: 1_800_000,
    maxExecutions: 16,
    steps: [
      {
        id: "review",
        name: "检视代码",
        kind: "agent",
        enabled: true,
        prompt:
          "阅读项目约定和当前 Git 差异，检视正确性、权限与失败路径。列出文件位置和依据；不修改文件，不编造测试结果。"
      },
      {
        id: "accept",
        name: "确认检视结果",
        kind: "approval",
        enabled: true,
        prompt: "请阅读检视结果，确认是否接受本次成果。"
      }
    ]
  }
}

/** A new host workflow needs no placeholder plugin or plugin grant. */
export function createHostReviewFlow(id: string): HostFlowDefinition {
  const legacy = createReviewFlow("unused", id)
  return {
    schemaVersion: 2,
    id: legacy.id,
    name: legacy.name,
    execution: { kind: "host" },
    goal: legacy.goal,
    timeoutMs: legacy.timeoutMs,
    maxExecutions: legacy.maxExecutions,
    steps: legacy.steps
  }
}

export function createAutobizFlow(plugin: string, id = "autobiz-delivery"): LegacyFlowDefinition {
  return {
    schemaVersion: 1,
    id,
    name: "Autobiz 研发流程",
    plugin,
    goal: "按 requirements.md 完成业务开发，保留原始需求和测试，提交真实的实现与验证结果。",
    timeoutMs: 1_800_000,
    maxExecutions: 64,
    steps: [
      {
        id: "requirements",
        name: "分析需求",
        enabled: false,
        kind: "agent",
        agentType: "plan",
        prompt: "阅读需求与当前实现，列出验收标准和风险。只分析，不修改文件。"
      },
      {
        id: "design",
        name: "方案设计",
        enabled: false,
        kind: "agent",
        agentType: "plan",
        prompt: "基于业务需求给出实现方案、依赖与测试计划。只分析，不修改文件。"
      },
      {
        id: "implement",
        name: "编码与修复",
        enabled: true,
        kind: "agent",
        prompt:
          "按照业务目标实现代码；若有此前检查失败，逐项修复。不得修改既有业务需求和测试来掩盖失败。需要 Autobiz 产物时，按当前阶段要求生成真实报告，不直接改 state.json 或 STATE.md。"
      },
      {
        id: "review",
        name: "独立代码评审",
        enabled: true,
        kind: "agent",
        agentType: "verification",
        prompt:
          "独立检查当前实现是否满足需求，报告具体缺陷。只评审不修复；仍有实质缺陷时返回业务不通过。",
        onFailure: { stepId: "implement", maxRetries: 2 }
      },
      {
        id: "unit",
        name: "单元测试",
        enabled: true,
        kind: "check",
        check: "unit-test",
        onFailure: { stepId: "implement", maxRetries: 2 }
      },
      {
        id: "e2e",
        name: "E2E 测试",
        enabled: false,
        kind: "check",
        check: "e2e",
        onFailure: { stepId: "implement", maxRetries: 2 }
      },
      {
        id: "accept",
        name: "人工验收",
        enabled: true,
        kind: "approval",
        prompt: "请核对本轮实现、独立评审及真实测试结果，确认这些成果可以交付。"
      },
      { id: "stage", name: "Autobiz 验收并推进阶段", enabled: false, kind: "autobiz-stage" }
    ]
  }
}

/** Generic host development workflow; legacy AutoBiz definitions remain unchanged. */
export function createHostDevelopmentFlow(id: string): HostFlowDefinition {
  const legacy = createAutobizFlow("unused", id)
  return {
    schemaVersion: 2,
    execution: { kind: "host" },
    id,
    name: "通用开发流程",
    goal: legacy.goal,
    timeoutMs: legacy.timeoutMs,
    maxExecutions: legacy.maxExecutions,
    steps: legacy.steps
      .filter((step) => step.kind !== "autobiz-stage")
      .map((step) =>
        step.id === "implement"
          ? {
              ...step,
              prompt:
                "按照业务目标实现代码；若有此前检查失败，逐项修复。不得修改既有业务需求和测试来掩盖失败。保留真实实现与验证结果，不自动推进项目阶段。"
            }
          : step
      )
  }
}
