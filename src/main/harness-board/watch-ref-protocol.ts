import type { HarnessWatchRef } from "../../shared/harness-board-types"

export const HARNESS_WATCH_REF_MAX_REFS = 64
export const HARNESS_WATCH_REF_MAX_SCOPES = 4

export interface HarnessRunAttributionTarget {
  projectId: string
  featureSlug: string
}

export interface HarnessWatchRefStartRequest {
  type: "start"
  scopeKey: string
  generation: number
  workspacePath: string
  refs: HarnessWatchRef[]
  attributionTarget?: HarnessRunAttributionTarget
  cancelBuffer: SharedArrayBuffer
}

export interface HarnessWatchRefStopRequest {
  type: "stop"
  scopeKey: string
  generation: number
}

export interface HarnessWatchRefStopAllRequest {
  type: "stop-all"
}

export interface HarnessWatchRefShutdownRequest {
  type: "shutdown"
}

export type HarnessWatchRefWorkerRequest =
  | HarnessWatchRefStartRequest
  | HarnessWatchRefStopRequest
  | HarnessWatchRefStopAllRequest
  | HarnessWatchRefShutdownRequest

export interface HarnessWatchRefChangedEvent {
  type: "changed"
  scopeKey: string
  generation: number
  workspacePath: string
  ref: HarnessWatchRef
  at: string
}

export interface HarnessWatchRefDirtyEvent {
  type: "dirty"
  scopeKey: string
  generation: number
  attributionTarget: HarnessRunAttributionTarget
}

export interface HarnessWatchRefInstalledEvent {
  type: "installed"
  scopeKey: string
  generation: number
  watcherCount: number
  cancelled: boolean
}

export interface HarnessWatchRefStoppedEvent {
  type: "stopped"
  scopeKey: string
  generation: number
}

export interface HarnessWatchRefShutdownComplete {
  type: "shutdown-complete"
}

export type HarnessWatchRefWorkerResponse =
  | HarnessWatchRefChangedEvent
  | HarnessWatchRefDirtyEvent
  | HarnessWatchRefInstalledEvent
  | HarnessWatchRefStoppedEvent
  | HarnessWatchRefShutdownComplete
