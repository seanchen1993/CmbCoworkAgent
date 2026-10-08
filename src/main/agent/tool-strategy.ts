import type { AgentToolStrategy } from "../../shared/agent-runtime-limits"
import {
  blockedToolNamesForAccess,
  type CoordinatorWorkerFilesystemAccess
} from "./coordinator-worker-access"

/** A preference only: never add tools or alter execution/approval policy. */
export function resolveEffectiveToolStrategy(
  requested: AgentToolStrategy,
  tools: readonly { name?: string }[],
  access?: CoordinatorWorkerFilesystemAccess
): AgentToolStrategy {
  if (
    requested === "standard" ||
    access?.shellAccess === "none" ||
    access?.shellAccess === "read_only" ||
    access?.workload === "read_only" ||
    access?.workload === "verify" ||
    (access?.ownedFiles?.length ?? 0) > 0
  ) {
    return "standard"
  }
  const names = new Set(tools.map((tool) => tool.name))
  return names.has("execute") && (names.has("edit_file") || names.has("write_file"))
    ? requested
    : "standard"
}

/** Workflow launch approval waives file-edit prompts only; shell approvals stay separate. */
export function resolveWorkflowToolStrategy(
  requested: AgentToolStrategy,
  yoloMode: boolean
): AgentToolStrategy {
  return yoloMode ? requested : "standard"
}

/** Early gate for native filesystem prompts/descriptions; the reminder still checks actual tools. */
export function resolveFilesystemToolStrategy(
  requested: AgentToolStrategy,
  options: {
    filesystemAccess?: CoordinatorWorkerFilesystemAccess
    blockedToolNames?: Iterable<string>
    filesystemEnabled?: boolean
  } = {}
): AgentToolStrategy {
  const blocked = new Set(options.blockedToolNames)
  if (options.filesystemAccess) {
    for (const name of blockedToolNamesForAccess(options.filesystemAccess)) blocked.add(name)
  }
  const tools =
    options.filesystemEnabled === false
      ? []
      : ["execute", "edit_file", "write_file"]
          .filter((name) => !blocked.has(name))
          .map((name) => ({ name }))
  return resolveEffectiveToolStrategy(requested, tools, options.filesystemAccess)
}

const COMMON_TOOL_STRATEGY_REMINDER = `This is a tool-selection preference, not permission to bypass approvals, role restrictions, workspace boundaries, or explicit user, project, Skill, and plugin requirements. Do not retry a denied action through another tool.
Use the actual operating system and shell described in the environment. Do not assume rg, Python, GNU utilities, or Bash are installed, and do not install dependencies just to follow this preference. Keep output bounded, read only relevant ranges of large files, preserve user changes and file encoding/line endings, and verify edits.
Use dedicated tools for their special semantics: load SKILL.md with read_file so Skill activation, placeholders, and hooks still run; use dedicated tools for managed/virtual resources, specialized file formats, and workflows requiring file-tool hooks or previews. Shell operations do not reproduce those file-tool lifecycle events. Refresh the file with read_file before falling back to edit_file.`

export function getToolStrategyReminder(strategy: AgentToolStrategy): string {
  if (strategy === "standard") return ""
  const preference =
    strategy === "shell-first"
      ? "For ordinary local text files, use execute for reading, searching, creating, and editing wherever it can accomplish the job safely and correctly. Combine related inspection and deterministic edits when useful. Fall back to dedicated file tools when Shell is unavailable or cannot preserve the required correctness or tool-specific behavior."
      : "Prefer execute for ordinary local text-file work, especially combined inspection and deterministic batch edits. Use dedicated file tools directly when they are clearly simpler or more reliable, including exact or multi-line replacements, fragile quoting, and encoding-sensitive edits. No preliminary failed shell attempt is required."
  return `## Tool strategy: ${strategy}\n${preference}\n${COMMON_TOOL_STRATEGY_REMINDER}`
}

// Keep shared descriptions free of text-editing promotion. The actual preference
// is added AFTER each role's tool guard, never by mutating shared tools.
// Standard mode leaves the upstream descriptions untouched.
export const SHELL_FIRST_TOOL_DESCRIPTIONS = {
  ls: "List files and directories at an absolute path. Useful when dedicated directory inspection is needed.",
  execute: `Run a shell command in the workspace, or in execute.cwd when provided, subject to the active sandbox, approval, role, and workspace restrictions. Use commands appropriate for the actual operating system and shell.
Follow the active tool strategy; this tool grants no additional permission.
Verify target and parent paths before creating or changing files. Quote paths and arguments safely, preserve user changes and encoding, and check the result. Prefer absolute paths or cwd rather than changing directories implicitly. Shell syntax, quoting, and multiline scripts must match the actual shell.
Returns command output and exit status; large output may be truncated, so keep inspection bounded. Follow the runtime's foreground/background and timeout guidance and the run_in_background parameter description. Do not use echo/printf as a substitute for responding to the user.`
}
