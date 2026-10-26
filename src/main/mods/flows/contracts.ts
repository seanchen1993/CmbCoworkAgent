import type { FlowFileReview, FlowFilePublicationOutcome, FlowFilePublicationRequest } from "../../../shared/mods/flows/file-publication"
import type { FlowFileRuntimeSettledCapture, FlowFileNamespace } from "../../../shared/mods/flows/file-recovery"
import type {
  FlowExecutionPlan,
  FlowAttempt,
  FlowRun,
  FlowStep,
  FlowStepResult,
  SavedFlow
} from "../../../shared/mods/flows/types"
import type { FlowRecoveryObservation } from "./recovery"
import type { FlowPromptRuntimeSettledCapture } from "../../../shared/mods/flows/prompt-recovery"
import type { FlowRecoveryCandidate, RecoveryHistoryRun } from "./recovery-history"

export interface FlowStepContext {
  run: FlowRun
  executionId: string
  signal: AbortSignal
  onProgress?(progress: Omit<NonNullable<FlowAttempt["progress"]>, "updatedAt">): void
}

/** Host adapters retain real runtime authority; the engine never constructs one. */
export interface FlowExecution {
  executionTelemetry?(executionId: string): FlowAttempt["telemetry"]
  finishTelemetry?(status: FlowRun["status"]): void
  readonly fileRecovery?: {
    readonly parentThreadIncarnation: string
    namespace(): FlowFileNamespace
    validateSource(source: FlowRun, history: readonly FlowRun[], signal: AbortSignal): Promise<void>
    assertReceiptCurrent(run: FlowRun, attempt: FlowAttempt): void
    settledCapture(executionId: string): FlowFileRuntimeSettledCapture | undefined
  }
  /** Private prepared host capability; a serialized object from renderer/model is never accepted. */
  readonly promptRecovery?: {
    readonly parentThreadIncarnation: string
    validateSource(source: FlowRun, history: readonly FlowRun[], signal: AbortSignal): Promise<void>
    assertReceiptCurrent(run: FlowRun, attempt: FlowAttempt): void
    settledCapture(executionId: string): FlowPromptRuntimeSettledCapture | undefined
  }
  readonly plan?: FlowExecutionPlan
  readonly signal?: AbortSignal
  assertLive(): void
  fingerprint(signal: AbortSignal): Promise<string>
  execute(step: FlowStep, context: FlowStepContext): Promise<FlowStepResult>
  /** Must run mandatory application rules before the sole terminal commit.
   * Invoke confirm before that commit (or before final PASS without a commit).
   * All selected native checks are revalidated against current artifacts here.
   * No automatic stage mutation is permitted by execute(). */
  finalize(
    context: FlowStepContext,
    confirm: () => Promise<void>,
    recordCheck: (label: string, result: FlowStepResult, fingerprint: string) => void
  ): Promise<FlowStepResult>
  dispose(): Promise<void>
}
export interface FlowHost {
  filePublication?(run: FlowRun, request: FlowFilePublicationRequest, signal: AbortSignal,
    assertRunCurrent: () => void): Promise<Omit<FlowFileReview, "runDigest"> | FlowFilePublicationOutcome>
  /** Validate current scope/grants before using or publishing any async result. */
  assertScope(workspace: string, threadId: string): void
  /** Validate identity for diagnostics even when execution has been disabled. */
  assertRecoveryScope?(workspace: string, threadId: string): void
  /** Pure observation: no execution preparation, connection, grant, or history mutation. */
  observeRecovery?(run: FlowRun): Promise<FlowRecoveryObservation>
  prepare(
    workspace: string,
    threadId: string,
    run: FlowRun,
    signal: AbortSignal
  ): Promise<FlowExecution>
  changed(threadId: string): void
}
export interface FlowPersistence {
  assertWorkspaceResourcesSettled?(workspace: string): { assertCurrent(): void }
  /** Host-only original execution facts; never a serialized guest result or UI API. */
  recordActionResult?(run: FlowRun, attempt: FlowAttempt, result: FlowStepResult): void
  reserveRecovery?(
    workspace: string,
    threadId: string,
    candidate: FlowRecoveryCandidate,
    input: { childRunId: string; now: number; assertCurrent(): void }
  ): RecoveryHistoryRun
  list(workspace: string): SavedFlow[]
  save(workspace: string, definition: unknown, expectedRevision: number): SavedFlow
  get(workspace: string, id: string): SavedFlow | undefined
  runs(workspace: string, threadId: string): FlowRun[]
  run(workspace: string, threadId: string, id: string): FlowRun | undefined
  put(run: FlowRun): void
}
