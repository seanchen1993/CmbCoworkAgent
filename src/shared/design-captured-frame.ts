export const CAPTURE_FRAME_ATTRIBUTE = "data-design-capture-frame"
export const CAPTURE_FRAME_PREVIEW_ATTRIBUTE = "data-design-frame-preview"

export function isCapturedFrameId(id: string): boolean {
  return /^f_\d{1,3}$/.test(id)
}

export function isCapturedFrameScreenshot(html: string): boolean {
  return html.includes('alt="嵌入页面截图"') && html.includes("data:image/png;base64,")
}

export function capturedFrameReference(id: string, src: string, nested: boolean): boolean {
  if (!isCapturedFrameId(id)) return false
  return new RegExp(`^${nested ? "\\.\\./" : ""}frames/${id}(?:-[a-f0-9]{64})?\\.html$`).test(src)
}

export function frameNodeId(frameId: string, nodeId: string): string {
  return `${frameId}:${nodeId}`
}

export function splitFrameNodeId(nodeId?: string): { frameId: string; nodeId: string } | null {
  const match = nodeId?.match(/^(f_\d{1,3}):(.+)$/)
  return match ? { frameId: match[1], nodeId: match[2] } : null
}
