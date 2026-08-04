import {
  deleteLegacyChatXRobotCredentials,
  getBuiltinRobotSettings,
  getUserInfo,
  hasLegacyChatXRobotCredentials,
  saveBuiltinRobotSettings
} from "../../storage"
import type {
  BuiltinRobotRouteStatus,
  BuiltinRobotFeatureBindingStatus,
  BuiltinRobotGrantableFeature,
  BuiltinRobotRemoteAccessOverview,
  BuiltinRobotSettings,
  BuiltinRobotStatus
} from "../../types"
import { notifyRemoteThreadChanged } from "../../agent/renderer-stream-mirror"
import { refreshEnterpriseLogin } from "../enterprise-login-refresh"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { ImGatewayWsClient, type ImGatewayWsStatus } from "./gateway-ws-client"
import { normalizeImGatewayUrlOverride } from "./gateway-url"
import { ImUnifiedBotService } from "./service"
import { imFeatureBindingService } from "./feature-binding-service"
import { imRemoteAccessService } from "./remote-access-service"
import type { ImGrantRouteIdentity } from "./remote-grant-store"

type StatusListener = (status: BuiltinRobotStatus) => void

function environmentGatewayUrl(): string | null {
  const env = (
    import.meta as ImportMeta & {
      env?: { VITE_UNIFIED_IM_GATEWAY_WS_URL?: string }
    }
  ).env
  return env?.VITE_UNIFIED_IM_GATEWAY_WS_URL?.trim() || null
}

function configuredGatewayUrl(): string | null {
  return getBuiltinRobotSettings().gatewayUrl ?? environmentGatewayUrl()
}

function diagnosticGatewayUrl(): string | null {
  const configured = configuredGatewayUrl()
  if (!configured) return null
  try {
    const url = new URL(configured)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function currentIdentity(): { token: string | null; error: string | null } {
  try {
    const user = getUserInfo()
    return {
      token: user?.ystIdToken?.trim() || null,
      error: null
    }
  } catch {
    return { token: null, error: "登录信息异常，请重新登录。" }
  }
}

/**
 * Single lifecycle owner for the built-in robot. Renderer and IPC code only
 * observe this manager; they never own WebSocket clients or Agent services.
 */
export class BuiltinRobotManager {
  private client: ImGatewayWsClient | null = null
  private service: ImUnifiedBotService | null = null
  private appVersion = "unknown"
  private listeners = new Set<StatusListener>()
  private lifecycle: Promise<void> = Promise.resolve()
  private gatewayStatus: ImGatewayWsStatus = {
    connectionState: "offline",
    authenticationFailed: false,
    sessionId: null,
    principalId: null,
    lastConnectedAt: null,
    lastError: null,
    lastHandshakeStatus: null,
    lastCloseCode: null,
    lastCloseReason: null,
    lastTransportError: null,
    reconnectAttempt: 0,
    routes: []
  }
  private managerError: string | null = null
  private activeIdentityToken: string | null = null

  start(appVersion?: string): Promise<void> {
    if (appVersion?.trim()) this.appVersion = appVersion.trim()
    return this.enqueue(() => this.startNow())
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopNow())
  }

  reconnect(): Promise<BuiltinRobotStatus> {
    return this.enqueue(async () => {
      await this.stopNow()
      await this.startNow()
      return this.getStatus()
    })
  }

  disconnect(): Promise<BuiltinRobotStatus> {
    return this.enqueue(async () => {
      await this.stopNow()
      return this.getStatus()
    })
  }

  refreshIdentity(): Promise<void> {
    return this.enqueue(async () => {
      const identity = currentIdentity()
      if (!getBuiltinRobotSettings().enabled) {
        this.emitStatus()
      } else if (!this.service || identity.token !== this.activeIdentityToken) {
        await this.stopNow()
        await this.startNow()
      } else {
        this.emitStatus()
      }
    })
  }

  updateSettings(updates: Partial<BuiltinRobotSettings>): Promise<BuiltinRobotStatus> {
    return this.enqueue(async () => {
      const previous = getBuiltinRobotSettings()
      const normalizedUpdates = {
        ...updates,
        ...(updates.gatewayUrl !== undefined
          ? { gatewayUrl: normalizeImGatewayUrlOverride(updates.gatewayUrl) }
          : {})
      }
      const settings = saveBuiltinRobotSettings(normalizedUpdates)
      if (!settings.enabled) {
        await this.stopNow()
      } else if (
        !previous.enabled ||
        previous.gatewayUrl !== settings.gatewayUrl ||
        previous.waitingDesktopTtlMinutes !== settings.waitingDesktopTtlMinutes
      ) {
        await this.stopNow()
        await this.startNow()
      } else if (!this.service) {
        await this.startNow()
      } else {
        this.emitStatus()
      }
      return this.getStatus()
    })
  }

  hasActiveRuns(): boolean {
    return this.service?.hasActiveRuns() === true
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStatus(): BuiltinRobotStatus {
    const settings = getBuiltinRobotSettings()
    const identity = currentIdentity()
    const summary = imEventStore.getStatusSummary()
    const routeMap = new Map<string, BuiltinRobotRouteStatus>()
    for (const conversation of imConversationStateStore.listConversations()) {
      routeMap.set(conversation.conversationKey, {
        principalId: conversation.principalId,
        conversationKey: conversation.conversationKey,
        state: conversation.state
      })
    }
    for (const route of this.gatewayStatus.routes) routeMap.set(route.conversationKey, route)
    const featureBindings: BuiltinRobotFeatureBindingStatus[] = []
    for (const conversation of imConversationStateStore.listConversations()) {
      for (const target of imConversationStateStore.listTargets(conversation.conversationKey)) {
        if (target.snapshot.kind !== "feature") continue
        featureBindings.push({
          conversationKey: conversation.conversationKey,
          bindingId: target.snapshot.bindingId,
          projectId: target.snapshot.projectId,
          featureSlug: target.snapshot.featureSlug,
          threadId: target.snapshot.threadId,
          state: target.state,
          suspendReason: target.suspendReason,
          activeTarget: conversation.activeTargetId === target.snapshot.targetId
        })
      }
    }
    const lastError = this.managerError ?? identity.error ?? this.gatewayStatus.lastError
    return {
      settings,
      connectionState: settings.enabled ? this.gatewayStatus.connectionState : "offline",
      identityState:
        identity.error || this.gatewayStatus.authenticationFailed
          ? "error"
          : this.gatewayStatus.principalId
            ? "verified"
            : identity.token
              ? "verifying"
              : "missing",
      sessionId: this.gatewayStatus.sessionId,
      principalId: this.gatewayStatus.principalId,
      lastConnectedAt: this.gatewayStatus.lastConnectedAt,
      lastError,
      legacyConfigDetected: hasLegacyChatXRobotCredentials(),
      routes: [...routeMap.values()].sort((left, right) =>
        left.conversationKey.localeCompare(right.conversationKey)
      ),
      featureBindings,
      eventCounts: summary.eventCounts,
      pendingOutboxCount: summary.pendingOutboxCount,
      diagnostics: {
        appVersion: this.appVersion,
        gatewayUrl: diagnosticGatewayUrl(),
        authenticationFailed: this.gatewayStatus.authenticationFailed,
        lastHandshakeStatus: this.gatewayStatus.lastHandshakeStatus,
        lastCloseCode: this.gatewayStatus.lastCloseCode,
        lastCloseReason: this.gatewayStatus.lastCloseReason,
        lastTransportError: this.gatewayStatus.lastTransportError,
        reconnectAttempt: this.gatewayStatus.reconnectAttempt
      }
    }
  }

  cleanupLegacyCredentials(confirmed: boolean): BuiltinRobotStatus {
    deleteLegacyChatXRobotCredentials(confirmed)
    this.emitStatus()
    return this.getStatus()
  }

  getRemoteAccessOverview(): BuiltinRobotRemoteAccessOverview {
    const resolved = this.resolveGrantRoute(false)
    return {
      routeAvailable: Boolean(resolved.route),
      routeReason: resolved.reason,
      activeRoute: resolved.status,
      threadGrants: imRemoteAccessService.listThreadGrants().map((grant) => ({
        kind: "thread",
        grantId: grant.grantId,
        threadId: grant.threadId,
        title: grant.titleSnapshot,
        state: grant.state,
        grantVersion: grant.grantVersion,
        conversationKey: grant.conversationKey,
        suspendReason: grant.suspendReason
      })),
      featureGrants: imRemoteAccessService.listFeatureGrants().map((grant) => ({
        kind: "feature",
        grantId: grant.grantId,
        projectId: grant.projectId,
        featureSlug: grant.featureSlug,
        projectName: grant.projectNameSnapshot,
        featureTitle: grant.featureTitleSnapshot,
        state: grant.state,
        grantVersion: grant.grantVersion,
        conversationKey: grant.conversationKey,
        suspendReason: grant.suspendReason
      }))
    }
  }

  setThreadRemoteAccess(
    threadId: string,
    enabled: boolean
  ): Promise<BuiltinRobotRemoteAccessOverview> {
    return this.enqueue(async () => {
      if (enabled) {
        await imRemoteAccessService.enableThread({
          route: this.requireGrantRoute(),
          threadId
        })
      } else {
        await imRemoteAccessService.disableThread(threadId)
      }
      this.emitStatus()
      return this.getRemoteAccessOverview()
    })
  }

  setFeatureRemoteAccess(
    projectId: string,
    featureSlug: string,
    enabled: boolean
  ): Promise<BuiltinRobotRemoteAccessOverview> {
    return this.enqueue(async () => {
      if (enabled) {
        await imRemoteAccessService.enableFeature({
          route: this.requireGrantRoute(),
          projectId,
          featureSlug
        })
      } else {
        await imRemoteAccessService.disableFeature(projectId, featureSlug)
      }
      this.emitStatus()
      return this.getRemoteAccessOverview()
    })
  }

  listGrantableFeatures(): Promise<BuiltinRobotGrantableFeature[]> {
    return this.enqueue(async () => {
      const projects = await imFeatureBindingService.listRemoteProjects()
      const result: BuiltinRobotGrantableFeature[] = []
      for (const project of projects) {
        const features = await imFeatureBindingService.listRemoteFeatures(project.id)
        for (const feature of features) {
          result.push({
            projectId: project.id,
            projectName: project.name,
            featureSlug: feature.slug,
            featureTitle: feature.title,
            featureStatus: feature.status,
            granted:
              imRemoteAccessService.getFeatureGrant(project.id, feature.slug)?.state === "active"
          })
        }
      }
      return result
    })
  }

  private async startNow(): Promise<void> {
    const settings = getBuiltinRobotSettings()
    if (!settings.enabled || this.service) {
      this.emitStatus()
      return
    }
    const identity = currentIdentity()
    this.managerError = null
    const client = new ImGatewayWsClient({
      url: configuredGatewayUrl,
      token: () => currentIdentity().token,
      appVersion: this.appVersion,
      onAuthenticationRequired: async (rejectedToken) => {
        const latestStoredToken = currentIdentity().token
        if (latestStoredToken && latestStoredToken !== rejectedToken) {
          this.activeIdentityToken = latestStoredToken
          return true
        }
        const refreshedUser = await refreshEnterpriseLogin()
        const refreshedToken = refreshedUser?.ystIdToken?.trim() || currentIdentity().token
        if (!refreshedToken || refreshedToken === rejectedToken) return false
        this.activeIdentityToken = refreshedToken
        return true
      },
      onRemoteEvent: async (event) => {
        const service = this.service
        if (!service) return
        await service.receiveEvent(event)
        notifyRemoteThreadChanged()
        this.emitStatus()
      },
      onLeaseRevoked: async (payload) => {
        const eventId = typeof payload.eventId === "string" ? payload.eventId.trim() : ""
        const reasonCode =
          typeof payload.reasonCode === "string" && payload.reasonCode.trim()
            ? payload.reasonCode.trim()
            : "LEASE_REVOKED"
        if (eventId && this.service) await this.service.handleLeaseRevoked(eventId, reasonCode)
        this.emitStatus()
      },
      onStatusChange: (status) => {
        this.gatewayStatus = status
        this.emitStatus()
        if (status.connectionState === "online") {
          const activeService = this.service
          void activeService
            ?.resumeQueued()
            .then(() => {
              if (this.service !== activeService) return
              this.managerError = null
              this.emitStatus()
            })
            .catch(() => {
              if (this.service !== activeService) return
              this.managerError = "恢复远程消息队列失败，请重连后重试。"
              this.emitStatus()
            })
        }
      }
    })
    const service = new ImUnifiedBotService(client, {
      waitingDesktopTtlMs: settings.waitingDesktopTtlMinutes * 60_000
    })
    this.client = client
    this.service = service
    this.activeIdentityToken = identity.token
    try {
      await service.recoverAndStart()
      client.start()
    } catch {
      await service.stop().catch(() => undefined)
      client.stop()
      this.client = null
      this.service = null
      this.activeIdentityToken = null
      this.managerError = "统一机器人本地状态恢复失败。"
      this.gatewayStatus = { ...this.gatewayStatus, connectionState: "error", sessionId: null }
    }
    this.emitStatus()
  }

  private async stopNow(): Promise<void> {
    const service = this.service
    const client = this.client
    this.service = null
    this.client = null
    this.activeIdentityToken = null
    if (service) await service.stop().catch(() => undefined)
    client?.stop()
    this.gatewayStatus = {
      ...this.gatewayStatus,
      connectionState: "offline",
      sessionId: null,
      principalId: null,
      routes: []
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    if (this.listeners.size === 0) return
    let status: BuiltinRobotStatus
    try {
      status = this.getStatus()
    } catch {
      return
    }
    for (const listener of this.listeners) listener(status)
  }

  private requireGrantRoute(): ImGrantRouteIdentity {
    const resolved = this.resolveGrantRoute(true)
    if (!resolved.route) throw new Error(resolved.reason ?? "当前没有可用的招乎单聊路由")
    return resolved.route
  }

  private resolveGrantRoute(requireOnline: boolean): {
    route: ImGrantRouteIdentity | null
    status: BuiltinRobotRouteStatus | null
    reason: string | null
  } {
    if (requireOnline && this.gatewayStatus.connectionState !== "online") {
      return { route: null, status: null, reason: "统一机器人尚未连接。" }
    }
    const principalId = this.gatewayStatus.principalId
    if (!principalId) {
      return { route: null, status: null, reason: "登录验证尚未完成。" }
    }
    const candidates = this.gatewayStatus.routes.filter(
      (route) => route.principalId === principalId && route.state === "active"
    )
    if (candidates.length === 0) {
      return {
        route: null,
        status: null,
        reason: "请先在招乎中向内置机器人发送一条消息，以建立远程会话。"
      }
    }
    if (candidates.length > 1) {
      return { route: null, status: null, reason: "存在多个招乎单聊路由，当前无法安全消歧。" }
    }
    const status = candidates[0]
    return {
      route: {
        principalId,
        conversationKey: status.conversationKey
      },
      status: { ...status },
      reason: null
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export const builtinRobotManager = new BuiltinRobotManager()
