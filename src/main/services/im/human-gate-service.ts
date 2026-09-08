import { randomBytes } from "node:crypto"
import { getThread } from "../../db"
import type { HarnessHumanGateSnapshot } from "../../../shared/harness-board-types"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

interface ImHumanGateCodeEntry {
  gateId: string
  projectId: string
  featureId: string
  principalId: string
  conversationKey: string
}

type ReplyDrainer = Pick<ImReplyClient, "sendPending">

export class ImHumanGateService {
  private readonly codes = new Map<string, ImHumanGateCodeEntry>()
  private replyDrainer: ReplyDrainer | null = null

  registerReplyDrainer(drainer: ReplyDrainer): () => void {
    this.replyDrainer = drainer
    return () => {
      if (this.replyDrainer === drainer) this.replyDrainer = null
    }
  }

  async publish(gate: HarnessHumanGateSnapshot): Promise<void> {
    const grant = imRemoteAccessService.getThreadGrant(gate.sourceThreadId)
    if (!grant || grant.state !== "active") return
    const conversation = imConversationStateStore.getConversation(grant.conversationKey)
    if (
      !conversation ||
      conversation.state !== "active" ||
      conversation.principalId !== grant.principalId
    ) {
      return
    }
    const code = this.uniqueCode()
    this.codes.set(code, {
      gateId: gate.gateId,
      projectId: gate.projectId,
      featureId: gate.featureId,
      principalId: grant.principalId,
      conversationKey: grant.conversationKey
    })
    const threadTitle = getThread(gate.sourceThreadId)?.title?.trim() || "关联会话"
    const featureGrant = imRemoteAccessService.getFeatureGrant(gate.projectId, gate.featureId)
    const projectName =
      featureGrant?.principalId === grant.principalId
        ? featureGrant.projectNameSnapshot
        : gate.projectId
    const featureName =
      featureGrant?.principalId === grant.principalId
        ? featureGrant.featureTitleSnapshot
        : gate.featureId
    const text = [
      `项目：[${projectName}]`,
      `特性：[${featureName}]`,
      `来源会话：[${threadTitle}]`,
      "",
      gate.message,
      "",
      `/门禁批准 ${code}   或   /门禁拒绝 ${code}`
    ].join("\n")
    try {
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `human-gate:${gate.gateId}`,
          conversationKey: grant.conversationKey,
          text
        })
      )
      this.drainReplies()
    } catch (error) {
      this.codes.delete(code)
      throw error
    }
  }

  async resolveCode(input: {
    code: string
    decision: "approve" | "reject"
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const code = input.code.trim().toUpperCase()
    if (!/^[A-F0-9]{6}$/u.test(code)) return "门禁短码无效，请核对后重试。"
    const entry = this.codes.get(code)
    if (!entry) return "门禁短码不存在、已失效或已使用。"
    if (
      entry.principalId !== input.principalId ||
      entry.conversationKey !== input.conversationKey
    ) {
      return "该门禁短码不属于当前招乎会话。"
    }
    const humanGate = await import("../../harness-board/human-gate-service")
    const applied =
      input.decision === "approve"
        ? await humanGate.approveHumanGate(
            {
              projectId: entry.projectId,
              featureId: entry.featureId,
              gateId: entry.gateId
            },
            "im"
          )
        : await humanGate.rejectHumanGate(
            {
              projectId: entry.projectId,
              featureId: entry.featureId,
              gateId: entry.gateId
            },
            "human_gate_rejected",
            "im"
          )
    if (!applied) {
      this.codes.delete(code)
      return "该门禁已在桌面处理或不再有效。"
    }
    this.removeGate(entry.gateId)
    return input.decision === "approve" ? "Human Gate 已批准。" : "Human Gate 已拒绝。"
  }

  removeGate(gateId: string): void {
    for (const [code, entry] of this.codes) {
      if (entry.gateId === gateId) this.codes.delete(code)
    }
  }

  clear(): void {
    this.codes.clear()
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = randomBytes(3).toString("hex").toUpperCase()
      if (!this.codes.has(code)) return code
    }
    throw new Error("unable to allocate a unique Human Gate code")
  }

  private drainReplies(): void {
    void this.replyDrainer?.sendPending().catch((error) => {
      console.warn("[IM] Human Gate notification remains queued.", error)
    })
  }
}

export const imHumanGateService = new ImHumanGateService()
