import { randomBytes } from "node:crypto"
import type { ImCardInteractionKind } from "../../../shared/im-gateway-contract"

/**
 * Tracks the cards this desktop has published and what each one is waiting on.
 *
 * Retention is the thread's: an entry is dropped when its thread is gone or its
 * request has been resolved, matching how approval short codes are pruned. It
 * deliberately does not survive a restart — the runs these cards gate do not
 * either, so a click arriving afterwards is genuinely stale and must be told so
 * rather than silently matched against a request that no longer exists.
 *
 * The gateway keeps the durable half (interactionId to platform message id), so
 * a forgotten interaction can still be updated to its terminal card.
 */

export interface ImCardInteraction {
  interactionId: string
  /**
   * Bearer capability the platform echoes on every click. High entropy is the
   * only thing standing between a click and someone else's approval: the
   * webhook is authenticated by source IP alone and carries no signature, so a
   * derivable tag would let a real, correctly-identified user act on a card
   * that was never theirs.
   */
  tag: string
  kind: ImCardInteractionKind
  /**
   * Null for a card that answers no run.
   *
   * Retention for every other card is its thread's: when the thread is gone the
   * request it gated is gone too. A target-bind card is published because the
   * reader asked for a list, so it has no thread to inherit from and uses
   * `expiresAt` instead.
   */
  threadId: string | null
  principalId: string
  conversationKey: string
  /** Stable identity of the request or notification this card answers. */
  requestRef: string
  targetLabel: string
  /** Monotonic; update-custom-card has no ordering guarantee of its own. */
  cardVersion: number
  createdAt: number
  /** Set only for thread-less cards; past it the card is collected. */
  expiresAt?: number
}

function createTag(): string {
  return randomBytes(24).toString("base64url")
}

export class ImCardInteractionStore {
  private readonly interactions = new Map<string, ImCardInteraction>()
  private readonly byTag = new Map<string, string>()

  constructor(
    private readonly createInteractionId: () => string = () => randomBytes(16).toString("hex"),
    private readonly now: () => number = Date.now
  ) {}

  register(input: {
    kind: ImCardInteractionKind
    threadId: string | null
    principalId: string
    conversationKey: string
    requestRef: string
    targetLabel: string
    expiresAt?: number
  }): ImCardInteraction {
    const interaction: ImCardInteraction = {
      interactionId: this.createInteractionId(),
      tag: createTag(),
      kind: input.kind,
      threadId: input.threadId,
      principalId: input.principalId,
      conversationKey: input.conversationKey,
      requestRef: input.requestRef,
      targetLabel: input.targetLabel,
      cardVersion: 1,
      createdAt: this.now(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
    }
    this.interactions.set(interaction.interactionId, interaction)
    this.byTag.set(interaction.tag, interaction.interactionId)
    return interaction
  }

  get(interactionId: string): ImCardInteraction | undefined {
    return this.interactions.get(interactionId)
  }

  /**
   * Resolves a click. `buttonTag` is the raw tag the platform echoed, which for
   * an operate button carries a `:decision` suffix the card itself appended.
   */
  resolveTag(buttonTag: string): { interaction: ImCardInteraction; suffix: string | null } | null {
    const separator = buttonTag.lastIndexOf(":")
    const candidates =
      separator > 0
        ? [
            { tag: buttonTag, suffix: null as string | null },
            { tag: buttonTag.slice(0, separator), suffix: buttonTag.slice(separator + 1) }
          ]
        : [{ tag: buttonTag, suffix: null as string | null }]
    for (const candidate of candidates) {
      const interactionId = this.byTag.get(candidate.tag)
      if (!interactionId) continue
      const interaction = this.interactions.get(interactionId)
      if (interaction) return { interaction, suffix: candidate.suffix }
    }
    return null
  }

  /** Claims the next version so two writers cannot publish the same one. */
  nextCardVersion(interactionId: string): number | null {
    const interaction = this.interactions.get(interactionId)
    if (!interaction) return null
    interaction.cardVersion += 1
    return interaction.cardVersion
  }

  findByRequestRef(requestRef: string): ImCardInteraction | undefined {
    for (const interaction of this.interactions.values()) {
      if (interaction.requestRef === requestRef) return interaction
    }
    return undefined
  }

  release(interactionId: string): void {
    const interaction = this.interactions.get(interactionId)
    if (!interaction) return
    this.interactions.delete(interactionId)
    this.byTag.delete(interaction.tag)
  }

  releaseByRequestRef(requestRef: string): ImCardInteraction | undefined {
    const interaction = this.findByRequestRef(requestRef)
    if (interaction) this.release(interaction.interactionId)
    return interaction
  }

  /**
   * Drops cards whose basis for existing is gone.
   *
   * Two bases, because a card either gates a run or does not. A thread-backed
   * card dies with its thread; a thread-less one dies at `expiresAt`, which the
   * publisher sets from whatever state the card renders. A card with neither
   * would never be collected, so `register` makes the pair exhaustive.
   */
  prune(isThreadLive: (threadId: string) => boolean, now = this.now()): void {
    for (const interaction of [...this.interactions.values()]) {
      const dead =
        interaction.threadId === null
          ? interaction.expiresAt !== undefined && interaction.expiresAt <= now
          : !isThreadLive(interaction.threadId)
      if (dead) this.release(interaction.interactionId)
    }
  }

  list(): ReadonlyArray<ImCardInteraction> {
    return [...this.interactions.values()]
  }

  clear(): void {
    this.interactions.clear()
    this.byTag.clear()
  }
}

export const imCardInteractionStore = new ImCardInteractionStore()
