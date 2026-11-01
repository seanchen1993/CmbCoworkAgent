/** Sizes only: no prompt text, tool arguments, URLs, headers or credentials enter evidence. */
export function creatorLiveBudgetObservation(body: Record<string, unknown>) {
  const output = Number(body.max_tokens ?? body.max_completion_tokens)
  return {
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    promptBytes: Buffer.byteLength(JSON.stringify(body.messages ?? []), "utf8"),
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(body.tools ?? []), "utf8"),
    offeredToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    requestedOutputTokens: Number.isFinite(output) ? output : null
  }
}
