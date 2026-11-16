import type { TabState } from "./managed-design-session"

export const DESIGN_LIGHT_UI_FIELDS = [
  "inputValue",
  "zoom",
  "tweaksOn",
  "rightTab",
  "activeMode",
  "iframeScrollX",
  "iframeScrollY",
  "iframeContentWidth",
  "iframeContentHeight",
  "editModeAvailable",
  "selectedModelId"
] as const
export type DesignUiPatch = Partial<Pick<TabState, (typeof DESIGN_LIGHT_UI_FIELDS)[number]>>

export function isDesignUiPatch(value: unknown): value is DesignUiPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length > 0 &&
    entries.every(([key, item]) => {
      if (!(DESIGN_LIGHT_UI_FIELDS as readonly string[]).includes(key)) return false
      if (key === "inputValue") return typeof item === "string" && item.length <= 1_000_000
      if (key === "selectedModelId")
        return item === null || (typeof item === "string" && item.length <= 256)
      if (key === "activeMode") return [null, "edit", "move", "draw", "comment"].includes(item)
      if (key === "rightTab") return item === "design" || item === "questions"
      if (key === "tweaksOn" || key === "editModeAvailable") return typeof item === "boolean"
      return (
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0 &&
        item <= (key === "zoom" ? 200 : 100_000_000)
      )
    })
  )
}
