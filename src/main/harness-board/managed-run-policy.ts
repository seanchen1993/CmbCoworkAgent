import type {
  AgentTurnEndEvent,
  ManagedBizRetryMode,
  ManagedFeatureStatusSnapshot,
  ManagedRunPolicyResult,
  ManagedRunSnapshot
} from "../../shared/harness-board-types"

export interface ManagedRunPolicyEvaluation {
  policyResult: ManagedRunPolicyResult
  summary: string
}

export interface ManagedRunPolicyConfig {
  incompleteStageRetryMode: "adaptive" | ManagedBizRetryMode
  maxBizRetries: number
  maxProviderRetries: number
  maxContextReuseRatio: number
}

export const DEFAULT_MANAGED_RUN_POLICY: ManagedRunPolicyConfig = {
  incompleteStageRetryMode: "adaptive",
  maxBizRetries: 3,
  maxProviderRetries: 3,
  maxContextReuseRatio: 0.9
}

export const MANAGED_PROVIDER_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const

export function resolveProviderRetryPlan(
  providerRetryCount: number,
  maxRetries = DEFAULT_MANAGED_RUN_POLICY.maxProviderRetries
): {
  retryNumber: number
  delayMs: number
} | null {
  const retryNumber = providerRetryCount + 1
  if (retryNumber > maxRetries) return null
  const delayMs = MANAGED_PROVIDER_RETRY_DELAYS_MS[retryNumber - 1]
  return delayMs === undefined ? null : { retryNumber, delayMs }
}

export function resolveContextUsageRatio(
  contextUsage: AgentTurnEndEvent["contextUsage"]
): number | undefined {
  if (
    !contextUsage ||
    !Number.isFinite(contextUsage.inputTokens) ||
    !Number.isFinite(contextUsage.maxTokens) ||
    contextUsage.inputTokens < 0 ||
    contextUsage.maxTokens <= 0
  ) {
    return undefined
  }
  return contextUsage.inputTokens / contextUsage.maxTokens
}

function isCompletedNodeStatus(status: ManagedFeatureStatusSnapshot["currentNodeStatus"]): boolean {
  return status === "done" || status === "archived" || status === "skipped"
}

function hasValidNextAction(feature: ManagedFeatureStatusSnapshot): boolean {
  return Boolean(feature.nextAction?.slashSkill && feature.nextAction.userMessage)
}

function missingNextActionDecision(
  feature: ManagedFeatureStatusSnapshot
): ManagedRunPolicyEvaluation | null {
  if (!feature.nextAction?.slashSkill) {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "next_action_missing_slash_skill",
        rule: "创建新会话前必须存在可执行技能；缺少技能时结束托管运行。"
      },
      summary: "当前节点的 nextAction 缺少 slashSkill"
    }
  }
  if (!feature.nextAction.userMessage) {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "next_action_missing_user_message",
        rule: "创建新会话前必须存在执行消息；缺少消息时结束托管运行。"
      },
      summary: "当前节点的 nextAction 缺少 userMessage"
    }
  }
  return null
}

function resolveBizRetryMode(input: {
  run: ManagedRunSnapshot
  feature: ManagedFeatureStatusSnapshot
  contextUsage?: AgentTurnEndEvent["contextUsage"]
  config: ManagedRunPolicyConfig
}): { retryMode: ManagedBizRetryMode; reasonCode: string; summary: string; rule: string } {
  const ratio = resolveContextUsageRatio(input.contextUsage)
  if (ratio !== undefined && ratio > input.config.maxContextReuseRatio) {
    return {
      retryMode: "new_thread",
      reasonCode: "biz_retry_context_limit",
      summary: "上下文占用超过复用阈值，使用新会话重新执行当前阶段",
      rule: "当前阶段尚未结束且上下文占用超过90%时，不复用当前会话，创建新会话重试。"
    }
  }
  if (input.config.incompleteStageRetryMode === "new_thread") {
    return {
      retryMode: "new_thread",
      reasonCode: "biz_retry_forced_new_thread",
      summary: "当前策略要求使用新会话重新执行当前阶段",
      rule: "当前阶段尚未结束且策略配置为新会话模式时，创建新会话重试。"
    }
  }
  if (input.config.incompleteStageRetryMode === "reuse_thread") {
    return {
      retryMode: "reuse_thread",
      reasonCode: "biz_retry_forced_reuse_thread",
      summary: "当前策略要求复用原会话继续当前任务",
      rule: "当前阶段尚未结束且策略配置为复用模式时，在原会话继续当前任务。"
    }
  }
  if (input.run.decisionBaseline?.featureStateHash === input.feature.featureStateHash) {
    return {
      retryMode: "new_thread",
      reasonCode: "biz_retry_no_progress",
      summary: "未识别到业务进展，使用新会话重新执行当前阶段",
      rule: "当前阶段尚未结束、上下文可复用且执行基线完全不变时，创建新会话重新执行当前阶段。"
    }
  }
  return {
    retryMode: "reuse_thread",
    reasonCode: "biz_retry_progress_detected",
    summary: "检测到业务进展，复用原会话继续当前任务",
    rule: "当前阶段尚未结束、上下文可复用且执行基线发生变化时，在原会话继续当前任务。"
  }
}

export function resolveManagedRunDecision(input: {
  run: ManagedRunSnapshot
  feature: ManagedFeatureStatusSnapshot
  terminal?: Pick<AgentTurnEndEvent, "outcome" | "endReason" | "contextUsage">
  config?: ManagedRunPolicyConfig
}): ManagedRunPolicyEvaluation {
  const { run, feature, terminal } = input
  const config = input.config ?? DEFAULT_MANAGED_RUN_POLICY
  if (
    feature.isFinalNode &&
    (feature.featureStatus === "done" || feature.featureStatus === "archived") &&
    (feature.currentNodeStatus === "done" || feature.currentNodeStatus === "archived")
  ) {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "complete_managed_run",
        reasonCode: "feature_terminal",
        rule: "当前阶段是工作流最后阶段，且特性状态和阶段状态均为已完成或已归档时，完成托管运行。"
      },
      summary: "特性已进入终态"
    }
  }
  if (["blocked", "warning", "error", "unknown"].includes(feature.featureStatus)) {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: `feature_status_${feature.featureStatus}`,
        rule: "特性状态为受阻、警告、错误或未知时，结束托管运行并等待人工处理。"
      },
      summary: `特性状态为 ${feature.featureStatus}，托管运行失败，需处理后重新开始`
    }
  }
  if (terminal?.endReason.code === "hook_halt") {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "hook_halt",
        rule: "Hook 明确阻止本轮继续时，结束托管运行。"
      },
      summary: terminal.endReason.message || "Hook 阻止了本轮完成"
    }
  }
  if (terminal?.endReason.code === "failure_fuse") {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "failure_fuse",
        rule: "失败熔断器触发时，结束托管运行，避免继续自动执行。"
      },
      summary: terminal.endReason.message || "失败熔断器阻止了继续执行"
    }
  }

  const nodeChanged = Boolean(
    run.decisionBaseline && run.decisionBaseline.nodeId !== feature.currentNodeId
  )
  const nodeStatusChanged = Boolean(
    run.decisionBaseline && run.decisionBaseline.nodeStatus !== feature.currentNodeStatus
  )
  const nodeCompleted = isCompletedNodeStatus(feature.currentNodeStatus)
  if (terminal?.endReason.code === "provider_error" && !nodeChanged && !nodeCompleted) {
    return {
      policyResult: {
        type: "provider_retry",
        proposedAction: "schedule_provider_retry",
        reasonCode: "provider_error",
        rule: "模型服务调用失败且当前阶段尚未结束时，不考虑上下文占用，在原会话中按退避计划重试。"
      },
      summary: "模型服务调用失败，计划在原会话重试"
    }
  }
  if (terminal?.outcome === "error" && terminal.endReason.code !== "provider_error") {
    return {
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "agent_error",
        rule: "非模型服务错误导致会话失败时，不自动重试并结束托管运行。"
      },
      summary: terminal.endReason.message || "Agent 执行失败"
    }
  }

  if (!run.decisionBaseline) {
    const invalidAction = missingNextActionDecision(feature)
    if (invalidAction) return invalidAction
    return {
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: "initial_action_resolved",
        rule: "当前托管运行尚无工作会话且 nextAction 合法时，创建第一个工作会话。"
      },
      summary: "首次检查得到合法执行指令，创建第一个工作会话"
    }
  }

  const shouldAdvanceCompletedNode =
    nodeCompleted && (terminal?.outcome !== "success" || nodeStatusChanged)
  if (nodeChanged || shouldAdvanceCompletedNode) {
    const invalidAction = missingNextActionDecision(feature)
    if (invalidAction) return invalidAction
    return {
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: nodeChanged ? "current_node_changed" : "current_node_completed",
        rule: nodeChanged
          ? "currentNodeId 变化表示进入新的工作阶段，创建新会话并清零 Biz Retry。"
          : "当前阶段状态变化为已完成、已归档或已跳过时，创建新会话推进并清零 Biz Retry。"
      },
      summary: nodeChanged ? "当前阶段已经变化，创建新会话继续" : "当前阶段已经结束，创建新会话继续"
    }
  }

  if (terminal?.outcome === "success" && run.bizRetryCount >= config.maxBizRetries) {
    return {
      policyResult: {
        type: "biz_retry",
        proposedAction: "fail_managed_run",
        reasonCode: "biz_retry_limit_exceeded",
        rule: "完成三次 Biz Retry 后当前阶段仍未结束时，结束托管运行。"
      },
      summary: "当前任务重试超过限制次数"
    }
  }

  const retry = resolveBizRetryMode({
    run,
    feature,
    contextUsage: terminal?.contextUsage,
    config
  })
  if (retry.retryMode === "new_thread" && !hasValidNextAction(feature)) {
    return missingNextActionDecision(feature) as ManagedRunPolicyEvaluation
  }
  return {
    policyResult: {
      type: "biz_retry",
      proposedAction:
        retry.retryMode === "reuse_thread" ? "continue_current_thread" : "start_new_thread",
      reasonCode: retry.reasonCode,
      rule: retry.rule
    },
    summary: retry.summary
  }
}
