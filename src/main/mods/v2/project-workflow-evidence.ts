import { captureThreadIncarnation, type ThreadIncarnationRow } from "../../services/thread-incarnation"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type { HostProjectOperation, HostProjectState } from "../../../shared/project-runtime/host-types"
import type { PersistedWorkflowRun } from "../../agent/workflow/types"
import { observeWorkflowRun } from "../../agent/workflow/observation"
import type { WorkflowEvidenceReadScope } from "../../agent/workflow/deterministic-action-native"
import type { ModObject } from "../../../shared/mods/types"

export interface ProjectWorkflowEvidenceSelection {
  runId: string
  stageId: string
  agentOffset?: number
  worktreeOffset?: number
  actionOffset?: number
  limit?: number
}
export interface ProjectWorkflowEvidenceStage {
  project: HostProjectState
  operation: HostProjectOperation
  /** Main-only physical Skill settlement, independent of final stage validation. */
  assertSkillSettled(): void
  /** Full immutable input/artifact/receipt checks at each real read boundary. */
  assertEvidenceCurrent(): void
  settlementIdentity: string
  assertCurrent(): void
}
export interface ProjectWorkflowEvidenceReaders {
  thread(id: string): ThreadIncarnationRow | null | undefined
  /** Reject active lifecycle, failed final persistence and unavailable physical completion. */
  assertSettled(threadId: string, runId: string): void
  load(workspace: string, threadId: string, runId: string): Promise<PersistedWorkflowRun | null>
  actions(scope: WorkflowEvidenceReadScope, runId: string, offset?: number, limit?: number): ModObject
}
function fail(code: string): never { throw Error("PROJECT_RUNTIME_PUBLIC_WORKFLOW_" + code) }

/** Read exactly one Host-selected original operation. This creates no execution authority. */
export async function captureProjectWorkflowEvidence(
  selected: ProjectWorkflowEvidenceStage,
  input: ProjectWorkflowEvidenceSelection,
  readers: ProjectWorkflowEvidenceReaders
): Promise<{ value: ModObject; assertCurrent(): void }> {
  const { project, operation } = selected
  const threadId = operation.execution?.threadId
  if (!threadId || operation.stageId !== input.stageId) fail("UNSETTLED")
  selected.assertSkillSettled()
  const initial = readers.thread(threadId)
  if (!initial) fail("THREAD_UNAVAILABLE")
  const incarnation = JSON.stringify(captureThreadIncarnation(initial))
  const initialMetadata = initial.metadata
  const assertCurrent = () => {
    selected.assertSkillSettled()
    selected.assertCurrent()
    const row = readers.thread(threadId)
    if (!row || JSON.stringify(captureThreadIncarnation(row)) !== incarnation ||
      row.metadata !== initialMetadata) fail("THREAD_CHANGED")
    const metadata = JSON.parse(row.metadata ?? "{}")
    const binding = metadata.hostProjectRuntime
    if (!binding || binding.projectId !== operation.projectId ||
      binding.operationId !== operation.operationId || binding.stageId !== operation.stageId ||
      binding.pluginDigest !== operation.pluginDigest ||
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, project.workspace) ||
      metadata.remoteState === "historical" || metadata.remoteReadOnly === true) fail("THREAD_CHANGED")
    readers.assertSettled(threadId, input.runId)
  }
  assertCurrent()
  selected.assertEvidenceCurrent()
  assertCurrent()
  const run = await readers.load(project.workspace, threadId, input.runId)
  selected.assertEvidenceCurrent()
  assertCurrent()
  if (!run) fail("RUN_UNAVAILABLE")
  const owner = run.hostExecution
  if (run.runId !== input.runId || run.threadId !== threadId || !owner ||
    owner.projectId !== project.projectId || owner.operationId !== operation.operationId ||
    owner.stageId !== operation.stageId || owner.packageDigest !== operation.pluginDigest ||
    owner.inputFingerprint !== operation.inputFingerprint || owner.threadId !== threadId ||
    owner.incarnationKey !== incarnation) fail("OWNER_MISMATCH")
  if (!["completed", "error", "aborted"].includes(run.status) ||
    run.worktrees?.some(tree => tree.cleanupPending || tree.resource?.state === "unknown" ||
      ["running", "integrating"].includes(tree.status))) fail("UNSETTLED")
  const scope: WorkflowEvidenceReadScope = {
    workspace: project.workspace, threadId, incarnation, assertCurrent
  }
  const observed = observeWorkflowRun(run, input)
  const actions = readers.actions(scope, input.runId, input.actionOffset, input.limit)
  selected.assertEvidenceCurrent()
  assertCurrent()
  return { assertCurrent, value: { found: true, run: { ...observed, ...actions },
    evidence: { projectId: project.projectId, operationId: operation.operationId,
      stageId: operation.stageId, pluginDigest: operation.pluginDigest,
      inputFingerprint: operation.inputFingerprint } } }
}
