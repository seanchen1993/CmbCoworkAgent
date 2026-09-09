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
import {
  buildAnsweredCard,
  buildQuestionCard,
  QUESTION_OTHER_SUFFIX,
  type QuestionCardQuestion
} from "./card-builder"
import { imCardPublisher, type ImCardPublisher } from "./card-publisher"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"
import {
  imRemoteInteractionRouteRegistry,
  type ImRemoteInteractionRouteRegistry
} from "./remote-interaction-route"
import { imRemoteAccessService, type ImRemoteAccessService } from "./remote-access-service"
import { imRemoteGrantStore, type ImRemoteGrantStore } from "./remote-grant-store"
import {
  imFeatureReplyPrefix,
  imInboxReplyPrefix,
  imTargetReplyPrefix,
  imThreadReplyPrefix
} from "./reply-context"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

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
  events: Pick<ImEventStore, "enqueueProactiveReplies" | "getEvent" | "markOutboxFailed">
  interactionRoutes: Pick<ImRemoteInteractionRouteRegistry, "get">
  cards: ImCardPublisher
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
    `短码在本轮等待期间一直有效；普通文本不会被当作回答。`
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
      interactionRoutes: dependencies.interactionRoutes ?? imRemoteInteractionRouteRegistry,
      cards: dependencies.cards ?? imCardPublisher,
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
    this.pruneResolvedSessions()

    const parsed = input.argument.trim().match(/^([A-Fa-f0-9]{6})\s+([\s\S]+)$/u)
    if (!parsed) return "用法：/回答 <6位输入短码> <编号>，或 /回答 <短码> 其他 <内容>。"
    const code = parsed[1].toUpperCase()
    const session = this.codes.get(code)
    if (!session) return "输入短码不存在、已使用，或该问题已不在等待中。"
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

    return this.finalizeSession(session)
  }

  /**
   * Submits a fully answered session. Shared by the short-code path and the
   * card form so a card can never reach the runtime through weaker checks than
   * a typed answer.
   */
  private finalizeSession(session: RemoteUserInputSession): string {
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
    this.resolveCardFor(session, "已回答")

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

  private resolveCardFor(session: RemoteUserInputSession, outcome: string): void {
    const interaction = this.dependencies.cards.interactions.findByRequestRef(
      session.request.requestId
    )
    if (!interaction) return
    this.dependencies.cards.resolveDetached(
      interaction.interactionId,
      buildAnsweredCard({
        targetLabel: interaction.targetLabel,
        outcome,
        answers: session.request.questions.flatMap((question) => {
          const answer = session.answers[question.id]
          if (!answer) return []
          return [
            {
              header: question.header,
              answer: answer.type === "option" ? answer.label : answer.text
            }
          ]
        })
      })
    )
  }

  /**
   * Applies a whole card form at once.
   *
   * Questions already answered by short code are ignored rather than
   * overwritten: the form was rendered before those answers landed, so its
   * values for them are stale by construction, and the recorded answer is the
   * one the reader actually gave.
   */
  async resolveCardAnswers(input: {
    requestId: string
    principalId: string
    conversationKey: string
    feedback: ReadonlyArray<{ key: string; value: string }>
  }): Promise<string> {
    const session = this.sessions.get(input.requestId)
    if (!session) return "这项补充输入不存在、已提交，或已不在等待中。"
    if (
      session.route.principalId !== input.principalId ||
      session.route.conversationKey !== input.conversationKey
    ) {
      return "该表单不属于当前招乎会话。"
    }
    const pending = this.dependencies.getPendingForThread(session.route.threadId)
    if (!pending || pending.requestId !== session.request.requestId) {
      this.removeSession(session.request.requestId)
      return "这项补充输入已在桌面处理或不再有效。"
    }

    const submitted = new Map(input.feedback.map((entry) => [entry.key, entry.value]))
    const staged: Record<string, UserInputAnswer> = {}
    const missing: string[] = []
    for (const [index, question] of session.request.questions.entries()) {
      if (index < session.questionIndex) continue
      const key = ImRemoteUserInputService.questionKey(index)
      const custom = submitted.get(`${key}${QUESTION_OTHER_SUFFIX}`)?.trim() ?? ""
      const selected = submitted.get(key)?.trim() ?? ""
      // Free text wins: someone who filled it in meant none of the options.
      const raw = custom ? `其他 ${custom}` : selected ? String(Number(selected) + 1) : ""
      if (!raw) {
        missing.push(`${index + 1}. ${question.header}`)
        continue
      }
      const resolved = answerFor(question, raw)
      if ("message" in resolved) {
        return `第 ${index + 1} 题（${question.header}）：${resolved.message}`
      }
      staged[question.id] = resolved.answer
    }
    if (missing.length > 0) {
      return ["还有问题没有作答：", ...missing].join("\n")
    }

    // Consume the live code before submitting, so a short-code answer racing
    // this form cannot record a second answer for the same question.
    if (this.codes.get(session.code) === session) this.codes.delete(session.code)
    Object.assign(session.answers, staged)
    session.questionIndex = session.request.questions.length
    return this.finalizeSession(session)
  }

  private async handlePending(request: Readonly<UserInputRequest>): Promise<void> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled || request.questions.length === 0) return
    const route = this.resolveRoute(request.threadId)
    if (!route) {
      this.dependencies.warn(
        "Remote user-input request has no authorized IM execution route.",
        new Error(`threadId=${request.threadId}, requestId=${request.requestId}`)
      )
      return
    }
    if (this.sessions.has(request.requestId)) return
    const session: RemoteUserInputSession = {
      request,
      route,
      code: this.uniqueCode(),
      questionIndex: 0,
      answers: {}
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
      await this.publishCard(session)
    } catch (error) {
      this.removeSession(request.requestId)
      throw error
    }
  }

  /** feedbackKey must be unique within one card; the index supplies that. */
  private static questionKey(index: number): string {
    return `q${index}`
  }

  private cardQuestions(session: RemoteUserInputSession): QuestionCardQuestion[] {
    return session.request.questions.map((question, index) => {
      const recorded = session.answers[question.id]
      return {
        key: ImRemoteUserInputService.questionKey(index),
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description
        })),
        answered: index < session.questionIndex,
        answeredLabel:
          recorded?.type === "option"
            ? recorded.label
            : recorded?.type === "other"
              ? recorded.text
              : undefined
      }
    })
  }

  private async publishCard(session: RemoteUserInputSession): Promise<void> {
    await this.dependencies.cards.publish({
      kind: "user_input",
      threadId: session.route.threadId,
      principalId: session.route.principalId,
      conversationKey: session.route.conversationKey,
      // Addressed by request rather than by code: the short code rotates as the
      // reader answers question by question, so it cannot identify the card.
      requestRef: session.request.requestId,
      targetLabel: session.route.prefix.replace(/[\u3010\u3011]/gu, "").trim(),
      build: (tag) =>
        buildQuestionCard({
          targetLabel: session.route.prefix.replace(/[\u3010\u3011]/gu, "").trim(),
          questions: this.cardQuestions(session),
          tag,
          fallbackCommand: `/回答 ${session.code} <编号>`
        })
    })
  }

  private resolveRoute(threadId: string): RemoteUserInputRoute | null {
    const thread = this.dependencies.getThread(threadId)
    if (!thread) return null
    const parsed = parseStandardThreadMetadata(thread.metadata)
    if (!parsed.workspacePath || !canonicalDirectory(parsed.workspacePath)) return null
    const registered = this.dependencies.interactionRoutes.get(threadId)
    if (registered) {
      const event = this.dependencies.events.getEvent(registered.eventId)
      const conversation = this.dependencies.conversations.getConversation(
        registered.conversationKey
      )
      const target = this.dependencies.conversations
        .listTargets(registered.conversationKey)
        .find(
          (candidate) =>
            candidate.state === "active" &&
            candidate.snapshot.targetId === registered.targetSnapshot.targetId &&
            candidate.snapshot.threadId === threadId
        )
      if (
        event &&
        (event.state === "executing" || event.state === "waiting_desktop") &&
        event.principalId === registered.principalId &&
        event.conversationKey === registered.conversationKey &&
        event.targetSnapshot?.targetId === registered.targetSnapshot.targetId &&
        conversation?.state === "active" &&
        conversation.principalId === registered.principalId &&
        target &&
        this.registeredTargetGrantIsActive(
          registered.targetSnapshot,
          registered.principalId,
          registered.conversationKey
        )
      ) {
        return {
          principalId: registered.principalId,
          conversationKey: registered.conversationKey,
          threadId,
          prefix: imTargetReplyPrefix(registered.targetSnapshot, {
            threadTitle: thread.title
          })
        }
      }
    }

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

  private registeredTargetGrantIsActive(
    target: ImTargetSnapshot,
    principalId: string,
    conversationKey: string
  ): boolean {
    if (target.kind === "inbox") return true
    if (target.kind === "thread") {
      const grant = this.dependencies.access.getThreadGrant(target.threadId)
      return Boolean(
        grant &&
        grant.state === "active" &&
        grant.grantId === target.grantId &&
        grant.grantVersion === target.grantVersion &&
        grant.principalId === principalId &&
        grant.conversationKey === conversationKey
      )
    }
    if (!target.grantId || !target.grantVersion) return false
    const grant = this.dependencies.grants.getFeatureGrantById(target.grantId)
    return Boolean(
      grant &&
      grant.state === "active" &&
      grant.grantVersion === target.grantVersion &&
      grant.principalId === principalId
    )
  }

  private uniqueCode(excludedCode?: string): string {
    this.pruneResolvedSessions()
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = this.dependencies.createCode().trim().toUpperCase()
      if (/^[A-F0-9]{6}$/u.test(code) && code !== excludedCode && !this.codes.has(code)) {
        return code
      }
    }
    throw new Error("unable to allocate a unique remote user-input code")
  }

  /**
   * Drops sessions whose question is no longer pending, so no code outlives
   * the request it answers.
   *
   * There is deliberately no clock here. The run waiting on this question is
   * not cancelled by elapsed time either (see remote-runner onWaitStart), so a
   * code that expired on its own would leave that run waiting with no way to
   * answer it — the one outcome worse than waiting.
   */
  private pruneResolvedSessions(): void {
    for (const [requestId, session] of this.sessions) {
      const pending = this.dependencies.getPendingForThread(session.route.threadId)
      if (!pending || pending.requestId !== session.request.requestId) {
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
