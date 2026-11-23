// Grok 0.75 bright tokens. Preserve persisted palette identities and legacy aliases.
const paletteAliases: Record<string, string> = {
  "#855c35": "#a06b39",
  "#936439": "#a06b39",
  "#ed2040": "#fb2b3e",
  "#ff263c": "#fb2b3e",
  "#ff7600": "#fd690f",
  "#ff6700": "#fd690f",
  "#ffb800": "#f59312",
  "#ff9800": "#f59312",
  "#009b62": "#14c16f",
  "#00c972": "#14c16f",
  "#00aa9b": "#13b7a2",
  "#00bca6": "#13b7a2",
  "#168bea": "#1e86fc",
  "#1084fe": "#1e86fc",
  "#9a65ee": "#8f59f9",
  "#9159fe": "#8f59f9",
  "#e32791": "#f93498",
  "#ff309b": "#f93498",
  "#808080": "#777777"
}
export const botAppearanceColor = (color: string): string =>
  paletteAliases[color.toLowerCase()] ?? color

// Grok 0.71.2's resolved fill/{hue}-bubble-user tokens (light, dark).
// The avatar's bright ink and a conversation bubble deliberately use different tones.
const bubbleColors: Record<string, readonly [string, string]> = {
  "#fb2b3e": ["#c82532", "#cf2b35"],
  "#fd690f": ["#d2550a", "#cd5309"],
  "#f59312": ["#c2730b", "#c8770c"],
  "#14c16f": ["#0d9655", "#0e9f5a"],
  "#13b7a2": ["#0d9381", "#0e9886"],
  "#1e86fc": ["#126fd4", "#116dd2"],
  "#8f59f9": ["#7442d1", "#7845d7"],
  "#f93498": ["#c82779", "#cf297e"],
  "#a06b39": ["#86592e", "#8c5d31"]
}

/** Reuse the official palette without changing persisted identities or adding a theme engine. */
export function botChatAccent(color: string | undefined): Record<string, string> {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return {}
  color = botAppearanceColor(color).toLowerCase()
  if (color === "#242424" || color === "#777777") return {}
  const bubble = bubbleColors[color]
  if (bubble)
    return {
      "--bot-user-bubble-light": bubble[0],
      "--bot-user-bubble-dark": bubble[1],
      "--bot-user-text-light": "#ffffff",
      "--bot-user-text-dark": "#f5f5f5"
    }
  // Existing custom colours retain their contrast-aware fallback.
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return {
    "--bot-user-bubble": color,
    "--bot-user-text": (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000" : "#fff"
  }
}
