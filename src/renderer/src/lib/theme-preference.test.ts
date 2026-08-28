import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyThemePreference,
  getThemePreference,
  setThemePreference,
  subscribeThemePreference
} from "./theme-preference"
import { DEFAULT_THEME_ID, THEME_DEFINITIONS } from "./theme-registry"

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(left: string, right: string): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right))
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right))
  return (lighter + 0.05) / (darker + 0.05)
}

function installFakeWindow(): {
  values: Map<string, string>
  variables: Map<string, string>
  root: {
    classList: { contains: (name: string) => boolean }
    style: { colorScheme: string; setProperty: (name: string, value: string) => void }
    dataset: { theme: string; colorScheme: string }
  }
} {
  const values = new Map<string, string>()
  const variables = new Map<string, string>()
  const target = new EventTarget()
  const classes = new Set<string>()
  const root = {
    classList: {
      toggle: (name: string, enabled?: boolean): boolean => {
        if (enabled) classes.add(name)
        else classes.delete(name)
        return Boolean(enabled)
      },
      contains: (name: string): boolean => classes.has(name)
    },
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string): void => {
        variables.set(name, value)
      }
    },
    dataset: { theme: "", colorScheme: "" }
  }
  Object.defineProperty(target, "localStorage", {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })
  vi.stubGlobal("window", target)
  vi.stubGlobal("document", { documentElement: root })
  return { values, variables, root }
}

describe("theme preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("defaults to the classic CMBDevClaw white theme", () => {
    installFakeWindow()
    expect(getThemePreference()).toBe("cmbdevclaw-white")
  })

  it("persists the dark theme, applies it, and notifies subscribers", () => {
    const { values, variables, root } = installFakeWindow()
    const listener = vi.fn()
    const unsubscribe = subscribeThemePreference(listener)

    setThemePreference("codex-dark")

    expect(getThemePreference()).toBe("codex-dark")
    expect(values.get("cmb:theme-preference")).toBe("codex-dark")
    expect(root.classList.contains("dark")).toBe(true)
    expect(root.dataset.theme).toBe("codex-dark")
    expect(root.dataset.colorScheme).toBe("dark")
    expect(variables.get("--background")).toBe("#111111")
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("keeps the active theme coherent when persistence is unavailable", () => {
    const { values, variables, root } = installFakeWindow()
    const listener = vi.fn()
    const unsubscribe = subscribeThemePreference(listener)
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable")
    })

    setThemePreference("dracula-dark")

    expect(values.has("cmb:theme-preference")).toBe(false)
    expect(getThemePreference()).toBe("dracula-dark")
    expect(root.dataset.theme).toBe("dracula-dark")
    expect(variables.get("--background")).toBe("#282a36")
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("removes the saved preference when returning to the default theme", () => {
    const { values, root } = installFakeWindow()
    setThemePreference("codex-dark")
    setThemePreference(DEFAULT_THEME_ID)

    expect(values.size).toBe(0)
    expect(root.classList.contains("dark")).toBe(false)
    expect(root.style.colorScheme).toBe("light")
    expect(root.dataset.theme).toBe("cmbdevclaw-white")
  })

  it("applies the stored preference before the app renders", () => {
    const { root } = installFakeWindow()
    applyThemePreference("nord-dark")
    expect(root.classList.contains("dark")).toBe(true)
    expect(root.dataset.theme).toBe("nord-dark")
  })

  it("applies cross-window storage changes before notifying subscribers", () => {
    const { root, variables } = installFakeWindow()
    const listener = vi.fn()
    const unsubscribe = subscribeThemePreference(listener)
    const event = new Event("storage")
    Object.defineProperties(event, {
      key: { value: "cmb:theme-preference" },
      newValue: { value: "dracula-dark" }
    })

    window.dispatchEvent(event)

    expect(root.classList.contains("dark")).toBe(true)
    expect(root.dataset.theme).toBe("dracula-dark")
    expect(variables.get("--background")).toBe("#282a36")
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("persists additional Codex themes", () => {
    const { values, root } = installFakeWindow()
    setThemePreference("catppuccin-dark")

    expect(values.get("cmb:theme-preference")).toBe("catppuccin-dark")
    expect(getThemePreference()).toBe("catppuccin-dark")
    expect(root.dataset.theme).toBe("catppuccin-dark")
    expect(root.classList.contains("dark")).toBe(true)
  })

  it("migrates the previous theme ids to Codex Desktop variants", () => {
    const { values } = installFakeWindow()

    values.set("cmb:theme-preference", "catppuccin-mocha")
    expect(getThemePreference()).toBe("catppuccin-dark")

    values.set("cmb:theme-preference", "light")
    expect(getThemePreference()).toBe("cmbdevclaw-white")
  })

  it("keeps the classic CMBDevClaw white palette intact", () => {
    const cmbTheme = THEME_DEFINITIONS.find((theme) => theme.id === "cmbdevclaw-white")

    expect(cmbTheme?.colorScheme).toBe("light")
    expect(cmbTheme?.palette.background).toBe("#FAF9F6")
    expect(cmbTheme?.palette.backgroundSecondary).toBe("#F5F3EF")
    expect(cmbTheme?.palette.backgroundElevated).toBe("#FFFFFF")
    expect(cmbTheme?.palette.primary).toBe("#C4956A")
    expect(cmbTheme?.palette.primaryForeground).toBe("#FFFFFF")
    expect(cmbTheme?.palette.button).toBe("#C4956A")
    expect(cmbTheme?.palette.buttonForeground).toBe("#FFFFFF")
    expect(cmbTheme?.palette.accentForeground).toBe("#FFFFFF")
    expect(cmbTheme?.palette.foreground).toBe("#292524")
    expect(cmbTheme?.palette.muted).toBe("#F5F3EF")
    expect(cmbTheme?.palette.mutedForeground).toBe("#8C857C")
    expect(cmbTheme?.palette.statusWarning).toBe("#D97706")
  })

  it("offers a balanced multi-theme catalog", () => {
    const lightThemes = THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "light")
    const darkThemes = THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "dark")
    const uniqueIds = new Set(THEME_DEFINITIONS.map((theme) => theme.id))

    expect(lightThemes).toHaveLength(17)
    expect(darkThemes).toHaveLength(27)
    expect(uniqueIds.size).toBe(THEME_DEFINITIONS.length)
  })

  it("gives every theme a specific description instead of repeated placeholder copy", () => {
    const descriptions = THEME_DEFINITIONS.map((theme) => theme.description)

    expect(descriptions.every((description) => description.trim().length > 0)).toBe(true)
    expect(new Set(descriptions).size).toBe(THEME_DEFINITIONS.length)
    expect(descriptions).not.toContain("Codex 桌面端原生浅色主题")
    expect(descriptions).not.toContain("Codex 桌面端原生深色主题")
    expect(descriptions.join("\n")).not.toMatch(/\b(?:Codex|Material|Atom|VS Code)\b|苹果/i)
  })

  it("uses Codex Desktop surfaces and separates accent, action, and list roles", () => {
    const codexLight = THEME_DEFINITIONS.find((theme) => theme.id === "codex-light")
    const codexDark = THEME_DEFINITIONS.find((theme) => theme.id === "codex-dark")
    const absolutelyLight = THEME_DEFINITIONS.find((theme) => theme.id === "absolutely-light")
    const linearDark = THEME_DEFINITIONS.find((theme) => theme.id === "linear-dark")
    const draculaDark = THEME_DEFINITIONS.find((theme) => theme.id === "dracula-dark")
    const catppuccinDark = THEME_DEFINITIONS.find((theme) => theme.id === "catppuccin-dark")

    expect(codexDark?.source).toBe("Codex Desktop 26.818.41509")
    expect(codexDark?.palette.background).toBe("#111111")
    expect(codexDark?.palette.foreground).toBe("#fcfcfc")
    expect(codexDark?.palette.primary).toBe("#0169cc")
    expect(codexLight?.palette.sidebarHover).toBe("rgb(13 13 13 / 0.05)")
    expect(codexLight?.palette.sidebarAccent).toBe(codexLight?.palette.sidebarHover)
    expect(absolutelyLight?.palette.background).toBe("#f9f9f7")
    expect(absolutelyLight?.palette.primary).toBe("#cc7d5e")
    expect(absolutelyLight?.palette.primaryForeground).toBe("#ffffff")
    expect(absolutelyLight?.palette.sidebarHover).toBe("rgb(45 45 43 / 0.05)")
    expect(absolutelyLight?.palette.sidebarAccent).toBe(absolutelyLight?.palette.sidebarHover)
    expect(linearDark?.palette.background).toBe("#0f0f11")
    expect(linearDark?.palette.primary).toBe("#606acc")
    expect(draculaDark?.palette.primary).toBe("#ff79c6")
    expect(draculaDark?.palette.button).toBe("#44475A")
    expect(draculaDark?.palette.buttonForeground).toBe("#F8F8F2")
    expect(draculaDark?.palette.sidebarHover).toBe("#44475A75")
    expect(draculaDark?.palette.sidebarAccent).toBe(draculaDark?.palette.sidebarHover)
    expect(catppuccinDark?.palette.primary).toBe("#cba6f7")

    const raycastLight = THEME_DEFINITIONS.find((theme) => theme.id === "raycast-light")
    expect(raycastLight?.palette.primary).toBe("#ff6363")
    expect(raycastLight?.palette.button).toBe("#138AF2")
    expect(raycastLight?.palette.buttonForeground).toBe("#FFFFFF")
  })

  it("uses the Codex ghost-hover surface for imported thread selection", () => {
    const codexThemes = THEME_DEFINITIONS.filter((theme) =>
      theme.source.startsWith("Codex Desktop")
    )
    const everforestLight = THEME_DEFINITIONS.find((theme) => theme.id === "everforest-light")
    const everforestDark = THEME_DEFINITIONS.find((theme) => theme.id === "everforest-dark")

    for (const theme of codexThemes) {
      expect(theme.palette.sidebarAccent, theme.id).toBe(theme.palette.sidebarHover)
      expect(theme.palette.sidebarHover, theme.id).not.toMatch(/^#[0-9a-f]{6}00$/i)
    }

    expect(everforestLight?.palette.sidebarHover).toBe("rgb(92 106 114 / 0.05)")
    expect(everforestDark?.palette.sidebarHover).toBe("rgb(211 198 170 / 0.08)")
  })

  it("uses the shared Codex text-accent rule for every imported theme", () => {
    const codexThemes = THEME_DEFINITIONS.filter((theme) =>
      theme.source.startsWith("Codex Desktop")
    )

    expect(codexThemes.length).toBeGreaterThan(0)
    for (const theme of codexThemes) {
      expect(theme.palette.statusInfo, theme.id).toBe(theme.palette.accentForeground)
    }
  })

  it("uses Codex semantic text colors without changing decorative theme colors", () => {
    for (const theme of THEME_DEFINITIONS) {
      const expected =
        theme.colorScheme === "light"
          ? { critical: "#E02E2A", warning: "#E25507", nominal: "#00A240" }
          : { critical: "#FF6764", warning: "#FF8549", nominal: "#40C977" }

      expect(theme.palette.statusCriticalForeground, theme.id).toBe(expected.critical)
      expect(theme.palette.statusWarningForeground, theme.id).toBe(expected.warning)
      expect(theme.palette.statusNominalForeground, theme.id).toBe(expected.nominal)
      if (theme.source.startsWith("Codex Desktop")) {
        expect(theme.palette.statusInfoForeground, theme.id).toBe(theme.palette.accentForeground)
      }
    }

    const cmbTheme = THEME_DEFINITIONS.find((theme) => theme.id === "cmbdevclaw-white")
    expect(cmbTheme?.palette.statusInfoForeground).toBe("#2563EB")

    const proof = THEME_DEFINITIONS.find((theme) => theme.id === "proof-light")
    expect(proof?.palette.statusWarning).toBe("#d3b45b")
    expect(proof?.palette.statusWarningForeground).toBe("#E25507")
  })

  it("keeps solid destructive actions readable in every theme", () => {
    for (const theme of THEME_DEFINITIONS) {
      expect(
        contrastRatio(theme.palette.destructive, theme.palette.destructiveForeground),
        theme.id
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("falls back to the default theme when storage contains an unknown theme", () => {
    const { values } = installFakeWindow()
    values.set("cmb:theme-preference", "removed-theme")
    expect(getThemePreference()).toBe("cmbdevclaw-white")
  })

  it("keeps every dark theme surface genuinely dark", () => {
    const surfaceKeys = [
      "background",
      "backgroundSecondary",
      "backgroundElevated",
      "backgroundInteractive",
      "card",
      "popover",
      "sidebar"
    ] as const

    for (const theme of THEME_DEFINITIONS.filter((item) => item.colorScheme === "dark")) {
      for (const key of surfaceKeys) {
        const color = theme.palette[key].toLowerCase().replace(/\s/g, "")
        expect(color, `${theme.id}.${key} must not be white`).not.toMatch(/^#fff(?:fff)?$/)
        expect(color, `${theme.id}.${key} must not be white`).not.toBe("rgb(255255255)")
      }
    }
  })
})
