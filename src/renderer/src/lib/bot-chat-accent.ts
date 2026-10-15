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

/** Pick the higher-contrast text colour for a validated persisted Bot colour. */
export function botChatAccent(color: string | undefined): Record<string, string> {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return {}
  color = botAppearanceColor(color)
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
