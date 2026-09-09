import type {
  ImCardInteractionKind,
  RemoteImCardSendV1,
  RemoteImCardUpdateV1
} from "../../../shared/im-gateway-contract"
import {
  assertRemoteImCardSendV1,
  assertRemoteImCardUpdateV1
} from "../../../shared/im-gateway-contract"
import type { CardComponent } from "./card-builder"
import {
  imCardInteractionStore,
  type ImCardInteraction,
  type ImCardInteractionStore
} from "./card-interaction-store"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"

/**
 * Publishes interaction cards, and never lets one fail loudly.
 *
 * Every caller has already queued the durable text notice with its short code
 * before reaching here. A card that cannot be built, sent or updated therefore
 * costs the reader a nicer affordance and nothing else — so this module reports
 * failure by returning null and logging, never by throwing into a gate's
 * publication path where it could strand a run that waits forever.
 */

type CardWarn = (message: string, error?: unknown) => void

interface CardPublisherDependencies {
  gateway: ImGatewayClientPort
  interactions: ImCardInteractionStore
  createIdempotencyKey: () => string
  warn: CardWarn
}

export class ImCardPublisher {
  private readonly dependencies: CardPublisherDependencies

  constructor(overrides: Partial<CardPublisherDependencies> = {}) {
    this.dependencies = {
      gateway: overrides.gateway ?? unavailableImGatewayClient,
      interactions: overrides.interactions ?? imCardInteractionStore,
      createIdempotencyKey:
        overrides.createIdempotencyKey ??
        (() => `card:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`),
      warn: overrides.warn ?? (() => {})
    }
  }

  setGateway(gateway: ImGatewayClientPort): void {
    this.dependencies.gateway = gateway
  }

  get interactions(): ImCardInteractionStore {
    return this.dependencies.interactions
  }

  /**
   * Registers and sends one card. Returns the interaction when the gateway
   * accepted it, so the caller can later update it; null means the reader is
   * working from the text notice alone, which is always a valid outcome.
   */
  async publish(input: {
    kind: ImCardInteractionKind
    threadId: string
    principalId: string
    conversationKey: string
    requestRef: string
    targetLabel: string
    build: (tag: string) => CardComponent[]
  }): Promise<ImCardInteraction | null> {
    if (!this.dependencies.gateway.isAuthenticated()) return null
    const interaction = this.dependencies.interactions.register({
      kind: input.kind,
      threadId: input.threadId,
      principalId: input.principalId,
      conversationKey: input.conversationKey,
      requestRef: input.requestRef,
      targetLabel: input.targetLabel
    })
    try {
      const card: RemoteImCardSendV1 = {
        schemaVersion: 1,
        interactionId: interaction.interactionId,
        conversationKey: input.conversationKey,
        idempotencyKey: this.dependencies.createIdempotencyKey(),
        tag: interaction.tag,
        kind: input.kind,
        content: input.build(interaction.tag)
      }
      assertRemoteImCardSendV1(card)
      const result = await this.dependencies.gateway.sendCard(card)
      if (result.state !== "accepted") {
        this.dependencies.interactions.release(interaction.interactionId)
        this.dependencies.warn(
          `Zhaohu interaction card was not accepted (${result.reasonCode ?? "unknown"}); the short code remains the answer path.`
        )
        return null
      }
      return interaction
    } catch (error) {
      this.dependencies.interactions.release(interaction.interactionId)
      this.dependencies.warn("Zhaohu interaction card could not be published.", error)
      return null
    }
  }

  /**
   * Replaces a live card with its terminal form.
   *
   * `update-custom-card` carries no idempotency key and no ordering guarantee,
   * so the version claimed here is what lets the gateway drop an update that
   * lost a race — a click and a desktop resolution can land at the same moment
   * and the card must end on the one that actually decided the request.
   */
  async resolve(interactionId: string, content: CardComponent[]): Promise<boolean> {
    const cardVersion = this.dependencies.interactions.nextCardVersion(interactionId)
    if (cardVersion === null) return false
    try {
      const update: RemoteImCardUpdateV1 = {
        schemaVersion: 1,
        interactionId,
        cardVersion,
        content
      }
      assertRemoteImCardUpdateV1(update)
      const result = await this.dependencies.gateway.updateCard(update)
      if (result.state !== "accepted") {
        this.dependencies.warn(
          `Zhaohu interaction card was not updated (${result.reasonCode ?? "unknown"}); it still shows as pending.`
        )
        return false
      }
      return true
    } catch (error) {
      this.dependencies.warn("Zhaohu interaction card could not be updated.", error)
      return false
    } finally {
      this.dependencies.interactions.release(interactionId)
    }
  }

  /** Fire-and-forget variant for paths that must not await platform latency. */
  resolveDetached(interactionId: string, content: CardComponent[]): void {
    void this.resolve(interactionId, content).catch((error) => {
      this.dependencies.warn("Zhaohu interaction card resolution failed.", error)
    })
  }

  async acknowledgeReceipt(receiptId: string): Promise<void> {
    try {
      await this.dependencies.gateway.acknowledgeCardReceipt(receiptId)
    } catch (error) {
      this.dependencies.warn("Zhaohu card receipt acknowledgement failed.", error)
    }
  }
}

export const imCardPublisher = new ImCardPublisher()
