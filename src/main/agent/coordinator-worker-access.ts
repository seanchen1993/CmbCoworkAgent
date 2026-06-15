import path from "path"
import type { CoordinatorWorkerWorkload } from "./coordinator-worker-manager"
import { isCoordinatorPathOwnedBy } from "./coordinator-worker-paths"

export interface CoordinatorWorkerFilesystemAccess {
  workload?: CoordinatorWorkerWorkload
  ownedFiles?: string[]
  workspacePath?: string
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
const ownedFileGuardToolNames = new Set(["write_file", "edit_file"])

function blockedToolNamesForAccess(
  access: CoordinatorWorkerFilesystemAccess,
  options: { includeDeferredDiscoveryTools?: boolean } = {}
): Set<string> {
  const deferredToolNames = options.includeDeferredDiscoveryTools
    ? new Set([...deferredExecutionToolNames, ...deferredDiscoveryToolNames])
    : deferredExecutionToolNames

  if (access.workload === "read_only") {
    return new Set([...directWriteToolNames, "execute", "task_output", ...deferredToolNames])
  }
  if (access.workload === "verify") {
    return new Set([...directWriteToolNames, ...deferredToolNames])
  }
  if ((access.ownedFiles ?? []).length > 0) {
    return new Set(["execute", "task_output", ...deferredToolNames])
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
  if (access.workload === "read_only" || access.workload === "verify") {
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
