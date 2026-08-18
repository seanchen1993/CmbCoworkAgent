import { BrowserWindow } from "electron"
import { v4 as uuid } from "uuid"
import { getThread } from "../db"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import { emitAppAttention } from "../app-attention-events"
import {
  formatGmt8Timestamp,
  getHarnessFeatureBinding,
  invokeHarnessAutoNextStep,
  readHarnessFeatureMetadata
} from "./service"
import {
  executeManagedActions,
  type ManagedActionExecutionContext
} from "./auto-mode-action-executor"
import {
  AUTO_MODE_CANCELLED_MESSAGE,
  type AgentTurnEndEvent,
  type AutoModeStateChangedEvent,
  type ManagedActionResult
} from "../../shared/harness-board-types"

export const AUTO_MODE_STATE_CHANGED_CHANNEL = "harnessBoard:autoModeStateChanged"

export interface AutoModeAgentTurnEndInput {
  threadId: string
  outcome: AgentTurnEndEvent["outcome"]
  endReason: AgentTurnEndEvent["endReason"]
  contextUsage?: AgentTurnEndEvent["contextUsage"]
  delivery: AgentRunDelivery
}

interface HarnessFeatureContext {
  projectId: string
  featureId: string
}

const MAX_MANAGED_ACTION_RESULT_EVENTS = 100
const managedActionResults = new Map<string, ManagedActionResult[]>()

function readHarnessFeatureContext(threadId: string): HarnessFeatureContext | null {
  const thread = getThread(threadId)
  if (!thread?.metadata) return null
  try {
    const metadata = JSON.parse(thread.metadata) as unknown
    const feature = readHarnessFeatureMetadata(metadata)
    return feature ? { projectId: feature.projectId, featureId: feature.slug } : null
  } catch {
    return null
  }
}

function readEnabledHarnessFeatureContext(threadId: string): HarnessFeatureContext | null {
  const feature = readHarnessFeatureContext(threadId)
  if (!feature) return null
  const binding = getHarnessFeatureBinding(feature.projectId, feature.featureId)
  return binding?.autoMode ? feature : null
}

function publishAutoModeStateChanged(event: AutoModeStateChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(AUTO_MODE_STATE_CHANGED_CHANNEL, event)
  }
}

function rememberManagedActionResults(eventId: string, results: ManagedActionResult[]): void {
  managedActionResults.set(eventId, results)
  while (managedActionResults.size > MAX_MANAGED_ACTION_RESULT_EVENTS) {
    const oldestEventId = managedActionResults.keys().next().value
    if (!oldestEventId) break
    managedActionResults.delete(oldestEventId)
  }
}

export async function handleAutoModeAgentTurnEnd(input: AutoModeAgentTurnEndInput): Promise<void> {
  const feature = readEnabledHarnessFeatureContext(input.threadId)
  if (!feature) return

  const event: AgentTurnEndEvent = {
    eventId: uuid(),
    eventType: "agent_turn_end",
    eventTime: formatGmt8Timestamp(),
    threadId: input.threadId,
    outcome: input.outcome,
    endReason: input.endReason,
    ...(input.contextUsage ? { contextUsage: input.contextUsage } : {})
  }

  if (input.outcome === "error") {
    emitAppAttention({
      kind: "task-error",
      threadId: input.threadId,
      key: `managed-mode:${event.eventId}`
    })
  }

  let decision: Awaited<ReturnType<typeof invokeHarnessAutoNextStep>>
  try {
    decision = await invokeHarnessAutoNextStep(feature.projectId, feature.featureId, event)
  } catch (error) {
    console.error("[AutoMode] autoNextStep failed:", {
      eventId: event.eventId,
      threadId: input.threadId,
      error
    })
    return
  }
  if (!decision) return
  console.info("[AutoMode] autoNextStep decision:", {
    eventId: event.eventId,
    threadId: input.threadId,
    ok: decision.ok,
    messages: decision.messages,
    actionCount: decision.action.length
  })

  const executionContext: ManagedActionExecutionContext = {
    eventId: event.eventId,
    sourceThreadId: input.threadId,
    projectId: feature.projectId,
    featureId: feature.featureId,
    messages: decision.messages
  }
  const execution = decision.ok
    ? await executeManagedActions({
        context: executionContext,
        actions: decision.action,
        delivery: input.delivery
      })
    : { results: [], pendingDrafts: [] }

  rememberManagedActionResults(event.eventId, execution.results)
  console.info("[AutoMode] action execution completed:", {
    eventId: event.eventId,
    results: execution.results
  })
  publishAutoModeStateChanged({
    eventId: event.eventId,
    projectId: feature.projectId,
    featureId: feature.featureId,
    sourceThreadId: input.threadId,
    messages: decision.messages,
    results: execution.results,
    pendingDrafts: execution.pendingDrafts
  })
}

export function handleAutoModeAgentCancelled(threadId: string): void {
  const feature = readEnabledHarnessFeatureContext(threadId)
  if (!feature) return

  publishAutoModeStateChanged({
    eventId: uuid(),
    projectId: feature.projectId,
    featureId: feature.featureId,
    sourceThreadId: threadId,
    messages: AUTO_MODE_CANCELLED_MESSAGE,
    results: [],
    pendingDrafts: []
  })
}
