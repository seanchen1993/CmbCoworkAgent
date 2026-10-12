import type { Page } from "playwright"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import type { BotComputerClient } from "./computer-client"

/** A physical callback capability, valid only while its source owns the surface queue.
 * It never creates a second execution or learning graph. */
export interface BotTeachView {
  hasSensitiveInput(): Promise<boolean>
  capture(): Promise<{ image: Buffer; title: string; url: string }>
}
export interface BotTeachInput {
  kind: string
  /** A queued window message acknowledges submission, not application completion. */
  afterOutcome?: "completed" | "submitted"
  /** Called only after the before-capture sensitive gate; secrets must be omitted by the source. */
  details(): Promise<Record<string, unknown>>
  /** Trusted post-input facts, collected under the same sensitive-field gate. */
  afterDetails?(): Promise<Record<string, unknown>>
}
export interface BotTeachSource {
  readonly backend: "browser" | "windows-native"
  target(botId: string): BotBrowserTarget
  assertHumanClient(botId: string, client: BotComputerClient): void
  humanClientConnected(botId: string): boolean
  takeControl(
    target: BotBrowserTarget,
    conversationId: string,
    threadRootId: string | undefined,
    client: BotComputerClient
  ): Promise<void>
  encoderPage(): Promise<Page>
  observe<T>(botId: string, operation: (view: BotTeachView) => Promise<T>): Promise<T>
  attach(
    botId: string,
    callbacks: {
      beforeTransfer(botId: string): Promise<void>
      input(
        botId: string,
        view: BotTeachView,
        input: BotTeachInput,
        phase: "before" | "after" | "unconfirmed"
      ): Promise<void>
    }
  ): () => void
}
