import { flushStrict, getThread, updateThread } from "../../db"
import {
  deleteLegacyChatXRobotCredentials,
  getBuiltinRobotDeviceIdentity,
  getBuiltinRobotSettings,
  getUserInfo,
  hasLegacyChatXRobotCredentials,
  saveBuiltinRobotSettings
} from "../../storage"
import type {
  BuiltinRobotRouteStatus,
  BuiltinRobotFeatureBindingStatus,
  BuiltinRobotSettings,
  BuiltinRobotStatus,
  BuiltinRobotTakeoverRequest,
  BuiltinRobotTakeoverResult
} from "../../types"
import { notifyRemoteThreadChanged } from "../../agent/renderer-stream-mirror"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore } from "./event-store"
import { ImGatewayWsClient, type ImGatewayWsStatus } from "./gateway-ws-client"
import { imInboxService } from "./inbox-service"
import { imSelectionContextStore } from "./selection-context"
import { ImUnifiedBotService } from "./service"

type StatusListener = (status: BuiltinRobotStatus) => void

function configuredGatewayUrl(): string | null {
  const env = (
    import.meta as ImportMeta & {
      env?: { VITE_UNIFIED_IM_GATEWAY_WS_URL?: string }
    }
  ).env
  return env?.VITE_UNIFIED_IM_GATEWAY_WS_URL?.trim() || null
}

function currentIdentity(): { token: string | null; error: string | null } {
  try {
    const user = getUserInfo()
    return {
      token: user?.ystIdToken?.trim() || null,
      error: null
    }
  } catch {
    return { token: null, error: "企业身份信息损坏，请重新登录。" }
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
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
    lastConnectedAt: null,
    lastError: null,
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
      const settings = saveBuiltinRobotSettings(updates)
      if (!settings.enabled) {
        await this.stopNow()
      } else if (
        !previous.enabled ||
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
    const device = getBuiltinRobotDeviceIdentity()
    const identity = currentIdentity()
    const summary = imEventStore.getStatusSummary()
    const routeMap = new Map<string, BuiltinRobotRouteStatus>()
    for (const conversation of imConversationStateStore.listConversations()) {
      routeMap.set(conversation.conversationKey, {
        conversationKey: conversation.conversationKey,
        deviceEpoch: conversation.deviceEpoch,
        state: conversation.state,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        ownedByCurrentDevice: true
      })
    }
    for (const route of this.gatewayStatus.routes) routeMap.set(route.conversationKey, route)
    const featureBindings: BuiltinRobotFeatureBindingStatus[] = []
    for (const conversation of imConversationStateStore.listConversations()) {
      for (const target of imConversationStateStore.listTargets(conversation.conversationKey)) {
        if (target.snapshot.kind !== "feature") continue
        const thread = getThread(target.snapshot.threadId)
        const metadata = parseMetadata(thread?.metadata ?? null)
        const historical = metadata.remoteState === "historical"
        featureBindings.push({
          conversationKey: conversation.conversationKey,
          bindingId: target.snapshot.bindingId,
          projectId: target.snapshot.projectId,
          featureSlug: target.snapshot.featureSlug,
          threadId: target.snapshot.threadId,
          state: historical ? "historical" : target.state,
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
          : identity.token
            ? "mapped"
            : "missing",
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      sessionId: this.gatewayStatus.sessionId,
      lastConnectedAt: this.gatewayStatus.lastConnectedAt,
      lastError,
      legacyConfigDetected: hasLegacyChatXRobotCredentials(),
      routes: [...routeMap.values()].sort((left, right) =>
        left.conversationKey.localeCompare(right.conversationKey)
      ),
      featureBindings,
      eventCounts: summary.eventCounts,
      pendingOutboxCount: summary.pendingOutboxCount
    }
  }

  cleanupLegacyCredentials(confirmed: boolean): BuiltinRobotStatus {
    deleteLegacyChatXRobotCredentials(confirmed)
    this.emitStatus()
    return this.getStatus()
  }

  takeover(request: BuiltinRobotTakeoverRequest): Promise<BuiltinRobotTakeoverResult> {
    return this.enqueue(() => this.takeoverNow(request))
  }

  private async startNow(): Promise<void> {
    const settings = getBuiltinRobotSettings()
    if (!settings.enabled || this.service) {
      this.emitStatus()
      return
    }
    const device = getBuiltinRobotDeviceIdentity()
    const identity = currentIdentity()
    this.managerError = null
    const client = new ImGatewayWsClient({
      url: configuredGatewayUrl,
      token: () => currentIdentity().token,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      appVersion: this.appVersion,
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
      routes: []
    }
    this.emitStatus()
  }

  private async takeoverNow(
    request: BuiltinRobotTakeoverRequest
  ): Promise<BuiltinRobotTakeoverResult> {
    if (!request.conversationKey.trim() || !Number.isSafeInteger(request.expectedDeviceEpoch)) {
      throw new Error("接管参数无效")
    }
    if (!this.client?.isAuthenticated()) throw new Error("统一机器人未连接，无法接管")
    const result = await this.client.requestTakeover(request)
    if (!result.success || !result.deviceEpoch) return result

    const existing = imConversationStateStore.getConversation(request.conversationKey)
    const principalId = result.principalId ?? existing?.principalId
    if (!principalId) throw new Error("网关接管响应缺少企业主体标识")

    if (existing && existing.deviceEpoch === request.expectedDeviceEpoch) {
      const runningEventId = this.service?.turnQueue.getCurrentEventId(request.conversationKey)
      if (runningEventId && this.service) {
        await this.service.handleLeaseRevoked(runningEventId, "ROUTE_TAKEOVER")
        await this.service.turnQueue.waitForIdle(request.conversationKey)
      }
      const oldTargets = imConversationStateStore.listTargets(request.conversationKey)
      await imEventStore.applyDeviceTakeover(request.conversationKey, request.expectedDeviceEpoch)
      for (const { snapshot } of oldTargets) {
        const thread = getThread(snapshot.threadId)
        if (!thread) continue
        updateThread(snapshot.threadId, {
          metadata: JSON.stringify({
            ...parseMetadata(thread.metadata),
            remoteState: "historical",
            remoteHistoricalAt: new Date().toISOString(),
            remoteHistoricalReason: "device_takeover"
          })
        })
      }
      await imConversationStateStore.resetForDeviceTakeover(
        request.conversationKey,
        request.expectedDeviceEpoch,
        result.deviceEpoch
      )
    } else if (!existing) {
      await imConversationStateStore.ensureConversation({
        conversationKey: request.conversationKey,
        principalId,
        deviceEpoch: result.deviceEpoch
      })
    } else if (existing.deviceEpoch !== result.deviceEpoch) {
      throw new Error("本地设备版本与网关接管结果冲突")
    }

    await imSelectionContextStore.clearConversation(request.conversationKey)
    await imInboxService.ensureInbox({
      conversationKey: request.conversationKey,
      principalId,
      deviceEpoch: result.deviceEpoch
    })
    await flushStrict()
    notifyRemoteThreadChanged()
    this.emitStatus()
    return result
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
