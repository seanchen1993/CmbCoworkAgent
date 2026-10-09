import { randomUUID } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { coordinatorWorkerManager } from "../../agent/coordinator-worker-manager"
import { SqlGoalStore } from "../../agent/goals/goal-store"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import {
  parseStandardThreadMetadata,
  type StandardThreadMetadata
} from "../../agent/standard-thread-turn"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { deleteThread, getThread, type ThreadRow } from "../../db"
import { hasPendingUserInputForThread } from "../user-input"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import {
  ImFeatureBindingError,
  imFeatureBindingService,
  type ImFeatureBindingService,
  type ImFeatureSessionMode
} from "./feature-binding-service"
import {
  imRemoteGrantStore,
  type ImFeatureGrantRecord,
  type ImGrantRouteIdentity,
  type ImRemoteGrantStore,
  type ImThreadGrantRecord
} from "./remote-grant-store"
import { imActivityTime, projectThreadAlias, projectThreadAliasParts } from "./thread-alias"

export type ImAuthorizedRemoteTarget =
  | {
      kind: "thread_grant"
      grantId: string
      grantVersion: number
      label: string
      threadId: string
      sourceTitle?: string
      sessionKind: "ordinary" | "project"
    }
  | {
      kind: "feature_grant"
      grantId: string
      grantVersion: number
      label: string
      projectId: string
      featureSlug: string
    }

export class ImRemoteAccessError extends Error {
  constructor(
    readonly code:
      | "REMOTE_ROUTE_UNAVAILABLE"
      | "REMOTE_THREAD_UNAVAILABLE"
      | "REMOTE_THREAD_UNSUPPORTED"
      | "REMOTE_FEATURE_UNAVAILABLE"
      | "REMOTE_GRANT_STALE",
    message: string
  ) {
    super(message)
    this.name = "ImRemoteAccessError"
  }
}

interface RemoteAccessDependencies {
  conversations: ImConversationStateStore
  grants: ImRemoteGrantStore
  features: ImFeatureBindingService
  getThread: typeof getThread
  deleteThread: typeof deleteThread
  createId: () => string
  getGoal: (threadId: string) => { status: string } | null
  coordinator: Pick<
    typeof coordinatorWorkerManager,
    | "hasRunningWorkersForThread"
    | "hasNotifications"
    | "hasTerminalWorkerAwaitingNotificationForThread"
  >
  workflow: Pick<typeof workflowRunManager, "isBusyForThread">
  hasPendingApproval: (threadId: string) => boolean
  hasPendingUserInput: (threadId: string) => boolean
}

function existingDirectory(path: string | undefined): string | null {
  const normalized = path?.trim()
  if (!normalized || !isAbsolute(normalized) || !existsSync(normalized)) return null
  try {
    if (!statSync(normalized).isDirectory()) return null
    return realpathSync(normalized)
  } catch {
    return null
  }
}

function threadGrantRouteMatches(route: ImGrantRouteIdentity, grant: ImThreadGrantRecord): boolean {
  return grant.principalId === route.principalId && grant.conversationKey === route.conversationKey
}

function featureGrantPrincipalMatches(principalId: string, grant: ImFeatureGrantRecord): boolean {
  return grant.principalId === principalId
}

function currentThreadTitle(thread: ThreadRow, fallback: string): string {
  return thread.title?.trim() || fallback
}

const goalStore = new SqlGoalStore()

export class ImRemoteAccessService {
  private readonly dependencies: RemoteAccessDependencies

  constructor(dependencies: Partial<RemoteAccessDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      grants: dependencies.grants ?? imRemoteGrantStore,
      features: dependencies.features ?? imFeatureBindingService,
      getThread: dependencies.getThread ?? getThread,
      deleteThread: dependencies.deleteThread ?? deleteThread,
      createId: dependencies.createId ?? randomUUID,
      getGoal: dependencies.getGoal ?? ((threadId) => goalStore.get(threadId)),
      coordinator: dependencies.coordinator ?? coordinatorWorkerManager,
      workflow: dependencies.workflow ?? workflowRunManager,
      hasPendingApproval: dependencies.hasPendingApproval ?? hasPendingApprovalForRuntimeThread,
      hasPendingUserInput: dependencies.hasPendingUserInput ?? hasPendingUserInputForThread
    }
  }

  async enableThread(input: {
    route: ImGrantRouteIdentity
    threadId: string
  }): Promise<ImThreadGrantRecord> {
    await this.dependencies.conversations.ensureConversation(input.route)
    const validation = this.validateGrantableThread(input.threadId)
    return this.dependencies.grants.enableThreadGrant({
      route: input.route,
      threadId: validation.thread.thread_id,
      title: await this.threadLabel(
        validation.thread,
        `会话 ${validation.thread.thread_id.slice(0, 8)}`
      )
    })
  }

  private async threadLabel(
    thread: ThreadRow,
    fallback: string,
    featureTitles?: Map<string, Promise<Map<string, string>>>
  ): Promise<string> {
    const parts = projectThreadAliasParts(thread)
    if (!parts) return currentThreadTitle(thread, fallback)
    let titles = featureTitles?.get(parts.projectId)
    if (!titles) {
      titles = this.dependencies.features.getFeatureTitles(parts.projectId)
      featureTitles?.set(parts.projectId, titles)
    }
    const title = (await titles).get(parts.featureSlug) || parts.featureSlug
    return projectThreadAlias(title, parts.launchStageName)
  }

  /** Align local desktop grants with a route confirmed by sync or real ingress. */
  async reconcileAuthoritativeRoute(route: ImGrantRouteIdentity): Promise<number> {
    await this.dependencies.conversations.ensureConversation(route)
    return this.dependencies.grants.rebindActiveThreadGrants(route)
  }

  async disableThread(threadId: string): Promise<ImThreadGrantRecord | null> {
    const grant = await this.dependencies.grants.revokeThreadGrant(threadId)
    if (grant) await this.suspendTargetsForGrant(grant.grantId, "REMOTE_GRANT_REVOKED")
    return grant
  }

  async enableFeature(input: {
    principalId: string
    projectId: string
    featureSlug: string
  }): Promise<ImFeatureGrantRecord> {
    const validation = await this.dependencies.features.validateFeature(
      input.projectId,
      input.featureSlug
    )
    if (!validation.valid) {
      throw new ImRemoteAccessError("REMOTE_FEATURE_UNAVAILABLE", validation.message)
    }
    return this.dependencies.grants.enableFeatureGrant({
      principalId: input.principalId,
      projectId: input.projectId,
      featureSlug: input.featureSlug,
      projectName: validation.project.name,
      featureTitle: validation.feature.title
    })
  }

  async disableFeature(
    projectId: string,
    featureSlug: string
  ): Promise<ImFeatureGrantRecord | null> {
    const grant = await this.dependencies.grants.revokeFeatureGrant(projectId, featureSlug)
    if (grant) await this.suspendTargetsForGrant(grant.grantId, "REMOTE_GRANT_REVOKED")
    return grant
  }

  async listAuthorizedTargets(route: ImGrantRouteIdentity): Promise<ImAuthorizedRemoteTarget[]> {
    this.dependencies.conversations.assertConversationOwner(
      route.conversationKey,
      route.principalId
    )
    const targets: ImAuthorizedRemoteTarget[] = []
    const activityByThreadId = new Map<string, number>()
    const featureTitles = new Map<string, Promise<Map<string, string>>>()
    for (const grant of this.dependencies.grants.listThreadGrants(route.conversationKey)) {
      if (grant.state !== "active" || !threadGrantRouteMatches(route, grant)) continue
      let thread: ThreadRow
      try {
        thread = this.validateGrantableThread(grant.threadId).thread
      } catch {
        continue
      }
      const metadata = parseStandardThreadMetadata(thread.metadata).metadata
      const projectMode = Boolean(metadata.harnessFeature || metadata.harnessProjectSession)
      targets.push({
        kind: "thread_grant",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        label: await this.threadLabel(thread, grant.titleSnapshot, featureTitles),
        threadId: grant.threadId,
        sourceTitle: thread.title?.trim() || undefined,
        sessionKind: projectMode ? "project" : "ordinary"
      })
      if (projectThreadAliasParts(thread)) activityByThreadId.set(grant.threadId, thread.updated_at)
    }
    const labelCounts = new Map<string, number>()
    for (const target of targets) {
      labelCounts.set(target.label, (labelCounts.get(target.label) ?? 0) + 1)
    }
    const minuteCounts = new Map<string, number>()
    const secondCounts = new Map<string, number>()
    for (const target of targets) {
      if (target.kind !== "thread_grant" || !activityByThreadId.has(target.threadId)) continue
      const timestamp = activityByThreadId.get(target.threadId)!
      const minuteKey = `${target.label}\u0000${imActivityTime(timestamp)}`
      const secondKey = `${target.label}\u0000${imActivityTime(timestamp, true)}`
      minuteCounts.set(minuteKey, (minuteCounts.get(minuteKey) ?? 0) + 1)
      secondCounts.set(secondKey, (secondCounts.get(secondKey) ?? 0) + 1)
    }
    for (const target of targets) {
      if (target.kind !== "thread_grant" || (labelCounts.get(target.label) ?? 0) < 2) continue
      const timestamp = activityByThreadId.get(target.threadId)
      if (timestamp === undefined) continue
      const minute = imActivityTime(timestamp)
      const minuteKey = `${target.label}\u0000${minute}`
      const second = imActivityTime(timestamp, true)
      const secondKey = `${target.label}\u0000${second}`
      const time = (minuteCounts.get(minuteKey) ?? 0) > 1 ? second : minute
      target.label = `${target.label} · ${time}${(secondCounts.get(secondKey) ?? 0) > 1 ? ` #${target.threadId.slice(0, 8)}` : ""}`
    }
    for (const grant of this.dependencies.grants.listFeatureGrants(route.principalId)) {
      if (grant.state !== "active" || !featureGrantPrincipalMatches(route.principalId, grant))
        continue
      targets.push({
        kind: "feature_grant",
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        label: `${grant.projectNameSnapshot} / ${grant.featureTitleSnapshot}`,
        projectId: grant.projectId,
        featureSlug: grant.featureSlug
      })
    }
    return targets.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
  }

  async bindThreadGrant(input: {
    route: ImGrantRouteIdentity
    grantId: string
    grantVersion: number
  }): Promise<Extract<ImTargetSnapshot, { kind: "thread" }>> {
    const grant = this.dependencies.grants.getThreadGrantById(input.grantId)
    if (!grant || grant.grantVersion !== input.grantVersion || grant.state !== "active") {
      throw new ImRemoteAccessError("REMOTE_GRANT_STALE", "会话授权已变化，请重新发送 /会话。")
    }
    this.dependencies.grants.assertActiveThreadGrant({
      grantId: input.grantId,
      grantVersion: input.grantVersion,
      route: input.route,
      threadId: grant.threadId
    })
    const validation = this.validateGrantableThread(grant.threadId)
    const title =
      (await this.listAuthorizedTargets(input.route)).find(
        (target) => target.kind === "thread_grant" && target.grantId === grant.grantId
      )?.label ?? (await this.threadLabel(validation.thread, grant.titleSnapshot))
    const reusable = this.dependencies.conversations
      .listTargets(input.route.conversationKey)
      .find(
        ({ snapshot }) =>
          snapshot.kind === "thread" &&
          snapshot.grantId === grant.grantId &&
          snapshot.threadId === grant.threadId
      )
    if (reusable?.snapshot.kind === "thread") {
      return (await this.dependencies.conversations.refreshGrantTarget({
        targetId: reusable.snapshot.targetId,
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        workspacePath: validation.workspacePath,
        title,
        activate: true
      })) as Extract<ImTargetSnapshot, { kind: "thread" }>
    }
    const target: Extract<ImTargetSnapshot, { kind: "thread" }> = {
      kind: "thread",
      targetId: this.dependencies.createId(),
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      threadId: grant.threadId,
      title,
      workspacePath: validation.workspacePath
    }
    await this.dependencies.conversations.registerTarget(input.route.conversationKey, target, {
      state: "active",
      activate: true
    })
    return target
  }

  async bindFeatureGrant(input: {
    route: ImGrantRouteIdentity
    grantId: string
    grantVersion: number
    /** Omitted lets the Feature's own configuration choose the session's mode. */
    sessionMode?: ImFeatureSessionMode
  }): Promise<Extract<ImTargetSnapshot, { kind: "thread" }>> {
    const grant = this.dependencies.grants.getFeatureGrantById(input.grantId)
    if (!grant || grant.grantVersion !== input.grantVersion || grant.state !== "active") {
      throw new ImRemoteAccessError("REMOTE_GRANT_STALE", "Feature 授权已变化，请重新发送 /会话。")
    }
    this.dependencies.grants.assertActiveFeatureGrant({
      grantId: input.grantId,
      grantVersion: input.grantVersion,
      principalId: input.route.principalId,
      projectId: grant.projectId,
      featureSlug: grant.featureSlug
    })
    const targetId = this.dependencies.createId()
    let created: Awaited<ReturnType<ImFeatureBindingService["createFeatureThread"]>>
    try {
      created = await this.dependencies.features.createFeatureThread({
        ...input.route,
        projectId: grant.projectId,
        featureSlug: grant.featureSlug,
        targetId,
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {})
      })
    } catch (error) {
      if (error instanceof ImFeatureBindingError) {
        throw new ImRemoteAccessError("REMOTE_FEATURE_UNAVAILABLE", error.message)
      }
      throw error
    }

    let threadGrant: ImThreadGrantRecord | null = null
    try {
      const createdThread = this.dependencies.getThread(created.threadId)
      const title = createdThread
        ? await this.threadLabel(createdThread, created.title)
        : projectThreadAlias(created.featureTitle, null)
      threadGrant = await this.dependencies.grants.enableThreadGrant({
        route: input.route,
        threadId: created.threadId,
        title
      })
      const target: Extract<ImTargetSnapshot, { kind: "thread" }> = {
        kind: "thread",
        targetId,
        grantId: threadGrant.grantId,
        grantVersion: threadGrant.grantVersion,
        threadId: created.threadId,
        title,
        workspacePath: created.workspacePath
      }
      await this.dependencies.conversations.registerTarget(input.route.conversationKey, target, {
        state: "active",
        activate: true
      })
      return target
    } catch (error) {
      if (threadGrant) {
        await this.dependencies.grants.revokeThreadGrant(created.threadId).catch(() => undefined)
      }
      this.dependencies.deleteThread(created.threadId)
      throw error
    }
  }

  getThreadGrant(threadId: string): ImThreadGrantRecord | null {
    return this.dependencies.grants.getThreadGrant(threadId)
  }

  getFeatureGrant(projectId: string, featureSlug: string): ImFeatureGrantRecord | null {
    return this.dependencies.grants.getFeatureGrant(projectId, featureSlug)
  }

  listThreadGrants(): ImThreadGrantRecord[] {
    return this.dependencies.grants.listThreadGrants()
  }

  listFeatureGrants(principalId?: string): ImFeatureGrantRecord[] {
    return this.dependencies.grants.listFeatureGrants(principalId)
  }

  validateThreadForRemoteAccess(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    return this.validateGrantableThread(threadId)
  }

  validateThreadForCompletionDelivery(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    const { thread, workspacePath } = this.validateThreadStructure(threadId)
    return { thread, workspacePath }
  }

  private validateGrantableThread(threadId: string): {
    thread: ThreadRow
    workspacePath: string
  } {
    // A grant describes which durable Thread IM may address. Execution mode,
    // detached workers/workflows and transient HITL state are evaluated at turn
    // time; treating them as grant structure made an otherwise valid switch
    // silently disappear from /会话.
    const { thread, workspacePath } = this.validateThreadStructure(threadId)
    return { thread, workspacePath }
  }

  private validateThreadStructure(threadId: string): {
    thread: ThreadRow
    workspacePath: string
    parsed: StandardThreadMetadata
  } {
    const thread = this.dependencies.getThread(threadId)
    if (!thread) {
      throw new ImRemoteAccessError("REMOTE_THREAD_UNAVAILABLE", "会话不存在或已删除。")
    }
    const parsed = parseStandardThreadMetadata(thread.metadata)
    const workspacePath = existingDirectory(parsed.workspacePath)
    if (!workspacePath) {
      throw new ImRemoteAccessError("REMOTE_THREAD_UNAVAILABLE", "会话工作区不可用。")
    }
    if (
      parsed.metadata.targetKind === "inbox" ||
      (parsed.metadata.remoteThread === true && parsed.metadata.targetKind !== "feature")
    ) {
      throw new ImRemoteAccessError("REMOTE_THREAD_UNSUPPORTED", "远程收件箱不能作为会话授权目标。")
    }
    return { thread, workspacePath, parsed }
  }

  private async suspendTargetsForGrant(grantId: string, reasonCode: string): Promise<void> {
    for (const conversation of this.dependencies.conversations.listConversations()) {
      for (const target of this.dependencies.conversations.listTargets(
        conversation.conversationKey
      )) {
        if (
          target.snapshot.kind !== "inbox" &&
          target.snapshot.grantId === grantId &&
          target.state !== "revoked"
        ) {
          await this.dependencies.conversations.updateTargetState(
            target.snapshot.targetId,
            "suspended",
            reasonCode,
            { fallbackToInboxIfSelected: true }
          )
        }
      }
    }
  }
}

export const imRemoteAccessService = new ImRemoteAccessService()
