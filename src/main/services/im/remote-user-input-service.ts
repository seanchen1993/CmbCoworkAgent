import { randomBytes } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getThread } from "../../db"
import { getBuiltinRobotSettings } from "../../storage"
import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse
} from "../../types"
import {
  getPendingUserInputForThread,
  submitUserInputResponse,
  subscribePendingUserInput,
  subscribeRemovedUserInput
} from "../user-input"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"
import { imRemoteAccessService, type ImRemoteAccessService } from "./remote-access-service"
import { imRemoteGrantStore, type ImRemoteGrantStore } from "./remote-grant-store"
import { imFeatureReplyPrefix, imInboxReplyPrefix, imThreadReplyPrefix } from "./reply-context"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

const DEFAULT_REMOTE_USER_INPUT_TTL_MINUTES = 10
const REMOTE_USER_INPUT_MAX_CUSTOM_CHARACTERS = 4_000

interface RemoteUserInputRoute {
  principalId: string
  conversationKey: string
  threadId: string
  prefix: string
}

interface RemoteUserInputSession {
  request: Readonly<UserInputRequest>
  route: RemoteUserInputRoute
  code: string
  questionIndex: number
  answers: Record<string, UserInputAnswer>
  expiresAt: number
  ttlMinutes: number
}

export interface ImRemoteUserInputAnswerNotice {
  requestId: string
  threadId: string
  message: string
}

type ReplyDrainer = Pick<ImReplyClient, "sendPending">
type AnswerListener = (notice: ImRemoteUserInputAnswerNotice) => void

interface RemoteUserInputDependencies {
  conversations: ImConversationStateStore
  access: Pick<ImRemoteAccessService, "getThreadGrant">
  grants: ImRemoteGrantStore
  events: Pick<ImEventStore, "enqueueProactiveReplies" | "markOutboxFailed">
  getThread: typeof getThread
  getSettings: typeof getBuiltinRobotSettings
  getPendingForThread: typeof getPendingUserInputForThread
  submitResponse: typeof submitUserInputResponse
  subscribePending: typeof subscribePendingUserInput
  subscribeRemoved: typeof subscribeRemovedUserInput
  now: () => number
  createCode: () => string
  warn: (message: string, error?: unknown) => void
}

export function remoteUserInputDesktopNotice(): string {
  return "已从招乎回答 Agent 的补充问题。"
}

function canonicalDirectory(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return null
    return realpathSync(path)
  } catch {
    return null
  }
}

function ttlMinutesFromSettings(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 60
    ? value
    : DEFAULT_REMOTE_USER_INPUT_TTL_MINUTES
}

function renderQuestion(session: RemoteUserInputSession): string {
  const question = session.request.questions[session.questionIndex]
  if (!question) throw new Error("remote user-input question index is invalid")
  const progress =
    session.request.questions.length > 1
      ? `（${session.questionIndex + 1}/${session.request.questions.length}）`
      : ""
  return [
    `${session.route.prefix}需要你确认${progress}`,
    `【${question.header}】${question.question}`,
    "",
    ...question.options.map(
      (option, index) => `${index + 1}. ${option.label} — ${option.description}`
    ),
    "",
    `回复 /回答 ${session.code} <编号>`,
    `如以上选项都不合适：/回答 ${session.code} 其他 <你的回答>`,
    `短码 ${session.ttlMinutes} 分钟内有效；普通文本不会被当作回答。`
  ].join("\n")
}

function answerFor(
  question: UserInputQuestion,
  rawAnswer: string
): { answer: UserInputAnswer } | { message: string } {
  const normalized = rawAnswer.trim()
  const optionMatch = normalized.match(/^(\d+)$/u)
  if (optionMatch) {
    const optionIndex = Number(optionMatch[1]) - 1
    const option = question.options[optionIndex]
    if (!option) {
      return { message: `选项编号无效，请输入 1-${question.options.length}。` }
    }
    return {
      answer: {
        type: "option",
        questionId: question.id,
        optionIndex,
        label: option.label,
        description: option.description
      }
    }
  }

  const customMatch = normalized.match(/^(?:其他|其它)\s+([\s\S]+)$/u)
  const customText = customMatch?.[1]?.trim() ?? ""
  if (!customText) {
    return {
      message: `请回复选项编号，或使用“/回答 <短码> 其他 <你的回答>”。`
    }
  }
  if (Array.from(customText).length > REMOTE_USER_INPUT_MAX_CUSTOM_CHARACTERS) {
    return {
      message: `自定义回答不能超过 ${REMOTE_USER_INPUT_MAX_CUSTOM_CHARACTERS} 个字符。`
    }
  }
  return {
    answer: {
      type: "other",
      questionId: question.id,
      text: customText
    }
  }
}

export class ImRemoteUserInputService {
  private readonly dependencies: RemoteUserInputDependencies
  private readonly codes = new Map<string, RemoteUserInputSession>()
  private readonly sessions = new Map<string, RemoteUserInputSession>()
  private readonly answerListeners = new Set<AnswerListener>()
  private replyDrainer: ReplyDrainer | null = null
  private readonly unsubscribePending: () => void
  private readonly unsubscribeRemoved: () => void

  constructor(dependencies: Partial<RemoteUserInputDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      access: dependencies.access ?? imRemoteAccessService,
      grants: dependencies.grants ?? imRemoteGrantStore,
      events: dependencies.events ?? imEventStore,
      getThread: dependencies.getThread ?? getThread,
      getSettings: dependencies.getSettings ?? getBuiltinRobotSettings,
      getPendingForThread: dependencies.getPendingForThread ?? getPendingUserInputForThread,
      submitResponse: dependencies.submitResponse ?? submitUserInputResponse,
      subscribePending: dependencies.subscribePending ?? subscribePendingUserInput,
      subscribeRemoved: dependencies.subscribeRemoved ?? subscribeRemovedUserInput,
      now: dependencies.now ?? Date.now,
      createCode: dependencies.createCode ?? (() => randomBytes(3).toString("hex").toUpperCase()),
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
    this.unsubscribePending = this.dependencies.subscribePending((request) => {
      void this.handlePending(request).catch((error) => {
        this.dependencies.warn("Failed to publish remote user-input request.", error)
      })
    })
    this.unsubscribeRemoved = this.dependencies.subscribeRemoved((requestId) => {
      this.removeSession(requestId)
    })
  }

  registerReplyDrainer(replyDrainer: ReplyDrainer): () => void {
    this.replyDrainer = replyDrainer
    return () => {
      if (this.replyDrainer === replyDrainer) this.replyDrainer = null
    }
  }

  subscribeAnswer(listener: AnswerListener): () => void {
    this.answerListeners.add(listener)
    return () => this.answerListeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribePending()
    this.unsubscribeRemoved()
    this.codes.clear()
    this.sessions.clear()
    this.answerListeners.clear()
    this.replyDrainer = null
  }

  async resolveAnswer(input: {
    argument: string
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled) return "本设备的内置机器人已断开。"
    this.pruneExpiredSessions()

    const parsed = input.argument.trim().match(/^([A-Fa-f0-9]{6})\s+([\s\S]+)$/u)
    if (!parsed) return "用法：/回答 <6位输入短码> <编号>，或 /回答 <短码> 其他 <内容>。"
    const code = parsed[1].toUpperCase()
    const session = this.codes.get(code)
    if (!session) return "输入短码不存在、已过期或已使用。"
    if (
      session.route.principalId !== input.principalId ||
      session.route.conversationKey !== input.conversationKey
    ) {
      return "该输入短码不属于当前招乎会话。"
    }

    const pending = this.dependencies.getPendingForThread(session.route.threadId)
    if (!pending || pending.requestId !== session.request.requestId) {
      this.removeSession(session.request.requestId)
      return "这项补充输入已在桌面处理或不再有效。"
    }
    const question = session.request.questions[session.questionIndex]
    if (!question) {
      this.removeSession(session.request.requestId)
      return "这项补充输入状态异常，请回到桌面处理。"
    }
    const resolved = answerFor(question, parsed[2])
    if ("message" in resolved) return resolved.message

    // Each displayed code answers exactly one question. Consume it before
    // advancing so a gateway redelivery cannot record the same answer twice.
    this.codes.delete(code)
    session.answers[question.id] = resolved.answer
    session.questionIndex += 1

    if (session.questionIndex < session.request.questions.length) {
      session.code = this.uniqueCode(code)
      this.codes.set(session.code, session)
      return [`已记录第 ${session.questionIndex} 题。`, "", renderQuestion(session)].join("\n")
    }

    const response: UserInputResponse = {
      requestId: session.request.requestId,
      answers: { ...session.answers },
      submittedAt: new Date(this.dependencies.now()).toISOString()
    }
    const submitted = this.dependencies.submitResponse(response, {
      notifyRenderer: true,
      reason: "已从招乎完成补充输入。"
    })
    if (!submitted) {
      this.removeSession(session.request.requestId)
      return "这项补充输入已在桌面处理或不再有效。"
    }

    const notice: ImRemoteUserInputAnswerNotice = {
      requestId: session.request.requestId,
      threadId: session.route.threadId,
      message: remoteUserInputDesktopNotice()
    }
    for (const listener of this.answerListeners) {
      try {
        listener(notice)
      } catch (error) {
        this.dependencies.warn("Remote user-input answer listener failed.", error)
      }
    }
    return "已从招乎提交回答，任务将继续执行。"
  }

  private async handlePending(request: Readonly<UserInputRequest>): Promise<void> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled || request.questions.length === 0) return
    const route = this.resolveRoute(request.threadId)
    if (!route) return
    if (this.sessions.has(request.requestId)) return
    const ttlMinutes = ttlMinutesFromSettings(settings.waitingDesktopTtlMinutes)
    const session: RemoteUserInputSession = {
      request,
      route,
      code: this.uniqueCode(),
      questionIndex: 0,
      answers: {},
      expiresAt: this.dependencies.now() + ttlMinutes * 60_000,
      ttlMinutes
    }
    this.sessions.set(request.requestId, session)
    this.codes.set(session.code, session)

    try {
      const outbox = await this.dependencies.events.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `user-input-request:${request.requestId}:0`,
          conversationKey: route.conversationKey,
          text: renderQuestion(session)
        })
      )
      const pending = this.dependencies.getPendingForThread(request.threadId)
      if (!pending || pending.requestId !== request.requestId) {
        this.removeSession(request.requestId)
        await Promise.all(
          outbox.map((record) =>
            this.dependencies.events.markOutboxFailed(
              record.outboxId,
              "USER_INPUT_ALREADY_RESOLVED"
            )
          )
        )
        return
      }
      this.drainReplies()
    } catch (error) {
      this.removeSession(request.requestId)
      throw error
    }
  }

  private resolveRoute(threadId: string): RemoteUserInputRoute | null {
    const thread = this.dependencies.getThread(threadId)
    if (!thread) return null
    const parsed = parseStandardThreadMetadata(thread.metadata)
    if (!parsed.workspacePath || !canonicalDirectory(parsed.workspacePath)) return null
    if (parsed.agentMode !== "normal") return null

    const threadGrant = this.dependencies.access.getThreadGrant(threadId)
    if (threadGrant?.state === "active") {
      const conversation = this.dependencies.conversations.getConversation(
        threadGrant.conversationKey
      )
      if (
        conversation?.state === "active" &&
        conversation.principalId === threadGrant.principalId
      ) {
        return {
          principalId: threadGrant.principalId,
          conversationKey: threadGrant.conversationKey,
          threadId,
          prefix: imThreadReplyPrefix(thread.title?.trim() || threadGrant.titleSnapshot)
        }
      }
    }

    for (const conversation of this.dependencies.conversations.listConversations()) {
      if (conversation.state !== "active") continue
      const target = this.dependencies.conversations
        .listTargets(conversation.conversationKey)
        .find(
          (candidate) => candidate.state === "active" && candidate.snapshot.threadId === threadId
        )
      if (!target) continue
      if (target.snapshot.kind === "feature") {
        if (!target.snapshot.grantId || !target.snapshot.grantVersion) continue
        const grant = this.dependencies.grants.getFeatureGrantById(target.snapshot.grantId)
        if (
          !grant ||
          grant.state !== "active" ||
          grant.grantVersion !== target.snapshot.grantVersion ||
          grant.principalId !== conversation.principalId
        ) {
          continue
        }
        return {
          principalId: conversation.principalId,
          conversationKey: conversation.conversationKey,
          threadId,
          prefix: imFeatureReplyPrefix({
            projectName: grant.projectNameSnapshot,
            projectId: grant.projectId,
            featureTitle: grant.featureTitleSnapshot,
            featureSlug: grant.featureSlug,
            threadTitle: thread.title
          })
        }
      }
      if (target.snapshot.kind === "inbox") {
        return {
          principalId: conversation.principalId,
          conversationKey: conversation.conversationKey,
          threadId,
          prefix: imInboxReplyPrefix()
        }
      }
    }
    return null
  }

  private uniqueCode(excludedCode?: string): string {
    this.pruneExpiredSessions()
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = this.dependencies.createCode().trim().toUpperCase()
      if (/^[A-F0-9]{6}$/u.test(code) && code !== excludedCode && !this.codes.has(code)) {
        return code
      }
    }
    throw new Error("unable to allocate a unique remote user-input code")
  }

  private pruneExpiredSessions(): void {
    const now = this.dependencies.now()
    for (const [requestId, session] of this.sessions) {
      const pending = this.dependencies.getPendingForThread(session.route.threadId)
      if (session.expiresAt <= now || !pending || pending.requestId !== session.request.requestId) {
        this.removeSession(requestId)
      }
    }
  }

  private removeSession(requestId: string): void {
    const session = this.sessions.get(requestId)
    if (!session) return
    this.sessions.delete(requestId)
    if (this.codes.get(session.code) === session) this.codes.delete(session.code)
  }

  private drainReplies(): void {
    const drainer = this.replyDrainer
    if (!drainer) return
    void drainer.sendPending().catch((error) => {
      this.dependencies.warn("Remote user-input notification remains queued.", error)
    })
  }
}

export const imRemoteUserInputService = new ImRemoteUserInputService()
