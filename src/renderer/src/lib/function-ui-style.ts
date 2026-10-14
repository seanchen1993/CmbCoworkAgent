import type { CSSProperties } from "react"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"
import { functionUiColor } from "./function-ui-color"

export function functionUiStyle(node: FunctionUiNode, inheritedBackground?: string): CSSProperties {
  const p = node.props
  if (node.type === "Text") {
    const truncated = p.wrap === "truncate-start" || p.wrap === "truncate-end"
    // Explicit backgrounds form an author-controlled color pair, including inverse.
    const ansiMode = p.backgroundColor !== undefined || inheritedBackground !== undefined
      ? "literal" : "adaptive"
    return {
      color: functionUiColor(p.inverse ? p.backgroundColor ?? inheritedBackground ?? "inverseText" : p.color, ansiMode),
      backgroundColor: functionUiColor(p.inverse ? p.color ?? "text" : p.backgroundColor, ansiMode),
      fontWeight: p.bold ? "bold" : undefined,
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
    typeof p[key] === "number" ? (p[key] as number) * 8 : undefined
  return {
    display: "flex",
    flexDirection: p.flexDirection === "column" ? "column" : "row",
    flexWrap: "wrap",
    gap: dimension("gap"),
    padding: dimension("padding"),
    paddingInline: dimension("paddingX"),
    paddingBlock: dimension("paddingY"),
    margin: dimension("margin"),
    marginInline: dimension("marginX"),
    marginBlock: dimension("marginY"),
    marginTop: dimension("marginTop"),
    alignItems: ["flex-start", "center", "flex-end", "stretch"].includes(String(p.alignItems))
      ? String(p.alignItems)
      : undefined,
    justifyContent: ["flex-start", "center", "flex-end", "space-between", "space-around"].includes(
      String(p.justifyContent)
    )
      ? String(p.justifyContent)
      : undefined,
    border: p.borderStyle ? "1px solid var(--border)" : undefined,
    borderColor: p.borderStyle ? functionUiColor(p.borderColor) : undefined,
    borderRadius: p.borderStyle === "round" ? 6 : undefined,
    width:
      typeof p.width === "number"
        ? `${p.width}ch`
        : typeof p.width === "string"
          ? p.width
          : undefined,
    height:
      typeof p.height === "number"
        ? `${p.height}lh`
        : typeof p.height === "string"
          ? p.height
          : undefined
  }
}
