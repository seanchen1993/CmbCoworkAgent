import { createHash } from "node:crypto"
import { captureProjectWorkflowEvidence, type ProjectWorkflowEvidenceReaders } from "./project-workflow-evidence"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { loadWorkflowRunAsync } from "../../agent/workflow/run-store"
import { observeWorkflowDeterministicActions } from "../../agent/workflow/deterministic-action-native"
import { getThreadCore } from "../../db"
import { getPlugins } from "../../storage"
import type { HostProjectService } from "../../harness-board/project-runtime/host-service"
import {
  captureThreadIncarnation,
  type ThreadIncarnationRow
} from "../../services/thread-incarnation"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { isProjectPreviewId, projectPreviewRegistry } from "../devtools/project-preview-registry"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import {
  createProjectRuntimePlatformProvider,
  type NativeProjectRuntimeReviewRequest,
  type NativeProjectRuntimeScope,
  type ProjectRuntimePlatformDependencies
} from "./platform-project-runtime-provider"

/** Lazy original Host service; ordinary Mods never instantiate a project runtime. */
type RuntimeReader = Pick<HostProjectService, "get" | "operations" | "readDebugInputIdentity"> &
  Partial<Pick<HostProjectService, "captureWorkflowEvidenceStage">>
let resolver: (() => RuntimeReader) | undefined
let command: ProjectRuntimePlatformDependencies["executeNative"]
/** Native IPC owns confirmation and dispatch. No function or authority comes from the guest. */
export function configureProjectRuntimeNativeCommand(
  next: NonNullable<ProjectRuntimePlatformDependencies["executeNative"]>
): () => void {
  command = next
  return () => {
    if (command === next) command = undefined
  }
}
export async function executeProjectRuntimeNativeCommand(
  request: NativeProjectRuntimeReviewRequest
) {
  request.assertCurrent()
  if (!command) fail("NATIVE_UNAVAILABLE")
  const result = await command(request)
  request.assertAuthority()
  return result
}
export function configureProjectRuntimePlatformResolver(next: () => RuntimeReader): () => void {
  resolver = next
  return () => {
    if (resolver === next) resolver = undefined
  }
}
function fail(code: string): never {
  throw Error(`PROJECT_RUNTIME_PUBLIC_${code}`)
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Exported for focused tests; production always uses original main-process readers below. */
export function resolveNativeProjectRuntimeScope(
  context: NativePlatformCallContext,
  readers: {
    thread(id: string): ThreadIncarnationRow | null | undefined
    runtime(): RuntimeReader | undefined
    authorize(project: NonNullable<ReturnType<RuntimeReader["get"]>>): void
    workflowEvidence?: Omit<ProjectWorkflowEvidenceReaders, "thread">
  }
): NativeProjectRuntimeScope | undefined {
  context.assertCurrent()
  const initial = readers.thread(context.threadId)
  if (!initial || JSON.stringify(captureThreadIncarnation(initial)) !== context.incarnation)
    fail("SCOPE_CHANGED")
  const metadata = record(
    typeof initial.metadata === "string" ? JSON.parse(initial.metadata) : initial.metadata
  )
  if (
    typeof metadata?.workspacePath !== "string" ||
    !isSameWorkspacePath(metadata.workspacePath, context.workspace)
  )
    fail("SCOPE_CHANGED")
  if (metadata.hostProjectRuntime === undefined) return undefined
  const binding = record(metadata.hostProjectRuntime)
  if (
    !binding ||
    typeof binding.projectId !== "string" ||
    typeof binding.operationId !== "string" ||
    typeof binding.stageId !== "string" ||
    typeof binding.pluginDigest !== "string"
  )
    fail("BINDING_INVALID")
  const api = readers.runtime()
  if (!api) fail("NATIVE_UNAVAILABLE")
  const projectId = binding.projectId
  const project = api.get(projectId)
  const operations = api.operations(projectId, 100)
  const operation = operations.find((item) => item.operationId === binding.operationId)
  if (!project || !operation) fail("BINDING_INVALID")
  const bindingIdentity = JSON.stringify(binding)
  const assertAuthority = () => {
    context.assertCurrent()
    context.signal.throwIfAborted()
    const row = readers.thread(context.threadId)
    if (!row || JSON.stringify(captureThreadIncarnation(row)) !== context.incarnation)
      fail("SCOPE_CHANGED")
    const currentMetadata = record(
      typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
    )
    const current = api.get(projectId)
    const owned = api
      .operations(projectId, 100)
      .find((item) => item.operationId === operation.operationId)
    if (
      typeof currentMetadata?.workspacePath !== "string" ||
      !isSameWorkspacePath(currentMetadata.workspacePath, context.workspace) ||
      JSON.stringify(currentMetadata.hostProjectRuntime) !== bindingIdentity ||
      !current ||
      !owned ||
      !isSameWorkspacePath(current.workspace, context.workspace) ||
      current.pluginDigest !== binding.pluginDigest ||
      current.installedPluginId !== project.installedPluginId ||
      owned.projectId !== projectId ||
      owned.pluginDigest !== binding.pluginDigest ||
      owned.stageId !== binding.stageId ||
      owned.execution?.threadId !== context.threadId ||
      !current.manifest.stages.some((stage) => stage.id === owned.stageId)
    )
      fail("SCOPE_CHANGED")
    readers.authorize(current)
  }
  const identity = JSON.stringify([project, operation])
  const assertCurrent = () => {
    assertAuthority()
    if (
      JSON.stringify([
        api.get(projectId),
        api.operations(projectId, 100).find((item) => item.operationId === operation.operationId)
      ]) !== identity
    )
      fail("STATE_CHANGED")
  }
  assertCurrent()
  return {
    project,
    operation,
    historyLimited: operations.length >= 100,
    assertCurrent,
    assertAuthority,
    async prepareWorkflowEvidence(input) {
      assertCurrent()
      if (!api.captureWorkflowEvidenceStage || !readers.workflowEvidence) fail("WORKFLOW_UNAVAILABLE")
      const selected = api.captureWorkflowEvidenceStage(projectId, operation.operationId, input.stageId)
      const result = await captureProjectWorkflowEvidence({ ...selected, assertCurrent() {
        assertCurrent()
        selected.assertCurrent()
      } }, input, { ...readers.workflowEvidence, thread: readers.thread })
      assertCurrent()
      selected.assertCurrent()
      return { value: result.value,
        identity: createHash("sha256").update(JSON.stringify([selected.settlementIdentity, result.value])).digest("hex"),
        assertCurrent() { assertCurrent(); result.assertCurrent() },
        assertContentCurrent() {
          assertCurrent()
          selected.assertEvidenceCurrent()
          result.assertCurrent()
        }
      }
    },
    async preflight(kind) {
      assertCurrent()
      // Cancellation and recovery remain reachable when normal runtime inputs are broken.
      const identity =
        kind === "continue"
          ? await api.readDebugInputIdentity(projectId)
          : JSON.stringify([project.pluginDigest, operation.inputFingerprint, operation.status])
      assertCurrent()
      return identity
    }
  }
}

export function createNativeProjectRuntimePlatformProvider(
  executeNative?: ProjectRuntimePlatformDependencies["executeNative"]
) {
  return createProjectRuntimePlatformProvider({
    resolve: (context) =>
      resolveNativeProjectRuntimeScope(context, {
        thread: getThreadCore,
        runtime: () => resolver?.(),
        workflowEvidence: {
          assertSettled(threadId, runId) {
            if (workflowRunManager.isActive(threadId) || workflowRunManager.getFlushFailedRun(runId))
              fail("WORKFLOW_UNSETTLED")
          },
          load: loadWorkflowRunAsync,
          actions: observeWorkflowDeterministicActions
        },
        authorize(project) {
          if (isProjectPreviewId(project.installedPluginId))
            projectPreviewRegistry.assertProject(project)
          else if (
            !getPlugins().some(
              (plugin) => plugin.id === project.installedPluginId && plugin.enabled
            )
          )
            fail("PLUGIN_UNAVAILABLE")
        }
      }),
    executeNative
  })
}
