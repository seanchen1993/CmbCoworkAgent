import { getAgentToolStrategy } from "../../shared/agent-runtime-limits"
import { extractShellCommandReadPaths } from "./shell-command-profile"

export function readPathsForToolCall(
  name: unknown,
  args?: Record<string, unknown> | null
): string[] {
  if (!args) return []
  if (name === "read_file") {
    const value = typeof args.path === "string" ? args.path : args.file_path
    return typeof value === "string" && value ? [value] : []
  }
  if (
    name !== "execute" ||
    getAgentToolStrategy() === "standard" ||
    typeof args.command !== "string"
  )
    return []
  return extractShellCommandReadPaths(args.command, typeof args.cwd === "string" ? args.cwd : "")
}
