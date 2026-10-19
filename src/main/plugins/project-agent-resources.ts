import { businessModPath } from "./business-mod-manifest"

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Explicit package-relative node dependencies only. Never infer agents from prompt text. */
export function projectNodeAgentResources(node: unknown): string[] {
  if (!object(node)) throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const policy = node.runtimePolicy
  if (policy === undefined) return []
  if (!object(policy)) throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const config = policy.subagentConfig
  if (config === undefined) return []
  if (!object(config)) throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const files = config.customSubagentFiles
  if (files === undefined) return []
  if (!Array.isArray(files) || files.length > 256)
    throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const paths = files.map(value => {
    try {
      const path = businessModPath(value)
      if (!/\.md$/i.test(path)) throw Error("PROJECT_AGENT_PATH_INVALID")
      return path
    } catch { throw Error("PROJECT_AGENT_PATH_INVALID") }
  })
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length)
    throw Error("PROJECT_AGENT_CONFIG_INVALID")
  return paths
}

export function assertProjectNodeAgentResources(
  node: unknown,
  read: (path: string) => Buffer | undefined
): string[] {
  const paths = projectNodeAgentResources(node)
  for (const path of paths) {
    const bytes = read(path)
    if (!bytes?.length) throw Error(`PROJECT_AGENT_RESOURCE_MISSING: ${path}`)
    if (bytes.length > 256 * 1024) throw Error(`PROJECT_AGENT_RESOURCE_LIMIT: ${path}`)
    if (!new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim())
      throw Error(`PROJECT_AGENT_RESOURCE_INVALID: ${path}`)
  }
  return paths
}

/** Use the caller's original no-link snapshot reader; this helper performs no filesystem IO. */
export function assertProjectAgentResourceClosure(
  board: unknown,
  read: (path: string) => Buffer | undefined
): string[] {
  if (!object(board)) throw Error("PROJECT_AGENT_CONFIG_INVALID")
  if (board.workflow === undefined) return []
  if (!object(board.workflow)) throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const nodes = board.workflow.nodes
  if (nodes !== undefined && (!Array.isArray(nodes) || nodes.length > 64))
    throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const dynamic = board.workflow.dynamicStages
  if (dynamic !== undefined && (!Array.isArray(dynamic) || dynamic.length > 64))
    throw Error("PROJECT_AGENT_CONFIG_INVALID")
  const branches = (dynamic ?? []) as unknown[]
  const branchNodes = branches.flatMap(stage => {
    if (!object(stage) || !Array.isArray(stage.nodes) || stage.nodes.length > 64)
      throw Error("PROJECT_AGENT_CONFIG_INVALID")
    return stage.nodes
  })
  const allNodes = [...((nodes ?? []) as unknown[]), ...branchNodes]
  return [...new Set(allNodes.flatMap(node => assertProjectNodeAgentResources(node, read)))]
}
