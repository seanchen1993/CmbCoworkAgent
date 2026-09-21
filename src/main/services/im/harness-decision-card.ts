import type { AppNotification } from "../../../shared/app-notifications"
import {
  buildHarnessDecisionResolvedCard,
  type HarnessDecisionCardContext,
  type HarnessDecisionResolvedCardInput
} from "./card-builder"
import { imCardPublisher } from "./card-publisher"

type OutcomeStyle = HarnessDecisionResolvedCardInput["outcomeStyle"]

interface HarnessDecisionOutcome {
  outcome: string
  outcomeStyle: OutcomeStyle
}

export function resolveExpiredHarnessDecisionCard(input: {
  interactionId: string
  context: HarnessDecisionCardContext
  kind: HarnessDecisionResolvedCardInput["kind"]
}): void {
  imCardPublisher.resolveDetached(
    input.interactionId,
    buildHarnessDecisionResolvedCard({
      ...input.context,
      kind: input.kind,
      outcome: "已失效",
      outcomeStyle: "neutral",
      detail: "该请求已经结束。"
    })
  )
}

export function resolveHarnessDecisionCard(input: {
  notification: AppNotification
  context: HarnessDecisionCardContext
  kind: HarnessDecisionResolvedCardInput["kind"]
  describeOutcome: (
    notification: AppNotification,
    channelLabel: "APP" | "招乎"
  ) => HarnessDecisionOutcome
}): void {
  const interaction = imCardPublisher.interactions.findByRequestRef(
    input.notification.notificationId
  )
  if (!interaction) return

  const disabled = input.notification.status === "pending" && input.notification.disabledTargets?.im
  const described = disabled
    ? { outcome: "已转至 APP 处理", outcomeStyle: "neutral" as const }
    : input.describeOutcome(
        input.notification,
        input.notification.channel === "desktop" ? "APP" : "招乎"
      )

  imCardPublisher.resolveDetached(
    interaction.interactionId,
    buildHarnessDecisionResolvedCard({
      ...input.context,
      kind: input.kind,
      ...described,
      detail: disabled ? "IM 渠道已关闭，请在 APP 中处理。" : input.notification.result
    })
  )
}
