import type { CSSProperties } from "react"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"
import { functionUiColor } from "./function-ui-color"
import {
  FUNCTION_UI_SPACE_PIXELS,
  FUNCTION_UI_TEXT_PIXELS,
  FUNCTION_UI_TEXT_WEIGHTS
} from "../../../shared/mods/v2/ui-layout"

export function functionUiStyle(node: FunctionUiNode, inheritedBackground?: string): CSSProperties {
  const p = node.props
  if (node.type === "Text") {
    const truncated =
      p.wrap === "truncate-start" || p.wrap === "truncate-end" || p.wrap === "truncate"
    // Explicit backgrounds form an author-controlled color pair, including inverse.
    const ansiMode =
      p.backgroundColor !== undefined || inheritedBackground !== undefined ? "literal" : "adaptive"
    return {
      color: functionUiColor(
        p.inverse ? (p.backgroundColor ?? inheritedBackground ?? "inverseText") : p.color,
        ansiMode
      ),
      backgroundColor: functionUiColor(
        p.inverse ? (p.color ?? "text") : p.backgroundColor,
        ansiMode
      ),
      fontWeight:
        typeof p.weight === "string" && Object.hasOwn(FUNCTION_UI_TEXT_WEIGHTS, p.weight)
          ? FUNCTION_UI_TEXT_WEIGHTS[p.weight as keyof typeof FUNCTION_UI_TEXT_WEIGHTS]
          : p.bold
            ? "bold"
            : undefined,
      fontSize:
        typeof p.size === "string" && Object.hasOwn(FUNCTION_UI_TEXT_PIXELS, p.size)
          ? FUNCTION_UI_TEXT_PIXELS[p.size as keyof typeof FUNCTION_UI_TEXT_PIXELS]
          : undefined,
      fontFamily:
        p.mono === true ? "var(--font-mono)" : p.mono === false ? "var(--font-sans)" : undefined,
      fontVariantNumeric:
        p.tabular === true ? "tabular-nums" : p.tabular === false ? "normal" : undefined,
      fontStyle: p.italic ? "italic" : undefined,
      textDecoration: [p.underline && "underline", p.strikethrough && "line-through"]
        .filter(Boolean)
        .join(" "),
      opacity: p.dimColor ? 0.65 : undefined,
      whiteSpace: truncated ? "nowrap" : "pre-wrap",
      textOverflow: truncated ? "ellipsis" : undefined,
      overflow: truncated ? "hidden" : undefined,
      display: truncated ? "block" : undefined,
      minWidth: truncated ? 0 : undefined,
      maxWidth: truncated ? "100%" : undefined,
      direction: p.wrap === "truncate-start" ? "rtl" : undefined,
      textAlign: p.wrap === "truncate-start" ? "left" : undefined,
      overflowWrap: "anywhere"
    }
  }
  const dimension = (key: string): number | undefined =>
    typeof p[key] === "number"
      ? (p[key] as number) * 8
      : typeof p[key] === "string" && Object.hasOwn(FUNCTION_UI_SPACE_PIXELS, p[key])
        ? FUNCTION_UI_SPACE_PIXELS[p[key] as keyof typeof FUNCTION_UI_SPACE_PIXELS]
        : undefined
  const size = (key: string, unit: "ch" | "lh"): string | undefined =>
    typeof p[key] === "number"
      ? `${p[key]}${unit}`
      : typeof p[key] === "string"
        ? (p[key] as string)
        : undefined
  return {
    display: "flex",
    flexDirection: ["row", "column", "row-reverse", "column-reverse"].includes(
      String(p.flexDirection)
    )
      ? (p.flexDirection as CSSProperties["flexDirection"])
      : "row",
    flexGrow: typeof p.flexGrow === "number" ? p.flexGrow : undefined,
    flexShrink: typeof p.flexShrink === "number" ? p.flexShrink : undefined,
    flexWrap: ["nowrap", "wrap", "wrap-reverse"].includes(String(p.flexWrap))
      ? (p.flexWrap as CSSProperties["flexWrap"])
      : "wrap",
    gap: dimension("gap"),
    rowGap: dimension("rowGap"),
    columnGap: dimension("columnGap"),
    padding: dimension("padding"),
    paddingInline: dimension("paddingX"),
    paddingBlock: dimension("paddingY"),
    paddingTop: dimension("paddingTop"),
    paddingBottom: dimension("paddingBottom"),
    paddingLeft: dimension("paddingLeft"),
    paddingRight: dimension("paddingRight"),
    margin: dimension("margin"),
    marginInline: dimension("marginX"),
    marginBlock: dimension("marginY"),
    marginTop: dimension("marginTop"),
    marginBottom: dimension("marginBottom"),
    marginLeft: dimension("marginLeft"),
    marginRight: dimension("marginRight"),
    alignItems: ["flex-start", "center", "flex-end", "stretch"].includes(String(p.alignItems))
      ? String(p.alignItems)
      : undefined,
    alignSelf: ["auto", "flex-start", "center", "flex-end", "stretch"].includes(String(p.alignSelf))
      ? String(p.alignSelf)
      : undefined,
    justifyContent: [
      "flex-start",
      "center",
      "flex-end",
      "space-between",
      "space-around",
      "space-evenly"
    ].includes(String(p.justifyContent))
      ? String(p.justifyContent)
      : undefined,
    border: p.borderStyle ? "1px solid var(--border)" : undefined,
    borderColor: p.borderStyle ? functionUiColor(p.borderColor) : undefined,
    borderRadius: p.borderStyle === "round" ? 6 : undefined,
    backgroundColor: functionUiColor(p.backgroundColor, "literal"),
    overflow: p.overflow === "hidden" || p.overflow === "visible" ? p.overflow : undefined,
    width: size("width", "ch"),
    height: size("height", "lh"),
    minWidth: size("minWidth", "ch"),
    minHeight: size("minHeight", "lh")
  }
}
