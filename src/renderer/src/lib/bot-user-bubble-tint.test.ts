import { describe, expect, it } from "vitest"
import type { CoworkBot } from "../../../shared/bot-types"
import { COLORS } from "@/components/bots/upstream/grok-persona-geometry"
import { botUserBubbleTint } from "./use-bot-user-bubble-tint"

const bot = { id: "11111111-1111-4111-8111-111111111111", avatarColor: "red" } as Pick<
  CoworkBot,
  "id" | "avatarColor" | "avatarHash"
>
const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  return channels.reduce(
    (total, channel, index) =>
      total +
      [0.2126, 0.7152, 0.0722][index] *
        (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4),
    0
  )
}

describe("direct Bot user bubble palette", () => {
  it("uses the shipped Bot hue while keeping excluded conversation and persona identities neutral", () => {
    expect(botUserBubbleTint("direct", bot, true)).toMatchObject({
      "--bot-user-bubble-fill": "#c21d2e"
    })
    for (const kind of ["group", "peer", undefined] as const)
      expect(botUserBubbleTint(kind, bot, true)).toBeUndefined()
    expect(botUserBubbleTint("direct", { ...bot, avatarColor: "black" }, true)).toBeUndefined()
    expect(
      botUserBubbleTint("direct", { ...bot, avatarHash: "immutable-photo" }, true)
    ).toBeUndefined()
    expect(botUserBubbleTint("direct", undefined, true)).toBeUndefined()
    expect(botUserBubbleTint("direct", bot, false)).toBeUndefined()
  })

  it("keeps every colored fill's normal text at least 4.5:1 and deterministic fallback in the existing palette", () => {
    for (const color of Object.keys(COLORS).filter((color) => color !== "black")) {
      const style = botUserBubbleTint(
        "direct",
        { ...bot, avatarColor: color as CoworkBot["avatarColor"] },
        true
      ) as Record<string, string>
      const fill = luminance(style["--bot-user-bubble-fill"]),
        text = luminance(style["--bot-user-bubble-text"])
      expect(
        (Math.max(fill, text) + 0.05) / (Math.min(fill, text) + 0.05),
        color
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
