import type { FunctionToolInfo } from "../../shared/mods/v2/tools"
import { isMcpFunctionTool } from "../mods/v2/tool-sdk"

// The model catalog and $.tool.call use different names and argument contracts.
// Advertise only adapters that the SDK can actually invoke in this Bot scope.
const aliases: Record<string, [string, string][]> = {
  project_read: [
    [
      "read_file",
      "Read a UTF-8 project file with file_path and optional line offset/limit. A successful read pins the version for this plugin's subsequent edits."
    ]
  ],
  project_list: [["ls", "List the authorized project directory given by path."]],
  project_glob: [
    [
      "glob",
      "Find project files with pattern and optional path; bounded traversal excludes links and Host data."
    ]
  ],
  project_grep: [
    [
      "grep",
      "Find literal text with pattern and optional path/glob. Incomplete scans are reported explicitly."
    ]
  ],
  project_edit: [
    [
      "write_file",
      "Write file_path/content after exact approval. Read existing files first through read_file or fs.read; concurrent edits are rejected. New files require an existing parent directory."
    ],
    [
      "edit_file",
      "Replace old_string with new_string in file_path, optionally replace_all. Read the file first; the approved change is checked against that version."
    ]
  ],
  execute: [
    [
      "execute",
      "Run command after approval in the configured project root. cwd, if supplied, must be that root. Foreground only, 60-second timeout; output includes exitCode and an artifact. A nonzero exit is an error; uncertain commands are never retried automatically."
    ]
  ],
  task_output: [
    [
      "task_output",
      "Read a permitted background task with task_id; this does not start or stop processes."
    ]
  ]
}

export function botPluginToolCatalog(tools: readonly FunctionToolInfo[]): FunctionToolInfo[] {
  return tools.flatMap((tool) =>
    isMcpFunctionTool(tool.name)
      ? [tool]
      : (aliases[tool.name] ?? []).map(([name, description]) => ({ name, description, mcp: false }))
  )
}
