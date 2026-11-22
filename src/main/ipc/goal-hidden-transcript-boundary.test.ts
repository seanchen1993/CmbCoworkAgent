import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import { addMessages } from "@langchain/langgraph"
import type { BrowserWindow } from "electron"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import {
  TURN_COMPLETION_GATE_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_MARKER_PREFIX
} from "../../shared/checkpoint-transcript"
import { NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY } from "../../shared/graph-transcript-boundary"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
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
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import {
  createPhysicalScopedGateRecoveryMessage,
  prepareLegacyScopedProviderHistory
} from "../agent/runtime"
import { closeCheckpointRuntimeProjectionWorker } from "../checkpointer/runtime-projection-client"
import { captureStockLegacyTranscriptSource } from "../checkpointer/legacy-stock-transcript-admission"
import { bootstrapStockLegacyCheckpointTranscript } from "../checkpointer/legacy-stock-transcript-store"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "../checkpointer/runtime-projection-protocol"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import * as db from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { ModsManager, setModsManager } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import {
  createPhysicalRunHiddenUserMessage,
  persistAndForwardPhysicalRunStreamChunk
} from "./agent"
import { STOP_HOOK_REVISION_PROMPT_PREFIX } from "./stop-hook-context"
import {
  createSerializedValuesMessageAccumulator,
  createStreamDataSerializer
} from "./stream-data-serialization"

const storage = vi.hoisted(() => ({ path: "", checkpointPath: "" }))
vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => storage.path,
  getThreadCheckpointPath: () => storage.checkpointPath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))

const window = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() }
} as unknown as BrowserWindow


it("routes physical hidden inputs through the durable boundary helper", () => {
  const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf8")
  expect(agentSource).toMatch(
    /: isWorkflowNotificationTurn\s+\? createPhysicalRunHiddenUserMessage\(/
  )
  expect(agentSource).toMatch(
    /const coordinatorNotificationInput = coordinatorNotificationFields\s+\? isCoordinatorNotificationTurn\s+\? createPhysicalRunHiddenUserMessage\(/
  )
  expect(agentSource).toContain("const goalInput = createPhysicalRunHiddenUserMessage(")
  expect(agentSource.match(/selectRuntimeCompletionRevisionInput\(/g)).toHaveLength(3)
  const runtimeSource = readFileSync(join(__dirname, "../agent/runtime.ts"), "utf8")
  expect(runtimeSource).toMatch(
    /createRecoveryMessage: \(threadId, messages, prompt\) =>\s+createPhysicalScopedGateRecoveryMessage\(/
  )
  expect(agentSource).toMatch(/adoptGraphTranscriptBoundaryFromValues\(\s*threadId,/)
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
    kind: "ordinary Team notification",
    notification: true,
    fields: {
      content: COORDINATOR_NOTIFICATION_PROMPT_PREFIX + " Worker finished",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    }
  },
  {
    kind: "ordinary Workflow notification",
    notification: true,
    fields: {
      content: WORKFLOW_NOTIFICATION_MARKER_PREFIX + "workflow-fixture]] Workflow finished",
      additional_kwargs: {
        cmb_coordinator_augmented_user_message: true,
        cmb_visible_user_message: WORKFLOW_NOTIFICATION_TURN_PROMPT
      }
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
  "keeps a hidden $kind boundary through stream replay and checkpoint import",
  async ({ kind, fields, notification }) => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-hidden-goal-boundary-"))
    const checkpointPath = join(directory, "checkpoint.sqlite")
    storage.path = join(directory, "threads.sqlite")
    const threadId = `hidden-goal-${kind}`
    const runToken = "physical-run"
    const signal = new AbortController().signal
    await db.initializeDatabase()
    try {
      db.createThread(threadId)
      const goal = notification ? undefined : goalManager.set(threadId, "Report the result")
      setCurrentRunMessageQueueOwner(threadId, runToken)
      const userContent = notification ? "Report the result" : "/goal Report the result"
      const user = new HumanMessage({
        id: "user",
        content: userContent,
        additional_kwargs: goal
          ? {
              [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true,
              cmb_visible_user_message: userContent
            }
          : {}
      })
      db.upsertThreadMessages(threadId, [
        { id: "user", role: "user", content: userContent, created_at: new Date() }
      ])

      let serialize = createStreamDataSerializer({ projectMessageChunks: true })
      let values = createSerializedValuesMessageAccumulator()
      const forwardValues = (messages: unknown[], owner = runToken, resumeNotification = false) => {
        const frame = serialize("values", { messages })
        const snapshot = values.update(frame)
        persistAndForwardPhysicalRunStreamChunk(
          window,
          "agent:test",
          threadId,
          owner,
          signal,
          "values",
          frame.data,
          frame.valuesMessageIndexOffset,
          frame.valuesSnapshotKind,
          snapshot.messages,
          Boolean(goal),
          resumeNotification
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
        ? createPhysicalScopedGateRecoveryMessage(threadId, runToken, history, fields.content)
        : createPhysicalRunHiddenUserMessage(
            threadId,
            runToken,
            signal,
            goal,
            fields,
            notification ? "notification" : "goal"
          )
      expect(hidden.id).toBeDefined()
      expect(hidden.id).not.toBe(fields.id)
      expect(hidden.additional_kwargs).toMatchObject({
        [notification
          ? NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY
          : GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true,
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
      const namespace = "model_request:fixture"
      const executionId = "cmb-notification-assistant:" + namespace
      const forwardChunk = (content: string, id?: string) => {
        const chunk = serialize("messages", [
          new AIMessageChunk({ id, content }),
          { langgraph_checkpoint_ns: namespace }
        ])
        return persistAndForwardPhysicalRunStreamChunk(
          window,
          "agent:test",
          threadId,
          runToken,
          signal,
          "messages",
          chunk.data
        )
      }
      // The first token can precede an ID. A different provider ID may appear
      // on the completed message, but both have the registered execution ID.
      const runModel = () =>
        wrapModelCall(
          { runtime: { configurable: { thread_id: threadId } }, messages: graph },
          async () => {
            if (notification) {
              expect(forwardChunk("", "wire-opening-id")).toBeNull()
              expect(forwardChunk("Result ")).toBe(executionId)
              expect(forwardChunk("verified", "wire-content-id")).toBe(executionId)
            }
            return new AIMessage({ id: providerId, content: "Result verified" })
          }
        )
      const newResponse = notification
        ? await AsyncLocalStorageProviderSingleton.runWithConfig(
            { metadata: { langgraph_checkpoint_ns: namespace } },
            runModel
          )
        : await runModel()
      if (notification) {
        expect(newResponse.id).toBe(executionId)
        expect(newResponse.additional_kwargs).toMatchObject({
          [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: executionId,
          [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 1
        })
      } else {
        expect(newResponse.id).not.toBe(previousCall.id)
        expect(newResponse.additional_kwargs).toMatchObject(provider(3))
      }
      // A graph-owned recovery may enter the model before IPC consumes its
      // frame. The earlier durable parent allows occurrence assignment first.
      forwardValues(graph)
      expect(db.getThreadTranscriptBoundaryOrdinal(threadId, hidden.id!)).toBe(4)
      const updated = addMessages(graph, [newResponse])
      expect(updated).toHaveLength(6)
      if (!notification) forwardChunk(String(newResponse.content), providerId)
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
        provider_source_id: notification ? executionId : providerId,
        provider_occurrence: notification ? 1 : 3
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

      if (notification) {
        const resumedRun = "resumed-approval"
        setCurrentRunMessageQueueOwner(threadId, resumedRun)
        try {
          const restoredGraph = [...history, missingReply, hidden, newResponse]
          const checkpoint = db.getThreadMessages(threadId)
          for (const resumesCheckpoint of [false, true]) {
            serialize = createStreamDataSerializer({ projectMessageChunks: true })
            values = createSerializedValuesMessageAccumulator()
            forwardValues(restoredGraph, resumedRun, resumesCheckpoint)
            expect(db.getThreadMessages(threadId)).toEqual(checkpoint)
          }
        } finally {
          clearCurrentRunMessageQueue(threadId, resumedRun)
        }
      }

      if (goal) {
        goalManager.pause(threadId)
        const inactive = createPhysicalRunHiddenUserMessage(
          threadId,
          runToken,
          signal,
          goal,
          fields
        )
        expect(inactive.additional_kwargs).toEqual(fields.additional_kwargs ?? {})
        expect(inactive.id).toBe(fields.id)
      }
    } finally {
      clearCurrentRunMessageQueue(threadId, runToken)
      await db.closeDatabase()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.each([
  ["declared", false],
  ["encoded", false],
  ["raw", false],
  ["encoded", true],
  ["raw", true],
  ["role collision", true],
  ["role collision suffix", true]
] as const)(
  "keeps distinct Goal replies and both tool results with older %s identity (compacted: %s)",
  async (identity, compacted) => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-goal-recovery-occurrence-"))
    const checkpointPath = join(directory, "checkpoint.sqlite")
    storage.path = join(directory, "threads.sqlite")
    const threadId = "goal-with-missing-earlier-reply"
    const runToken = "physical-run"
    const signal = new AbortController().signal
    const providerId = "reused-provider"
    const historyOccurrence = identity === "declared" || identity === "encoded" ? 2 : 1
    const liveOccurrence = historyOccurrence + 1
    const sharedCallId = "reused-call-id"
    const toolCalls = [{ id: sharedCallId, name: "read", args: {} }]
    const provider = (occurrence: number) => ({
      [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: providerId,
      [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence
    })
    await db.initializeDatabase()
    try {
      db.createThread(threadId)
      const goal = goalManager.set(threadId, "Report the result")
      setCurrentRunMessageQueueOwner(threadId, runToken)
      const user = new HumanMessage({
        id: identity.startsWith("role collision") ? providerId : "user",
        content: "/goal Report the result"
      })
      const previous = new AIMessage({
        id: historyOccurrence === 1 ? "different-provider" : providerId,
        content: "Durable reply",
        additional_kwargs: historyOccurrence === 1 ? {} : provider(1)
      })
      db.upsertThreadMessages(threadId, [
        { id: user.id!, role: "user", content: String(user.content), created_at: new Date() },
        {
          id: previous.id!,
          role: "assistant",
          content: String(previous.content),
          created_at: new Date(),
          ...(historyOccurrence > 1 && { provider_source_id: providerId, provider_occurrence: 1 })
        }
      ])
      const earlier = createPhysicalRunHiddenUserMessage(threadId, runToken, signal, goal, {
        content: "Earlier continuation"
      })
      const checkpointMessageIds = {
        declared: "checkpoint-only-reply",
        encoded: buildMessageSameRoleDuplicateId(providerId, "assistant", historyOccurrence),
        raw: providerId,
        "role collision": buildMessageRoleCollisionId(providerId, "assistant"),
        "role collision suffix": buildMessageRoleCollisionId(providerId, "assistant", 3)
      }
      const missing = new AIMessage({
        id: checkpointMessageIds[identity],
        content: "Recovered reply",
        tool_calls: toolCalls,
        additional_kwargs: identity === "declared" ? provider(historyOccurrence) : {}
      })
      const earlierResult = new ToolMessage({
        id: "earlier-result",
        content: "Recovered evidence",
        tool_call_id: sharedCallId,
        status: "success"
      })
      const saved = [user, previous, earlier, missing, earlierResult]
      const saver = new SqlJsSaver(checkpointPath)
      try {
        await saver.put(
          { configurable: { thread_id: threadId, checkpoint_ns: "" } },
          {
            v: 1,
            id: "checkpoint-awaiting-legacy-bootstrap",
            ts: new Date().toISOString(),
            channel_values: { messages: saved },
            channel_versions: { messages: 1 },
            versions_seen: {}
          },
          { source: "loop", step: 1, parents: {} }
        )
      } finally {
        await saver.close()
      }

      const bootstrap = () =>
        bootstrapLegacyCheckpointTranscript(
          checkpointPath,
          storage.path,
          threadId,
          "",
          new SharedArrayBuffer(4)
        )
      if (compacted) {
        expect(bootstrap().stats.migratedMessages).toBe(2)
        // A compacted model input cannot supply the older occurrence. SQLite
        // must recover it even from rows without persisted provider metadata.
        expect(
          db.getThreadMessageProviderOccurrencesBeforeUser(threadId, earlier.id!, [providerId])
        ).not.toContainEqual(
          expect.objectContaining({
            role: "assistant",
            provider_occurrence: historyOccurrence
          })
        )
      }
      const current = createPhysicalRunHiddenUserMessage(threadId, runToken, signal, goal, {
        content: "Current continuation"
      })
      if (compacted) {
        expect(
          db.getThreadMessageProviderOccurrencesBeforeUser(threadId, current.id!, [providerId])
        ).toContainEqual({
          provider_source_id: providerId,
          role: "assistant",
          provider_occurrence: historyOccurrence
        })
      }
      const graph = addMessages(compacted ? [user] : saved, [current])
      const serialize = createStreamDataSerializer({ projectMessageChunks: true })
      const values = createSerializedValuesMessageAccumulator()
      const forward = (mode: "values" | "messages", payload: unknown) => {
        const frame = serialize(mode, payload)
        const snapshot = mode === "values" ? values.update(frame) : undefined
        persistAndForwardPhysicalRunStreamChunk(
          window,
          "agent:test",
          threadId,
          runToken,
          signal,
          mode,
          frame.data,
          frame.valuesMessageIndexOffset,
          frame.valuesSnapshotKind,
          snapshot?.messages,
          true
        )
      }
      forward("values", { messages: graph })
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
      const wrapModelCall = middleware.wrapModelCall as unknown as (
        request: { runtime: { configurable: { thread_id: string } }; messages: typeof graph },
        handler: () => Promise<AIMessage>
      ) => Promise<AIMessage>
      let reply: AIMessage
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        reply = await wrapModelCall(
          { runtime: { configurable: { thread_id: threadId } }, messages: graph },
          async () => {
            forward("messages", [
              new AIMessageChunk({ id: providerId, content: "Live reply" }),
              { checkpoint_ns: "model:fixture" }
            ])
            await vi.advanceTimersByTimeAsync(250)
            expect(db.getThreadMessages(threadId).at(-1)).toMatchObject({
              content: "Live reply",
              provider_occurrence: liveOccurrence
            })
            return new AIMessage({ id: providerId, content: "Live reply", tool_calls: toolCalls })
          }
        )
      } finally {
        vi.useRealTimers()
      }
      expect(reply.additional_kwargs).toMatchObject(provider(liveOccurrence))
      const currentResult = new ToolMessage({
        id: "current-result",
        content: "Live evidence",
        tool_call_id: sharedCallId,
        status: "success"
      })
      forward("values", { messages: addMessages(graph, [reply, currentResult]) })
      expect(db.getThreadMessages(threadId).map(({ content }) => content)).toEqual([
        user.content,
        previous.content,
        ...(compacted ? [missing.content, earlierResult.content] : []),
        reply.content,
        currentResult.content
      ])
      const rendererEvent = vi.mocked(window.webContents.send).mock.lastCall?.[1] as {
        data: { messages: Array<{ kwargs: Record<string, unknown> }> }
      }
      expect(rendererEvent.data.messages.map(({ kwargs }) => kwargs)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: "Live reply",
            additional_kwargs: expect.objectContaining(provider(liveOccurrence))
          }),
          expect.objectContaining({ content: "Live evidence", tool_call_id: sharedCallId })
        ])
      )

      expect(bootstrap().stats.migratedMessages).toBe(compacted ? 0 : 2)
      const transcript = db.getThreadMessages(threadId)
      expect(
        transcript.map(({ content, ordinal, provider_occurrence }) => [
          content,
          ordinal,
          provider_occurrence
        ])
      ).toEqual([
        [user.content, 0, undefined],
        [previous.content, 1, historyOccurrence === 1 ? undefined : 1],
        [missing.content, 3, historyOccurrence === 1 ? undefined : historyOccurrence],
        [earlierResult.content, 4, undefined],
        [reply.content, 6, liveOccurrence],
        [currentResult.content, 7, 1]
      ])
      expect(
        transcript
          .filter(({ role }) => role === "tool")
          .map(({ content, status, tool_call_id }) => [content, status, tool_call_id])
      ).toEqual([
        [earlierResult.content, "success", sharedCallId],
        [currentResult.content, "success", sharedCallId]
      ])
    } finally {
      clearCurrentRunMessageQueue(threadId, runToken)
      await db.closeDatabase()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.each([false, true])("prepares provider history and respects the run owner (Goal turn=%s)", async (goalTurn) => {
  const threadId = "goal-with-upgraded-provider-history"
  const runToken = "originating-owner"
  let finishPreparation!: () => void
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
  )
  const handler = vi.fn(async () => new AIMessage({ id: "reply", content: "Result" }))
  const boundary = new HumanMessage({
    id: "goal-boundary",
    content: "Continuation",
    ...(goalTurn && { additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true } })
  })
  const middleware = createCurrentRunMessageQueueMiddleware(runToken, undefined, prepare)
  const wrapModelCall = middleware.wrapModelCall as unknown as (
    request: { runtime: { configurable: { thread_id: string } }; messages: HumanMessage[] },
    handler: () => Promise<AIMessage>
  ) => Promise<AIMessage>
  const request = {
    runtime: { configurable: { thread_id: threadId } },
    messages: [boundary]
  }
  setCurrentRunMessageQueueOwner(threadId, runToken)
  try {
    const initial = wrapModelCall(request, handler)
    expect(prepare).toHaveBeenCalledWith(threadId, goalTurn, undefined)
    expect(handler).not.toHaveBeenCalled()
    finishPreparation()
    await initial
    expect(handler).toHaveBeenCalledTimes(1)

    const superseded = wrapModelCall(request, handler)
    setCurrentRunMessageQueueOwner(threadId, "replacement-owner")
    finishPreparation()
    await expect(superseded).rejects.toMatchObject({ name: "AbortError" })
    expect(handler).toHaveBeenCalledTimes(1)
  } finally {
    clearCurrentRunMessageQueue(threadId)
  }
})

it.each([false, true])("recovers a pending legacy Goal provider occurrence (fragmented: %s)", async (fragmented) => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-legacy-goal-running-recovery-"))
  storage.path = join(directory, "threads.sqlite")
  storage.checkpointPath = join(directory, "checkpoint.sqlite")
  const threadId = "legacy-goal-running-recovery"
  const runToken = "current-physical-run"
  const providerId = "repeated-provider-id"
  const recoveredId = buildMessageSameRoleDuplicateId(providerId, "assistant", 2)
  const reply = fragmented ? "待恢复的正文".repeat(140_000) : "Pending reply"
  const signal = new AbortController().signal
  const hidden = new HumanMessage({ id: "hidden", content: "Continuation",
    additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true } })
  try {
    await db.initializeDatabase()
    db.createThread(threadId, { harnessProjectSession: { projectId: "legacy-project", kind: "chat" } })
    db.upsertThreadMessages(threadId, [
      { id: "root", role: "user", content: "Question", created_at: new Date() },
      { id: providerId, role: "assistant", content: "Prior reply", created_at: new Date() }
    ])
    db.reserveThreadGraphTranscriptBoundary(threadId, hidden.id!)
    const saver = new SqlJsSaver(storage.checkpointPath)
    try {
      await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: "" } }, {
        id: "legacy-goal", ts: new Date().toISOString(), v: 1,
        channel_values: { messages: [hidden, new AIMessage({ id: providerId, content: reply,
          additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: providerId,
            [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2 } })] },
        channel_versions: { messages: 1 }, versions_seen: {}
      }, { source: "loop", step: 1, parents: {} })
    } finally {
      await saver.close()
    }
    // Reproduce an interrupted older migration that recorded ordinals without provider tuples.
    const database = new DatabaseSync(storage.path)
    try {
      const currentMigration = database.prepare(`SELECT status
        FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`)
      const cancellation = new SharedArrayBuffer(4)
      const flag = new Int32Array(cancellation)
      const load = Atomics.load
      const pause = vi.spyOn(Atomics, "load").mockImplementation((target, index) => {
        if (target.buffer === cancellation && currentMigration.get(threadId)?.status === "migrating")
          Atomics.store(flag, 0, 1)
        return load(target, index)
      })
      try {
        expect(() => bootstrapLegacyCheckpointTranscript(
          storage.checkpointPath, storage.path, threadId, "", cancellation
        )).toThrow(expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED }))
      } finally {
        pause.mockRestore()
      }
      database.prepare(`UPDATE legacy_checkpoint_transcript_slots
        SET provider_source_id = NULL, role = NULL, provider_occurrence = NULL WHERE thread_id = ?`)
        .run(threadId)
      // The compacted checkpoint had only occurrence 2 and its archived time still used the raw ID.
      database.prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?")
        .run(JSON.stringify({ messageTimes: { [providerId]: { start_at: 200, end_at: 300 } } }), threadId)
    } finally {
      database.close()
    }
    expect(db.hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(true)
    const middleware = createCurrentRunMessageQueueMiddleware(runToken, undefined,
      (id, scopedTurn, activeSignal) => prepareLegacyScopedProviderHistory(
        id, scopedTurn, runToken, activeSignal))
    const wrapModelCall = middleware.wrapModelCall as unknown as (
      request: { runtime: { configurable: { thread_id: string }; signal: AbortSignal };
        messages: HumanMessage[] }, handler: () => Promise<AIMessage>
    ) => Promise<AIMessage>
    const handler = vi.fn(async () => {
      expect(db.hasUnresolvedLegacyTranscriptSlots(threadId)).toBe(false)
      const recovered = db.getThreadMessages(threadId)
      expect(recovered).toEqual([
        expect.objectContaining({ id: "root", content: "Question" }),
        expect.objectContaining({ id: providerId, content: "Prior reply" }),
        expect.objectContaining({ id: recoveredId, provider_occurrence: 2 })
      ])
      const hash = (content: string) => createHash("sha256").update(content).digest("hex")
      let recoveredBody = String(recovered[2].content)
      if (fragmented) {
        const fragments = db.getDb().exec(`SELECT content_text FROM thread_message_fragments
          WHERE thread_id = ? AND message_id = ? ORDER BY fragment_id`, [threadId, recoveredId])
        recoveredBody = fragments[0]?.values.map(([content]) => String(content)).join("") ?? ""
      }
      expect(hash(recoveredBody)).toBe(hash(reply))
      expect([recovered[1].start_at, recovered[1].end_at]).toEqual([undefined, undefined])
      expect([recovered[2].start_at?.getTime(), recovered[2].end_at?.getTime()]).toEqual([200, 300])
      return new AIMessage({ id: "current-reply", content: "Result" })
    })
    setCurrentRunMessageQueueOwner(threadId, runToken)
    await wrapModelCall({ runtime: { configurable: { thread_id: threadId }, signal },
      messages: [hidden] }, handler)
    expect(handler).toHaveBeenCalledOnce()
  } finally {
    clearCurrentRunMessageQueue(threadId, runToken)
    await closeCheckpointRuntimeProjectionWorker()
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

const stockScopes = ["ordinary", "project", "project with newer checkpoint", "protected project"]
it.each(stockScopes)("resumes an interrupted stock reservation in %s", async (scope) => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-stock-running-recovery-"))
  storage.path = join(directory, "threads.sqlite")
  storage.checkpointPath = join(directory, "checkpoint.sqlite")
  const threadId = "stock-running-recovery"
  const runToken = "current-stock-run"
  const signal = new AbortController().signal
  const protectedOutput = scope === "protected project"
  const hasNewerCheckpoint = scope === "project with newer checkpoint"
  const manager = new ModsManager(join(directory, "mods.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false })
  try {
    await db.initializeDatabase()
    const thread = db.createThread(threadId, { workspacePath: directory })
    const root = new HumanMessage({ id: "root", content: "Initial question" })
    const prior = new AIMessage({ id: "prior", content: "Earlier response" })
    const hidden = new HumanMessage({ id: "goal-boundary", content: "Continue Goal",
      additional_kwargs: { [GOAL_CONTINUATION_BOUNDARY_METADATA_KEY]: true } })
    const missing = new AIMessage({ id: "checkpoint-only", content: "Recovered Goal response" })
    db.upsertThreadMessages(threadId, [
      { id: root.id!, role: "user", content: String(root.content), created_at: new Date() },
      { id: prior.id!, role: "assistant", content: String(prior.content), created_at: new Date() }
    ], { preserveExistingOrder: true })
    db.reserveThreadGraphTranscriptBoundary(threadId, hidden.id!)
    const oldRows = Array.from({ length: 70 }, (_, index) => ({ id: `existing-${index}`,
      role: "assistant" as const, content: `Existing ${index}`, created_at: new Date() }))
    db.upsertThreadMessages(threadId, oldRows, { preserveExistingOrder: true })
    const history = [root, prior, missing, hidden,
      ...oldRows.map(row => new AIMessage({ id: row.id, content: row.content }))]
    const saver = new SqlJsSaver(storage.checkpointPath)
    try {
      await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: "" } }, {
        id: "stock-goal", ts: new Date().toISOString(), v: 1,
        channel_values: { messages: history },
        channel_versions: { messages: 1 }, versions_seen: {}
      }, { source: "loop", step: 1, parents: {} })
    } finally {
      await saver.close()
    }
    const source = captureStockLegacyTranscriptSource({ database: db.getDb(),
      checkpointPath: storage.checkpointPath, threadId, incarnation: captureThreadIncarnation(thread),
      assertCurrent() {} })!
    expect(source).toBeDefined()
    const observer = new DatabaseSync(storage.path)
    try {
      const marker = observer.prepare(`SELECT status, scoped_order, ordinal_reservation
        FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`)
      const cancellation = new SharedArrayBuffer(4)
      const flag = new Int32Array(cancellation)
      const load = Atomics.load
      const pause = vi.spyOn(Atomics, "load").mockImplementation((target, index) => {
        // Read from a separate connection and wait until the reservation is durable.
        if (target.buffer === cancellation && marker.get(threadId)?.status === "reserving")
          Atomics.store(flag, 0, 1)
        return load(target, index)
      })
      try {
        expect(() => bootstrapStockLegacyCheckpointTranscript(
          storage.checkpointPath, storage.path, threadId, "", cancellation, source.authority
        )).toThrow(expect.objectContaining({ name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED }))
      } finally {
        pause.mockRestore()
      }
      expect(marker.get(threadId)).toMatchObject({ status: "reserving", scoped_order: 1,
        ordinal_reservation: expect.any(String) })
      // Old UAT allowed the same stock reservation for project chats. Recreate
      // their durable attribution after seeding with the current ordinary path.
      if (scope !== "ordinary") observer.prepare(`UPDATE threads SET metadata =
        json_set(metadata, '$.harnessProjectSession', json(?)) WHERE thread_id = ?`)
        .run(JSON.stringify({ projectId: "legacy-project", kind: "chat" }), threadId)
      expect(db.hasPendingGoalTranscriptOrder(threadId)).toBe(true)
    } finally {
      observer.close()
    }
    if (hasNewerCheckpoint) {
      // LangGraph can write a new input checkpoint before the model's history hook.
      const newerSaver = new SqlJsSaver(storage.checkpointPath, undefined, { maxRootCheckpoints: 3 })
      try {
        await newerSaver.put({ configurable: { thread_id: threadId, checkpoint_ns: "",
          checkpoint_id: "stock-goal" } }, {
          id: "stock-goal-newer", ts: new Date().toISOString(), v: 1,
          channel_values: { messages: [...history,
            new HumanMessage({ id: "newer-only", content: "New graph input" })] },
          channel_versions: { messages: 2 }, versions_seen: {}
        }, { source: "input", step: 2, parents: {} })
      } finally {
        await newerSaver.close()
      }
      const checkpoints = new DatabaseSync(storage.checkpointPath, { readOnly: true })
      try {
        expect(checkpoints.prepare(`SELECT checkpoint_id FROM checkpoints WHERE thread_id=?
          ORDER BY checkpoint_ts DESC, checkpoint_id DESC`).all(threadId).map(row => row.checkpoint_id))
          .toEqual(["stock-goal-newer", "stock-goal"])
      } finally {
        checkpoints.close()
      }
    }
    manager.configure(directory, false, protectedOutput)
    setModsManager(manager)
    setCurrentRunMessageQueueOwner(threadId, runToken)
    expect(claimLocalThreadRunLease({ threadId, owner: "desktop", runId: runToken }).acquired).toBe(true)
    const recovery = prepareLegacyScopedProviderHistory(threadId, true, runToken, signal)
    if (protectedOutput) {
      await expect(recovery).rejects.toMatchObject({ name: "LEGACY_CHECKPOINT_TRANSCRIPT_SOURCE_UNAVAILABLE" })
      expect(db.hasPendingGoalTranscriptOrder(threadId)).toBe(true)
      expect(db.getThreadMessages(threadId).some(message => message.id === missing.id)).toBe(false)
      return
    }
    await recovery
    expect(db.hasPendingGoalTranscriptOrder(threadId)).toBe(false)
    expect(db.getThreadMessages(threadId).map(message => message.id)).toEqual([
      root.id, prior.id, missing.id, ...oldRows.map(message => message.id)
    ])
  } finally {
    setModsManager(undefined)
    manager.close()
    clearCurrentRunMessageQueue(threadId, runToken)
    releaseLocalThreadRunLease(threadId, "desktop", runToken)
    await closeCheckpointRuntimeProjectionWorker()
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
