import type { BrowserWindow } from "electron"
import { dirname } from "node:path"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { flowDigest } from "../mods/flows/store"
import type { HostSkillExecutionContext } from "./project-runtime/host-service"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { fingerprintHostStageInput } from "./project-runtime/host-validators"
import {
  assertProjectActionProviders,
  captureProjectActionInputs,
  readProjectActionLock
} from "./project-runtime/action-input"
import { createProjectActionFlow } from "./project-runtime/action-flow"
import { withProjectActionScope } from "./project-action-scope"
import { getProjectActionRuntime } from "./project-action-runtime"
import { executeHostProjectSkill } from "./host-skill-executor"

/** Skill, then exported actions, then the coordinator's checks. One durable overall terminal. */
export async function executeHostProjectStage(
  context: HostSkillExecutionContext,
  owner: BrowserWindow,
  assertOperationCurrent: () => void
) {
  const project = context.project
  const lock = readProjectActionLock(context.snapshotRoot, project.manifest)
  const captured = captureProjectActionInputs(project, lock)
  if (!captured.bindings.length) return executeHostProjectSkill(context, owner)
  const runtime = getProjectActionRuntime()
  const snapshots = new HostPackageSnapshots(dirname(dirname(context.snapshotRoot)))
  const assertInputs = () => {
    context.signal.throwIfAborted()
    assertOperationCurrent()
    if (
      snapshots.read(project.pluginDigest).root !== context.snapshotRoot ||
      fingerprintHostStageInput(project, project.goal) !== context.ticket.inputFingerprint
    )
      throw Error("PROJECT_ACTION_INPUT_CHANGED")
    captured.assertCurrent()
    captured.assertScope(project)
  }
  assertInputs()
  const threadScope = (id: string) => {
    const thread = getThreadCore(id)
    if (!thread) throw Error("PROJECT_ACTION_THREAD_CHANGED")
    const incarnation = captureThreadIncarnation(thread)
    const metadata =
      typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
    const binding = metadata?.hostProjectRuntime
    if (
      !binding ||
      binding.operationId !== context.operation.operationId ||
      binding.projectId !== project.projectId ||
      binding.pluginDigest !== project.pluginDigest
    )
      throw Error("PROJECT_ACTION_THREAD_CHANGED")
    const assertIdentity = () => {
      if (!matchesThreadIncarnation(getThreadCore(id), incarnation))
        throw Error("PROJECT_ACTION_THREAD_CHANGED")
      const raw = getThreadCore(id)?.metadata
      const value = typeof raw === "string" ? JSON.parse(raw) : raw
      if (
        JSON.stringify(value?.hostProjectRuntime) !== JSON.stringify(binding) ||
        value?.workspacePath !== project.workspace
      )
        throw Error("PROJECT_ACTION_THREAD_CHANGED")
    }
    return { binding, assertIdentity }
  }
  let threadId: string | undefined
  let terminal: Parameters<HostSkillExecutionContext["recordTerminal"]>[0] | undefined
  let preflightFailed = false
  const result = await executeHostProjectSkill(
    {
      ...context,
      bindThread: (id) => {
        threadId = id
        context.bindThread(id)
      },
      recordTerminal: (value) => {
        terminal = value
      },
      prepareThread: async (id) => {
        try {
          const scope = threadScope(id)
          await withProjectActionScope(id, scope.binding, scope.assertIdentity, async () => {
            assertProjectActionProviders(lock, await runtime.catalog(project.workspace, id))
            assertInputs()
          })
        } catch (error) {
          preflightFailed = true
          throw error
        }
      }
    },
    owner
  ).catch((error) => {
    if (!preflightFailed) throw error
    terminal = { outcome: "error", code: "project_action_dependencies_unavailable" }
    return "failed" as const
  })
  if (result !== "succeeded" || !threadId) {
    context.recordTerminal(
      terminal ?? { outcome: "unknown", code: "project_skill_terminal_missing" }
    )
    return result === "succeeded" ? ("unknown" as const) : result
  }
  const id = threadId
  const { binding, assertIdentity } = threadScope(id)
  const assertCurrent = () => {
    assertInputs()
    assertIdentity()
  }
  return withProjectActionScope(id, binding, assertIdentity, async () => {
    assertProjectActionProviders(lock, await runtime.catalog(project.workspace, id))
    await runtime.prepareSelection(project.workspace, id, captured.bindings)
    assertCurrent()
    const definition = createProjectActionFlow(project, context.operation.operationId, captured)
    const run = await runtime.flows.startSaved(
      project.workspace,
      id,
      {
        definition,
        revision: 1,
        digest: flowDigest(definition),
        updatedAt: Date.now()
      },
      { workspace: project.workspace, goal: project.goal },
      assertCurrent
    )
    const cancel = () => {
      void runtime.flows.cancel(project.workspace, id, run.id).catch(() => {})
    }
    context.signal.addEventListener("abort", cancel, { once: true })
    if (context.signal.aborted) cancel()
    try {
      await runtime.flows.waitForSettlement(project.workspace, id, run.id)
      const settled = runtime.flows.run(project.workspace, id, run.id)
      // A Flow can be labelled cancelled/failed while an external action has no known result.
      // Retain the host operation's ownership in that case; retry could duplicate a write.
      const actionIds = new Set(captured.bindings.map((item) => item.id))
      const uncertain = settled?.attempts.some(
        (attempt) =>
          actionIds.has(attempt.stepId) &&
          (["unknown", "running", "waiting"].includes(attempt.status) ||
            (attempt.status !== "skipped" && !attempt.result))
      )
      const outcome = uncertain
        ? "unknown"
        : settled?.status === "complete"
          ? "success"
          : settled?.status === "failed"
            ? "error"
            : settled?.status === "cancelled"
              ? "cancelled"
              : "unknown"
      // Never persist Skill success as overall success while an action is still outstanding.
      if (outcome === "success") assertCurrent()
      context.recordTerminal({ outcome, code: `project_actions_${settled?.status ?? "unknown"}` })
      return outcome === "success"
        ? ("succeeded" as const)
        : outcome === "error"
          ? ("failed" as const)
          : outcome
    } finally {
      context.signal.removeEventListener("abort", cancel)
    }
  })
}
