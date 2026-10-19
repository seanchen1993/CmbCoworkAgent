import { getHarnessProjectAdapterSnapshot } from "../harness-board/service"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { getThreadCore } from "../db"
import { getOpenworkDir, getPlugins } from "../storage"
import { captureProjectCapabilityContext } from "../mods/project-capability-context"
import { registerProjectCapabilityRunAdmission } from "../agent/agent-run-admission"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { readProjectCapabilitySelection } from "./project-capability-selection"
import { ProjectCapabilityRuntimeService } from "./project-capability-runtime"
import { closeProjectCapabilityMcpService } from "../mcp/capability-service"
import { withSnapshotRetention } from "../harness-board/project-runtime/snapshot-retention"
import { readRuntimeRequiredHooks } from "./runtime-required-hooks"
import { readPackageExtensionContract } from "./extension-contract"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { readRuntimeScopedFile } from "../harness-board/project-runtime/safe-files"

/** The original parent-chat gateway; no renderer flags can issue source capabilities. */
export function registerProjectCapabilityRuntimeAdmission(): () => void {
  return registerProjectCapabilityRunAdmission(async (request, context) => {
    const thread = getThreadCore(request.threadId)
    if (!thread) return undefined
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(thread.metadata ?? "{}")
    } catch {
      return undefined
    }
    if (
      !metadata ||
      metadata.hostProjectRuntime ||
      metadata.isInternalFlowRuntime ||
      typeof metadata.workspacePath !== "string"
    )
      return undefined
    const session = metadata.harnessProjectSession as { projectId?: unknown } | undefined
    const feature = metadata.harnessFeature as { projectId?: unknown } | undefined
    const candidateId = session?.projectId ?? feature?.projectId
    if (typeof candidateId !== "string" || !candidateId) return undefined
    const selection = readProjectCapabilitySelection(candidateId, metadata.workspacePath)
    if (!selection.sources.length && context.pluginSourceSnapshot) return undefined
    const initialPlugins = getPlugins()
    const adapter = context.pluginSourceSnapshot
      ? undefined
      : await getHarnessProjectAdapterSnapshot(candidateId)
    const parentInstalled = adapter
      ? initialPlugins.find((plugin) => plugin.id === adapter.id && plugin.enabled)
      : undefined
    let reviewedParentDigest: string | undefined
    if (!selection.sources.length && parentInstalled && readPackageExtensionContract(parentInstalled.path)) {
      const file = readRuntimeScopedFile(parentInstalled.path, "devclaw.stage-checks.json", 4096)
      const declaration = file.present ? JSON.parse(file.bytes!.toString("utf8")) : undefined
      if (declaration?.adapter === "autobiz-v1") {
        const catalog = await readNativeCapabilityCatalog(parentInstalled, "project", context.signal)
        if (catalog.status !== "declared" || catalog.legacyAdapter !== "autobiz-v1" || !catalog.packageDigest)
          throw Error("PROJECT_AUTOBIZ_PARENT_PROTOCOL_UNREVIEWED")
        reviewedParentDigest = catalog.packageDigest
      }
    }
    if (
      !selection.sources.length &&
      (!parentInstalled ||
        (!readPackageExtensionContract(parentInstalled.path) &&
          !readRuntimeRequiredHooks(parentInstalled, { legacy: true }).length))
    )
      return undefined
    if (adapter && !parentInstalled) throw Error("PROJECT_CAPABILITY_PARENT_SOURCE_REQUIRED")
    const scope = captureProjectCapabilityContext(request.threadId, metadata.workspacePath)
    if (scope.projectId !== candidateId) throw Error("PROJECT_CAPABILITY_CONTEXT_CHANGED")
    const incarnation = captureThreadIncarnation(thread)
    const sourceIds = [
      ...new Set([
        ...selection.sources.map((source) => source.pluginId),
        ...(parentInstalled ? [parentInstalled.id] : [])
      ])
    ]
    const registry = JSON.stringify(
      sourceIds.map((id) => initialPlugins.find((plugin) => plugin.id === id))
    )
    const assertCurrent = () => {
      scope.assertCurrent()
      if (
        !matchesThreadIncarnation(getThreadCore(request.threadId), incarnation) ||
        readProjectCapabilitySelection(scope.projectId, metadata.workspacePath as string)
          .revision !== selection.revision ||
        JSON.stringify(sourceIds.map((id) => getPlugins().find((plugin) => plugin.id === id))) !==
          registry
      )
        throw Error("PROJECT_CAPABILITY_CONTEXT_CHANGED")
      context.signal?.throwIfAborted()
    }
    const service = new ProjectCapabilityRuntimeService(
      join(getOpenworkDir(), "project-compositions", "capability-packages"),
      { getPlugin: (id) => getPlugins().find((plugin) => plugin.id === id), assertCurrent }
    )
    return withSnapshotRetention(
      [join(getOpenworkDir(), "project-compositions", "capability-packages")],
      async () => {
        const sources = selection.sources.length
          ? await service.admit(selection.sources, context.signal)
          : []
        const parentPlugin = parentInstalled
          ? await service.retainParentPluginAsync(parentInstalled, context.signal)
          : undefined
        if (reviewedParentDigest && parentPlugin?.path.split(/[\\/]/).at(-2) !== reviewedParentDigest)
          throw Error("PROJECT_AUTOBIZ_PARENT_SOURCE_CHANGED")
        const token = service.issue(
          {
            threadId: request.threadId,
            incarnationKey: JSON.stringify(incarnation),
            projectId: scope.projectId,
            workspace: metadata.workspacePath as string,
            operationId: randomUUID(),
            sources,
            parentPlugin
          },
          assertCurrent,
          context.pluginSourceSnapshot
        )
        return {
          context: { ...context, pluginSourceSnapshot: token },
          settle: () => closeProjectCapabilityMcpService(token)
        }
      }
    )
  })
}
