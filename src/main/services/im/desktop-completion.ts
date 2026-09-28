import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"
import { imRemoteAccessService, type ImRemoteAccessService } from "./remote-access-service"
import { imProjectModeReplyPrefix, imThreadReplyPrefix } from "./reply-context"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"
import { resolveImProjectModeReplyContext } from "./project-reply-context"

export interface DesktopTurnCompletion {
  source: "desktop"
  threadId: string
  finalAssistantMessageId: string
  finalText: string
}

export type DesktopTurnCompletionResult =
  | { status: "enqueued"; deliveryId: string }
  | { status: "skipped"; reasonCode: string }
  | { status: "failed"; reasonCode: "DESKTOP_COMPLETION_OBSERVER_FAILED" }

type ReplyDrainer = Pick<ImReplyClient, "sendPending">

interface DesktopCompletionDependencies {
  conversations: ImConversationStateStore
  access: Pick<ImRemoteAccessService, "getThreadGrant" | "validateThreadForCompletionDelivery">
  events: Pick<ImEventStore, "enqueueProactiveReplies">
  getReplyDrainer: () => ReplyDrainer | null
  warn: (message: string, error?: unknown) => void
}

let configuredReplyDrainer: ReplyDrainer | null = null

export function registerImDesktopCompletionReplyDrainer(replyDrainer: ReplyDrainer): () => void {
  configuredReplyDrainer = replyDrainer
  return () => {
    if (configuredReplyDrainer === replyDrainer) configuredReplyDrainer = null
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

export class ImDesktopCompletionObserver {
  private readonly dependencies: DesktopCompletionDependencies

  constructor(dependencies: Partial<DesktopCompletionDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      access: dependencies.access ?? imRemoteAccessService,
      events: dependencies.events ?? imEventStore,
      getReplyDrainer: dependencies.getReplyDrainer ?? (() => configuredReplyDrainer),
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
  }

  /**
   * Best-effort side channel for a completed desktop turn. Every failure is
   * contained here so Gateway/outbox availability can never change the desktop
   * turn's successful outcome.
   */
  async observe(input: DesktopTurnCompletion): Promise<DesktopTurnCompletionResult> {
    try {
      return await this.observeUnsafe(input)
    } catch (error) {
      this.dependencies.warn("Failed to enqueue desktop completion for IM delivery.", error)
      return { status: "failed", reasonCode: "DESKTOP_COMPLETION_OBSERVER_FAILED" }
    }
  }

  private async observeUnsafe(input: DesktopTurnCompletion): Promise<DesktopTurnCompletionResult> {
    if (input.source !== "desktop") {
      return { status: "skipped", reasonCode: "SOURCE_NOT_DESKTOP" }
    }
    const threadId = required(input.threadId, "threadId")
    const finalAssistantMessageId = required(
      input.finalAssistantMessageId,
      "finalAssistantMessageId"
    )
    const finalText = input.finalText.trim()
    if (!finalText) return { status: "skipped", reasonCode: "FINAL_TEXT_EMPTY" }

    const grant = this.dependencies.access.getThreadGrant(threadId)
    if (!grant || grant.state !== "active") {
      return { status: "skipped", reasonCode: "THREAD_GRANT_INACTIVE" }
    }
    const conversation = this.dependencies.conversations.getConversation(grant.conversationKey)
    if (
      !conversation ||
      conversation.state !== "active" ||
      conversation.principalId !== grant.principalId
    ) {
      return { status: "skipped", reasonCode: "GRANT_ROUTE_STALE" }
    }

    let threadTitle = grant.titleSnapshot
    let threadMetadata: Record<string, unknown> = {}
    try {
      const validated = this.dependencies.access.validateThreadForCompletionDelivery(threadId)
      threadTitle = validated.thread.title?.trim() || threadTitle
      try {
        threadMetadata = validated.thread.metadata
          ? (JSON.parse(validated.thread.metadata) as Record<string, unknown>)
          : {}
      } catch {
        threadMetadata = {}
      }
    } catch {
      return { status: "skipped", reasonCode: "THREAD_STRUCTURE_INVALID" }
    }

    const projectContext = await resolveImProjectModeReplyContext({ metadata: threadMetadata })
    // 桌面发起的结果同样要标出它不是当前绑定的会话。IM 发起的走 remote-runner，模式
    // 通知走 notification-pump，那两条都算了这个标志，只有这条漏了——于是从桌面发起的
    // 任何结果推到招乎都不带提示。而这条路恰恰最需要它:读者根本没在招乎里发起过这一
    // 轮，也就没有任何理由知道它来自哪个会话，落在一串对话里就像是当前会话的回复。
    //
    // 比 threadId 而不是 targetId:桌面会话不一定在 im_targets 里登记过，它只要有一个
    // grant 就能把结果推过来，那种情况下根本没有 targetId 可比。三种 target 快照都带
    // threadId，比它对三种绑定是同一套逻辑。
    //
    // 用 getSelectedTarget 而不是 getActiveTarget:后者在目标不是 active 时会抛，把提示
    // 连同异常一起吞掉——绑定的授权一失效就不再标注，而那恰恰是最该标注的时候。
    // getSelectedTarget 不管状态都把行返回，绑定关系本身和它可不可用是两件事。
    //
    // 注意不能反过来把"取不到"当成"不是当前绑定":挂掉的那个目标完全可能就是本会话，
    // 那样会凭空多出一行假提示。要判的始终是身份，不是状态。
    let switched = false
    try {
      const bound = this.dependencies.conversations.getSelectedTarget(grant.conversationKey)
      switched = Boolean(bound && bound.snapshot.threadId !== threadId)
    } catch (error) {
      // 只兜数据库读失败。这行提示是附加信息，不该因为它把一条真实的结果拦在外面。
      this.dependencies.warn("Desktop completion could not read the bound target.", error)
    }
    const prefix = projectContext
      ? imProjectModeReplyPrefix({ ...projectContext, switched })
      : imThreadReplyPrefix(threadTitle, switched)

    const deliveryId = `desktop-turn:${threadId}:${finalAssistantMessageId}`
    await this.dependencies.events.enqueueProactiveReplies(
      buildImProactiveReplies({
        deliveryId,
        conversationKey: grant.conversationKey,
        text: finalText,
        prefix
      })
    )

    const drainer = this.dependencies.getReplyDrainer()
    if (drainer) {
      void drainer.sendPending().catch((error) => {
        this.dependencies.warn("Desktop completion remains queued after IM send failure.", error)
      })
    }
    return { status: "enqueued", deliveryId }
  }
}

export const imDesktopCompletionObserver = new ImDesktopCompletionObserver()
