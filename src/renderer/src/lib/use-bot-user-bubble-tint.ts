import { useMemo, useSyncExternalStore, type CSSProperties } from "react"
import type { CoworkBot } from "../../../shared/bot-types"
import { COLORS, resolvePersonaColor } from "@/components/bots/upstream/grok-persona-geometry"
import { getBotMessageTintEnabled, subscribeThemePreference } from "./theme-preference"

// Grok 0.68.1 uu/kF -> V4e selects the tenth light solid hue in both themes.
// Keep its shipped fill; dark text fixes the three fills whose white text is
// below WCAG's 4.5:1 normal-text contrast. Photo and black personas stay neutral.
const USER_FILL: Readonly<Record<string, string>> = {
  gray: "#5a5a5a",
  blue: "#0c64c1",
  red: "#c21d2e",
  orange: "#c24e00",
  yellow: "#c27400",
  green: "#009957",
  cyan: "#008f7e",
  violet: "#6e44c1",
  magenta: "#c22476",
  brown: "#734f2e"
}

type TintBot = Pick<CoworkBot, "id" | "avatarColor" | "avatarHash">

export function botUserBubbleTint(
  kind: "direct" | "group" | "peer" | undefined,
  bot: TintBot | undefined,
  enabled: boolean
): CSSProperties | undefined {
  if (!enabled || kind !== "direct" || !bot || bot.avatarHash) return undefined
  const color = resolvePersonaColor(bot.id, bot.avatarColor)
  const fill = USER_FILL[color]
  if (color === "black" || !COLORS[color] || !fill) return undefined
  return {
    "--bot-user-bubble-fill": fill,
    "--bot-user-bubble-text": ["yellow", "green", "cyan"].includes(color) ? "#141414" : "#fcfcfc"
  } as CSSProperties
}

const defaultEnabled = (): boolean => true

export function useBotUserBubbleTint(
  kind: "direct" | "group" | "peer" | undefined,
  bot: TintBot | undefined
): CSSProperties | undefined {
  const enabled = useSyncExternalStore(
    subscribeThemePreference,
    getBotMessageTintEnabled,
    defaultEnabled
  )
  const id = bot?.id
  const avatarColor = bot?.avatarColor
  const avatarHash = bot?.avatarHash
  return useMemo(
    () => botUserBubbleTint(kind, id ? { id, avatarColor, avatarHash } : undefined, enabled),
    [kind, id, avatarColor, avatarHash, enabled]
  )
}
