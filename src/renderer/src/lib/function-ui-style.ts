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
      p.wrap !== undefined && p.wrap !== "wrap"
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
      direction: p.dir === "ltr" || p.dir === "rtl" ? p.dir : undefined,
      unicodeBidi: "plaintext",
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
  const style: CSSProperties = {
    boxSizing: "border-box",
    maxWidth: "100%",
    display: p.display === "none" ? "none" : "flex",
    position: p.position === "absolute" ? "absolute" : "relative",
    top: p.position === "absolute" ? size("top", "lh") : undefined,
    bottom: p.position === "absolute" ? size("bottom", "lh") : undefined,
    left: p.position === "absolute" ? size("left", "ch") : undefined,
    right: p.position === "absolute" ? size("right", "ch") : undefined,
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
    borderColor: p.borderStyle
      ? p.borderDimColor ? `color-mix(in srgb, ${functionUiColor(p.borderColor) ?? "var(--border)"} 65%, transparent)`
        : functionUiColor(p.borderColor) : undefined,
    borderRadius: p.borderStyle === "round" ? 6 : undefined,
    backgroundColor: functionUiColor(p.backgroundColor, "literal"),
    overflow: p.overflow === "hidden" || p.overflow === "visible" ? p.overflow : undefined,
    width: size("width", "ch"),
    height: size("height", "lh"),
    minWidth: size("minWidth", "ch"),
    minHeight: size("minHeight", "lh")
  }
  // React assigns inline styles in order. An absent rowGap/paddingTop must not clear
  // the gap/padding shorthand that was just assigned on the same element.
  return Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined))
}

/** Native style-only hover. Cross-site author groups are intentionally not inferred. */
export function functionUiHoverStyle(node: FunctionUiNode, background?: string): CSSProperties {
  const hover = node.props.hover
  if (!hover || typeof hover !== "object" || Array.isArray(hover)) return {}
  const props = { ...node.props, ...hover }
  if (node.type !== "Box" && typeof hover.bold === "boolean") delete props.weight
  const style = functionUiStyle({ ...node, type: node.type === "Button" ? "Text" : node.type, props }, background)
  const result: CSSProperties = {}
  if (node.type === "Box") {
    if (hover.backgroundColor !== undefined) result.backgroundColor = style.backgroundColor
    if (node.props.borderStyle) {
      if (hover.borderColor !== undefined || hover.borderDimColor !== undefined)
        result.borderColor = style.borderColor
      if (hover.borderStyle !== undefined) result.borderRadius = style.borderRadius ?? 0
    }
    if (hover.display === "flex" && node.props.display === "none") result.display = "flex"
    if (node.props.position === "absolute")
      for (const key of ["top", "left", "right", "bottom"] as const)
        if (hover[key] !== undefined) result[key] = style[key]
  } else {
    if (hover.color !== undefined || hover.inverse !== undefined) result.color = style.color
    if (hover.backgroundColor !== undefined || hover.inverse !== undefined)
      result.backgroundColor = style.backgroundColor
    if (hover.dimColor !== undefined) result.opacity = hover.dimColor ? 0.65 : 1
    if (hover.bold !== undefined) result.fontWeight = hover.bold ? "bold" : "normal"
    if (hover.italic !== undefined) result.fontStyle = hover.italic ? "italic" : "normal"
    if (hover.underline !== undefined || hover.strikethrough !== undefined)
      result.textDecoration = style.textDecoration || "none"
  }
  return result
}
