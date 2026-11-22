import { describe, expect, it } from "vitest"
import nativeEmoji from "../../../shared/bots/reaction-emoji-native.json"
import { loadBotEmojiCatalog, searchBotEmoji } from "../components/bots/bot-emoji-catalog"

describe("official Emoji 17 catalog shared by picker and host", () => {
  it("keeps all selectable Unicode sequences and skin variants consistent with host validation", async () => {
    const catalog = await loadBotEmojiCatalog()
    expect(catalog.groups).toHaveLength(9)
    expect(catalog.entries).toHaveLength(3944)
    expect(new Set(catalog.entries.map((entry) => entry.native))).toEqual(new Set(nativeEmoji))
    expect(catalog.entries.find((entry) => entry.label === "trombone")?.native).toBe("🪊")
    expect(
      catalog.entries.find((entry) => entry.label === "waving hand: dark skin tone")?.native
    ).toBe("👋🏿")
    expect(catalog.entries.some((entry) => entry.label === "regional indicator A")).toBe(false)
  })
  it("searches labels and official shortcode aliases with bounded results", async () => {
    const { entries } = await loadBotEmojiCatalog()
    expect(searchBotEmoji(entries, ":thumbsup:").some((entry) => entry.native === "👍")).toBe(true)
    expect(
      searchBotEmoji(entries, "waving hand: dark skin tone").map((entry) => entry.native)
    ).toEqual(["👋🏿"])
    expect(searchBotEmoji(entries, "face").length).toBeLessThanOrEqual(96)
    expect(searchBotEmoji(entries, "no-such-emoji-exists")).toEqual([])
  })
})
