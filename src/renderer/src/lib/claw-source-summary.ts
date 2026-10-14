import type { ClawSourceSelection } from "../../../shared/mods/claw"

export function clawSourceSummary(selection?: ClawSourceSelection, kind = "功能"): string {
  if (!selection || selection.mode === "all") return `使用已开启的${kind}`
  return selection.items.length ? `仅使用已选 ${selection.items.length} 项` : "不使用此类功能"
}
