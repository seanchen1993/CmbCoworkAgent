import type { FunctionToolInfo } from "../../shared/mods/v2/tools"

/** A transport-bound tool belongs to the parent turn, never its temporary task agents. */
export const MAIN_TURN_ONLY_TOOL_METADATA_KEY = "cmb_main_turn_only"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function filterTaskSubagentTools<T>(tools: readonly T[]): T[] {
  return tools.filter(
    (entry) => record(record(entry)?.metadata)?.[MAIN_TURN_ONLY_TOOL_METADATA_KEY] !== true
  )
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
