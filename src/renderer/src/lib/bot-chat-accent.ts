// Grok's zf palette. Preserve persisted identities while displaying the matching palette tone.
const paletteAliases: Record<string, string> = {
  "#855c35": "#936439",
  "#ed2040": "#ff263c",
  "#ff7600": "#ff6700",
  "#ffb800": "#ff9800",
  "#009b62": "#00c972",
  "#00aa9b": "#00bca6",
  "#168bea": "#1084fe",
  "#9a65ee": "#9159fe",
  "#e32791": "#ff309b",
  "#808080": "#777777"
}
export const botAppearanceColor = (color: string): string =>
  paletteAliases[color.toLowerCase()] ?? color

// Grok 0.71.2's resolved fill/{hue}-bubble-user tokens (light, dark).
// The avatar's bright ink and a conversation bubble deliberately use different tones.
const bubbleColors: Record<string, readonly [string, string]> = {
  "#ff263c": ["#c82532", "#cf2b35"],
  "#ff6700": ["#d2550a", "#cd5309"],
  "#ff9800": ["#c2730b", "#c8770c"],
  "#00c972": ["#0d9655", "#0e9f5a"],
  "#00bca6": ["#0d9381", "#0e9886"],
  "#1084fe": ["#126fd4", "#116dd2"],
  "#9159fe": ["#7442d1", "#7845d7"],
  "#ff309b": ["#c82779", "#cf297e"],
  "#936439": ["#86592e", "#8c5d31"]
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
