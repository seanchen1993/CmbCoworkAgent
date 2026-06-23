import path from "path"
import type { CoordinatorWorkerWorkload } from "./coordinator-worker-manager"
import { isCoordinatorPathOwnedBy } from "./coordinator-worker-paths"

export interface CoordinatorWorkerFilesystemAccess {
  workload?: CoordinatorWorkerWorkload
  ownedFiles?: string[]
  workspacePath?: string
  /** Explicit tool denylist (registry agents, CC-style). When this or shellAccess
   * is set, the access is in "explicit mode" and workload/ownedFiles are ignored
   * for tool cutting. Coordinator workers never set these, so their workload path
   * is untouched. */
  disallowedTools?: string[]
  /** execute policy for registry agents: none = cut execute+task_output;
   * read_only = keep execute (commands gated elsewhere by isReadOnlyShellCommand);
   * full = keep execute. */
  shellAccess?: "none" | "read_only" | "full"
}

/** True when the access uses the explicit registry denylist/shell model rather
 * than the coordinator's workload model. */
export function isExplicitToolAccess(access?: CoordinatorWorkerFilesystemAccess): boolean {
  return !!access && (access.disallowedTools !== undefined || access.shellAccess !== undefined)
}

interface RuntimeToolLike {
  name?: string
  description?: string
  schema?: unknown
  invoke?: (input: unknown, config?: unknown) => Promise<unknown> | unknown
  call?: (input: unknown, config?: unknown) => Promise<unknown> | unknown
}

const directWriteToolNames = new Set(["write_file", "edit_file"])
const deferredExecutionToolNames = new Set([
  "code_exec",
  "save_code_exec_tool",
  "invoke_deferred_tool"
])
const deferredDiscoveryToolNames = new Set(["search_tool", "inspect_tool"])
const externalSideEffectToolNames = new Set(["browser_playwright"])
const ownedFileGuardToolNames = new Set(["write_file", "edit_file"])
// Ad-hoc code execution + orchestration/meta tools. A registry agent
// (Explore/Plan/verification/custom) is a SUBAGENT, not an orchestrator, so it
// never gets these regardless of its shell tier — parity with coordinator
// workers (which disable scheduler/skill-evolution and block code-exec) and with
// CC, whose subagent tool allowlist excludes them.
const adHocExecutionToolNames = new Set(["code_exec", "save_code_exec_tool"])
const orchestrationToolNames = new Set(["manage_scheduler", "manage_skill"])
// The deferred-execution bridge. invoke_deferred_tool can run saved code_exec
// tools (arbitrary LOCAL code) and deferred MCP tools (possible writes), so it is
// a real execution surface — not just discovery. A read-only / no-shell agent
// must not have it (parity with the coordinator read-only worker, which also cuts
// these). search_tool/inspect_tool only discover deferred tools, so they're
// pointless without the bridge and are cut alongside it. EAGER MCP tools (those
// surfaced directly, not via the bridge) are still kept; verify/write tiers keep
// the bridge since they can already execute.
const deferredBridgeToolNames = new Set(["invoke_deferred_tool", "search_tool", "inspect_tool"])

/**
 * Blocked tools for a registry agent: its own disallowedTools, plus ad-hoc code
 * execution + orchestration meta tools (always), plus execute/task_output when
 * the shell is off, plus — for read-only/no-shell — browser automation and the
 * deferred-execution bridge (invoke_deferred_tool + discovery). verify/write keep
 * browser + bridge; eager MCP is kept for all. Used by BOTH the workflow Level-1
 * path (filesystemAccess) and the Solo Level-2 guard so they cut the same set.
 */
export function registryAgentBlockedTools(
  disallowedTools: string[],
  shellAccess: "none" | "read_only" | "full"
): Set<string> {
  const blocked = new Set<string>([
    ...disallowedTools,
    ...adHocExecutionToolNames,
    ...orchestrationToolNames
  ])
  if (shellAccess === "none") {
    blocked.add("execute")
    blocked.add("task_output")
  }
  if (shellAccess === "read_only" || shellAccess === "none") {
    // No shell / read-only → no browser automation and no deferred-execution
    // bridge (both are side-effecting). A `tools:` allowlist that omits Bash
    // (→ none) clearly didn't ask for browser either; verify/write (full) keep
    // both. (Previously `none` kept browser, contradicting this comment.)
    for (const t of externalSideEffectToolNames) blocked.add(t)
    for (const t of deferredBridgeToolNames) blocked.add(t)
  }
  return blocked
}

/** Blocked tool names for an access (workload OR explicit registry mode). Public
 * so the runtime can clean the injected fs system prompt (strip docs of tools
 * this access can't use) for BOTH coordinator workers and registry/workflow
 * leaves — keeping the prompt consistent with the actually-available tools. */
export function blockedToolNamesForAccess(
  access: CoordinatorWorkerFilesystemAccess,
  options: { includeDeferredDiscoveryTools?: boolean } = {}
): Set<string> {
  const deferredToolNames = options.includeDeferredDiscoveryTools
    ? new Set([...deferredExecutionToolNames, ...deferredDiscoveryToolNames])
    : deferredExecutionToolNames

  // Explicit registry mode (Explore/Plan/verification/custom): denylist + shell
  // policy + ad-hoc-exec/orchestration cut (workload ignored). MCP is kept.
  if (isExplicitToolAccess(access)) {
    return registryAgentBlockedTools(access.disallowedTools ?? [], access.shellAccess ?? "full")
  }

  if (access.workload === "read_only") {
    // read-only workers KEEP execute (+ task_output for its results) but the
    // runtime's execute tool gates each command through isReadOnlyShellCommand
    // (which layers assessCommandSafety with read-only build-tool and Windows
    // PowerShell handling), so only commands that can be proven read-only (ls,
    // git log, git diff, find, cat …) run; unsafe/unverified shell composition
    // such as pipes/chaining/redirection is rejected;
    // mutating/unrecognized commands are rejected. Direct writes, deferred
    // execution surfaces, and browser automation remain unavailable.
    return new Set([...directWriteToolNames, ...deferredToolNames, ...externalSideEffectToolNames])
  }
  if (access.workload === "verify") {
    return new Set([...directWriteToolNames, ...deferredToolNames])
  }
  if ((access.ownedFiles ?? []).length > 0) {
    return new Set(["execute", "task_output", ...deferredToolNames, ...externalSideEffectToolNames])
  }
  return new Set()
}

function resolveWorkerFilePath(
  filePath: string,
  access: CoordinatorWorkerFilesystemAccess
): string {
  const root = path.resolve(access.workspacePath ?? ".")
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath)
}

function resolveWorkerOwnedScopePath(
  ownedPath: string,
  access: CoordinatorWorkerFilesystemAccess
): string {
  const resolved = resolveWorkerFilePath(ownedPath, access)
  return /[\\/]$/.test(ownedPath) ? `${resolved}${path.sep}` : resolved
}

function isInsideOwnedFiles(filePath: string, access: CoordinatorWorkerFilesystemAccess): boolean {
  const ownedFiles = access.ownedFiles ?? []
  if (ownedFiles.length === 0) return true
  return ownedFiles.some((ownedFile) => {
    return isCoordinatorPathOwnedBy(
      resolveWorkerFilePath(filePath, access),
      resolveWorkerOwnedScopePath(ownedFile, access)
    )
  })
}

function extractToolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const data = input as Record<string, unknown>
  const raw = data.file_path ?? data.filePath ?? data.path
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

export function applyCoordinatorWorkerFilesystemAccess<TTool>(
  tools: TTool[],
  access?: CoordinatorWorkerFilesystemAccess
): TTool[] {
  if (!access) return tools
  const blockedToolNames = blockedToolNamesForAccess(access)
  // Explicit registry mode and read-only/verify workloads: straight denylist
  // filter (no owned-files write guard).
  if (
    isExplicitToolAccess(access) ||
    access.workload === "read_only" ||
    access.workload === "verify"
  ) {
    return tools.filter((tool) => {
      const name = (tool as { name?: string }).name
      return !name || !blockedToolNames.has(name)
    })
  }

  const ownedFiles = access.ownedFiles ?? []
  if (ownedFiles.length === 0) return tools
  return tools
    .filter((tool) => {
      const name = (tool as { name?: string }).name
      return !name || !blockedToolNames.has(name)
    })
    .map((tool) => {
      const runtimeTool = tool as RuntimeToolLike
      if (!runtimeTool.name || !ownedFileGuardToolNames.has(runtimeTool.name)) return tool
      const guardedTool = Object.create(Object.getPrototypeOf(runtimeTool)) as RuntimeToolLike
      const descriptors = Object.getOwnPropertyDescriptors(runtimeTool)
      delete descriptors.invoke
      delete descriptors.call
      Object.defineProperties(guardedTool, descriptors)
      const guardAccess = (input: unknown): string | undefined => {
        const filePath = extractToolFilePath(input)
        if (!filePath || !isInsideOwnedFiles(filePath, access)) {
          return `Error: ${runtimeTool.name} is limited to this worker's owned_files: ${ownedFiles.join(", ")}. Target was: ${filePath ?? "(missing file_path)"}. Do not retry this same path; report the blocked path in your result.`
        }
        return undefined
      }
      Object.defineProperty(guardedTool, "invoke", {
        configurable: true,
        writable: true,
        value: async (input: unknown, config?: unknown): Promise<unknown> => {
          const denied = guardAccess(input)
          if (denied) return denied
          if (typeof runtimeTool.invoke !== "function") {
            return `Error: ${runtimeTool.name} cannot be invoked by the owned_files guard.`
          }
          return runtimeTool.invoke(input, config)
        }
      })
      if (typeof runtimeTool.call === "function") {
        Object.defineProperty(guardedTool, "call", {
          configurable: true,
          writable: true,
          value: async (input: unknown, config?: unknown): Promise<unknown> => {
            const denied = guardAccess(input)
            if (denied) return denied
            return runtimeTool.call!(input, config)
          }
        })
      }
      return guardedTool as TTool
    })
}

export function filterCoordinatorWorkerFinalTools<TTool>(
  tools: TTool[],
  access?: CoordinatorWorkerFilesystemAccess
): TTool[] {
  if (!access) return tools
  const blockedToolNames = blockedToolNamesForAccess(access, {
    includeDeferredDiscoveryTools: true
  })
  if (blockedToolNames.size === 0) return tools
  return tools.filter((tool) => {
    const name = (tool as { name?: string }).name
    return !name || !blockedToolNames.has(name)
  })
}
