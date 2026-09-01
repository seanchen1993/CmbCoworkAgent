import { randomBytes } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  approvalDecisionBroker,
  type ApprovalBrokerRegistration,
  type ApprovalDecisionBroker
} from "../../agent/approval-decision-broker"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getThread } from "../../db"
import { getBuiltinRobotSettings } from "../../storage"
import type { ApprovalRequest } from "../../types"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"
import { imRemoteAccessService, type ImRemoteAccessService } from "./remote-access-service"
import {
  imRemoteApprovalAuditStore,
  type ImRemoteApprovalAuditRecord,
  type ImRemoteApprovalAuditStore
} from "./remote-approval-audit-store"
import { imRemoteGrantStore, type ImRemoteGrantStore } from "./remote-grant-store"
import { imFeatureReplyPrefix, imInboxReplyPrefix, imThreadReplyPrefix } from "./reply-context"
import { buildImProactiveReplies, IM_REPLY_TRUNCATION_NOTICE } from "./reply-segmentation"
import type { ImReplyClient } from "./reply-client"

const REMOTE_APPROVAL_CODE_TTL_MS = 10 * 60_000
interface RemoteApprovalRoute {
  principalId: string
  conversationKey: string
  threadId: string
  workspacePath: string
  prefix: string
}

interface RemoteApprovalCode {
  code: string
  requestId: string
  toolCallId: string
  operation: string
  summary: string
  allowedDecisions: ReadonlyArray<"approve" | "reject">
  route: RemoteApprovalRoute
  expiresAt: number
}

interface ApprovalPresentation {
  approvable: boolean
  operation: string
  summary: string
  detail: string
  allowedDecisions: ReadonlyArray<"approve" | "reject">
}

type ReplyDrainer = Pick<ImReplyClient, "sendPending">
type AuditListener = (record: ImRemoteApprovalAuditRecord) => void

interface RemoteApprovalDependencies {
  broker: ApprovalDecisionBroker
  conversations: ImConversationStateStore
  access: Pick<ImRemoteAccessService, "getThreadGrant">
  grants: ImRemoteGrantStore
  events: Pick<ImEventStore, "enqueueProactiveReplies" | "markOutboxFailed">
  audits: ImRemoteApprovalAuditStore
  getThread: typeof getThread
  getSettings: typeof getBuiltinRobotSettings
  now: () => number
  createCode: () => string
  warn: (message: string, error?: unknown) => void
}

export function remoteApprovalDesktopNotice(record: ImRemoteApprovalAuditRecord): string {
  const action = record.decision === "approve" ? "一次性批准" : "拒绝"
  return `已从招乎远程${action}工具调用：${record.summary}`
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function canonicalDirectory(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return null
    return realpathSync(path)
  } catch {
    return null
  }
}

function canonicalPotentialPath(path: string): string | null {
  let ancestor = resolve(path)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return null
    ancestor = parent
  }
  try {
    const canonicalAncestor = realpathSync(ancestor)
    return resolve(canonicalAncestor, relative(ancestor, resolve(path)))
  } catch {
    return null
  }
}

function safeRelativePath(workspacePath: string, request: ApprovalRequest): string | null {
  const filePath = request.filePath?.trim()
  if (!filePath) return null
  const base = request.cwd?.trim() || workspacePath
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const canonicalWorkspace = canonicalDirectory(workspacePath)
  const canonicalCandidate = canonicalPotentialPath(candidate)
  if (
    !canonicalWorkspace ||
    !canonicalCandidate ||
    !isWithin(canonicalWorkspace, canonicalCandidate)
  ) {
    return null
  }
  const display = relative(canonicalWorkspace, canonicalCandidate)
  return display && !display.startsWith("..") && !isAbsolute(display) ? display : null
}

/**
 * Resolve the absolute side-effect path used when the target lies outside the
 * authorized workspace. The approver must still see exactly which file is
 * being written, so the IM message falls back to the resolved path (with a
 * workspace-outside marker) instead of hiding it behind a desktop-only notice.
 */
function resolvedFilePath(workspacePath: string, request: ApprovalRequest): string | null {
  const filePath = request.filePath?.trim()
  if (!filePath) return null
  const base = request.cwd?.trim() || workspacePath
  return isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
}

function approvalOperation(request: ApprovalRequest): string {
  if (request.operation) return request.operation
  if (request.command?.trim()) return "execute"
  const toolName = request.tool_call?.name?.trim()
  return toolName || "unknown"
}

function presentationFor(request: ApprovalRequest, workspacePath: string): ApprovalPresentation {
  const operation = approvalOperation(request)
  const allowedDecisions = (["approve", "reject"] as const).filter((decision) =>
    request.allowed_approval_types.includes(decision)
  )
  const oneShotDecisionAllowed = allowedDecisions.length > 0
  if (operation === "write_file" || operation === "edit_file") {
    const label = operation === "write_file" ? "写入文件" : "编辑文件"
    if (!oneShotDecisionAllowed) {
      return {
        approvable: false,
        operation,
        summary: `${label}（仅桌面确认）`,
        detail: "该请求不接受一次性批准，请回到桌面确认。",
        allowedDecisions: []
      }
    }
    const relativePath = safeRelativePath(workspacePath, request)
    const displayPath = relativePath ?? resolvedFilePath(workspacePath, request)
    if (!displayPath) {
      return {
        approvable: false,
        operation,
        summary: `${label}（仅桌面确认）`,
        detail: "该请求没有可展示的文件路径，请回到桌面确认。",
        allowedDecisions: []
      }
    }
    const outsideWorkspace = relativePath === null
    return {
      approvable: true,
      operation,
      summary: `${label} ${displayPath}${outsideWorkspace ? "（工作区外）" : ""}`,
      detail: [
        `${label}：${displayPath}`,
        outsideWorkspace ? "目标在已授权工作区外，请核对后再决定。" : ""
      ]
        .filter(Boolean)
        .join("\n"),
      allowedDecisions
    }
  }
  if (operation === "execute") {
    const command = request.command?.trim() ?? ""
    if (!command || !oneShotDecisionAllowed) {
      return {
        approvable: false,
        operation,
        summary: "执行命令（仅桌面确认）",
        detail: "该请求没有可展示的命令，或不接受一次性批准，请回到桌面确认。",
        allowedDecisions: []
      }
    }
    return {
      approvable: true,
      operation,
      summary: `执行命令：${command}`,
      detail: `执行命令：\n${command}`,
      allowedDecisions
    }
  }
  return {
    approvable: false,
    operation,
    summary: `${operation}（仅桌面确认）`,
    detail: `操作 ${operation} 不支持从招乎批准，请回到桌面确认。`,
    allowedDecisions: []
  }
}

export class ImRemoteApprovalService {
  private readonly dependencies: RemoteApprovalDependencies
  private readonly codes = new Map<string, RemoteApprovalCode>()
  private readonly auditListeners = new Set<AuditListener>()
  private replyDrainer: ReplyDrainer | null = null
  private readonly unsubscribePending: () => void
  private readonly unsubscribeRemoved: () => void

  constructor(dependencies: Partial<RemoteApprovalDependencies> = {}) {
    this.dependencies = {
      broker: dependencies.broker ?? approvalDecisionBroker,
      conversations: dependencies.conversations ?? imConversationStateStore,
      access: dependencies.access ?? imRemoteAccessService,
      grants: dependencies.grants ?? imRemoteGrantStore,
      events: dependencies.events ?? imEventStore,
      audits: dependencies.audits ?? imRemoteApprovalAuditStore,
      getThread: dependencies.getThread ?? getThread,
      getSettings: dependencies.getSettings ?? getBuiltinRobotSettings,
      now: dependencies.now ?? Date.now,
      createCode: dependencies.createCode ?? (() => randomBytes(3).toString("hex").toUpperCase()),
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
    }
    this.unsubscribePending = this.dependencies.broker.subscribePending((registration) => {
      void this.handlePending(registration).catch((error) => {
        this.dependencies.warn("Failed to publish remote approval request.", error)
      })
    })
    this.unsubscribeRemoved = this.dependencies.broker.subscribeRemoved((requestId) => {
      this.removeRequestCodes(requestId)
    })
  }

  registerReplyDrainer(replyDrainer: ReplyDrainer): () => void {
    this.replyDrainer = replyDrainer
    return () => {
      if (this.replyDrainer === replyDrainer) this.replyDrainer = null
    }
  }

  subscribeAudit(listener: AuditListener): () => void {
    this.auditListeners.add(listener)
    return () => this.auditListeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribePending()
    this.unsubscribeRemoved()
    this.codes.clear()
    this.replyDrainer = null
  }

  async resolveCode(input: {
    code: string
    decision: "approve" | "reject"
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled || !settings.remoteApprovalEnabled) {
      return "招乎远程审批未开启，请回到桌面确认。"
    }
    this.pruneExpiredCodes()
    const code = input.code.trim().toUpperCase()
    if (!/^[A-F0-9]{6}$/u.test(code)) return "审批短码无效，请核对后重试。"
    const pendingCode = this.codes.get(code)
    if (!pendingCode) return "审批短码不存在、已过期或已使用。"
    if (
      pendingCode.route.principalId !== input.principalId ||
      pendingCode.route.conversationKey !== input.conversationKey
    ) {
      return "该审批短码不属于当前招乎会话。"
    }
    if (!pendingCode.allowedDecisions.includes(input.decision)) {
      return "该请求不接受这个审批决定，请使用提示中的可用指令或回到桌面确认。"
    }
    const registration = this.dependencies.broker.get(pendingCode.requestId)
    if (!registration) {
      this.codes.delete(code)
      return "该审批已在桌面处理或不再有效。"
    }

    // Reserve the short code before crossing the audit flush. The Runtime is not
    // resumed until the remote decision has a durable audit row.
    this.codes.delete(code)
    let audit: ImRemoteApprovalAuditRecord
    try {
      audit = await this.dependencies.audits.record({
        requestId: pendingCode.requestId,
        toolCallId: pendingCode.toolCallId,
        threadId: pendingCode.route.threadId,
        principalId: input.principalId,
        conversationKey: input.conversationKey,
        operation: pendingCode.operation,
        decision: input.decision,
        summary: pendingCode.summary
      })
    } catch (error) {
      this.dependencies.warn(
        "Remote approval audit persistence failed; decision was not applied.",
        error
      )
      if (
        pendingCode.expiresAt > this.dependencies.now() &&
        this.dependencies.broker.get(pendingCode.requestId)
      ) {
        this.codes.set(code, pendingCode)
      }
      return "无法安全写入远程审批审计，本次决定未执行；请重试或回到桌面确认。"
    }

    const result = this.dependencies.broker.decide({
      source: {
        kind: "im",
        principalId: input.principalId,
        conversationKey: input.conversationKey
      },
      requestId: pendingCode.requestId,
      decision: {
        type: input.decision,
        tool_call_id: pendingCode.toolCallId
      }
    })
    if (!result.accepted) {
      try {
        await this.dependencies.audits.remove(pendingCode.requestId)
      } catch (error) {
        this.dependencies.warn("Failed to remove an uncommitted remote approval audit.", error)
      }
      return result.reasonCode === "REMOTE_APPROVAL_TYPE_NOT_ALLOWED"
        ? "该请求不接受这个审批决定，请回到桌面确认。"
        : "该审批已失效或发生变化，请回到桌面确认。"
    }

    for (const listener of this.auditListeners) {
      try {
        listener(audit)
      } catch (error) {
        this.dependencies.warn("Remote approval audit listener failed.", error)
      }
    }
    return input.decision === "approve"
      ? "已从招乎一次性批准，任务将继续执行。"
      : "已从招乎拒绝，本次工具调用不会执行。"
  }

  private async handlePending(registration: Readonly<ApprovalBrokerRegistration>): Promise<void> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled || !settings.remoteApprovalEnabled) return
    const route = this.resolveRoute(registration.threadId)
    if (!route) return
    const presentation = presentationFor(registration.request, route.workspacePath)
    let code: RemoteApprovalCode | null = null
    if (presentation.approvable) {
      code = {
        code: this.uniqueCode(),
        requestId: registration.request.id,
        toolCallId: registration.request.tool_call?.id ?? registration.request.id,
        operation: presentation.operation,
        summary: presentation.summary,
        allowedDecisions: presentation.allowedDecisions,
        route,
        expiresAt: this.dependencies.now() + REMOTE_APPROVAL_CODE_TTL_MS
      }
      this.codes.set(code.code, code)
    }
    const decisionCommands = code
      ? [
          ...(code.allowedDecisions.includes("approve") ? [`/批准 ${code.code}`] : []),
          ...(code.allowedDecisions.includes("reject") ? [`/拒绝 ${code.code}`] : [])
        ].join("   或   ")
      : ""
    const text = code
      ? [
          `${route.prefix}需要批准`,
          presentation.detail,
          "",
          decisionCommands,
          "短码 10 分钟内单次有效。"
        ].join("\n")
      : [`${route.prefix}需要在桌面确认`, presentation.detail].join("\n")
    const replies = buildImProactiveReplies({
      deliveryId: `approval-request:${registration.request.id}`,
      conversationKey: route.conversationKey,
      text
    })
    if (
      code &&
      replies.some((reply) => reply.message.content.includes(IM_REPLY_TRUNCATION_NOTICE))
    ) {
      this.codes.delete(code.code)
      code = null
      return this.publishDesktopOnlyNotice(registration, route, presentation.operation)
    }
    try {
      const outbox = await this.dependencies.events.enqueueProactiveReplies(replies)
      if (!this.dependencies.broker.get(registration.request.id)) {
        if (code) this.codes.delete(code.code)
        await Promise.all(
          outbox.map((record) =>
            this.dependencies.events.markOutboxFailed(record.outboxId, "APPROVAL_ALREADY_RESOLVED")
          )
        )
        return
      }
      this.drainReplies()
    } catch (error) {
      if (code) this.codes.delete(code.code)
      throw error
    }
  }

  private async publishDesktopOnlyNotice(
    registration: Readonly<ApprovalBrokerRegistration>,
    route: RemoteApprovalRoute,
    operation: string
  ): Promise<void> {
    await this.dependencies.events.enqueueProactiveReplies(
      buildImProactiveReplies({
        deliveryId: `approval-request:${registration.request.id}`,
        conversationKey: route.conversationKey,
        text: `${route.prefix}需要在桌面确认\n操作 ${operation} 无法在招乎中完整、安全地展示。`
      })
    )
    this.drainReplies()
  }

  private resolveRoute(threadId: string): RemoteApprovalRoute | null {
    const thread = this.dependencies.getThread(threadId)
    if (!thread) return null
    const parsed = parseStandardThreadMetadata(thread.metadata)
    const workspacePath = parsed.workspacePath ? canonicalDirectory(parsed.workspacePath) : null
    if (!workspacePath || parsed.agentMode !== "normal") return null

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
          workspacePath,
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
          workspacePath,
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
          workspacePath,
          prefix: imInboxReplyPrefix()
        }
      }
    }
    return null
  }

  private uniqueCode(): string {
    this.pruneExpiredCodes()
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = this.dependencies.createCode().trim().toUpperCase()
      if (/^[A-F0-9]{6}$/u.test(code) && !this.codes.has(code)) return code
    }
    throw new Error("unable to allocate a unique remote approval code")
  }

  private pruneExpiredCodes(): void {
    const now = this.dependencies.now()
    for (const [code, pending] of this.codes) {
      if (pending.expiresAt <= now || !this.dependencies.broker.get(pending.requestId)) {
        this.codes.delete(code)
      }
    }
  }

  private removeRequestCodes(requestId: string): void {
    for (const [code, pending] of this.codes) {
      if (pending.requestId === requestId) this.codes.delete(code)
    }
  }

  private drainReplies(): void {
    const drainer = this.replyDrainer
    if (!drainer) return
    void drainer.sendPending().catch((error) => {
      this.dependencies.warn("Remote approval notification remains queued.", error)
    })
  }
}

export const imRemoteApprovalService = new ImRemoteApprovalService()
