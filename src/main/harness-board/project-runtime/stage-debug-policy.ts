import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, parse, relative, resolve, sep, win32 } from "node:path"
import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

/** Application tool confinement only. This is not an operating-system sandbox. */
export const STAGE_DEBUG_TOOL_NAMES = Object.freeze(["read_file", "write_file", "edit_file"])

export interface StageDebugFilePolicy {
  workspace: string
  snapshotRoot: string
  baselineId: string
}

export function isStageDebugPolicyError(value: unknown): boolean {
  const seen = new Set<unknown>()
  while (value instanceof Error && !seen.has(value) && seen.size < 32) {
    seen.add(value)
    if (value.message.startsWith("PROJECT_STAGE_DEBUG_")) return true
    value = value.cause
  }
  return false
}

function deny(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}
function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}
function plainPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 32768 ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    deny("PATH_INVALID")
  if (/^(?:\\\\|\/\/|\\\?\\)/.test(value)) deny("PATH_INVALID")
  const parts = value.replace(/\\/g, "/").split("/")
  if (
    parts.some(
      (part) =>
        part === ".." ||
        (/[. ]$/.test(part) && part !== ".") ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    )
  )
    deny("PATH_INVALID")
  if (parts.some((part, index) => part.includes(":") && !(index === 0 && /^[A-Za-z]:$/.test(part))))
    deny("PATH_INVALID")
  if (parts.some((part) => part.toLowerCase() === ".git")) deny("PATH_INVALID")
  return value
}

/** Check each existing component, including intermediate directories and hard links. */
function assertNoLinks(target: string): void {
  const root = parse(target).root
  let current = root
  const parts = relative(root, target).split(sep).filter(Boolean)
  for (const part of parts) {
    current = resolve(current, part)
    try {
      const stat = lstatSync(current)
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        deny("LINK_UNSUPPORTED")
      if (!samePath(realpathSync(current), current)) deny("LINK_UNSUPPORTED")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

export function assertStageDebugToolCall(
  policy: StageDebugFilePolicy,
  name: string,
  args: unknown
): void {
  if (!STAGE_DEBUG_TOOL_NAMES.includes(name)) deny("TOOL_UNSUPPORTED")
  if (!policy.baselineId || !isAbsolute(policy.workspace) || !isAbsolute(policy.snapshotRoot))
    deny("SCOPE_INVALID")
  if (!args || typeof args !== "object" || Array.isArray(args)) deny("ARGUMENTS_INVALID")
  const input = args as Record<string, unknown>
  if (
    input.file_path !== undefined &&
    input.filePath !== undefined &&
    input.file_path !== input.filePath
  )
    deny("ARGUMENTS_INVALID")
  const requested = plainPath(input.file_path ?? input.filePath)
  if (process.platform !== "win32" && win32.isAbsolute(requested)) deny("PATH_OUTSIDE")
  const target = resolve(policy.workspace, requested)
  const workspace = resolve(policy.workspace),
    source = resolve(policy.snapshotRoot)
  const write = name === "write_file" || name === "edit_file"
  if (!inside(workspace, target) && (write || !inside(source, target))) deny("PATH_OUTSIDE")
  if (write && inside(source, target)) deny("SOURCE_READ_ONLY")
  assertNoLinks(workspace)
  assertNoLinks(source)
  assertNoLinks(target)
}

export function createStageDebugFileMiddleware(
  policy: StageDebugFilePolicy,
  assertEnvironment: () => void
): ReturnType<typeof createMiddleware> {
  const allowed = new Set(STAGE_DEBUG_TOOL_NAMES)
  return createMiddleware({
    name: "stageDebugFileConfinement",
    wrapModelCall: (request, handler) => {
      assertEnvironment()
      return handler({
        ...request,
        tools: request.tools.filter((tool) => "name" in tool && allowed.has(String(tool.name)))
      })
    },
    wrapToolCall: (request, handler) => {
      try {
        assertEnvironment()
        assertStageDebugToolCall(policy, request.toolCall.name, request.toolCall.args)
      } catch (error) {
        return new ToolMessage({
          name: request.toolCall.name,
          tool_call_id: request.toolCall.id ?? "",
          content: error instanceof Error ? error.message : "PROJECT_STAGE_DEBUG_DENIED",
          status: "error"
        })
      }
      return handler(request)
    }
  })
}
