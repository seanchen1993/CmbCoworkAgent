const DEFAULT_MAX_OUTPUT_CHARS = 6_000
const DEFAULT_MAX_INPUT_CHARS = 1_200

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.65)
  const tailChars = Math.floor(maxChars * 0.25)
  return `${text.slice(0, headChars)}\n...(middle truncated, ${text.length - headChars - tailChars} chars omitted)...\n${text.slice(-tailChars)}`
}

function compactGoalToolArg(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= 500) return value
    return `${value.slice(0, 300)}...(${value.length - 420} chars omitted)...${value.slice(-120)}`
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactGoalToolArg(item, depth + 1))
  }
  if (depth >= 2) return "[object omitted]"

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value).slice(0, 16)) {
    out[key] = compactGoalToolArg(raw, depth + 1)
  }
  return out
}

export function summarizeGoalToolInput(
  args: Record<string, unknown> | undefined,
  maxChars = DEFAULT_MAX_INPUT_CHARS
): string {
  if (!args || Object.keys(args).length === 0) return ""
  try {
    return truncateMiddle(JSON.stringify(compactGoalToolArg(args), null, 2), maxChars)
  } catch {
    return truncateMiddle(String(args), maxChars)
  }
}

export function buildGoalToolEvidenceEntry(params: {
  toolName: string
  output: string
  inputSummary?: string
  maxOutputChars?: number
}): string | null {
  const trimmed = params.output.trim()
  if (!trimmed) return null

  return [
    `Tool: ${params.toolName}`,
    ...(params.inputSummary ? [`Input:\n${params.inputSummary}`] : []),
    `Output:\n${truncateMiddle(trimmed, params.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)}`
  ].join("\n")
}

export class GoalEvidenceBuffer {
  private readonly inputByCallId = new Map<string, string>()
  private readonly evidence: string[] = []
  private evidenceStartCount = 0

  constructor(
    private readonly maxItems = 60,
    private readonly maxPendingInputs = Math.max(120, maxItems * 4)
  ) {}

  rememberToolCall(
    toolCallId: string | undefined,
    args: Record<string, unknown> | undefined
  ): void {
    if (!toolCallId) return
    const summary = summarizeGoalToolInput(args)
    if (summary) {
      this.inputByCallId.set(toolCallId, summary)
      while (this.inputByCallId.size > this.maxPendingInputs) {
        const oldestKey = this.inputByCallId.keys().next().value
        if (!oldestKey) break
        this.inputByCallId.delete(oldestKey)
      }
    }
  }

  appendToolResult(params: { toolName: string; output: string; toolCallId?: string }): void {
    const inputSummary = params.toolCallId ? this.inputByCallId.get(params.toolCallId) : undefined
    if (params.toolCallId) this.inputByCallId.delete(params.toolCallId)
    const entry = buildGoalToolEvidenceEntry({
      toolName: params.toolName,
      output: params.output,
      inputSummary
    })
    if (!entry) return
    this.evidence.push(entry)
    if (this.evidence.length > this.maxItems) {
      const removed = this.evidence.length - this.maxItems
      this.evidence.splice(0, removed)
      this.evidenceStartCount += removed
    }
  }

  getItems(): string[] {
    return this.evidence.slice()
  }

  getItemsSince(startIndex: number): string[] {
    const absoluteIndex = Math.max(0, Math.floor(startIndex))
    if (absoluteIndex <= this.evidenceStartCount) {
      return this.evidence.slice()
    }
    const relativeIndex = Math.min(this.evidence.length, absoluteIndex - this.evidenceStartCount)
    return this.evidence.slice(relativeIndex)
  }

  getCount(): number {
    return this.evidenceStartCount + this.evidence.length
  }
}
