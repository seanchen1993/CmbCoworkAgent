/** Desktop Java observations, not a language-server installation or execution grant. */
export const DEVELOPER_CODE_CAPABILITY_REF = {
  provider: "native.code",
  id: "java",
  version: "1.0.0"
} as const

export const DEVELOPER_CODE_METHODS = [
  "definition",
  "references",
  "hover",
  "implementation",
  "documentSymbols",
  "workspaceSymbol",
  "diagnostics",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls"
] as const
export type DeveloperCodeMethod = (typeof DEVELOPER_CODE_METHODS)[number]
export interface DeveloperCodeInput {
  path?: string
  line?: number
  column?: number
  query?: string
  limit?: number
}
export const DEVELOPER_CODE_LIMITS = {
  fileBytes: 512 * 1024,
  resultBytes: 14_000,
  items: 64,
  inspectedItems: 256,
  text: 8_000,
  inFlight: 4,
  waitMs: 10_000
} as const

export function developerCodeInputSchema(method: DeveloperCodeMethod) {
  const position = !["documentSymbols", "workspaceSymbol", "diagnostics"].includes(method)
  const properties: Record<string, unknown> = {
    limit: { type: "integer", minimum: 1, maximum: DEVELOPER_CODE_LIMITS.items }
  }
  const required: string[] = []
  if (method === "workspaceSymbol") {
    properties.query = { type: "string", minLength: 1, maxLength: 256 }
    required.push("query")
  } else {
    properties.path = { type: "string", minLength: 1, maxLength: 4096 }
    if (method !== "diagnostics") required.push("path")
  }
  if (position) {
    properties.line = { type: "integer", minimum: 1, maximum: 10_000_000 }
    properties.column = { type: "integer", minimum: 1, maximum: 1_000_000 }
    required.push("line", "column")
  }
  return { type: "object", additionalProperties: false, properties, required }
}
