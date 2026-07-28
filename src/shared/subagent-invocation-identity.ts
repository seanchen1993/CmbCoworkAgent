export interface SubagentTaskInvocationIdentityInput {
  parentMessageId?: string
  parentOccurrence: number
  parentContent?: unknown
  parentToolCalls?: unknown
  taskToolCallId: string
  taskToolCallIndex: number
  taskArgs?: unknown
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`
}

export function buildSubagentTaskInvocationIdentity(
  input: SubagentTaskInvocationIdentityInput
): string {
  const source = stableJson({
    parentMessageId: input.parentMessageId || null,
    parentOccurrence: input.parentOccurrence,
    parentContent: input.parentContent ?? null,
    parentToolCalls: input.parentToolCalls ?? [],
    taskToolCallId: input.taskToolCallId,
    taskToolCallIndex: input.taskToolCallIndex,
    taskArgs: input.taskArgs ?? null
  })
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `task-v1-${source.length.toString(36)}-${(first >>> 0).toString(36)}-${(
    second >>> 0
  ).toString(36)}`
}
