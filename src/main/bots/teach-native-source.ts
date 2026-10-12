import type { Page } from "playwright"
import type { BotBrowserTarget } from "../../shared/bot-computer"
import type {
  BotNativeDesktopTarget,
  BotNativeDesktopHumanInput
} from "../../shared/bot-native-desktop"
import { BotDomainError } from "../../shared/bot-types"
import type { BotComputerClient } from "./computer-client"
import type { NativeDesktopBroker } from "./native-desktop-broker"
import type { BotTeachSource, BotTeachView, BotTeachInput } from "./teach-source"

/** Broker-created callback capability: readonly worker operations inside its existing queue. */
export interface NativeDesktopTeachView {
  hasSensitiveInput(): Promise<boolean>
  capture(): Promise<{ image: string; title: string; viewId: string }>
}

/** Deliberately omit semantic values/text, accessible names, and the raw submitted input.
 * Native screenshots still require the conservative protected-control gate + manual pause. */
export function nativeTeachInputDetails(
  input: BotNativeDesktopHumanInput
): Record<string, unknown> {
  const action = input.action
  const details: Record<string, unknown> = { backend: "windows-native", operation: action.op }
  if ("elementId" in action) details.elementId = action.elementId
  if ("direction" in action) details.direction = action.direction
  if ("amount" in action) details.amount = action.amount
  if ("x" in action) {
    details.x = action.x
    details.y = action.y
  }
  if ("kind" in action) details.kind = action.kind
  if ("button" in action) details.button = action.button
  if ("delta" in action) details.delta = action.delta
  // Text and keys are not recorded here: typing a credential into a custom non-password
  // canvas must never make its plaintext part of the durable semantic event record.
  if ("value" in action || "text" in action || "key" in action) details.inputContentOmitted = true
  return details
}

export class NativeBotTeachSource implements BotTeachSource {
  readonly backend = "windows-native" as const
  private client?: BotComputerClient
  constructor(
    private readonly broker: NativeDesktopBroker,
    private readonly createEncoderPage: () => Promise<Page>
  ) {}
  target(botId: string): BotNativeDesktopTarget {
    return this.broker.target(botId)
  }
  assertHumanClient(botId: string, client: BotComputerClient): void {
    this.broker.assertHumanClient(botId, client)
    this.client = client
  }
  humanClientConnected(botId: string): boolean {
    if (!this.client) return false
    try {
      this.broker.assertHumanClient(botId, this.client)
      return true
    } catch {
      return false
    }
  }
  async takeControl(
    target: BotBrowserTarget,
    _conversationId: string,
    _threadRootId: string | undefined,
    client: BotComputerClient
  ): Promise<void> {
    await this.broker.takeControl({ ...target, backend: "windows-native" }, client)
    this.assertHumanClient(target.botId, client)
  }
  encoderPage(): Promise<Page> {
    return this.createEncoderPage()
  }
  private view(physical: NativeDesktopTeachView): BotTeachView {
    return {
      hasSensitiveInput: () => physical.hasSensitiveInput(),
      capture: async () => {
        const frame = await physical.capture()
        const prefix = "data:image/jpeg;base64,"
        if (!frame.image.startsWith(prefix) || frame.image.length > 3 * 1024 * 1024)
          throw new BotDomainError("teach_frame", "原生示范画面无效")
        const image = Buffer.from(frame.image.slice(prefix.length), "base64")
        if (!image.length || image.length > 2 * 1024 * 1024)
          throw new BotDomainError("teach_frame", "原生示范画面超出限制")
        return { image, title: frame.title.slice(0, 400), url: `native-window:${frame.viewId}` }
      }
    }
  }
  observe<T>(botId: string, operation: (view: BotTeachView) => Promise<T>): Promise<T> {
    if (!this.client) throw new BotDomainError("teach_scope", "请先接管原生电脑")
    return this.broker.teachObserve(botId, this.client, (physical) =>
      operation(this.view(physical))
    )
  }
  attach(botId: string, callbacks: Parameters<BotTeachSource["attach"]>[1]): () => void {
    const beforeTransfer = (id: string) => callbacks.beforeTransfer(id)
    const observer: NonNullable<NativeDesktopBroker["humanObserver"]> = (
      id,
      _target,
      action,
      phase,
      physical
    ) => {
      const input: BotTeachInput = {
        kind: action.action.op,
        ...(action.action.op === "message_pointer" || action.action.op === "message_keyboard"
          ? { afterOutcome: "submitted" as const }
          : {}),
        details: async () => nativeTeachInputDetails(action)
      }
      return callbacks.input(id, this.view(physical), input, phase)
    }
    this.broker.teachRecordingBot = botId
    this.broker.beforeHumanTransfer = beforeTransfer
    this.broker.humanObserver = observer
    return () => {
      if (this.broker.beforeHumanTransfer === beforeTransfer)
        this.broker.beforeHumanTransfer = undefined
      if (this.broker.humanObserver === observer) this.broker.humanObserver = undefined
      if (this.broker.teachRecordingBot === botId) this.broker.teachRecordingBot = undefined
      this.client = undefined
    }
  }
}
