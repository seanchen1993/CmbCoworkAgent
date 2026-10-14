import { randomUUID } from "node:crypto"
import { getThreadCore } from "../../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../../services/thread-incarnation"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { goalManager } from "../../agent/goals/runtime"
import { onGoalStateChanged } from "../../agent/goals/state-events"
import { isAgentRunBusy, onAgentRunSettled, startAgentRun } from "../../agent/agent-run-service"
import { createManagedTransportAgentRunDelivery } from "../../agent/managed-transport-delivery"
import {
  claimLocalThreadRunLease,
  captureLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { createNativePluginPromptRun } from "../../agent/mods-plugin-prompt-entry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import type { ModsManager } from "../manager"
import { withFunctionTransportExecution } from "./host-call"
import { withFreshFunctionSessionActivity } from "./session-activity"
import { FunctionPluginPromptQueue, type FunctionPluginPromptLease } from "./plugin-prompt-queue"

/** One process-wide queue; resident Session cancellation retires only its own entries. */
export function createFunctionPluginPromptHost(
  manager: Pick<ModsManager, "workspaceKey" | "isEnabled" | "functionTurns">,
  assertThread: (workspace: string, threadId: string) => void
) {
  const runIds = new WeakMap<FunctionPluginPromptLease, string>()
  const queue = new FunctionPluginPromptQueue({
    busy: (threadId) =>
      !!getLocalThreadRunLease(threadId) ||
      isAgentRunBusy(threadId) ||
      manager.functionTurns.hasUnsettled(threadId) ||
      goalManager.get(threadId)?.status === "active",
    claim: (threadId) => {
      const runId = randomUUID()
      const claim = claimLocalThreadRunLease({ threadId, owner: "mods", runId })
      if (!claim.acquired) return undefined
      const current = captureLocalThreadRunLease(threadId)
      const lease: FunctionPluginPromptLease = {
        assertCurrent: () => {
          if (!current?.()) throw new ModFunctionError("MODS_PLUGIN_PROMPT_LEASE_CHANGED")
        },
        release: () => {
          releaseLocalThreadRunLease(threadId, "mods", runId)
        }
      }
      runIds.set(lease, runId)
      return lease
    },
    run: (scope, input, framed, lease, signal, started) =>
      withFreshFunctionSessionActivity(() =>
        withFunctionTransportExecution(
          {
            workspace: scope.workspace,
            threadId: scope.threadId,
            userInitiated: false,
            leased: true,
            immediate: false
          },
          async () => {
            const runId = runIds.get(lease)
            if (!runId) throw new ModFunctionError("MODS_PLUGIN_PROMPT_LEASE_CHANGED")
            const assertLive = () => {
              signal.throwIfAborted()
              scope.assertLive()
              lease.assertCurrent()
            }
            assertLive()
            const receipt = createNativePluginPromptRun({
              workspace: scope.workspace,
              threadId: scope.threadId,
              text: input.text as string,
              context: (input.context as string[] | undefined) ?? [],
              origin: scope.origin,
              framed,
              assertLive,
              started: () => {
                assertLive()
                started()
              }
            })
            const handle = await startAgentRun(
              { threadId: scope.threadId, message: receipt.text, userMessageId: randomUUID() },
              createManagedTransportAgentRunDelivery(),
              {
                source: "mods",
                pluginPrompt: receipt,
                signal,
                localRunLease: { owner: "mods", runId, managedExternally: true },
                backgroundNotificationOwner: "desktop",
                verifyResolvedThread: (resolved) => {
                  try {
                    assertLive()
                    if (
                      !resolved.workspacePath ||
                      manager.workspaceKey(resolved.workspacePath) !== scope.workspace
                    )
                      return "MODS_PLUGIN_PROMPT_SCOPE_CHANGED"
                    return null
                  } catch {
                    return "MODS_PLUGIN_PROMPT_SCOPE_CHANGED"
                  }
                }
              }
            )
            await handle.completion
          }
        )
      ),
    onIdle: (listener) => {
      const stops = [
        onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId)),
        onAgentRunSettled(listener),
        manager.functionTurns.onSettled(listener),
        onGoalStateChanged(listener)
      ]
      return () => stops.forEach((stop) => stop())
    },
    error: (error) => console.error("[Mods] Plugin prompt cleanup failed:", error)
  })
  return {
    reserve(
      workspace: string,
      threadId: string,
      origin: FunctionPluginPromptOrigin,
      lifetime: AbortSignal,
      assertResident: () => void
    ) {
      assertThread(workspace, threadId)
      const thread = getThreadCore(threadId)
      if (!thread) throw new ModFunctionError("MODS_PLUGIN_PROMPT_SCOPE_CHANGED")
      const incarnation = captureThreadIncarnation(thread)
      const assertLive = () => {
        lifetime.throwIfAborted()
        assertResident()
        assertThread(workspace, threadId)
        const current = getThreadCore(threadId)
        const parsed = parseStandardThreadMetadata(current?.metadata)
        if (
          !matchesThreadIncarnation(current, incarnation) ||
          !manager.isEnabled(workspace) ||
          parsed.agentMode !== "normal" ||
          !parsed.workspacePath ||
          manager.workspaceKey(parsed.workspacePath) !== workspace
        )
          throw new ModFunctionError("MODS_PLUGIN_PROMPT_SCOPE_CHANGED")
      }
      assertLive()
      return queue.reserve({
        workspace,
        threadId,
        origin: { ...origin },
        signal: lifetime,
        assertLive
      })
    },
    close: () => queue.close()
  }
}
