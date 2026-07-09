import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import {
  checkpointHasInterrupt,
  describeCheckpointMessageForkTarget,
  deriveCheckpointTranscriptIndex,
  type CheckpointTranscriptIndex
} from "./checkpoint-transcript"

export const FORK_BOUNDARY_MARKER_VERSION = 1
export const FORK_BOUNDARY_THREAD_METADATA_KEY = "cmbForkBoundaryVersion"

export type ForkBoundarySource =
  | "metadata_marker"
  | "legacy_latest_idle_fallback"
  | "legacy_historical_idle_fallback"

export type LegacyForkFallbackMode = "none" | "all" | "older_than_marker"

export type ForkUnstableReason =
  | "missing_boundary_marker"
  | "in_progress_turn"
  | "interrupt"
  | "pending_approval"
  | "pending_writes"
  | "unknown"

export interface ThreadForkOverrides {
  title?: string
  model?: string
  workspacePath?: string | null
  memoryEnabled?: boolean
  agentMode?: "normal" | "coordinator" | "workflow"
}

export interface ThreadForkParams {
  sourceThreadId: string
  checkpointId?: string
  messageId?: string
  title?: string
  overrides?: ThreadForkOverrides
}

export interface ThreadForkResponse<TThread = unknown> {
  thread: TThread
  sourceThreadId: string
  sourceCheckpointId: string
  sourceCheckpointNs: ""
}

export interface ThreadForkCheckpointForMessageParams {
  threadId: string
  messageId: string
}

export interface ForkabilityStatus {
  isStableTurnBoundary: boolean
  boundarySource?: ForkBoundarySource
  stableTurnId?: string
  unstableReason?: ForkUnstableReason
  hasInterrupt: boolean
  hasPendingWrites: boolean
}

export interface ForkableCheckpointSummary {
  checkpointId: string
  checkpointNs: ""
  createdAt?: string
  messageCount: number
  lastMessagePreview: string
  lastUserMessagePreview?: string
  isStableTurnBoundary: boolean
  stableTurnId?: string
  boundarySource?: ForkBoundarySource
  unstableReason?: ForkUnstableReason
  hasInterrupt: boolean
  hasPendingWrites: boolean
}

export type ForkableCheckpoint = ForkableCheckpointSummary

export function getCheckpointNamespace(tuple: CheckpointTuple): string {
  const ns = tuple.config?.configurable?.checkpoint_ns
  return typeof ns === "string" ? ns : ""
}

export function getCheckpointId(tuple: CheckpointTuple): string {
  const configId = tuple.config?.configurable?.checkpoint_id
  const checkpointId = tuple.checkpoint?.id
  if (typeof configId === "string" && configId) return configId
  if (typeof checkpointId === "string" && checkpointId) return checkpointId
  throw new Error("Checkpoint is missing an id")
}

export function getCheckpointThreadId(tuple: CheckpointTuple): string {
  const threadId = tuple.config?.configurable?.thread_id
  return typeof threadId === "string" ? threadId : ""
}

export function getForkBoundaryMarker(tuple: CheckpointTuple): Record<string, unknown> | null {
  const metadata = tuple.metadata as Record<string, unknown> | undefined
  const boundary = metadata?.cmb_fork_boundary
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) return null
  const marker = boundary as Record<string, unknown>
  return marker.kind === "turn_complete" ? marker : null
}

export function isForkableCheckpointForMessage(tuple: CheckpointTuple, messageId: string): boolean {
  const targetMessageId = messageId.trim()
  const status = describeCheckpointMessageForkTarget(tuple.checkpoint, targetMessageId)
  if (!status.isForkableMessageBoundary) return false

  const marker = getForkBoundaryMarker(tuple)
  const markerLastVisibleMessageId = marker?.lastVisibleMessageId
  return (
    typeof markerLastVisibleMessageId !== "string" || markerLastVisibleMessageId === targetMessageId
  )
}

function previewText(text: string | undefined): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim()
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

export function describeCheckpointForkability(
  tuple: CheckpointTuple,
  options: {
    allowLegacyLatestFallback: boolean
    allowLegacyHistoricalFallback?: boolean
    activeRun?: boolean
    pendingApproval?: boolean
  }
): ForkabilityStatus {
  const checkpointId = getCheckpointId(tuple)
  const hasInterrupt = checkpointHasInterrupt(tuple.checkpoint)
  const hasPendingWrites = (tuple.pendingWrites?.length ?? 0) > 0
  const marker = getForkBoundaryMarker(tuple)

  if (getCheckpointNamespace(tuple) !== "") {
    return {
      isStableTurnBoundary: false,
      unstableReason: "unknown",
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (hasInterrupt) {
    return {
      isStableTurnBoundary: false,
      unstableReason: "interrupt",
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (options.pendingApproval) {
    return {
      isStableTurnBoundary: false,
      unstableReason: "pending_approval",
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (options.activeRun) {
    return {
      isStableTurnBoundary: false,
      unstableReason: "in_progress_turn",
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (hasPendingWrites) {
    return {
      isStableTurnBoundary: false,
      unstableReason: "pending_writes",
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (marker) {
    const boundaryId = marker.boundaryId
    return {
      isStableTurnBoundary: true,
      boundarySource: "metadata_marker",
      stableTurnId: typeof boundaryId === "string" ? boundaryId : checkpointId,
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (options.allowLegacyLatestFallback) {
    return {
      isStableTurnBoundary: true,
      boundarySource: "legacy_latest_idle_fallback",
      stableTurnId: checkpointId,
      hasInterrupt,
      hasPendingWrites
    }
  }
  if (options.allowLegacyHistoricalFallback) {
    return {
      isStableTurnBoundary: true,
      boundarySource: "legacy_historical_idle_fallback",
      stableTurnId: checkpointId,
      hasInterrupt,
      hasPendingWrites
    }
  }
  return {
    isStableTurnBoundary: false,
    unstableReason: "missing_boundary_marker",
    hasInterrupt,
    hasPendingWrites
  }
}

export function toForkabilityError(reason?: ForkUnstableReason): string {
  switch (reason) {
    case "interrupt":
      return "该 checkpoint 处于中断状态，无法 fork。"
    case "pending_approval":
      return "该 checkpoint 正在等待审批，请先处理审批后再 fork。"
    case "pending_writes":
      return "该 checkpoint 仍有未完成写入，无法 fork。"
    case "in_progress_turn":
      return "该 checkpoint 所属 turn 尚未完成，无法 fork。"
    case "missing_boundary_marker":
      return "该 checkpoint 不是稳定完成边界，无法 fork。"
    default:
      return "该 checkpoint 当前不可 fork。"
  }
}

export function buildForkableCheckpointSummary(
  tuple: CheckpointTuple,
  options: {
    activeRun: boolean
    pendingApproval: boolean
    allowLegacyHistoricalFallback?: boolean
    transcript?: CheckpointTranscriptIndex
  }
): ForkableCheckpointSummary {
  const checkpointId = getCheckpointId(tuple)
  const transcript = options.transcript ?? deriveCheckpointTranscriptIndex(tuple.checkpoint)
  const lastMessage = [...transcript.visibleMessages].reverse().find((message) => message.text)
  const lastUserMessage = [...transcript.visibleMessages]
    .reverse()
    .find((message) => message.role === "user" && message.text)
  const forkability = describeCheckpointForkability(tuple, {
    allowLegacyLatestFallback: false,
    allowLegacyHistoricalFallback: options.allowLegacyHistoricalFallback,
    activeRun: options.activeRun,
    pendingApproval: options.pendingApproval
  })

  return {
    checkpointId,
    checkpointNs: "",
    createdAt: typeof tuple.checkpoint?.ts === "string" ? tuple.checkpoint.ts : undefined,
    messageCount: transcript.visibleMessageIds.length,
    lastMessagePreview: previewText(lastMessage?.text),
    lastUserMessagePreview: lastUserMessage ? previewText(lastUserMessage.text) : undefined,
    isStableTurnBoundary: forkability.isStableTurnBoundary,
    stableTurnId: forkability.stableTurnId,
    boundarySource: forkability.boundarySource,
    unstableReason: forkability.unstableReason,
    hasInterrupt: forkability.hasInterrupt,
    hasPendingWrites: forkability.hasPendingWrites
  }
}

export function buildVisibleForkableCheckpointList(
  tuples: Iterable<CheckpointTuple>,
  options: {
    activeRun: boolean
    pendingApproval: boolean
    legacyFallbackMode?: LegacyForkFallbackMode
  }
): ForkableCheckpointSummary[] {
  const checkpoints: ForkableCheckpointSummary[] = []
  const seenLastVisibleMessageIds = new Set<string>()
  const legacyFallbackMode = options.legacyFallbackMode ?? "none"
  let seenNewerBoundaryMarker = false

  for (const tuple of tuples) {
    const marker = getForkBoundaryMarker(tuple)
    const allowLegacyHistoricalFallback =
      !marker &&
      (legacyFallbackMode === "all" ||
        (legacyFallbackMode === "older_than_marker" && seenNewerBoundaryMarker))
    const initialTranscript = deriveCheckpointTranscriptIndex(tuple.checkpoint)
    const lastVisibleMessageId = initialTranscript.visibleMessageIds.at(-1)
    if (!lastVisibleMessageId) {
      if (marker) seenNewerBoundaryMarker = true
      continue
    }

    const messageTarget = describeCheckpointMessageForkTarget(tuple.checkpoint, lastVisibleMessageId)
    if (!messageTarget.isForkableMessageBoundary) {
      if (marker) seenNewerBoundaryMarker = true
      continue
    }

    const markerLastVisibleMessageId = marker?.lastVisibleMessageId
    if (
      typeof markerLastVisibleMessageId === "string" &&
      markerLastVisibleMessageId !== lastVisibleMessageId
    ) {
      seenNewerBoundaryMarker = true
      continue
    }

    const summary = buildForkableCheckpointSummary(tuple, {
      ...options,
      allowLegacyHistoricalFallback,
      transcript: messageTarget.transcript
    })
    if (marker) seenNewerBoundaryMarker = true
    if (!summary.isStableTurnBoundary) continue
    if (seenLastVisibleMessageIds.has(lastVisibleMessageId)) continue

    seenLastVisibleMessageIds.add(lastVisibleMessageId)
    checkpoints.push(summary)
  }

  return checkpoints
}
