export const STRUCTURED_OUTPUT_FATAL_ERROR = Symbol.for("cmb.workflow.structured_output.fatal")

export function isWorkflowStructuredOutputFatalError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STRUCTURED_OUTPUT_FATAL_ERROR]?: unknown })[STRUCTURED_OUTPUT_FATAL_ERROR] === true
  )
}
