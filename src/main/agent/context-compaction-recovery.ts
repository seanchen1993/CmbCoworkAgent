import { BaseMessage } from "@langchain/core/messages"

/** Byte accounting includes JSON escaping and the serialized summary wrapper, unlike chars / 4. */
export function summaryRequestBytes(messages: BaseMessage[]): number {
  return Buffer.byteLength(
    JSON.stringify(
      messages.map((message) => ({
        role: message.getType(),
        content: message.content
      }))
    )
  )
}

export function contextWindowFromError(error: unknown): number | undefined {
  const seen = new Set<unknown>()
  function visit(value: unknown): number | undefined {
    if (value == null || seen.has(value) || seen.size > 24) return undefined
    seen.add(value)
    if (typeof value === "string") {
      const match = value.match(/maximum context length (?:is|of)\s+([\d,]+)\s*tokens/i)
      const limit = match ? Number(match[1].replaceAll(",", "")) : NaN
      return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
    }
    if (typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    for (const key of ["message", "error", "cause", "responseBody", "errorMsg"]) {
      const limit = visit(record[key])
      if (limit) return limit
    }
    return undefined
  }
  return visit(error)
}

export function summaryRetryByteBudget(input: {
  previousRequestBytes: number
  configuredInputBudget: number
  contextWindow?: number
  outputTokens: number
  lastAttempt: boolean
}): number {
  const inputBudget = input.contextWindow
    ? input.contextWindow - input.outputTokens - 1_000
    : input.configuredInputBudget
  // Reserve output and framing, treat each UTF-8 byte as a conservative token
  // allowance, and shrink on EVERY rejection, including "at least N" errors.
  return Math.max(
    0,
    Math.floor(
      Math.min(
        input.configuredInputBudget,
        inputBudget,
        input.previousRequestBytes / 2,
        input.lastAttempt ? 16_000 : Infinity
      )
    )
  )
}

export function excerptUtf8(text: string, bytes: number): string {
  return excerptBuffer(Buffer.from(text), bytes)
}

function excerptBuffer(buffer: Buffer, bytes: number): string {
  if (buffer.length <= bytes) return buffer.toString("utf8")
  const head = Math.floor(Math.max(0, bytes) / 4)
  const tail = Math.max(0, bytes - head)
  return `${buffer
    .subarray(0, head)
    .toString("utf8")
    .replace(/\uFFFD+$/, "")}\n[... truncated to fit the compaction window ...]\n${
    tail > 0
      ? buffer
          .subarray(-tail)
          .toString("utf8")
          .replace(/^\uFFFD+/, "")
      : ""
  }`
}

/** Only the transient summary request is clipped; original checkpoints/archive messages remain intact. */
export function fitSummaryRequestToBytes(
  transcript: string,
  byteBudget: number,
  build: (transcript: string, compactInstructions: boolean) => BaseMessage[]
): BaseMessage[] {
  const complete = build(transcript, false)
  if (summaryRequestBytes(complete) <= byteBudget) return complete
  const compactInstructions = summaryRequestBytes(build("", false)) > byteBudget / 2
  const transcriptBuffer = Buffer.from(transcript)
  const excerpt = (bytes: number): BaseMessage[] => {
    const text = excerptBuffer(transcriptBuffer, bytes)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    return build(`<truncated-transcript>\n${text}\n</truncated-transcript>`, compactInstructions)
  }
  let fitted = excerpt(0)
  if (summaryRequestBytes(fitted) > byteBudget) {
    throw new Error(
      `Cannot fit minimal compaction instructions into the ${byteBudget}-byte recovery budget`
    )
  }
  let low = 0
  let high = Math.min(transcriptBuffer.length, byteBudget)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = excerpt(middle)
    if (summaryRequestBytes(candidate) <= byteBudget) {
      low = middle
      fitted = candidate
    } else {
      high = middle - 1
    }
  }
  return fitted
}
