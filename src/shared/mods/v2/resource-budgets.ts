/** Existing, independent accounting domains. These are capacity limits, never grants.
 * Abort requests cleanup; physical capacity returns only on the existing finally/exit boundary.
 */
export const FUNCTION_MOD_RESOURCE_BUDGETS = Object.freeze({
  // Per renderer fair display queue. Active jobs include obsolete reads until IPC really settles.
  rendererDisplay: Object.freeze({ physical: 4, pending: 256, interactive: 3, background: 1 }),
  // Per Main registry: legacy anonymous reads share total; only identified reads have frame caps.
  mainDisplay: Object.freeze({ physical: 32, perNativeFrame: 16, pendingMounts: 32 }),
  // Per utility client. Logical requests and physical native host calls are separate domains.
  runtimeClient: Object.freeze({
    pending: 128,
    hostCalls: 512,
    moduleCallsPerRuntime: 128,
    childRssBytes: 384 * 1024 * 1024
  }),
  // Per utility process, across its guest runtimes, including pending loads.
  utilityHost: Object.freeze({ runtimes: 16, frames: 128 }),
  // Per guest runtime; independent of the utility-wide frame cap.
  guest: Object.freeze({ frames: 32, rpc: 128 }),
  // Native credits per actual thread, shared by live/candidate/retiring utilities.
  uiResolveThread: Object.freeze({ handles: 4096, roots: 32, branches: 1024, reactions: 1024 }),
  // New cold schema Workers, across all databases. Active credit lasts until actual Worker exit.
  checkpointMaintenance: Object.freeze({ active: 2, wait: 16 }),
  // Actual Main V1 bridge commands, including ACK dispatch; not whole Worker requests.
  // Original single oversized row/timing-source compatibility exceptions remain supported.
  legacyTranscriptBridgeWriter: Object.freeze({
    active: 1,
    wait: 16,
    rowsPerBatch: 64,
    batchBytes: 1024 * 1024
  }),
  // Renderer pending-only directory read publishers, independent of display read slots.
  rendererThreadSummaryRead: Object.freeze({ pending: 128 }),
  diagnostics: Object.freeze({ retainedEvents: 32 })
})
