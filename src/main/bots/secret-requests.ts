import { setTimeout as delay } from "node:timers/promises"
import type { BotSecretCard, BotSecretInput, BotSecretUseCard } from "../../shared/bot-secrets"
import type { BotRunLease } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotStore } from "./store"
import type { LocalBotComputerProvider } from "./computer-provider"
import {
  buildSecretProvidedAck,
  clampSecretLabel,
  clampSecretDescription
} from "./upstream/grok-secret-request"
import * as v from "./validation"
import { BotSecretVault } from "./secret-vault"

type Pending = { lease: BotRunLease; card: BotSecretCard; value?: string }

/** Only approved values in memory reach the exact browser field. No value is stored in SQL or graph state. */
export class BotSecretRequests {
  private readonly pending = new Map<string, Pending>()
  constructor(
    private readonly store: BotStore,
    private readonly computer: LocalBotComputerProvider,
    readonly vault = new BotSecretVault(undefined, store)
  ) {}

  async fill(
    request: BotRuntimeRequest,
    input: { id: string; revision: number; ref: string },
    callId: string,
    check: () => void,
    withApproval: (
      id: string,
      action: unknown,
      operation: () => Promise<string>,
      beforeStart?: () => Promise<void>
    ) => Promise<string>
  ): Promise<string> {
    check()
    const record = (await this.vault.list(request.bot.id)).items.find(
      (item) => item.id === input.id && item.revision === input.revision
    )
    if (!record) throw new Error("凭据已替换、删除或不属于此 Bot，请重新读取凭据列表")
    const broker = await this.computer.get()
    const destination = await broker.prepareSecret(
      await broker.ensure(request.bot.id),
      input.ref,
      check
    )
    try {
      if (record.origin !== destination.origin) throw new Error("凭据不允许用于此网站")
      const usage = {
        botId: request.bot.id,
        id: record.id,
        revision: record.revision,
        origin: destination.origin
      }
      const secretUse: BotSecretUseCard = {
        version: 1,
        credential: { id: record.id, name: record.name, revision: record.revision },
        destination: { botId: request.bot.id, ...destination }
      }
      return await withApproval(
        `saved-secret:${request.run.id}:${callId}`,
        { secretUse },
        async () => {
          await this.vault.use(usage, (value, assertCurrent) =>
            broker.fillSecret(
              destination.token,
              value,
              () => {
                check()
                assertCurrent()
              },
              request.signal
            )
          )
          return buildSecretProvidedAck({
            label: record.name,
            target: { kind: "browser password field" }
          })
        },
        () =>
          this.vault.use(usage, async (_value, assertCurrent) => {
            check()
            assertCurrent()
          })
      )
    } finally {
      await broker.discardSecret(destination.token)
    }
  }

  provide(input: BotSecretInput): void {
    v.record(input)
    v.identifier(input.id)
    v.integer(input.revision, "请求版本", 1, Number.MAX_SAFE_INTEGER)
    if (typeof input.value !== "string" || !input.value.length || input.value.length > 16_000)
      throw new Error("请输入有效的密码，最多 16000 个字符")
    const entry = this.pending.get(input.id),
      interaction = this.store.getInteraction(input.id)
    if (
      !entry ||
      entry.value !== undefined ||
      interaction.revision !== input.revision ||
      interaction.status !== "pending" ||
      interaction.expiresAt <= this.store.now()
    )
      throw new Error("安全输入请求已处理或失效，请刷新后查看")
    this.store.assertLease(entry.lease, true)
    entry.value = input.value
    try {
      // The ordinary answer contains no secret; only this trusted branch can approve the card.
      this.store.answerInteraction({ id: input.id, revision: input.revision, answer: "approve" })
    } catch (error) {
      entry.value = undefined
      throw error
    }
  }

  async request(
    request: BotRuntimeRequest,
    input: { label: string; description: string; ref: string },
    callId: string,
    check: () => void,
    notifyPermission?: (interactionId: string, key: string, action: unknown) => Promise<void>
  ): Promise<string> {
    const { lease, run, bot, signal } = request
    check()
    const effectId = `secret:${run.id}:${callId}`,
      previous = this.store.effectResult(lease, effectId)
    if (previous) {
      if (previous.status === "succeeded") return previous.result ?? "安全输入已完成"
      throw new Error("此安全输入已有未确认记录，请人工核对，勿自动重试")
    }
    const broker = await this.computer.get()
    const destination = await broker.prepareSecret(await broker.ensure(bot.id), input.ref, check)
    let interactionId: string | undefined
    try {
      check()
      const card: BotSecretCard = {
        version: 1,
        botId: bot.id,
        label: clampSecretLabel(input.label) || "网页密码",
        description: clampSecretDescription(input.description),
        ...destination
      }
      const action = { secretRequest: card }
      const interaction = this.store.requestInteraction(lease, {
        kind: "approval",
        prompt: JSON.stringify(action),
        action
      })
      interactionId = interaction.id
      const entry: Pending = { lease, card }
      this.pending.set(interaction.id, entry)
      // Register the secure channel before a notification can require its own approval.
      await notifyPermission?.(interaction.id, effectId, action)
      while (true) {
        signal.throwIfAborted()
        this.store.assertLease(lease, true)
        const current = this.store.getInteraction(interaction.id)
        if (current.status === "answered") {
          if (current.answer !== "approve")
            return "用户拒绝提供密码。请说明需要人工处理，不得改用普通聊天索取密码。"
          break
        }
        if (current.status !== "pending" || current.expiresAt <= this.store.now())
          throw new Error("安全输入请求已取消或过期")
        await delay(250, undefined, { signal })
      }
      check()
      if (entry.value === undefined) throw new Error("安全输入内容未收到，请重新请求")
      this.store.beginEffect(lease, { id: effectId, action, approvalId: interaction.id })
      try {
        const value = entry.value
        entry.value = undefined
        await broker.fillSecret(destination.token, value, check, signal)
        const result = buildSecretProvidedAck({
          label: card.label,
          target: { kind: "browser password field" }
        })
        this.store.settleEffect(lease, effectId, "succeeded", result)
        return result
      } catch {
        const message = "安全填充未确认，请人工核对网页状态，勿自动重试。"
        this.store.settleEffect(lease, effectId, "unknown", message)
        throw new Error(message)
      }
    } finally {
      if (interactionId) {
        const entry = this.pending.get(interactionId)
        if (entry) entry.value = undefined
        this.pending.delete(interactionId)
      }
      await broker.discardSecret(destination.token)
    }
  }
}
