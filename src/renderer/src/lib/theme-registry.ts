export type ThemeColorScheme = "light" | "dark"

export interface ThemePalette {
  background: string
  backgroundSecondary: string
  backgroundElevated: string
  backgroundInteractive: string
  foreground: string
  border: string
  borderEmphasis: string
  input: string
  ring: string
  muted: string
  mutedForeground: string
  tertiaryForeground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  button: string
  buttonForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  statusCritical: string
  statusWarning: string
  statusNominal: string
  statusInfo: string
  statusCriticalForeground: string
  statusWarningForeground: string
  statusNominalForeground: string
  statusInfoForeground: string
  syntaxKeyword: string
  syntaxString: string
  syntaxNumber: string
  syntaxComment: string
  syntaxMeta: string
  syntaxAddition: string
  syntaxDeletion: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarHover: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  sidebarRing: string
}

interface CodexVariantSeed {
  surface: string
  ink: string
  accent: string
  contrast: number
  diffAdded: string
  diffRemoved: string
  skill: string
  syntax: readonly [keyword: string, string: string, number: string, comment: string, meta: string]
}

interface CodexFamilySeed {
  id: string
  label: string
  lightDescription?: string
  darkDescription?: string
  light?: CodexVariantSeed
  dark?: CodexVariantSeed
}

/**
 * Codex keeps chrome roles separate from the theme accent. These values are
 * copied from the installed desktop theme registrations (`button.*` and
 * `list.*`). Variants without an explicit source value use the common palette
 * derivation below.
 */
interface CodexChromeOverride {
  button?: string
  buttonForeground?: string
  sidebarHover?: string
}

const CODEX_CHROME_OVERRIDES: Readonly<Record<string, CodexChromeOverride>> = {
  "ayu-dark": {
    button: "#e6b450",
    buttonForeground: "#765b24",
    sidebarHover: "#47526640"
  },
  "catppuccin-light": {
    button: "#8839ef",
    buttonForeground: "#dce0e8",
    sidebarHover: "#ccd0da80"
  },
  "catppuccin-dark": {
    button: "#cba6f7",
    buttonForeground: "#11111b",
    sidebarHover: "#31324480"
  },
  "dracula-dark": {
    button: "#44475A",
    buttonForeground: "#F8F8F2",
    sidebarHover: "#44475A75"
  },
  "everforest-light": {
    button: "#93b259",
    buttonForeground: "#fdf6e3",
    sidebarHover: "#fdf6e300"
  },
  "everforest-dark": {
    button: "#a7c080",
    buttonForeground: "#2d353b",
    sidebarHover: "#2d353b00"
  },
  "github-light": {
    button: "#1f883d",
    buttonForeground: "#ffffff",
    sidebarHover: "#eaeef280"
  },
  "github-dark": {
    button: "#238636",
    buttonForeground: "#ffffff",
    sidebarHover: "#6e76811a"
  },
  "gruvbox-light": {
    button: "#45858880",
    buttonForeground: "#3c3836",
    sidebarHover: "#ebdbb280"
  },
  "gruvbox-dark": {
    button: "#45858880",
    buttonForeground: "#ebdbb2",
    sidebarHover: "#3c383680"
  },
  "material-dark": {
    button: "#80CBC420",
    buttonForeground: "#ffffff",
    sidebarHover: "#263238"
  },
  "monokai-dark": { button: "#75715E", sidebarHover: "#3e3d32" },
  "night-owl-dark": {
    button: "#7e57c2cc",
    buttonForeground: "#ffffffcc",
    sidebarHover: "#011627"
  },
  "nord-dark": {
    button: "#88c0d0ee",
    buttonForeground: "#2e3440",
    sidebarHover: "#3b4252"
  },
  "one-light": {
    button: "#5871EF",
    buttonForeground: "#FFFFFF",
    sidebarHover: "#DBDBDC66"
  },
  "one-dark": { button: "#404754", sidebarHover: "#2c313a" },
  "raycast-light": {
    button: "#138AF2",
    buttonForeground: "#FFFFFF",
    sidebarHover: "#0000000f"
  },
  "raycast-dark": {
    button: "#4FA3F8",
    buttonForeground: "#FFFFFF",
    sidebarHover: "#FFFFFF14"
  },
  "rose-pine-light": {
    button: "#d7827e",
    buttonForeground: "#faf4ed",
    sidebarHover: "#6e6a860d"
  },
  "rose-pine-dark": {
    button: "#ea9a97",
    buttonForeground: "#232136",
    sidebarHover: "#817c9c14"
  },
  "solarized-light": { button: "#AC9D57", sidebarHover: "#DFCA8844" },
  "solarized-dark": { button: "#2AA19899", sidebarHover: "#004454AA" },
  "tokyo-night-dark": {
    button: "#3d59a1dd",
    buttonForeground: "#ffffff",
    sidebarHover: "#13131a"
  }
}

export interface ThemeDefinition {
  id: ThemeId
  familyId: string
  label: string
  description: string
  source: string
  colorScheme: ThemeColorScheme
  palette: ThemePalette
}

const variant = (
  surface: string,
  ink: string,
  accent: string,
  diffAdded: string,
  diffRemoved: string,
  skill: string,
  syntax: CodexVariantSeed["syntax"],
  contrast: number
): CodexVariantSeed => ({
  surface,
  ink,
  accent,
  contrast,
  diffAdded,
  diffRemoved,
  skill,
  syntax
})

const light = (
  surface: string,
  ink: string,
  accent: string,
  diffAdded: string,
  diffRemoved: string,
  skill: string,
  syntax: CodexVariantSeed["syntax"],
  contrast = 45
): CodexVariantSeed =>
  variant(surface, ink, accent, diffAdded, diffRemoved, skill, syntax, contrast)

const dark = (
  surface: string,
  ink: string,
  accent: string,
  diffAdded: string,
  diffRemoved: string,
  skill: string,
  syntax: CodexVariantSeed["syntax"],
  contrast = 60
): CodexVariantSeed =>
  variant(surface, ink, accent, diffAdded, diffRemoved, skill, syntax, contrast)

/**
 * Extracted from the theme registrations bundled with Codex Desktop
 * 26.818.41509. These are Codex's own chrome-theme seeds and syntax colors,
 * not hand-authored approximations.
 */
const CODEX_THEME_FAMILIES: readonly CodexFamilySeed[] = [
  {
    id: "absolutely",
    label: "Absolutely",
    lightDescription: "暖白配陶土橙，柔和自然",
    darkDescription: "炭灰配陶土橙，温暖沉稳",
    light: light("#f9f9f7", "#2d2d2b", "#cc7d5e", "#00a240", "#ba2623", "#cc7d5e", [
      "#ff5f38",
      "#00c853",
      "#ff5f38",
      "#939391",
      "#2d2d2b"
    ]),
    dark: dark("#2d2d2b", "#f9f9f7", "#cc7d5e", "#40c977", "#fa423e", "#cc7d5e", [
      "#ff5f38",
      "#00c853",
      "#ff5f38",
      "#b2b2b0",
      "#f9f9f7"
    ])
  },
  {
    id: "ayu",
    label: "Ayu",
    darkDescription: "墨蓝黑配琥珀金，清晰锐利",
    dark: dark("#10141c", "#bfbdb6", "#e6b450", "#70bf56", "#f26d78", "#d0a1ff", [
      "#ff8f40",
      "#aad94c",
      "#d2a6ff",
      "#5a6673",
      "#ffb454"
    ])
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    lightDescription: "雾白配葡萄紫，柔和清甜",
    darkDescription: "粉紫深底配淡紫，柔和低饱和",
    light: light("#eff1f5", "#4c4f69", "#8839ef", "#40a02b", "#d20f39", "#8839ef", [
      "#fe640b",
      "#40a02b",
      "#fe640b",
      "#7c7f93",
      "#1e66f5"
    ]),
    dark: dark("#1e1e2e", "#cdd6f4", "#cba6f7", "#a6e3a1", "#f38ba8", "#cba6f7", [
      "#fab387",
      "#a6e3a1",
      "#fab387",
      "#9399b2",
      "#89b4fa"
    ])
  },
  {
    id: "codex",
    label: "Codex",
    lightDescription: "纯白配系统蓝，清爽克制",
    darkDescription: "近黑配系统蓝，中性克制",
    light: light("#ffffff", "#0d0d0d", "#0169cc", "#00a240", "#e02e2a", "#751ed9", [
      "#d53538",
      "#008809",
      "#0071ea",
      "#666666",
      "#751ed9"
    ]),
    dark: dark("#111111", "#fcfcfc", "#0169cc", "#00a240", "#e02e2a", "#b06dff", [
      "#f67576",
      "#85df7b",
      "#6dcbf4",
      "#999999",
      "#b06dff"
    ])
  },
  {
    id: "dracula",
    label: "Dracula",
    darkDescription: "深紫灰配亮粉，鲜明高对比",
    dark: dark("#282a36", "#f8f8f2", "#ff79c6", "#50fa7b", "#ff5555", "#ff79c6", [
      "#bd93f9",
      "#ff79c6",
      "#ff79c6",
      "#6272a4",
      "#50fa7b"
    ])
  },
  {
    id: "everforest",
    label: "Everforest",
    lightDescription: "暖米黄配草木绿，自然护眼",
    darkDescription: "森林灰配苔藓绿，柔和护眼",
    light: light("#fdf6e3", "#5c6a72", "#93b259", "#8da101", "#f85552", "#df69ba", [
      "#f85552",
      "#dfa000",
      "#df69ba",
      "#939f91",
      "#8da101"
    ]),
    dark: dark("#2d353b", "#d3c6aa", "#a7c080", "#a7c080", "#e67e80", "#d699b6", [
      "#e67e80",
      "#dbbc7f",
      "#d699b6",
      "#859289",
      "#a7c080"
    ])
  },
  {
    id: "github",
    label: "GitHub",
    lightDescription: "纯白配链接蓝，熟悉清晰",
    darkDescription: "深海黑配亮蓝，开发者风格",
    light: light("#ffffff", "#1f2328", "#0969da", "#1a7f37", "#cf222e", "#8250df", [
      "#cf222e",
      "#6e7781",
      "#0969da",
      "#6e7781",
      "#8250df"
    ]),
    dark: dark("#0d1117", "#e6edf3", "#1f6feb", "#3fb950", "#f85149", "#bc8cff", [
      "#ff7b72",
      "#8b949e",
      "#1f6feb",
      "#8b949e",
      "#d2a8ff"
    ])
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    lightDescription: "复古米黄配青绿，温暖怀旧",
    darkDescription: "复古棕黑配青绿，低亮护眼",
    light: light("#fbf1c7", "#3c3836", "#458588", "#3c3836", "#cc241d", "#b16286", [
      "#9d0006",
      "#79740e",
      "#458588",
      "#928374",
      "#689d6a"
    ]),
    dark: dark("#282828", "#ebdbb2", "#458588", "#ebdbb2", "#cc241d", "#b16286", [
      "#fb4934",
      "#b8bb26",
      "#458588",
      "#928374",
      "#689d6a"
    ])
  },
  {
    id: "linear",
    label: "Linear",
    lightDescription: "冷白配靛蓝，简洁现代",
    darkDescription: "极深灰配靛蓝，利落现代",
    light: light("#fcfcfd", "#1b1b1b", "#5e6ad2", "#52a450", "#c94446", "#8160d8", [
      "#5e6ad2",
      "#0f8f83",
      "#b4831f",
      "#8a93a6",
      "#8160d8"
    ]),
    dark: dark("#0f0f11", "#e3e4e6", "#606acc", "#69c967", "#ff7e78", "#c2a1ff", [
      "#8c97ff",
      "#7ad9c0",
      "#f5c56a",
      "#636b7b",
      "#c2a1ff"
    ])
  },
  {
    id: "lobster",
    label: "Lobster",
    darkDescription: "藏蓝黑配珊瑚红，活泼醒目",
    dark: dark("#111827", "#e4e4e7", "#ff5c5c", "#40c977", "#fa423e", "#ff5c5c", [
      "#ff5c5c",
      "#14b8a6",
      "#f59e0b",
      "#71717a",
      "#22c55e"
    ])
  },
  {
    id: "material",
    label: "Material",
    darkDescription: "石墨黑配青瓷绿，清透沉稳",
    dark: dark("#212121", "#eeffff", "#80cbc4", "#c3e88d", "#f07178", "#c792ea", [
      "#f78c6c",
      "#c3e88d",
      "#f78c6c",
      "#545454",
      "#eeffff"
    ])
  },
  {
    id: "matrix",
    label: "Matrix",
    darkDescription: "纯黑配荧光绿，赛博终端感",
    dark: dark("#040805", "#b8ffca", "#1eff5a", "#40c977", "#fa423e", "#1eff5a", [
      "#1eff5a",
      "#7dff95",
      "#55ff7d",
      "#3f8f52",
      "#9bffb8"
    ])
  },
  {
    id: "monokai",
    label: "Monokai",
    darkDescription: "橄榄黑配复古彩色，经典编辑器",
    dark: dark("#272822", "#f8f8f2", "#99947c", "#86b42b", "#c4265e", "#8c6bc8", [
      "#f92672",
      "#e6db74",
      "#ae81ff",
      "#88846f",
      "#a6e22e"
    ])
  },
  {
    id: "night-owl",
    label: "Night Owl",
    darkDescription: "深夜蓝配雾蓝，适合夜间阅读",
    dark: dark("#011627", "#d6deeb", "#44596b", "#c5e478", "#ef5350", "#c792ea", [
      "#c792ea",
      "#ecc48d",
      "#f78c6c",
      "#637777",
      "#c792ea"
    ])
  },
  {
    id: "nord",
    label: "Nord",
    darkDescription: "极地蓝灰配冰川蓝，冷静低饱和",
    dark: dark("#2e3440", "#d8dee9", "#88c0d0", "#a3be8c", "#bf616a", "#b48ead", [
      "#81a1c1",
      "#a3be8c",
      "#b48ead",
      "#616e88",
      "#88c0d0"
    ])
  },
  {
    id: "notion",
    label: "Notion",
    lightDescription: "纸白配知识库蓝，简洁文档感",
    darkDescription: "炭黑配知识库蓝，安静文档感",
    light: light("#ffffff", "#37352f", "#3183d8", "#00a240", "#ba2623", "#3183d8", [
      "#0000ff",
      "#a31515",
      "#098658",
      "#008000",
      "#795e26"
    ]),
    dark: dark("#191919", "#d9d9d8", "#3183d8", "#40c977", "#fa423e", "#3183d8", [
      "#569cd6",
      "#ce9178",
      "#b5cea8",
      "#6a9955",
      "#dcdcaa"
    ])
  },
  {
    id: "one",
    label: "One",
    lightDescription: "浅灰白配亮靛蓝，明快经典",
    darkDescription: "蓝灰配柔和蓝，沉静经典",
    light: light("#fafafa", "#383a42", "#526fff", "#00a240", "#ba2623", "#526fff", [
      "#a626a4",
      "#50a14f",
      "#986801",
      "#a0a1a7",
      "#0184bc"
    ]),
    dark: dark("#282c34", "#abb2bf", "#4d78cc", "#8cc265", "#e05561", "#c162de", [
      "#c678dd",
      "#98c379",
      "#d19a66",
      "#7f848e",
      "#61afef"
    ])
  },
  {
    id: "oscurange",
    label: "Oscurange",
    darkDescription: "墨黑配蜜桃橙，暖色高对比",
    dark: dark("#0b0b0f", "#e6e6e6", "#f9b98c", "#40c977", "#fa423e", "#f9b98c", [
      "#9099a1",
      "#e6e6e6",
      "#f9b98c",
      "#46474f",
      "#f9b98c"
    ])
  },
  {
    id: "proof",
    label: "Proof",
    lightDescription: "纸张米灰配墨绿，专注审阅阅读",
    light: light("#f5f3ed", "#2f312d", "#3d755d", "#00a240", "#ba2623", "#3d755d", [
      "#5f6ac2",
      "#3d755d",
      "#d3b45b",
      "#8b877c",
      "#3d755d"
    ])
  },
  {
    id: "raycast",
    label: "Raycast",
    lightDescription: "纯白配珊瑚红，轻快醒目",
    darkDescription: "纯黑配珊瑚红，强烈醒目",
    light: light("#ffffff", "#030303", "#ff6363", "#006b4f", "#b12424", "#9a1b6e", [
      "#000000",
      "#c03030",
      "#000000",
      "#999999",
      "#666666"
    ]),
    dark: dark("#101010", "#fefefe", "#ff6363", "#59d499", "#ff6363", "#cf2f98", [
      "#ffffff",
      "#ff6363",
      "#ffffff",
      "#666666",
      "#999999"
    ])
  },
  {
    id: "rose-pine",
    label: "Rose Pine",
    lightDescription: "暖粉米白配玫瑰粉，柔雅舒缓",
    darkDescription: "紫灰夜色配玫瑰粉，柔雅沉静",
    light: light("#faf4ed", "#575279", "#d7827e", "#56949f", "#797593", "#907aa9", [
      "#286983",
      "#ea9d34",
      "#d7827e",
      "#9893a5",
      "#b4637a"
    ]),
    dark: dark("#232136", "#e0def4", "#ea9a97", "#9ccfd8", "#908caa", "#c4a7e7", [
      "#3e8fb0",
      "#f6c177",
      "#ea9a97",
      "#6e6a86",
      "#eb6f92"
    ])
  },
  {
    id: "sentry",
    label: "Sentry",
    darkDescription: "紫炭灰配亮紫，技术监控感",
    dark: dark("#2d2935", "#e6dff9", "#7055f6", "#40c977", "#fa423e", "#7055f6", [
      "#7055f6",
      "#8ee6d7",
      "#f4c46a",
      "#8d849f",
      "#a58cff"
    ])
  },
  {
    id: "solarized",
    label: "Solarized",
    lightDescription: "经典米黄配赭金，低对比护眼",
    darkDescription: "深青配红色强调，经典护眼",
    light: light("#fdf6e3", "#657b83", "#b58900", "#859900", "#dc322f", "#d33682", [
      "#859900",
      "#2aa198",
      "#d33682",
      "#93a1a1",
      "#268bd2"
    ]),
    dark: dark("#002b36", "#839496", "#d30102", "#859900", "#dc322f", "#d33682", [
      "#859900",
      "#2aa198",
      "#d33682",
      "#586e75",
      "#268bd2"
    ])
  },
  {
    id: "temple",
    label: "Temple",
    darkDescription: "墨绿黑配荧光黄绿，神秘醒目",
    dark: dark("#02120c", "#c7e6da", "#e4f222", "#40c977", "#fa423e", "#e4f222", [
      "#e4f222",
      "#e4f222",
      "#e4f222",
      "#394d46",
      "#e4f222"
    ])
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    darkDescription: "东京夜蓝配靛蓝，冷静霓虹",
    dark: dark("#1a1b26", "#a9b1d6", "#3d59a1", "#449dab", "#914c54", "#9d7cd8", [
      "#5a638c",
      "#51597d",
      "#ff9e64",
      "#51597d",
      "#0db9d7"
    ])
  },
  {
    id: "vercel",
    label: "Vercel",
    lightDescription: "纯白黑字配品牌蓝，极简高对比",
    darkDescription: "纯黑白字配品牌蓝，极简高对比",
    light: light(
      "#ffffff",
      "#171717",
      "#006aff",
      "#28a948",
      "#eb001d",
      "#a100f8",
      ["#006aff", "#28a948", "#a100f8", "#666666", "#a100f8"],
      40
    ),
    dark: dark(
      "#000000",
      "#ededed",
      "#006efe",
      "#00ad3a",
      "#f13342",
      "#9540d5",
      ["#006efe", "#00ad3a", "#9540d5", "#666666", "#9540d5"],
      50
    )
  },
  {
    id: "vscode-plus",
    label: "VS Code Plus",
    lightDescription: "纯白配明亮蓝，清晰实用",
    darkDescription: "深灰配明亮蓝，沉稳实用",
    light: light("#ffffff", "#000000", "#007acc", "#00a240", "#ba2623", "#007acc", [
      "#098658",
      "#a31515",
      "#098658",
      "#008000",
      "#0000ff"
    ]),
    dark: dark("#1e1e1e", "#d4d4d4", "#007acc", "#40c977", "#fa423e", "#007acc", [
      "#b5cea8",
      "#ce9178",
      "#b5cea8",
      "#6a9955",
      "#569cd6"
    ])
  },
  {
    id: "xcode",
    label: "Xcode",
    lightDescription: "纯白配电光蓝，清晰明快",
    darkDescription: "深灰配亮蓝，专业沉稳",
    light: light("#ffffff", "#000000", "#0e0eff", "#00a240", "#ba2623", "#0e0eff", [
      "#9b2393",
      "#c41a16",
      "#1c00cf",
      "#5d6c79",
      "#326d74"
    ]),
    dark: dark("#1f1f24", "#ffffff", "#5482ff", "#40c977", "#fa423e", "#5482ff", [
      "#fc5fa3",
      "#fc6a5d",
      "#d0bf69",
      "#6c7986",
      "#67b7a4"
    ])
  }
]

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0")
}

function mix(from: string, to: string, amount: number): string {
  const left = hexToRgb(from)
  const right = hexToRgb(to)
  const ratio = Math.min(1, Math.max(0, amount))
  return `#${left.map((value, index) => toHex(value + (right[index] - value) * ratio)).join("")}`
}

function alpha(color: string, opacity: number): string {
  const [red, green, blue] = hexToRgb(color)
  return `rgb(${red} ${green} ${blue} / ${Math.min(1, Math.max(0, opacity))})`
}

function isFullyTransparent(color: string): boolean {
  const normalized = color.trim().toLowerCase()
  return normalized === "transparent" || /^#[0-9a-f]{6}00$/.test(normalized)
}

/**
 * The `text-on-accent` decision used by Codex Desktop's theme runtime.
 * It is used for dark-theme accent surfaces. CMB's filled primary actions
 * intentionally keep a white foreground in light themes, matching the
 * classic CMBDevClaw button treatment instead of turning their glyphs black.
 */
function codexTextOnAccent(color: string): string {
  const [red, green, blue] = hexToRgb(color)
  const linearize = (channel: number) => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)

  if (blue > red && blue > green) {
    const chroma = blue - Math.min(red, green)
    const hue = ((red - green) / chroma + 4) * 60
    const isStrongAzure = chroma / blue >= 0.8 && hue >= 205 && hue <= 212
    const isMediumBlue = chroma / blue >= 0.6 && hue >= 218 && hue <= 233 && luminance <= 0.21

    if (isStrongAzure || isMediumBlue) return "#ffffff"
  }

  return luminance > 0.179 ? "#000000" : "#ffffff"
}

function normalizedContrast(seed: CodexVariantSeed, colorScheme: ThemeColorScheme): number {
  const baseline = colorScheme === "light" ? 45 : 60
  const interpolated = seed.contrast / 100 + ((seed.contrast - baseline) / 60) * 0.7
  return seed.contrast <= baseline
    ? interpolated
    : baseline / 100 + (interpolated - baseline / 100) * 2
}

function defineCodexTheme(
  family: CodexFamilySeed,
  colorScheme: ThemeColorScheme,
  seed: CodexVariantSeed
): ThemeDefinition {
  const themeId = `${family.id}-${colorScheme}`
  const chrome = CODEX_CHROME_OVERRIDES[themeId]
  const contrast = normalizedContrast(seed, colorScheme)
  const isLight = colorScheme === "light"
  const whiteOrInk = isLight ? "#ffffff" : seed.ink
  const interactiveOpacity = isLight ? 0.04 + contrast * 0.02 : 0.04 + contrast * 0.03
  const elevatedOpacity = isLight ? 0.18 + contrast * 0.008 : 0.03 + contrast * 0.03
  const cardOpacity = isLight ? 0.16 + contrast * 0.12 : 0.08 + contrast * 0.08
  const accentForeground = isLight
    ? seed.accent
    : mix(seed.accent, "#ffffff", 0.3 + contrast * 0.15)
  const accentBackground = isLight
    ? mix(seed.surface, seed.accent, 0.11 + contrast * 0.04)
    : mix("#000000", seed.accent, 0.2 + contrast * 0.08)
  const primary = seed.accent
  const primaryForeground = isLight ? "#ffffff" : codexTextOnAccent(primary)
  const button = chrome?.button ?? primary
  const buttonForeground =
    chrome?.buttonForeground ?? (isLight ? "#ffffff" : codexTextOnAccent(button))
  const border = alpha(seed.ink, 0.06 + contrast * 0.04)
  const borderEmphasis = alpha(seed.ink, (isLight ? 0.09 : 0.12) + contrast * 0.06)
  const backgroundElevated = mix(seed.surface, whiteOrInk, elevatedOpacity)
  const card = mix(seed.surface, whiteOrInk, cardOpacity)
  const backgroundInteractive = mix(seed.surface, seed.ink, interactiveOpacity)
  const sidebar = isLight ? mix(seed.surface, seed.ink, 0.04) : mix(seed.surface, "#000000", 0.16)
  const sidebarHoverFallback = alpha(seed.ink, isLight ? 0.05 : 0.08)
  const sidebarHover =
    chrome?.sidebarHover && !isFullyTransparent(chrome.sidebarHover)
      ? chrome.sidebarHover
      : sidebarHoverFallback
  const description = colorScheme === "light" ? family.lightDescription : family.darkDescription

  if (!description) {
    throw new Error(`Missing ${colorScheme} description for Codex theme ${family.id}`)
  }

  return {
    id: themeId,
    familyId: family.id,
    label: family.label,
    description,
    source: "Codex Desktop 26.818.41509",
    colorScheme,
    palette: {
      background: seed.surface,
      backgroundSecondary: sidebar,
      backgroundElevated,
      backgroundInteractive,
      foreground: seed.ink,
      border,
      borderEmphasis,
      input: borderEmphasis,
      ring: isLight ? seed.accent : alpha(accentForeground, 0.7 + contrast * 0.1),
      muted: alpha(seed.ink, 0.1),
      mutedForeground: alpha(seed.ink, 0.65 + contrast * 0.1),
      tertiaryForeground: alpha(
        seed.ink,
        (isLight ? 0.45 : 0.42) + contrast * (isLight ? 0.1 : 0.13)
      ),
      card,
      cardForeground: seed.ink,
      popover: card,
      popoverForeground: seed.ink,
      primary,
      primaryForeground,
      button,
      buttonForeground,
      secondary: backgroundInteractive,
      secondaryForeground: seed.ink,
      accent: accentBackground,
      accentForeground,
      destructive: seed.diffRemoved,
      destructiveForeground: codexTextOnAccent(seed.diffRemoved),
      statusCritical: seed.diffRemoved,
      statusWarning: seed.syntax[2],
      statusNominal: seed.diffAdded,
      statusInfo: accentForeground,
      statusCriticalForeground: isLight ? "#E02E2A" : "#FF6764",
      statusWarningForeground: isLight ? "#E25507" : "#FF8549",
      statusNominalForeground: isLight ? "#00A240" : "#40C977",
      statusInfoForeground: accentForeground,
      syntaxKeyword: seed.syntax[0],
      syntaxString: seed.syntax[1],
      syntaxNumber: seed.syntax[2],
      syntaxComment: seed.syntax[3],
      syntaxMeta: seed.syntax[4],
      syntaxAddition: seed.diffAdded,
      syntaxDeletion: seed.diffRemoved,
      sidebar,
      sidebarForeground: seed.ink,
      sidebarPrimary: seed.accent,
      sidebarPrimaryForeground: primaryForeground,
      sidebarHover,
      sidebarAccent: sidebarHover,
      sidebarAccentForeground: seed.ink,
      sidebarBorder: border,
      sidebarRing: seed.accent
    }
  }
}

const cmbdevclawWhite: ThemeDefinition = {
  id: "cmbdevclaw-white",
  familyId: "cmbdevclaw",
  label: "CMBDevClaw 白",
  description: "经典米白与棕金配色",
  source: "CMBDevClaw Classic",
  colorScheme: "light",
  palette: {
    background: "#FAF9F6",
    backgroundSecondary: "#F5F3EF",
    backgroundElevated: "#FFFFFF",
    backgroundInteractive: "#F0EEE9",
    foreground: "#292524",
    border: "#EEECE7",
    borderEmphasis: "#DDD9D2",
    input: "#EEECE7",
    ring: "#C4956A",
    muted: "#F5F3EF",
    mutedForeground: "#8C857C",
    tertiaryForeground: "#A8A29E",
    card: "#FAF9F6",
    cardForeground: "#292524",
    popover: "#FFFFFF",
    popoverForeground: "#292524",
    primary: "#C4956A",
    primaryForeground: "#FFFFFF",
    button: "#C4956A",
    buttonForeground: "#FFFFFF",
    secondary: "#F0EEE9",
    secondaryForeground: "#44403C",
    accent: "#D4956A",
    accentForeground: "#FFFFFF",
    destructive: "#DC2626",
    destructiveForeground: "#FFFFFF",
    statusCritical: "#DC2626",
    statusWarning: "#D97706",
    statusNominal: "#16A34A",
    statusInfo: "#2563EB",
    statusCriticalForeground: "#E02E2A",
    statusWarningForeground: "#E25507",
    statusNominalForeground: "#00A240",
    statusInfoForeground: "#2563EB",
    syntaxKeyword: "#8957E5",
    syntaxString: "#22863A",
    syntaxNumber: "#B08800",
    syntaxComment: "#8C857C",
    syntaxMeta: "#2563EB",
    syntaxAddition: "#16A34A",
    syntaxDeletion: "#DC2626",
    sidebar: "#FAF9F6",
    sidebarForeground: "#292524",
    sidebarPrimary: "#C4956A",
    sidebarPrimaryForeground: "#FFFFFF",
    sidebarHover: "rgb(41 37 36 / 0.05)",
    sidebarAccent: "#F0EEE9",
    sidebarAccentForeground: "#292524",
    sidebarBorder: "#EEECE7",
    sidebarRing: "#C4956A"
  }
}

export type ThemeId = string

export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  cmbdevclawWhite,
  ...CODEX_THEME_FAMILIES.flatMap((family) => {
    const definitions: ThemeDefinition[] = []
    if (family.light) definitions.push(defineCodexTheme(family, "light", family.light))
    if (family.dark) definitions.push(defineCodexTheme(family, "dark", family.dark))
    return definitions
  })
]

export const THEME_IDS: readonly ThemeId[] = THEME_DEFINITIONS.map((theme) => theme.id)
export const DEFAULT_THEME_ID: ThemeId = "cmbdevclaw-white"

const THEME_BY_ID = new Map(THEME_DEFINITIONS.map((theme) => [theme.id, theme]))

const LEGACY_THEME_ID_MAP: Readonly<Record<string, ThemeId>> = {
  light: "cmbdevclaw-white",
  dark: "codex-dark",
  "catppuccin-latte": "catppuccin-light",
  "catppuccin-mocha": "catppuccin-dark",
  "catppuccin-macchiato": "catppuccin-dark",
  nord: "nord-dark",
  dracula: "dracula-dark",
  "one-half-light": "one-light",
  "one-half-dark": "one-dark",
  "two-dark": "one-dark",
  "solarized-light": "solarized-light",
  "solarized-dark": "solarized-dark",
  "base16-ocean-light": "github-light",
  "gruvbox-light": "gruvbox-light",
  "gruvbox-dark": "gruvbox-dark",
  zenburn: "codex-dark"
}

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && THEME_BY_ID.has(value)
}

export function normalizeThemeId(value: string | null): ThemeId | null {
  if (isThemeId(value)) return value
  return value === null ? null : (LEGACY_THEME_ID_MAP[value] ?? null)
}

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return THEME_BY_ID.get(themeId) ?? THEME_BY_ID.get(DEFAULT_THEME_ID) ?? THEME_DEFINITIONS[0]
}

export const CSS_VARIABLE_BY_PALETTE_KEY: Record<keyof ThemePalette, `--${string}`> = {
  background: "--background",
  backgroundSecondary: "--background-secondary",
  backgroundElevated: "--background-elevated",
  backgroundInteractive: "--background-interactive",
  foreground: "--foreground",
  border: "--border",
  borderEmphasis: "--border-emphasis",
  input: "--input",
  ring: "--ring",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  tertiaryForeground: "--tertiary-foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  button: "--button",
  buttonForeground: "--button-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  statusCritical: "--status-critical",
  statusWarning: "--status-warning",
  statusNominal: "--status-nominal",
  statusInfo: "--status-info",
  statusCriticalForeground: "--status-critical-foreground",
  statusWarningForeground: "--status-warning-foreground",
  statusNominalForeground: "--status-nominal-foreground",
  statusInfoForeground: "--status-info-foreground",
  syntaxKeyword: "--syntax-keyword",
  syntaxString: "--syntax-string",
  syntaxNumber: "--syntax-number",
  syntaxComment: "--syntax-comment",
  syntaxMeta: "--syntax-meta",
  syntaxAddition: "--syntax-addition",
  syntaxDeletion: "--syntax-deletion",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarHover: "--sidebar-hover",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring"
}
