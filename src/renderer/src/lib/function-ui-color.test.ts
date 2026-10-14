import { describe, expect, it } from "vitest"
import { functionUiColor } from "./function-ui-color"
import { functionUiStyle } from "./function-ui-style"
import { CSS_VARIABLE_BY_PALETTE_KEY, THEME_DEFINITIONS } from "./theme-registry"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"

const expected = {
  text: "--foreground",
  inverseText: "--background",
  inactive: "--muted-foreground",
  subtle: "--tertiary-foreground",
  suggestion: "--status-info",
  remember: "--status-info",
  success: "--status-nominal",
  error: "--status-critical",
  warning: "--status-warning",
  merged: "--accent",
  claude: "--accent",
  permission: "--accent",
  planMode: "--accent",
  autoAccept: "--status-nominal",
  promptBorder: "--border-emphasis",
  bashBorder: "--status-warning",
  ide: "--status-info",
  diffAdded: "--syntax-addition",
  diffRemoved: "--syntax-deletion",
  diffAddedDimmed: "--syntax-addition",
  diffRemovedDimmed: "--syntax-deletion",
  diffAddedWord: "--syntax-addition",
  diffRemovedWord: "--syntax-deletion"
}

describe("Function UI color names", () => {
  it.each(Object.entries(expected))(
    "resolves %s through the current theme variable",
    (name, variable) => {
      const color = `var(${variable})`
      expect(functionUiColor(name)).toBe(
        name.endsWith("Dimmed") ? `color-mix(in srgb, ${color} 65%, transparent)` : color
      )
    }
  )

  it("uses variables available in every real theme preset", () => {
    expect(Object.keys(expected)).toHaveLength(23)
    const paletteEntries = Object.entries(CSS_VARIABLE_BY_PALETTE_KEY)
    for (const variable of Object.values(expected)) {
      const entry = paletteEntries.find(([, value]) => value === variable)
      expect(entry, variable).toBeDefined()
      for (const theme of THEME_DEFINITIONS) {
        const value = theme.palette[entry![0] as keyof typeof theme.palette]
        expect(typeof value, `${theme.id}:${variable}`).toBe("string")
        expect(value.length, `${theme.id}:${variable}`).toBeGreaterThan(0)
      }
    }
  })

  it.each([
    "#ff0000",
    "rgb(20, 30, 40)",
    "var(--brand)",
    "unknown-key",
    "constructor",
    "__proto__",
    "toString"
  ])("preserves the raw or unknown color %s", (color) => expect(functionUiColor(color)).toBe(color))

  it("adapts foreground and background without changing data or existing styles", () => {
    const node: FunctionUiNode = {
      type: "Text",
      props: {
        color: "error",
        backgroundColor: "text",
        bold: true,
        italic: true,
        underline: true,
        strikethrough: true,
        dimColor: true,
        wrap: "truncate-end"
      },
      children: ["status"]
    }
    const before = JSON.stringify(node)
    expect(functionUiStyle(node)).toEqual({
      color: "var(--status-critical)",
      backgroundColor: "var(--foreground)",
      fontWeight: "bold",
      fontStyle: "italic",
      textDecoration: "underline line-through",
      opacity: 0.65,
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      overflow: "hidden",
      display: "block",
      minWidth: 0,
      maxWidth: "100%",
      overflowWrap: "anywhere"
    })
    expect(JSON.stringify(node)).toBe(before)
    expect(functionUiColor(undefined)).toBeUndefined()
    expect(functionUiColor(null)).toBeUndefined()
  })
})

it("maps ANSI hues and bright aliases without changing explicit colors", () => {
  for (const name of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    expect(functionUiColor(name)).toBe(`var(--mods-ansi-${name})`)
    expect(functionUiColor(name + "Bright")).toBe(functionUiColor(name))
  }
  expect(functionUiColor("gray")).toBe("var(--mods-ansi-gray)")
  expect(functionUiColor("grey")).toBe(functionUiColor("gray"))
  for (const raw of ["#ffff00", "#FFFF00", "rgb(255, 255, 0)", "var(--custom-yellow)", "navy"])
    expect(functionUiColor(raw)).toBe(raw)
  expect(functionUiStyle({ type: "Text", props: { color: "yellow" } }).color)
    .toBe("var(--mods-ansi-yellow)")
  expect(functionUiStyle({ type: "Box", props: { borderStyle: "round", borderColor: "cyan" } }).borderColor)
    .toBe("var(--mods-ansi-cyan)")
})

it("preserves ANSI pair literals without changing semantic roles or custom colors", () => {
  for (const name of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
    expect(functionUiColor(name, "literal")).toBe(name)
    expect(functionUiColor(name + "Bright", "literal")).toBe(name)
  }
  for (const value of ["text", "error", "#ffff00", "rgb(1, 2, 3)", "var(--custom)", "navy"])
    expect(functionUiColor(value, "literal")).toBe(functionUiColor(value))
})
