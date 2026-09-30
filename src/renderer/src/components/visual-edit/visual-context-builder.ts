import type {
  ClawVisualAnnotation,
  ClawVisualFeedbackContext,
  ClawVisualPoint
} from "./visual-edit-types"

function coord(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "-"
}

function pointBounds(points: ClawVisualPoint[]): string | null {
  if (points.length === 0) return null
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return `x:${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}, y:${Math.round(
    Math.min(...ys)
  )}-${Math.round(Math.max(...ys))}`
}

function anchorSummary(annotation: ClawVisualAnnotation): string {
  const anchor = annotation.anchor
  if (!anchor) return ""

  const parts = [
    anchor.tagName ? `tag=${anchor.tagName}` : "",
    anchor.selector ? `selector=${anchor.selector}` : "",
    anchor.role ? `role=${anchor.role}` : "",
    anchor.text ? `text="${anchor.text}"` : "",
    anchor.screenLabel && anchor.screenLabel !== anchor.text ? `label="${anchor.screenLabel}"` : ""
  ].filter(Boolean)

  return parts.length > 0 ? `；DOM anchor：${parts.join("，")}` : ""
}

export function buildVisualAnnotationSummary(
  annotation: ClawVisualAnnotation,
  index: number
): string {
  const id = annotation.id || `A${index + 1}`
  const nearby =
    annotation.nearbyElements && annotation.nearbyElements.length > 0
      ? `；附近元素：${annotation.nearbyElements.join("，")}`
      : ""
  const text = annotation.text?.trim() ? `；用户意见：${annotation.text.trim()}` : ""
  const anchor = anchorSummary(annotation)

  if (annotation.kind === "draw") {
    const bounds = annotation.stroke ? pointBounds(annotation.stroke.points) : null
    const strokeMeta = annotation.stroke
      ? `；画笔 ${annotation.stroke.color}，粗细 ${annotation.stroke.width}px，${annotation.stroke.points.length} 个点`
      : ""
    return `[${id}] draw：区域 ${bounds ?? "未知"}${strokeMeta}${nearby}${anchor}${text}`
  }

  return `[${id}] comment：坐标 x:${coord(annotation.pageX)}, y:${coord(
    annotation.pageY
  )}${nearby}${anchor}${text}`
}

export function buildVisualEditPrompt(context: ClawVisualFeedbackContext): string {
  const annotationLines = context.annotations
    .map((annotation, index) => buildVisualAnnotationSummary(annotation, index))
    .join("\n")

  const targetLines = [
    `- 类型：${context.targetKind}`,
    context.targetPath ? `- 文件：${context.targetPath}` : "",
    context.targetUrl ? `- URL：${context.targetUrl}` : ""
  ].filter(Boolean)

  return `用户在当前 CMBDevClaw 预览界面上做了视觉标注。请根据这些标注修改当前 workspace 中的真实源码。

要求：
- 只修改标注涉及的区域。
- 未标注区域尽量保持不变。
- 优先根据 DOM anchor、元素文本、附近元素和坐标定位相关源码。
- 如果标注意图不明确，先基于最小改动做合理判断，并在最终回复里说明假设。
- 修改后运行必要检查，例如 typecheck、lint、test 或项目中合适的验证命令。
- 最终回复必须按标注 ID 总结处理结果。

预览目标：
${targetLines.join("\n") || "- 未知"}

标注列表：
${annotationLines || "无"}

最终回复格式：
标注处理结果：
- A1: resolved/unresolved/stale，说明...
- A2: resolved/unresolved/stale，说明...

修改文件：
- ...

验证：
- ...`
}
