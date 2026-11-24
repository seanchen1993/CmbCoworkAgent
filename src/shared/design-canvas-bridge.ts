import type { DesignEditableDocument } from "./design-edit"
import type { DesignAppliedPatch } from "./design-patch"
import type { DesignLiveDelta } from "../renderer/src/lib/design-live-patch"
import type { DesignSectionPatch } from "../renderer/src/lib/design-progressive-preview"
import type { TweakValues } from "./design-tweaks"
import type {
  AnchoredDrawPoint,
  DesignElementAnchor,
  DrawNote,
  DrawPoint,
  DrawStroke
} from "../renderer/src/components/design/types"

export interface DesignCanvasResolvedAnnotations {
  comments: Array<{ id: string; point: DrawPoint | null; orphaned: boolean }>
  draftComment: { point: DrawPoint | null; orphaned: boolean } | null
  strokes: Array<{ id: string; points: DrawPoint[]; orphaned: boolean }>
  notes: Array<{ id: string; point: DrawPoint | null; orphaned: boolean }>
  draftDrawNote: { point: DrawPoint | null; orphaned: boolean } | null
}

export interface DesignCanvasSyncAnnotationsPayload {
  comments: Array<{ id: string; pageX: number; pageY: number; anchor?: DesignElementAnchor }>
  draftComment: { pageX: number; pageY: number; anchor?: DesignElementAnchor } | null
  strokes: Array<{
    id: string
    points: DrawPoint[]
    anchor?: DesignElementAnchor
    anchoredPoints?: AnchoredDrawPoint[]
  }>
  notes: Array<{ id: string; pageX: number; pageY: number; anchor?: DesignElementAnchor }>
  draftDrawNote: { pageX: number; pageY: number; anchor?: DesignElementAnchor } | null
}

export interface DesignCanvasObservationItem {
  nodeId: string
  box: { width: number; height: number }
  computed: Record<string, string>
}

export type DesignCanvasMode = "comment" | "edit" | "move" | "draw" | null

export type AppToCanvasMessage =
  | { type: "__design_set_mode"; previewInstanceId: string; mode: DesignCanvasMode }
  | {
      type: "__design_editor_config"
      previewInstanceId: string
      config: DesignEditableDocument
      mode: "edit" | "move"
    }
  | {
      type: "__design_editor_action"
      previewInstanceId: string
      action: "editSelected" | "deleteSelected" | "clearSelection" | "cleanup" | "flush"
      requestId?: string
    }
  | {
      type: "__design_editor_result"
      previewInstanceId: string
      commandId: string
      error?: string
    }
  | { type: "__design_scroll_to"; previewInstanceId: string; x: number; y: number }
  | { type: "__design_scroll_by"; previewInstanceId: string; left: number; top: number }
  | {
      type: "__design_query_point_anchor"
      previewInstanceId: string
      requestId: string
      point: DrawPoint
    }
  | {
      type: "__design_query_stroke_anchor"
      previewInstanceId: string
      requestId: string
      points: DrawPoint[]
    }
  | {
      type: "__design_sync_annotations"
      previewInstanceId: string
      annotations: DesignCanvasSyncAnnotationsPayload
    }
  | {
      type: "__design_query_observations"
      previewInstanceId: string
      requestId: string
      nodeIds: string[]
    }
  | {
      type: "__design_set_tweak_keys"
      protocol: 2
      previewInstanceId: string
      tweakRevision: number
      keys: TweakValues
    }
  | {
      type: "__design_live_patch"
      previewInstanceId: string
      baseRevision: number
      revision: number
      patchId?: string
      delta: DesignLiveDelta
    }
  | {
      type: "__design_preview_update"
      previewInstanceId: string
      runId: string
      baseRevision: number | null
      revision: number
      patch?: DesignSectionPatch
      html?: string
      keys: TweakValues
    }

export type CanvasToAppMessage =
  | {
      type: "__design_canvas_ready"
      previewInstanceId: string
      scrollX: number
      scrollY: number
      contentW: number
      contentH: number
      viewportW: number
      viewportH: number
      artifactRevision?: number
    }
  | {
      type: "__iframe_scroll"
      previewInstanceId?: string
      x: number
      y: number
      width: number
      height: number
      viewportW?: number
      viewportH?: number
    }
  | {
      type: "__comment_click"
      previewInstanceId?: string
      pageX: number
      pageY: number
      winW: number
      winH: number
      elementDesc: string
      anchor?: DesignElementAnchor
    }
  | {
      type: "__design_editor_flush_reply"
      previewInstanceId: string
      requestId: string
      command?: unknown
      error?: string
    }
  | {
      type: "__design_point_anchor_reply"
      previewInstanceId: string
      requestId: string
      anchor?: DesignElementAnchor
      elements: string[]
    }
  | {
      type: "__design_stroke_anchor_reply"
      previewInstanceId: string
      requestId: string
      anchor?: DesignElementAnchor
      anchoredPoints?: AnchoredDrawPoint[]
      elements: string[]
      sampledAnchors: DesignElementAnchor[]
    }
  | {
      type: "__design_annotations_resolved"
      previewInstanceId: string
      resolved: DesignCanvasResolvedAnnotations
    }
  | {
      type: "__design_observations_reply"
      previewInstanceId: string
      requestId: string
      observations: DesignCanvasObservationItem[]
    }
  | {
      type: "__design_live_applied"
      previewInstanceId: string
      patchId?: string
      revision: number
    }
  | { type: "__design_live_resync"; previewInstanceId: string }
  | {
      type: "__design_preview_ready"
      previewInstanceId: string
      runId: string
      revision: number
    }
  | {
      type: "__design_preview_applied"
      previewInstanceId: string
      runId: string
      revision: number
    }
  | { type: "__design_preview_resync"; previewInstanceId: string; revision: number }

export type { DesignAppliedPatch, DrawNote, DrawStroke }
