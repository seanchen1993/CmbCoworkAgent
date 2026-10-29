import { botInteractionRoutes } from "./bot-interaction-route"
import { submitFormattedImReply } from "./submit-formatted-reply"
import { conversationSwitchedToText } from "./withheld-text-notices"
import type { LocalBotHost } from "../../bots/host"
import { botImScopeId, type StoredBotImEvent } from "../../bots/im-gateway-store"
import type { BotImBinding, BotImBindingPage, BotImEvent } from "../../../shared/bots/im-channel"
import type { ImGatewayWsClient } from "./gateway-ws-client"
import { ImGatewayCommandError } from "./gateway-ws-client"
import { buildImProactiveReplies } from "./reply-segmentation"

export type BotImGatewayClient = Pick<
  ImGatewayWsClient,
  | "getStatus"
  | "supportsBotChannel"
  | "botBindingCommand"
  | "sendAcknowledgement"
  | "acquireBotPermit"
  | "renewBotPermit"
  | "submitReply"
> &
  Partial<Pick<ImGatewayWsClient, "supportsMarkdownReplies" | "supportsBotCards">>

/** Authenticated IM -> local Bot adapter. Renderer has no event injection API. */
export class BotImChannelService {
  private timer?: ReturnType<typeof setInterval>
  private pumping = false
  private stopped = false
  private nextSync = 0
  private syncing = false
  private delivering = false
  private epoch = 0
  private nextDelivery = 0
  private resolvedHost?: LocalBotHost
  private getHost(): LocalBotHost {
    return (this.resolvedHost ??= this.resolveHost())
  }
  private receiving: Promise<void> = Promise.resolve()
  constructor(
    private readonly client: BotImGatewayClient,
    private readonly realm: string,
    private readonly resolveHost: () => LocalBotHost,
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly usesTextReplies = (key: string) =>
      conversationSwitchedToText(key, console.warn)
  ) {
    this.releaseTransport = botInteractionRoutes.setTransport(
      (realm, principal) =>
        !this.stopped &&
        realm === this.realm &&
        this.client.supportsBotCards?.() === true &&
        this.client.getStatus().principalId === principal
    )
  }
  private readonly releaseTransport: () => void

  isRouteConfirmed(conversation: string, principal: string): boolean {
    return (
      !this.stopped &&
      (this.resolvedHost?.imGateway.hasRoute(this.realm, principal, conversation) ?? false)
    )
  }
  start(): void {
    this.timer = setInterval(() => {
      this.expirePermits()
      void this.pump()
      void this.syncBindings()
      void this.deliver()
    }, 1000)
    this.timer.unref?.()
  }
  private identity(): string {
    const principal = this.client.getStatus().principalId
    if (this.stopped || !this.client.supportsBotChannel() || !principal)
      throw new Error("请先登录并连接支持 Bot 接入的 IM 网关")
    return principal
  }
  private register(binding: BotImBinding, principal: string): BotImBinding {
    const host = this.getHost()
    host.getBot(binding.botId)
    const route = host.imGateway.register(this.realm, principal, binding)
    binding = route.binding
    if (binding.state === "active") {
      host.imChannel.importImBinding({
        id: route.id,
        botId: binding.botId,
        kind: binding.kind,
        label: binding.label,
        channelKey: botImScopeId(this.realm, principal, binding.conversationKey!),
        version: binding.version
      })
      host.setImOnline(binding.botId, route.id, true)
    } else if (binding.state === "revoked") {
      try {
        const local = host.imChannel.get(binding.botId, route.id)
        if (!local.revoked) host.imChannel.revoke(binding.botId, route.id, local.grantVersion)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "NOT_FOUND")) throw error
      }
      for (const event of host.imGateway.active())
        if (event.bindingId === route.id) this.cancel(event)
    }
    return binding
  }
  async create(botId: string, kind: "dm" | "group", operationId: string): Promise<BotImBinding> {
    const epoch = this.epoch,
      principal = this.identity(),
      bot = this.getHost().getBot(botId)
    if (bot.archived || bot.deleting) throw new Error("请先恢复 Bot")
    const value = await this.client.botBindingCommand(
      { action: "create", botId, kind, label: bot.name.slice(0, 100) },
      operationId
    )
    if ("items" in value || principal !== this.identity()) throw new Error("IM 身份已变化，请刷新")
    if (epoch !== this.epoch) throw new Error("连接已变化，请刷新绑定")
    return this.register(value, principal)
  }
  async list(botId: string, before?: string): Promise<BotImBindingPage> {
    const epoch = this.epoch,
      principal = this.identity()
    this.getHost().getBot(botId)
    const value = await this.client.botBindingCommand({
      action: "list",
      botId,
      ...(before ? { before } : {})
    })
    if (!("items" in value) || principal !== this.identity())
      throw new Error("IM 身份已变化，请刷新")
    if (epoch !== this.epoch) throw new Error("连接已变化，请刷新绑定")
    const items = value.items.map((binding) => this.register(binding, principal))
    return {
      ...value,
      items: this.getHost().imGateway.visibleBindings(this.realm, principal, items)
    }
  }
  async revoke(botId: string, bindingId: string, expectedVersion: number): Promise<BotImBinding> {
    const epoch = this.epoch,
      principal = this.identity()
    const known = this.getHost().imGateway.binding(botImScopeId(this.realm, principal, bindingId))
    if (!known || known.binding.botId !== botId) throw new Error("绑定不属于当前 Bot")
    const value = await this.client.botBindingCommand({
      action: "revoke",
      bindingId,
      expectedVersion
    })
    if ("items" in value || principal !== this.identity()) throw new Error("IM 身份已变化，请刷新")
    if (epoch !== this.epoch) throw new Error("连接已变化，请刷新绑定")
    return this.register(value, principal)
  }
  remove(botId: string, bindingId: string): void {
    const principal = this.identity()
    this.getHost().getBot(botId)
    this.getHost().imGateway.removeBinding(botId, botImScopeId(this.realm, principal, bindingId))
  }
  history(botId: string, bindingId: string, before?: string) {
    const host = this.getHost(),
      principal = this.identity()
    const known = host.imGateway.binding(botImScopeId(this.realm, principal, bindingId))
    if (!known || known.binding.botId !== botId) throw new Error("绑定不属于当前 Bot")
    if (known.binding.state === "pending" || known.binding.state === "expired")
      return { items: [], before: null }
    try {
      return host.imChannel.history(botId, known.id, before)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND")
        return { items: [], before: null }
      throw error
    }
  }
  receive(payload: BotImEvent): Promise<void> {
    const epoch = this.epoch
    const run = this.receiving.then(() =>
      epoch === this.epoch ? this.receiveNow(payload, epoch) : undefined
    )
    this.receiving = run.catch(() => {})
    return run
  }
  private async receiveNow(payload: BotImEvent, epoch: number): Promise<void> {
    const principal = this.identity(),
      host = this.getHost(),
      wire = payload.event
    const old = host.imGateway.event(botImScopeId(this.realm, principal, wire.eventId))
    if (!old && host.imGateway.active().length >= 16) {
      await this.client.sendAcknowledgement({
        type: "busy",
        eventId: wire.eventId,
        leaseId: wire.lease.id
      })
      return
    }
    let receipt: StoredBotImEvent
    try {
      receipt = host.imGateway.receive(this.realm, principal, payload)
    } catch {
      await this.client.sendAcknowledgement({
        type: "failed",
        eventId: wire.eventId,
        leaseId: wire.lease.id,
        retryable: false,
        reasonCode: "BOT_BINDING_NOT_AUTHORIZED"
      })
      return
    }
    try {
      await this.client.sendAcknowledgement({
        type: "received",
        eventId: wire.eventId,
        leaseId: wire.lease.id
      })
      if (!["received", "active"].includes(receipt.state)) {
        await this.ackTerminal(receipt)
        return
      }
      if (old?.state === "active" && old.taskId) {
        if (old.leaseId !== wire.lease.id || old.expiresAt <= Date.now()) this.cancel(receipt)
        else
          await this.client.sendAcknowledgement({
            type: "accepted",
            eventId: wire.eventId,
            leaseId: wire.lease.id
          })
        return
      }
      const permit = await this.client.acquireBotPermit({
        eventId: wire.eventId,
        leaseId: wire.lease.id
      })
      const expiry = Date.parse(permit.expiresAt ?? "")
      if (
        permit.status !== "granted" ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now() ||
        epoch !== this.epoch ||
        this.stopped ||
        principal !== this.identity()
      ) {
        this.cancel(receipt)
        return
      }
      const registration = host.imGateway.binding(receipt.bindingId)!
      this.register(
        { ...registration.binding, state: "active", conversationKey: wire.conversationKey },
        principal
      )
      host.imGateway.settle(receipt.id, "active", undefined, expiry)
      if (
        !receipt.taskId &&
        /^\/(?:回答|批准|拒绝|文字模式)(?:\s|$)/u.test(wire.message.text.trim())
      ) {
        const { handleBotImInteractionCommand } = await import("./bot-interaction-command")
        await this.client.sendAcknowledgement({
          type: "accepted",
          eventId: wire.eventId,
          leaseId: wire.lease.id
        })
        await handleBotImInteractionCommand(payload, principal, receipt.id)
        host.imGateway.settle(receipt.id, "completed")
        await this.ackTerminal(host.imGateway.event(receipt.id)!)
        return
      }
      if (!receipt.taskId) {
        const accepted = host.acceptImEvent({
          bindingId: receipt.bindingId,
          eventId: receipt.id,
          messageId: botImScopeId(this.realm, principal, wire.platformMessageId),
          senderId: botImScopeId(this.realm, principal, payload.route.senderId),
          text: wire.message.text,
          mentionsBotIds: [payload.route.botId]
        })
        if (!accepted.taskId) throw new Error("已认证的 IM 事件没有创建执行记录")
        host.imGateway.settle(receipt.id, "active", accepted.taskId)
      }
      await this.client.sendAcknowledgement({
        type: "accepted",
        eventId: wire.eventId,
        leaseId: wire.lease.id
      })
    } catch (error) {
      this.cancel(receipt)
      throw error
    }
  }
  private cancel(event: StoredBotImEvent): void {
    const host = this.getHost()
    const current = host.imGateway.event(event.id)
    // Delayed revocation/renewal responses cannot turn an acknowledged result into an unknown one.
    if (!current || !["received", "active"].includes(current.state)) return
    host.imGateway.settle(event.id, "unknown", undefined, 0)
    for (let batch = 0; batch < 16; batch++) {
      const tasks = host.imGateway.pendingTasks(event.id)
      for (const task of tasks) {
        try {
          host.cancel(task)
        } catch (error) {
          this.reportError(error)
        }
      }
      if (tasks.length < 40) break
    }
  }
  private async ackTerminal(event: StoredBotImEvent): Promise<void> {
    const wire = event.payload.event
    await this.client.sendAcknowledgement(
      event.state === "completed"
        ? { type: "completed", eventId: wire.eventId, leaseId: event.leaseId }
        : {
            type: "failed",
            eventId: wire.eventId,
            leaseId: event.leaseId,
            retryable: false,
            reasonCode: event.state === "unknown" ? "EVENT_OUTCOME_UNKNOWN" : "BOT_EXECUTION_FAILED"
          }
    )
    this.getHost().imGateway.acknowledged(event.id)
  }
  async leaseRevoked(eventId: string): Promise<boolean> {
    const principal = this.client.getStatus().principalId
    if (!principal) return false
    const event = this.getHost().imGateway.event(botImScopeId(this.realm, principal, eventId))
    if (!event) return false
    this.cancel(event)
    return true
  }
  private async sync(): Promise<void> {
    const principal = this.identity()
    for (const botId of this.getHost().imGateway.botIds(this.realm, principal)) {
      let before: string | undefined
      const seen = new Set<string>()
      do {
        const page = await this.list(botId, before)
        before = page.before ?? undefined
        if (before && seen.has(before)) throw new Error("IM 绑定分页游标重复")
        if (before) seen.add(before)
      } while (before && !this.stopped)
    }
  }
  private expirePermits(): void {
    if (this.stopped || !this.client.supportsBotChannel()) return
    // Independent from slow network requests: an expired grant must stop local execution on time.
    for (const event of this.getHost().imGateway.active())
      if (event.expiresAt <= Date.now()) this.cancel(event)
  }
  private async syncBindings(): Promise<void> {
    if (
      this.syncing ||
      this.stopped ||
      !this.client.supportsBotChannel() ||
      Date.now() < this.nextSync
    )
      return
    this.syncing = true
    this.nextSync = Date.now() + 30000
    try {
      await this.sync()
    } catch (error) {
      this.reportError(error)
    } finally {
      this.syncing = false
    }
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || !this.client.supportsBotChannel()) return
    this.pumping = true
    const epoch = this.epoch
    try {
      const host = this.getHost(),
        principal = this.identity()
      const active = host.imGateway.active().filter((event) => {
        const route = host.imGateway.binding(event.bindingId)
        return route?.realm === this.realm && route.principal === principal
      })
      // Bounded concurrency keeps renewals independent of one slow lease while capping load at 4.
      for (let offset = 0; offset < active.length && epoch === this.epoch; offset += 4) {
        await Promise.all(
          active.slice(offset, offset + 4).map(async (event) => {
            try {
              if (!host.imGateway.pendingTasks(event.id).length && event.taskId) {
                host.imGateway.settle(event.id, host.imGateway.settledTaskOutcome(event.id))
              } else if (event.expiresAt - Date.now() < 60000) {
                const permit = await this.client.renewBotPermit({
                  eventId: event.payload.event.eventId,
                  leaseId: event.leaseId
                })
                const expiry = Date.parse(permit.expiresAt ?? "")
                if (epoch !== this.epoch || host.imGateway.event(event.id)?.state !== "active")
                  return
                if (
                  permit.status === "granted" &&
                  Number.isFinite(expiry) &&
                  expiry > Date.now() &&
                  !this.stopped
                )
                  host.imGateway.settle(event.id, "active", undefined, expiry)
                else this.cancel(event)
              }
            } catch (error) {
              this.cancel(event)
              this.reportError(error)
            }
          })
        )
      }
      if (epoch !== this.epoch) return
      for (const event of host.imGateway.pendingAcknowledgements(this.realm, principal))
        await this.ackTerminal(event)
    } catch (error) {
      this.reportError(error)
    } finally {
      this.pumping = false
    }
  }
  private async deliver(): Promise<void> {
    if (
      this.delivering ||
      this.stopped ||
      !this.client.supportsBotChannel() ||
      Date.now() < this.nextDelivery
    )
      return
    this.delivering = true
    const epoch = this.epoch
    const host = this.getHost()
    let reply: ReturnType<typeof host.imChannel.beginDelivery> = null
    try {
      reply = host.imChannel.beginDelivery()
      if (!reply) return
      const registered = host.imGateway.binding(reply.bindingId)
      if (
        !registered ||
        registered.realm !== this.realm ||
        registered.principal !== this.identity() ||
        registered.binding.state !== "active" ||
        !registered.binding.conversationKey
      ) {
        host.imChannel.delivered(reply.id, "blocked")
        return
      }
      const messages = buildImProactiveReplies({
        deliveryId: reply.id,
        conversationKey: registered.binding.conversationKey,
        text: reply.text,
        format: "markdown"
      })
      for (const message of messages) {
        if (this.stopped || epoch !== this.epoch) throw new Error("IM 连接已变化")
        if (!host.imChannel.mayDeliver(reply.id)) return
        const markdown =
          this.client.supportsMarkdownReplies?.() === true &&
          !this.usesTextReplies(registered.binding.conversationKey)
        const result = await submitFormattedImReply(this.client, {
          ...message,
          message: { ...message.message, type: markdown ? "markdown" : "text" }
        })
        if (result.state === "platform_unknown") {
          host.imChannel.delivered(reply.id, "unknown")
          return
        }
      }
      host.imChannel.delivered(reply.id, "accepted")
    } catch (error) {
      if (reply)
        host.imChannel.delivered(
          reply.id,
          error instanceof ImGatewayCommandError && error.resultUnknown
            ? "unknown"
            : error instanceof ImGatewayCommandError && error.permanent
              ? "blocked"
              : "pending"
        )
      this.nextDelivery = Date.now() + 5000
      this.reportError(error)
    } finally {
      this.delivering = false
    }
  }
  disconnected(): void {
    this.epoch++
    this.nextSync = 0
    const host = this.resolvedHost
    if (!host) return
    host.imChannel.setAllOffline()
    for (const event of host.imGateway.active()) this.cancel(event)
  }
  stop(): void {
    this.stopped = true
    this.releaseTransport()
    if (this.timer) clearInterval(this.timer)
    this.disconnected()
  }
}
