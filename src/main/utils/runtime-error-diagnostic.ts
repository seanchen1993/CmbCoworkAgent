/** Logs only bounded error metadata, never the error object, stack, payload or cause. */
export function runtimeErrorDiagnostic(error: unknown): { name: string; message: string } {
  if (!(error instanceof Error)) return { name: "UnknownError", message: "Non-Error rejection" }
  const message = error.message
    .split(/[\r\n]/, 1)[0]
    .replace(/\b(?:https?|file):\/\/\S+/gi, "[url]")
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)/gi, "[credential]")
    .replace(/\b(?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[credential]")
    .replace(/\{.*|\[.*$/g, "[payload]")
    .replace(/(["'`]).*?\1/g, "[quoted]")
    .slice(0, 240)
  return { name: error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64), message }
}
