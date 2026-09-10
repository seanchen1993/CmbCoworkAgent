import { randomBytes, randomUUID } from "node:crypto"
import { getThreadMessages } from "../../db"
import type { AgentRunDelivery } from "../../agent/agent-run-service"
import type {
  ManagedRunEvent,
  ManagedRunPolicyResult,
  ManagedRunSessionAction,
  ManagedRunSnapshot
} from "../../../shared/harness-board-types"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

export type ManagedBizRetryChoice = "stop" | "continue" | "new_thread"

export interface PendingManagedBizRetry {
  decisionId: string
  projectId: string
  featureId: string
  runId: string
  originThreadId: string
  policyResult: Extract<ManagedRunPolicyResult, { type: "biz_retry" }>
  route: { principalId: string; conversationKey: string }
  state: "pending" | "handling"
  createdAt: number
}

interface ManagedBizRetryRequest {
  run: ManagedRunSnapshot
  sourceEvent: Pick<ManagedRunEvent, "eventId" | "type">
  policyResult: PendingManagedBizRetry["policyResult"]
  summary: string
  delivery: AgentRunDelivery
  stageName: string
  nodeStatus: string
  contextUsageRatio?: number
  nextAction?: ManagedRunSessionAction
}

interface InternalPending extends PendingManagedBizRetry {
  sourceEvent: ManagedBizRetryRequest["sourceEvent"]
  summary: string
  delivery: AgentRunDelivery
}

type ReplyDrainer = Pick<ImReplyClient, "sendPending">

export class ImManagedBizRetryService {
  private readonly pendingByRun = new Map<string, InternalPending>()
  private readonly codes = new Map<string, string>()
  private replyDrainer: ReplyDrainer | null = null

  registerReplyDrainer(drainer: ReplyDrainer): () => void {
    this.replyDrainer = drainer
    return () => {
      if (this.replyDrainer === drainer) this.replyDrainer = null
    }
  }

  async request(input: ManagedBizRetryRequest): Promise<boolean> {
    const originThreadId = input.run.currentSession?.threadId
    if (!originThreadId) return false
    const grant = imRemoteAccessService.getThreadGrant(originThreadId)
    if (!grant || grant.state !== "active") return false
    const conversation = imConversationStateStore.getConversation(grant.conversationKey)
    if (
      !conversation ||
      conversation.state !== "active" ||
      conversation.principalId !== grant.principalId
    ) {
      return false
    }

    this.removeRun(input.run.runId)
    const decisionId = randomUUID()
    const code = this.uniqueCode()
    const pending: InternalPending = {
      decisionId,
      projectId: input.run.projectId,
      featureId: input.run.featureId,
      runId: input.run.runId,
      originThreadId,
      policyResult: input.policyResult,
      route: {
        principalId: grant.principalId,
        conversationKey: grant.conversationKey
      },
      state: "pending",
      createdAt: Date.now(),
      sourceEvent: input.sourceEvent,
      summary: input.summary,
      delivery: input.delivery
    }
    this.pendingByRun.set(input.run.runId, pending)
    this.codes.set(code, input.run.runId)

    const featureGrant = imRemoteAccessService.getFeatureGrant(
      input.run.projectId,
      input.run.featureId
    )
    const projectName =
      featureGrant?.principalId === grant.principalId
        ? featureGrant.projectNameSnapshot
        : input.run.projectId
    const featureName =
      featureGrant?.principalId === grant.principalId
        ? featureGrant.featureTitleSnapshot
        : input.run.featureId
    const assistantTail = this.lastAssistantTail(originThreadId)
    const nextActionText = input.nextAction
      ? `若选择 /托管开启新会话，将调用 /${input.nextAction.slashSkill} 技能并输入 ${input.nextAction.userMessage}`
      : "当前没有可用的新会话动作；回复时会重新检查最新状态。"
    const contextText =
      input.contextUsageRatio === undefined
        ? "未知"
        : `${Math.round(input.contextUsageRatio * 100)}%`
    const text = [
      `托管模式运行项目：[${projectName}]-特性:[${featureName}]需要人工决策：`,
      `触发人工决策原因：${input.summary}`,
      `当前阶段：${input.stageName}`,
      `节点状态：${input.nodeStatus}`,
      `上下文占用：${contextText}`,
      "",
      "最近一条大模型返回消息：",
      assistantTail || "（无可展示内容）",
      "",
      nextActionText,
      "",
      `/托管停止 ${code}`,
      `/托管继续当前会话 ${code} <输入消息，不填默认继续当前任务>`,
      `/托管开启新会话 ${code}`
    ].join("\n")
    try {
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `managed-biz-retry:${decisionId}`,
          conversationKey: grant.conversationKey,
          text
        })
      )
      this.drainReplies()
      return true
    } catch (error) {
      this.removeRun(input.run.runId)
      throw error
    }
  }

  async resolveCode(input: {
    code: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const code = input.code.trim().toUpperCase()
    if (!/^[A-F0-9]{6}$/u.test(code)) return "托管短码无效，请核对后重试。"
    const runId = this.codes.get(code)
    const pending = runId ? this.pendingByRun.get(runId) : undefined
    if (!pending || pending.state !== "pending") return "托管短码不存在、已失效或已使用。"
    if (
      pending.route.principalId !== input.principalId ||
      pending.route.conversationKey !== input.conversationKey
    ) {
      return "该托管短码不属于当前招乎会话。"
    }
    pending.state = "handling"
    try {
      const controller = await import("../../harness-board/auto-mode-controller")
      const result = await controller.resolveManagedBizRetryDecision({
        ...pending,
        choice: input.choice,
        message: input.message
      })
      if (!result.applied) {
        pending.state = "pending"
        return result.message
      }
      this.removeRun(pending.runId)
      return result.message
    } catch (error) {
      pending.state = "pending"
      console.warn("[IM] Managed Biz Retry action failed:", error)
      return "托管操作未完成，短码仍有效，可重试或选择停止。"
    }
  }

  getPending(runId: string): PendingManagedBizRetry | null {
    return this.pendingByRun.get(runId) ?? null
  }

  removeRun(runId: string): void {
    this.pendingByRun.delete(runId)
    for (const [code, candidateRunId] of this.codes) {
      if (candidateRunId === runId) this.codes.delete(code)
    }
  }

  clear(): void {
    this.pendingByRun.clear()
    this.codes.clear()
  }

  private lastAssistantTail(threadId: string): string {
    const message = [...getThreadMessages(threadId)]
      .reverse()
      .find((item) => item.role === "assistant")
    if (!message) return ""
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
    const combined = [message.reasoning, text].filter(Boolean).join("\n\n")
    const characters = Array.from(combined)
    return characters.length > 4_000
      ? `[已截断，仅保留末尾 4,000 字符]\n${characters.slice(-4_000).join("")}`
      : combined
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = randomBytes(3).toString("hex").toUpperCase()
      if (!this.codes.has(code)) return code
    }
    throw new Error("unable to allocate a unique Managed Biz Retry code")
  }

  private drainReplies(): void {
    void this.replyDrainer?.sendPending().catch((error) => {
      console.warn("[IM] Managed Biz Retry notification remains queued.", error)
    })
  }
}

export const imManagedBizRetryService = new ImManagedBizRetryService()
