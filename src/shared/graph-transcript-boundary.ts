// The Goal marker also appears in checkpoints written by older builds.
export const GOAL_CONTINUATION_BOUNDARY_METADATA_KEY = "cmb_internal_goal_continuation_boundary"
export const NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY =
  "cmb_internal_notification_transcript_boundary"
export const INITIAL_NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY =
  "cmb_internal_initial_notification_transcript_boundary"

export function hasScopedGraphTranscriptBoundary(
  metadata: Record<string, unknown> | undefined
): boolean {
  return (
    metadata?.[GOAL_CONTINUATION_BOUNDARY_METADATA_KEY] === true ||
    metadata?.[NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY] === true
  )
}
