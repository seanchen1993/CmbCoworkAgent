import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { addMessages } from "@langchain/langgraph"
import type { BrowserWindow } from "electron"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import {
  TURN_COMPLETION_GATE_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_MARKER_PREFIX
} from "../../shared/checkpoint-transcript"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import {
  COORDINATOR_NOTIFICATION_PROMPT_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../shared/internal-notification-turn"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  setCurrentRunMessageQueueOwner
} from "../agent/current-run-message-queue"
import {
  GOAL_CONTINUATION_BOUNDARY_METADATA_KEY,
  GOAL_GATE_PARENT_BOUNDARY_METADATA_KEY
} from "../agent/goals/internal-prompt"
import { goalManager } from "../agent/goals/runtime"
import { createPhysicalGoalGateRecoveryMessage } from "../agent/runtime"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import * as db from "../db"
import {
  createPhysicalRunHiddenUserMessage,
  persistAndForwardPhysicalRunStreamChunk
} from "./agent"
import { STOP_HOOK_REVISION_PROMPT_PREFIX } from "./stop-hook-context"
import {
  createSerializedValuesMessageAccumulator,
  createStreamDataSerializer
} from "./stream-data-serialization"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))

const window = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
} as unknown as BrowserWindow

it("routes each physical hidden Goal input through the durable boundary helper", () => {
  const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf8")
  expect(agentSource).toMatch(
    /: isWorkflowNotificationTurn\s+\? createPhysicalRunHiddenUserMessage\(/
  )
  expect(agentSource).toMatch(
    /const coordinatorNotificationInput = coordinatorNotificationHumanMessage\s+\? createPhysicalRunHiddenUserMessage\(/
  )
  expect(agentSource).toContain("const goalInput = createPhysicalRunHiddenUserMessage(")
  expect(
    agentSource.match(/const revisionInput = createPhysicalRunHiddenUserMessage\(/g)
  ).toHaveLength(3)
  const runtimeSource = readFileSync(join(__dirname, "../agent/runtime.ts"), "utf8")
  expect(runtimeSource).toMatch(
    /createRecoveryMessage: \(threadId, messages, prompt\) =>\s+createPhysicalGoalGateRecoveryMessage\(/
  )
  expect(agentSource).toContain(
    "adoptGraphTranscriptBoundaryFromValues(threadId, runToken, payload, completeValuesMessages)"
  )
})

it.each([
  {
    kind: "coordinator",
    fields: {
      content: `${COORDINATOR_NOTIFICATION_PROMPT_PREFIX} Worker finished`,
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    }
  },
  {
    kind: "workflow",
    fields: {
      id: "transport-user-id",
      content: `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}workflow-fixture]] Workflow finished`,
      additional_kwargs: {
        cmb_coordinator_augmented_user_message: true,
        cmb_visible_user_message: WORKFLOW_NOTIFICATION_TURN_PROMPT
      }
    }
  },
  { kind: "Stop revision", fields: { content: `${STOP_HOOK_REVISION_PROMPT_PREFIX} Revise` } },
  {
    kind: "completion gate",
    fields: { content: `${TURN_COMPLETION_GATE_MARKER_PREFIX}todo]] Finish the remaining work` }
  }
])(
  "keeps a hidden Goal $kind boundary through stream replay and checkpoint import",
  async ({ kind, fields }) => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-hidden-goal-boundary-"))
    const checkpointPath = join(directory, "checkpoint.sqlite")
    storage.path = join(directory, "threads.sqlite")
    const threadId = `hidden-goal-${kind}`
    const runToken = "physical-run"
    const signal = new AbortController().signal
    await db.initializeDatabase()
    try {
      db.createThread(threadId)
      const goal = goalManager.set(threadId, "Report the result")
      setCurrentRunMessageQueueOwner(threadId, runToken)
      const userContent = "/goal Report the result"
      const user = new HumanMessage({
        id: "user",
        content: userContent,
        additional_kwargs: {
          [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true,
          cmb_visible_user_message: userContent
        }
      })
      db.upsertThreadMessages(threadId, [
        { id: "user", role: "user", content: userContent, created_at: new Date() }
      ])

      let serialize = createStreamDataSerializer({ projectMessageChunks: true })
      let values = createSerializedValuesMessageAccumulator()
      const forwardValues = (messages: unknown[]) => {
        const frame = serialize("values", { messages })
        const snapshot = values.update(frame)
        persistAndForwardPhysicalRunStreamChunk(
          window,
          "agent:test",
          threadId,
          runToken,
          signal,
          "values",
          frame.data,
          frame.valuesMessageIndexOffset,
          frame.valuesSnapshotKind,
          snapshot.messages,
          true
        )
      }
      const providerId = "fixed-provider-id"
      const provider = (occurrence: number) => ({
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: providerId,
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence
      })
      const previousCall = new AIMessage({
        id: providerId,
        content: "Start work",
        tool_calls: [{ id: "call", name: "fixture", args: {} }],
        additional_kwargs: provider(1)
      })
      const previousResult = new ToolMessage({
        id: "past-result",
        content: "Work started",
        tool_call_id: "call",
        status: "success"
      })
      const previousReply = new AIMessage({
        id: "past-final-graph",
        content: "Waiting for result",
        additional_kwargs: provider(2)
      })
      const history = [user, previousCall, previousResult, previousReply]
      forwardValues(history)

      const gateInput = kind === "completion gate"
      const hidden = gateInput
        ? createPhysicalGoalGateRecoveryMessage(threadId, runToken, history, fields.content)
        : createPhysicalRunHiddenUserMessage(threadId, runToken, signal, goal, fields)
      expect(hidden.id).toBeDefined()
      expect(hidden.id).not.toBe(fields.id)
      expect(hidden.additional_kwargs).toMatchObject({
        [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true,
        ...(kind === "coordinator" && { cmb_internal_coordinator_notification: true }),
        ...(kind === "workflow" && { cmb_coordinator_augmented_user_message: true }),
        ...(gateInput && { [GOAL_GATE_PARENT_BOUNDARY_METADATA_KEY]: user.id })
      })
      expect(hidden.additional_kwargs).not.toHaveProperty("cmb_visible_user_message")
      expect(db.getThreadTranscriptBoundaryOrdinal(threadId, hidden.id!)).toBe(
        gateInput ? undefined : 4
      )
      expect(db.getThreadMessagesByIds(threadId, [hidden.id!])).toEqual([])

      const graph = addMessages(history, [hidden])
      const middleware = createCurrentRunMessageQueueMiddleware(
        runToken,
        (scope, boundaryId, source) => {
          const previous = db.getThreadMessageProviderOccurrencesBeforeUser(scope, boundaryId, [
            source
          ])
          return previous === undefined
            ? undefined
            : (previous.find((entry) => entry.role === "assistant")?.provider_occurrence ?? 0)
        }
      )
      // The SDK exposes the middleware hook with its broad Request type. The hook
      // receives only these fields when routing the physical graph response.
      const wrapModelCall = middleware.wrapModelCall as unknown as (
        request: { runtime: { configurable: { thread_id: string } }; messages: typeof graph },
        handler: () => Promise<AIMessage>
      ) => Promise<AIMessage>
      const newResponse = await wrapModelCall(
        { runtime: { configurable: { thread_id: threadId } }, messages: graph },
        async () => new AIMessage({ id: providerId, content: "Result verified" })
      )
      expect(newResponse.id).not.toBe(previousCall.id)
      expect(newResponse.additional_kwargs).toMatchObject(provider(3))
      // A graph-owned recovery may enter the model before IPC consumes its
      // frame. The earlier durable parent allows occurrence assignment first.
      forwardValues(graph)
      expect(db.getThreadTranscriptBoundaryOrdinal(threadId, hidden.id!)).toBe(4)
      const updated = addMessages(graph, [newResponse])
      expect(updated).toHaveLength(6)
      const chunk = serialize("messages", [
        new AIMessageChunk({ id: providerId, content: newResponse.content }),
        { checkpoint_ns: "model:fixture" }
      ])
      persistAndForwardPhysicalRunStreamChunk(
        window,
        "agent:test",
        threadId,
        runToken,
        signal,
        "messages",
        chunk.data
      )
      forwardValues(updated)
      const persisted = db.getThreadMessages(threadId)
      expect(persisted.map(({ content, ordinal }) => [content, ordinal])).toEqual([
        [user.content, 0],
        [previousCall.content, 1],
        [previousResult.content, 2],
        [previousReply.content, 3],
        [newResponse.content, 5]
      ])
      expect(persisted.at(-1)).toMatchObject({
        provider_source_id: providerId,
        provider_occurrence: 3
      })
      serialize = createStreamDataSerializer({ projectMessageChunks: true })
      values = createSerializedValuesMessageAccumulator()
      forwardValues(updated)
      expect(db.getThreadMessages(threadId)).toEqual(persisted)

      // An older missing row should be imported ahead of the hidden input rather
      // than being inserted between that boundary and its own response.
      const missingReply = new AIMessage({ id: "missing", content: "Older recovered evidence" })
      const saver = new SqlJsSaver(checkpointPath)
      try {
        await saver.put(
          { configurable: { thread_id: threadId, checkpoint_ns: "" } },
          {
            v: 1,
            id: "checkpoint-hidden-goal",
            ts: new Date().toISOString(),
            channel_values: { messages: [...history, missingReply, hidden, newResponse] },
            channel_versions: { messages: 1 },
            versions_seen: {}
          },
          { source: "loop", step: 1, parents: {} }
        )
      } finally {
        await saver.close()
      }
      await db.closeDatabase()
      const restored = bootstrapLegacyCheckpointTranscript(
        checkpointPath,
        storage.path,
        threadId,
        "",
        new SharedArrayBuffer(4)
      )
      expect(restored.stats).toMatchObject({ totalMessages: 6, migratedMessages: 1 })
      await db.initializeDatabase()
      expect(db.getThreadTranscriptBoundaryOrdinal(threadId, hidden.id!)).toBe(5)
      expect(
        db
          .getThreadMessages(threadId)
          .slice(-2)
          .map(({ content, ordinal }) => [content, ordinal])
      ).toEqual([
        [missingReply.content, 4],
        [newResponse.content, 6]
      ])

      goalManager.pause(threadId)
      const inactive = createPhysicalRunHiddenUserMessage(threadId, runToken, signal, goal, fields)
      expect(inactive.additional_kwargs).toEqual(fields.additional_kwargs ?? {})
      expect(inactive.id).toBe(fields.id)
    } finally {
      clearCurrentRunMessageQueue(threadId, runToken)
      await db.closeDatabase()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
