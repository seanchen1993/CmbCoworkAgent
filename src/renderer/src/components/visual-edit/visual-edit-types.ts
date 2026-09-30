export type ClawVisualAnnotationKind = "comment" | "draw"

export type ClawVisualAnnotationStatus =
  | "draft"
  | "pending"
  | "submitted"
  | "resolved"
  | "unresolved"
  | "stale"

export type ClawVisualTargetKind = "html-preview" | "file-preview" | "browser-preview"

export interface ClawVisualPoint {
  x: number
  y: number
}

export interface ClawVisualBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ClawVisualAnchor {
  selector?: string
  tagName?: string
  role?: string
  text?: string
  className?: string
  screenLabel?: string
  bbox?: ClawVisualBox
  offsetRatio?: ClawVisualPoint
  targetPath?: string
  targetUrl?: string
}

export interface ClawVisualStroke {
  points: ClawVisualPoint[]
  color: string
  width: number
}

export interface ClawVisualAnnotation {
  id: string
  kind: ClawVisualAnnotationKind
  text?: string
  pageX?: number
  pageY?: number
  bbox?: ClawVisualBox
  anchor?: ClawVisualAnchor
  stroke?: ClawVisualStroke
  nearbyElements?: string[]
  status: ClawVisualAnnotationStatus
  createdAt: number
}

export interface ClawVisualFeedbackContext {
  threadId: string
  targetKind: ClawVisualTargetKind
  targetPath?: string
  targetUrl?: string
  annotations: ClawVisualAnnotation[]
  beforeScreenshot?: string
  submittedAt: number
}

export type ClawVisualToolMode = "comment" | "draw"

export interface ClawVisualViewport {
  scrollX: number
  scrollY: number
  width: number
  height: number
}
