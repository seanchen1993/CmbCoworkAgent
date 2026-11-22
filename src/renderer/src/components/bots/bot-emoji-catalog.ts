export interface BotEmoji {
  native: string
  label: string
  search: string
  group: number
}
export interface BotEmojiCatalog {
  entries: BotEmoji[]
  groups: { order: number; message: string }[]
}
interface RawEmoji {
  unicode: string
  hexcode: string
  label: string
  group?: number
  tags?: string[]
  emoticon?: string
  skins?: RawEmoji[]
}
const normalize = (text: string) => text.replace(/(\p{Emoji_Presentation})\uFE0F/gu, "$1")
let loading: Promise<BotEmojiCatalog> | undefined
/** Loaded only after More; data comes from the official emojibase-data 17.0.0 release. */
export function loadBotEmojiCatalog(): Promise<BotEmojiCatalog> {
  return (loading ??= Promise.all([
    import("../../assets/emoji/compact.json"),
    import("../../assets/emoji/messages.json"),
    import("../../assets/emoji/iamcal.json"),
    import("../../assets/emoji/emojibase.json")
  ])
    .then(([compact, messages, iamcal, emojibase]) => {
      const primary = iamcal.default as Record<string, string | string[]>
      const secondary = emojibase.default as Record<string, string | string[]>
      const groups = messages.default.groups.filter((group) => group.key !== "component")
      const entries: BotEmoji[] = []
      for (const base of compact.default as RawEmoji[]) {
        if (base.group === undefined || base.group === 2) continue
        for (const item of [base, ...(base.skins ?? [])]) {
          const aliases = [primary[item.hexcode], secondary[item.hexcode]].flat().filter(Boolean)
          entries.push({
            native: normalize(item.unicode),
            label: item.label,
            group: base.group,
            search: [
              item.label,
              item.hexcode,
              ...aliases,
              ...(base.tags ?? []),
              item.emoticon ?? ""
            ]
              .join(" ")
              .toLowerCase()
          })
        }
      }
      return { entries, groups }
    })
    .catch((error) => {
      loading = undefined
      throw error
    }))
}
export function searchBotEmoji(entries: BotEmoji[], query: string): BotEmoji[] {
  const term = query.trim().toLowerCase().replace(/^:|:$/g, "")
  return term
    ? entries.filter((entry) => entry.search.includes(term) || entry.native === term).slice(0, 96)
    : entries
}
