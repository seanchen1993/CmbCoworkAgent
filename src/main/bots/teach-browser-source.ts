import type { Page } from "playwright"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import type { BotComputerClient } from "./computer-client"
import type { BotBrowserBroker } from "./browser-broker"
import type { BotTeachSource, BotTeachView } from "./teach-source"
import { teachHasSensitiveInput, teachInputDetails, teachSafeUrl } from "./teach-observation"

/** Adapter over the existing owned-page capture and human observer, unchanged browser semantics. */
export class BrowserBotTeachSource implements BotTeachSource {
  readonly backend = "browser" as const
  constructor(private readonly broker: BotBrowserBroker) {}
  target(botId: string): BotBrowserTarget {
    return this.broker.target(botId)
  }
  assertHumanClient(botId: string, client: BotComputerClient): void {
    this.broker.assertHumanClient(botId, client)
  }
  humanClientConnected(botId: string): boolean {
    return this.broker.humanClientConnected(botId)
  }
  async takeControl(
    target: BotBrowserTarget,
    conversationId: string,
    threadRootId: string | undefined,
    client: BotComputerClient
  ): Promise<void> {
    await this.broker.takeControl(target, conversationId, threadRootId, client)
  }
  encoderPage(): Promise<Page> {
    return this.broker.teachEncoderPage()
  }
  private view(page: Page): BotTeachView {
    return {
      hasSensitiveInput: () => teachHasSensitiveInput(page),
      capture: async () => ({
        image: await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }),
        title: (await page.title()).slice(0, 400),
        url: teachSafeUrl(page.url())
      })
    }
  }
  observe<T>(botId: string, operation: (view: BotTeachView) => Promise<T>): Promise<T> {
    return this.broker.teachObserve(botId, (page) => operation(this.view(page)))
  }
  attach(botId: string, callbacks: Parameters<BotTeachSource["attach"]>[1]): () => void {
    const beforeTransfer = (id: string) => callbacks.beforeTransfer(id)
    const input: NonNullable<BotBrowserBroker["humanObserver"]> = (
      id,
      page,
      action,
      phase,
      selection
    ) =>
      callbacks.input(
        id,
        this.view(page),
        {
          kind: action.kind,
          details: async () => ({
            ...(await teachInputDetails(page, action)),
            ...(selection ? { selection } : {})
          }),
          ...(selection ? { afterDetails: async () => ({ selection }) } : {})
        },
        phase
      )
    this.broker.teachRecordingBot = botId
    this.broker.beforeHumanTransfer = beforeTransfer
    this.broker.humanObserver = input
    return () => {
      if (this.broker.beforeHumanTransfer === beforeTransfer)
        this.broker.beforeHumanTransfer = undefined
      if (this.broker.humanObserver === input) this.broker.humanObserver = undefined
      if (this.broker.teachRecordingBot === botId) this.broker.teachRecordingBot = undefined
    }
  }
}
