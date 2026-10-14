import { getThreadCore } from "../../db"
import { getPlugins } from "../../storage"
import { getHarnessAgentContext, type HarnessAgentContext } from "../../agent/standard-thread-turn"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "../../harness-board/project-action-scope"

const fields = [
  "harnessFeature",
  "harnessProjectSession",
  "harnessProjectId",
  "featureId",
  "isHarnessProjectSession",
  "disableAgentsPrompt",
  "workspacePath",
  "cmb_thread_incarnation"
]

/** Context originates from the parent DB binding, never a Flow definition or renderer payload. */
export async function prepareFlowHarnessContext(threadId: string, workspacePath: string) {
  const read = () => {
    const raw = getThreadCore(threadId)?.metadata
    const value = projectActionFlowMetadata(threadId, typeof raw === "string" ? JSON.parse(raw) : raw)
    if (!isOrdinaryFlowMetadata(value)) throw Error("FLOW_HARNESS_BINDING_INVALID")
    return value as Record<string, unknown>
  }
  const metadata = read()
  const binding = (value: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(fields.map((key) => [key, value[key] ?? null])))
  const captured = binding(metadata)
  const bound = !!(metadata.harnessFeature || metadata.harnessProjectSession)
  const context: HarnessAgentContext = bound
    ? await getHarnessAgentContext(metadata, { workspacePath })
    : metadata.disableAgentsPrompt === true
      ? { enableAgentsPrompt: false }
      : {}
  const projectSession = metadata.harnessProjectSession as { projectId: string } | undefined
  const projectAdapter =
    projectSession && !metadata.harnessFeature
      ? await (
          await import("../../harness-board/service")
        ).getHarnessProjectAdapterSnapshot(projectSession.projectId)
      : undefined
  if (projectSession && !metadata.harnessFeature && !projectAdapter)
    throw Error("FLOW_HARNESS_PROJECT_UNAVAILABLE")
  const contextPluginId =
    context.pluginId ?? (projectAdapter?.type === "plugin" ? projectAdapter.id : undefined)
  if (
    metadata.harnessFeature &&
    (!context.pluginId || !context.harnessProjectId || !context.featureId)
  )
    throw Error("FLOW_HARNESS_CONTEXT_UNAVAILABLE")
  const pluginSnapshot = () =>
    contextPluginId
      ? JSON.stringify(
          getPlugins().find((plugin) => plugin.id === contextPluginId && plugin.enabled) ?? null
        )
      : undefined
  const plugin = pluginSnapshot()
  if (contextPluginId && plugin === "null") throw Error("FLOW_HARNESS_PLUGIN_UNAVAILABLE")
  const assertCurrent = () => {
    if (binding(read()) !== captured || pluginSnapshot() !== plugin)
      throw Error("FLOW_HARNESS_BINDING_CHANGED")
  }
  assertCurrent()
  return {
    context,
    bound,
    childMetadata: Object.fromEntries(
      fields
        .filter((key) => key !== "cmb_thread_incarnation")
        .filter((key) => metadata[key] !== undefined)
        .map((key) => [key, structuredClone(metadata[key])])
    ),
    assertCurrent,
    async refresh() {
      assertCurrent()
      if (projectAdapter && projectSession) {
        const current = await (
          await import("../../harness-board/service")
        ).getHarnessProjectAdapterSnapshot(projectSession.projectId)
        if (JSON.stringify(current) !== JSON.stringify(projectAdapter))
          throw Error("FLOW_HARNESS_PROJECT_CHANGED")
      }
      const next = await getHarnessAgentContext(read(), { workspacePath })
      const stable = (value: HarnessAgentContext) => {
        return JSON.stringify(
          Object.fromEntries(Object.entries(value).filter(([key]) => key !== "harnessNodeStatus"))
        )
      }
      assertCurrent()
      if (stable(context) !== stable(next)) throw Error("FLOW_HARNESS_CONTEXT_CHANGED")
    }
  }
}

export function constrainFlowHarnessContext(
  context: HarnessAgentContext,
  restricted: boolean
): HarnessAgentContext {
  return {
    ...context,
    managedExecution: true,
    ...(restricted
      ? {
          enableAgentsPrompt: false,
          additionalAgentsWorkspacePaths: [],
          additionalAgentsWorkspaceMappings: []
        }
      : {})
  }
}
