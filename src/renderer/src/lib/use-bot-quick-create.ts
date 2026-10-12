import { useLayoutEffect, useMemo, useSyncExternalStore } from "react"
import { botApi } from "./bot-api"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { createBotQuickCreateController } from "./bot-quick-create"
import {
  resolvePersonaColor,
  resolvePersonaShape
} from "../components/bots/upstream/grok-persona-geometry"
import type { BotAvatarColor, BotAvatarShape } from "../../../shared/bot-persona"

/** One controller per Workspace; all Plus/shortcut/welcome entry points call the same start. */
export function useBotQuickCreate(onSelected?: (id: string) => void) {
  const controller = useMemo(
    () =>
      createBotQuickCreateController({
        scope: () => {
          const state = useBotWorkspaceStore.getState()
          return {
            hostId: state.host?.hostId,
            dataEpoch: state.snapshot?.dataEpoch ?? null,
            selected: state.selected,
            lease: state.viewportLease,
            capabilities: state.host?.capabilities ?? []
          }
        },
        defaults: (nonce) => ({
          name: "新 Bot",
          instructions: "",
          modelRef: null,
          workspacePath: null,
          connectorIds: [],
          harnessBinding: null,
          avatarShape: resolvePersonaShape(nonce) as BotAvatarShape,
          avatarColor: resolvePersonaColor(nonce) as BotAvatarColor
        }),
        create: (input) => botApi.create(input),
        refresh: (preserveSelection) =>
          useBotWorkspaceStore
            .getState()
            .refresh(preserveSelection ? { preserveSelection: true } : undefined),
        select: (id) => {
          useBotWorkspaceStore.getState().select(id)
        },
        validate: (receipt) => {
          const snapshot = useBotWorkspaceStore.getState().snapshot
          const target = snapshot?.conversations.find((item) => item.id === receipt.conversationId)
          return (
            target?.kind === "direct" &&
            target.members.length === 1 &&
            target.members[0] === receipt.bot.id &&
            snapshot?.bots.some((item) => item.id === receipt.bot.id && item.deletedAt === null) ===
              true
          )
        }
      }),
    []
  )
  useLayoutEffect(() => controller.onSelected(onSelected), [controller, onSelected])
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  useLayoutEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  return {
    state,
    start: controller.start,
    confirmReview: controller.confirmReview,
    cancelReview: controller.cancelReview,
    repair: controller.repair
  }
}
