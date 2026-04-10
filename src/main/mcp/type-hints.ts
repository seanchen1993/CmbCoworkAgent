import type { McpCapabilityTool } from "./capability-types"

export interface RenderedToolHints {
  callExample: string
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

function formatPropertyKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key)
}

function buildPlaceholderValue(key: string, schema: unknown): string {
  if (!schema || typeof schema !== "object") return JSON.stringify(`<${key}>`)

  const source = schema as Record<string, unknown>
  switch (source.type) {
    case "integer":
    case "number":
      return "0"
    case "boolean":
      return "false"
    case "array":
      return "[]"
    case "object":
      return "{}"
    default:
      return JSON.stringify(`<${key}>`)
  }
}

function buildExampleArgs(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "{}"

  const source = schema as Record<string, unknown>

  if (source.type === "object" || source.properties) {
    const properties = source.properties && typeof source.properties === "object"
      ? (source.properties as Record<string, unknown>)
      : {}
    const required = new Set(
      Array.isArray(source.required)
        ? source.required.filter((item): item is string => typeof item === "string")
        : []
    )

    const requiredKeys = Object.keys(properties).filter((key) => required.has(key))
    const keys = requiredKeys.length > 0 ? requiredKeys : Object.keys(properties).slice(0, 2)
    if (keys.length === 0) return "{}"

    const lines = keys.map((key) => `  ${formatPropertyKey(key)}: ${buildPlaceholderValue(key, properties[key])}`)
    return `{\n${lines.join(",\n")}\n}`
  }

  return "{}"
}

function buildCallExample(tool: McpCapabilityTool): string {
  return `const result = await mcp.$call(${JSON.stringify(tool.toolId)}, ${buildExampleArgs(tool.inputSchema ?? { type: "object" })})`
}

export function renderToolHints(tool: McpCapabilityTool): RenderedToolHints {
  const callExample = buildCallExample(tool)

  return {
    callExample
  }
}
