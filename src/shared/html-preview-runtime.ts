export const HTML_PREVIEW_MESSAGE_TYPE = "cmb-html-preview-status"

export interface HtmlPreviewRuntimeStatus {
  type: typeof HTML_PREVIEW_MESSAGE_TYPE
  id: string
  kind: "ready" | "error" | "blocked"
}

export function isHtmlPreviewRuntimeStatus(
  value: unknown,
  id: string
): value is HtmlPreviewRuntimeStatus {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<HtmlPreviewRuntimeStatus>
  return (
    message.type === HTML_PREVIEW_MESSAGE_TYPE &&
    message.id === id &&
    (message.kind === "ready" || message.kind === "error" || message.kind === "blocked")
  )
}
