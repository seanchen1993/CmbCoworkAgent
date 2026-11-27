import { isNestedMappingError } from "./dashboard-es-nested-mapping"
import { SHELL_TASK_MONITOR_TOOL_NAMES } from "../agent/shell-task-monitor"

/** Built-in file, shell and meta tools excluded from the filtered ranking. */
export const FILTERED_TOOL_EXCLUDES = [
  "execute",
  "read_file",
  "write_file",
  "glob",
  "grep",
  "list_directory",
  "task",
  ...SHELL_TASK_MONITOR_TOOL_NAMES,
  "ls",
  "edit_file",
  "search_tool",
  "inspect_tool",
  "invoke_deferred_tool",
  "code_exec",
  "save_code_exec_tool",
  "write_todos"
]

/** Tool names backed by the app's built-in browser, across regular and Bot conversations. */
export const BUILTIN_BROWSER_TOOL_USAGE_FILTER = {
  bool: {
    should: [
      { wildcard: { "toolUsage.name": "*inAppBrowser_*" } },
      { term: { "toolUsage.name": "bot_browser" } }
    ],
    minimum_should_match: 1
  }
}

/** Retry only a missing/conflicting nested mapping during a rolling upgrade. */
export async function queryWithToolUsageMappingFallback<T>(
  execute: (body: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>
): Promise<T> {
  try {
    return await execute(body)
  } catch (error) {
    if (!isNestedMappingError(error, "toolUsage")) throw error
    const aggs = { ...(body.aggs as Record<string, unknown>) }
    delete aggs.tool_usage_complete
    return execute({ ...body, aggs })
  }
}
