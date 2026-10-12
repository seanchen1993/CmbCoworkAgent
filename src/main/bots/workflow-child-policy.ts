import type { BotWorkflowChildInput } from "./workflow-children"

// Ordinary tasks retain project capabilities; trusted browser tasks get only
// their own page tools. Neither capability grants persistent Bot administration.
const taskTools = new Set([
  "project_list",
  "project_glob",
  "project_grep",
  "project_read",
  "read_global_instructions",
  "project_view",
  "project_edit",
  "project_publish",
  "execute",
  "task_output",
  "stop_shell_task",
  "list_files",
  "read_file",
  "read_task_history",
  "deliver_file",
  "create_presentation",
  "list_skills",
  "read_skill",
  "list_skill_files",
  "read_skill_file",
  "copy_skill_file",
  "ask_user",
  "request_user_input",
  "request_user_form",
  "search_connector_tools",
  "inspect_connector_tool",
  "call_connector_tool",
  "list_connector_resources",
  "read_connector_resource",
  "structured_output",
  "write_todos"
])
const aliases: Record<string, string[]> = {
  request_user_form: ["ask_user", "request_user_input"],
  request_computer_help: ["browser"],
  upload_file: ["browser", "read_file"],
  project_list: ["ls", "glob"],
  project_glob: ["ls", "glob", "project_list"],
  project_grep: ["grep", "read_file", "project_read"],
  project_read: ["read_file"],
  read_global_instructions: ["read_file", "project_read"],
  project_view: ["read_file", "project_read"],
  project_edit: ["write_file", "edit_file"],
  project_publish: ["read_file"],
  deliver_file: ["write_file"],
  create_presentation: ["write_file", "deliver_file"],
  copy_skill_file: ["write_file", "edit_file", "read_file"],
  list_skill_files: ["ls", "glob"],
  read_skill_file: ["read_file"],
  read_skill: ["read_file"],
  search_connector_tools: ["search_tool"],
  inspect_connector_tool: ["inspect_tool"],
  call_connector_tool: ["invoke_deferred_tool"],
  list_connector_resources: [
    "search_tool",
    "search_connector_tools",
    "list_mcp_resources",
    "list_mcp_resource_templates"
  ],
  read_connector_resource: ["invoke_deferred_tool", "call_connector_tool", "read_mcp_resource"]
}
const computerTaskTools = new Set([
  "native_computer",
  "request_computer_help",
  "read_file",
  "list_files",
  "deliver_file",
  "create_presentation",
  "ask_user",
  "request_user_input",
  "request_user_form",
  "structured_output",
  "write_todos",
  "read_task_history"
])
const browserTaskTools = new Set([
  "browser",
  "request_computer_help",
  "download_file",
  "upload_file",
  "read_file",
  "list_files",
  "ask_user",
  "request_user_input",
  "request_user_form",
  "structured_output",
  "write_todos",
  "read_task_history"
])
export function botWorkflowChildAllows(input: BotWorkflowChildInput, tool: string): boolean {
  const name = tool.replace(/^host:/, "")
  const allowed =
    input.desktopAccess === "shared-native"
      ? computerTaskTools
      : input.browserAccess === "page"
        ? browserTaskTools
        : taskTools
  if (!allowed.has(name)) return false
  if (input.disallowedTools?.some((denied) => denied === name || aliases[name]?.includes(denied)))
    return false
  if (name === "execute" && input.shellAccess === "none") return false
  if (
    input.shellAccess === "read_only" &&
    [
      "project_edit",
      "copy_skill_file",
      "deliver_file",
      "create_presentation",
      "call_connector_tool",
      "read_connector_resource"
    ].includes(name)
  )
    return false
  return true
}
