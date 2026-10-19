/** Only the main process may create internal execution identities. */
export function validateRendererThreadCreateMetadata(metadata: unknown): void {
  if (metadata === undefined) return
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw Error("Invalid thread metadata")
  for (const key of [
    "__proto__",
    "prototype",
    "constructor",
    "isInternalFlowRuntime",
    "hostProjectRuntime",
    "modsAgentRunId",
    "cmb_thread_incarnation"
  ]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key))
      throw Error(`Thread metadata key is main-process-only: ${key}`)
  }
}
