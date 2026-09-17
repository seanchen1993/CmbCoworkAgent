import type { FunctionToolInfo } from "../../shared/mods/v2/tools"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Project only public metadata from the same sources collected by LangChain ReactAgent. */
export function collectRuntimeToolCatalog(
  tools: unknown,
  middleware: unknown = []
): FunctionToolInfo[] {
  const sources = [
    ...(Array.isArray(tools) ? tools : []),
    ...(Array.isArray(middleware) ? middleware : []).flatMap((entry) => {
      const values = record(entry)?.tools
      return Array.isArray(values) ? values : []
    })
  ]
  return sources.flatMap((entry) => {
    const value = record(entry)
    const spec = record(value?.function)
    const name = value?.name ?? spec?.name
    const description = value?.description ?? spec?.description
    return typeof name === "string"
      ? [
          {
            name,
            description: typeof description === "string" ? description : "",
            mcp: name.startsWith("mcp__")
          }
        ]
      : []
  })
}
