import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
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
  INITIAL_NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY,
  NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY
} from "../../shared/graph-transcript-boundary"
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
import { createPhysicalScopedGateRecoveryMessage } from "../agent/runtime"
import { bootstrapLegacyCheckpointTranscript } from "../checkpointer/runtime-projection-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import * as db from "../db"
import {
  createPhysicalRunHiddenUserMessage,
  getCheckpointInitialNotificationUserMessageId,
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

it("routes physical hidden inputs through the durable boundary helper", () => {
  const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf8")
  expect(agentSource).toMatch(
    /: isWorkflowNotificationTurn\s+\? createPhysicalRunHiddenUserMessage\([^)]*"notification",\s*\{ turn: turnState, initial: true \}/
  )
  expect(agentSource).toMatch(
    /const coordinatorNotificationInput = coordinatorNotificationFields\s+\? isCoordinatorNotificationTurn\s+\? createPhysicalRunHiddenUserMessage\([^)]*"notification",\s*\{ turn: turnState, initial: true \}/
  )
  expect(agentSource).toContain("const goalInput = createPhysicalRunHiddenUserMessage(")
  expect(
    agentSource.match(/const revisionInput = createPhysicalRunHiddenUserMessage\([^)]*\{ turn: turnState \}/g)
  ).toHaveLength(3)
  const runtimeSource = readFileSync(join(__dirname, "../agent/runtime.ts"), "utf8")
  expect(runtimeSource).toMatch(
    /createRecoveryMessage: \(threadId, messages, prompt\) =>\s+createPhysicalScopedGateRecoveryMessage\(/
  )
  expect(agentSource).toMatch(/adoptGraphTranscriptBoundaryFromValues\(\s*threadId,/)
})

it("keeps the initial notification as the side context cutoff during a revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-notification-side-context-"))
  storage.path = join(directory, "threads.sqlite")
  const threadId = "notification-side-context"
  const runToken = "notification-run"
  const signal = new AbortController().signal
  const turn = { runToken, userMessageId: "scheduler-request" }
  await db.initializeDatabase()
  try {
    db.createThread(threadId)
    setCurrentRunMessageQueueOwner(threadId, runToken)
    db.upsertThreadMessages(threadId, [
      { id: "user", role: "user", content: "Previous request", created_at: new Date() },
      { id: "reply", role: "assistant", content: "Completed reply", created_at: new Date() }
    ])
    const initial = createPhysicalRunHiddenUserMessage(threadId, runToken, signal, null, {
      content: `${COORDINATOR_NOTIFICATION_PROMPT_PREFIX} Worker finished`
    }, "notification", { turn, initial: true })
    db.upsertThreadMessages(threadId, [
      { id: "draft", role: "assistant", content: "Rejected notification draft", created_at: new Date() }
    ])
    const revision = createPhysicalRunHiddenUserMessage(threadId, runToken, signal, null, {
      content: `${STOP_HOOK_REVISION_PROMPT_PREFIX} Revise`
    }, "notification", { turn })

    expect(turn.userMessageId).toBe(initial.id)
    expect(db.getThreadTranscriptBoundaryOrdinal(threadId, turn.userMessageId)).toBe(2)
    expect(db.getThreadTranscriptBoundaryOrdinal(threadId, revision.id!)).toBe(4)
    expect(revision.additional_kwargs[NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY]).toBe(true)
    const gate = createPhysicalScopedGateRecoveryMessage(threadId, runToken, [revision], "Finish the revision")
    expect(gate.additional_kwargs[INITIAL_NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY]).toBe(initial.id)

    const checkpointPath = join(directory, "checkpoint.sqlite")
    const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    const saver = new SqlJsSaver(checkpointPath)
    try {
      await saver.put(config, {
        v: 1,
        id: "held-notification",
        ts: new Date().toISOString(),
        channel_values: { messages: [initial, new AIMessage("Rejected notification draft"), revision] },
        channel_versions: { messages: 1 },
        versions_seen: {}
      }, { source: "loop", step: 1, parents: {} })
    } finally {
      await saver.close()
    }
    await db.closeDatabase()
    await db.initializeDatabase()
    const reopened = new SqlJsSaver(checkpointPath)
    try {
      const held = await reopened.getTuple(config)
      const userMessageId = getCheckpointInitialNotificationUserMessageId(threadId, held?.checkpoint)
      expect(userMessageId).toBe(initial.id)
      const resumedRunToken = "resumed-notification-run"
      setCurrentRunMessageQueueOwner(threadId, resumedRunToken)
      const resumedTurn = { runToken: resumedRunToken, userMessageId }
      const resumedRevision = createPhysicalRunHiddenUserMessage(threadId, resumedRunToken, signal, null, {
        content: `${STOP_HOOK_REVISION_PROMPT_PREFIX} Revise after approval`
      }, "notification", { turn: resumedTurn })
      expect(resumedTurn.userMessageId).toBe(initial.id)
      expect(getCheckpointInitialNotificationUserMessageId(threadId, {
        channel_values: { messages: [initial, revision, resumedRevision] }
      })).toBe(initial.id)
      expect(getCheckpointInitialNotificationUserMessageId("another-thread", held?.checkpoint)).toBeUndefined()
      expect(getCheckpointInitialNotificationUserMessageId(threadId, {
        channel_values: { messages: [revision] }
      })).toBeUndefined()
      expect(getCheckpointInitialNotificationUserMessageId(threadId, {
        channel_values: { messages: [initial, revision, new HumanMessage("Unrelated new request")] }
      })).toBeUndefined()
    } finally {
      await reopened.close()
    }

    const nextRunToken = "replacement-notification-run"
    setCurrentRunMessageQueueOwner(threadId, nextRunToken)
    const nextTurn = { runToken: nextRunToken, userMessageId: "replacement-scheduler-request" }
    const nextInitial = createPhysicalRunHiddenUserMessage(threadId, nextRunToken, signal, null, {
      content: `${COORDINATOR_NOTIFICATION_PROMPT_PREFIX} Another worker finished`
    }, "notification", { turn: nextTurn, initial: true })
    expect(nextTurn.userMessageId).toBe(nextInitial.id)
    expect(nextInitial.id).not.toBe(initial.id)
    expect(getCheckpointInitialNotificationUserMessageId(threadId, {
      channel_values: { messages: [initial, revision, nextInitial] }
    })).toBe(nextInitial.id)
  } finally {
    clearCurrentRunMessageQueue(threadId)
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
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
        undefined,
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
        undefined,
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
  const middleware = createCurrentRunMessageQueueMiddleware(runToken, undefined, undefined, prepare)
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
    expect(prepare).toHaveBeenCalledWith(threadId, goalTurn)
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
