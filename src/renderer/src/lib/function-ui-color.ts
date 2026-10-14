import { CSS_VARIABLE_BY_PALETTE_KEY, type ThemePalette } from "./theme-registry"

/** Claude color names retain their meaning while following the person's DevClaw theme. */
const roles = {
  text: "foreground",
  inverseText: "background",
  inactive: "mutedForeground",
  subtle: "tertiaryForeground",
  suggestion: "statusInfo",
  remember: "statusInfo",
  success: "statusNominal",
  error: "statusCritical",
  warning: "statusWarning",
  merged: "accent",
  claude: "accent",
  permission: "accent",
  planMode: "accent",
  autoAccept: "statusNominal",
  promptBorder: "borderEmphasis",
  bashBorder: "statusWarning",
  ide: "statusInfo",
  diffAdded: "syntaxAddition",
  diffRemoved: "syntaxDeletion",
  diffAddedDimmed: "syntaxAddition",
  diffRemovedDimmed: "syntaxDeletion",
  diffAddedWord: "syntaxAddition",
  diffRemovedWord: "syntaxDeletion"
} as const satisfies Readonly<Record<string, keyof ThemePalette>>

/** Terminal names use Mods-only palette variables; explicit CSS colors stay author-controlled. */
const ansiColors = {
  "black": "black",
  "blackBright": "black",
  "red": "red",
  "redBright": "red",
  "green": "green",
  "greenBright": "green",
  "yellow": "yellow",
  "yellowBright": "yellow",
  "blue": "blue",
  "blueBright": "blue",
  "magenta": "magenta",
  "magentaBright": "magenta",
  "cyan": "cyan",
  "cyanBright": "cyan",
  "white": "white",
  "whiteBright": "white",
  "gray": "gray",
  "grey": "gray"
} as const

/** Color data only. Raw CSS colors and unknown names preserve their original value. */
export function functionUiColor(
  value: unknown,
  ansiMode: "adaptive" | "literal" = "adaptive"
): string | undefined {
  if (typeof value !== "string") return undefined
  if (Object.hasOwn(ansiColors, value)) {
    const name = ansiColors[value as keyof typeof ansiColors]
    return ansiMode === "literal" ? name : `var(--mods-ansi-${name})`
  }
  if (!Object.hasOwn(roles, value)) return value
  const role = roles[value as keyof typeof roles]
  const color = `var(${CSS_VARIABLE_BY_PALETTE_KEY[role]})`
  return value === "diffAddedDimmed" || value === "diffRemovedDimmed"
    ? `color-mix(in srgb, ${color} 65%, transparent)`
    : color
}
