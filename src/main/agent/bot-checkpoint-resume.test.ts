import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware, tool } from "langchain"
import { z } from "zod"
import { describe, expect, it } from "vitest"
import {
  assertBotModelCheckpoint,
  assertBotTaskContinuationCheckpoint,
  botGroupResumeCheckpoint,
  botTaskContinuationCheckpoint,
  botWorkflowNotificationClaim
} from "./bot-checkpoint-resume"
import { createCurrentRunMessageQueueMiddleware } from "./current-run-message-queue"

describe("Bot-owned model checkpoint continuation", () => {
  const context = {
    source: "bot" as const,
    localRunLease: { owner: "bot" as const, runId: "task", managedExternally: true },
    resumeCheckpointId: "checkpoint"
  }
  const metadata = { botHostId: "local", botId: "a", botGroupId: "group" }

  it("accepts an exact workflow instance only from the trusted managed Bot receipt", () => {
    const claim = { runId: "wf_original", startedAt: "2026-10-18T13:00:00.000Z" }
    const receipt = {
      ...context,
      workflowInternalNotification: true,
      botWorkflowNotification: claim
    }
    expect(botWorkflowNotificationClaim(receipt, metadata)).toEqual(claim)
    expect(
      botWorkflowNotificationClaim(
        { ...receipt, botWorkflowNotification: { ...claim, owner: "managed" } } as typeof receipt,
        metadata
      )
    ).toEqual(claim)
    expect(botWorkflowNotificationClaim({ source: "desktop" }, {})).toBeUndefined()
    for (const rejected of [
      { ...receipt, source: "desktop" as const },
      { ...receipt, localRunLease: undefined },
      { ...receipt, workflowInternalNotification: false },
      { ...receipt, botWorkflowNotification: { ...claim, runId: " " } },
      { ...receipt, botWorkflowNotification: { ...claim, startedAt: " " } },
      { ...receipt, botWorkflowNotification: { ...claim, startedAt: "x".repeat(101) } }
    ])
      expect(() => botWorkflowNotificationClaim(rejected, metadata)).toThrow("无权")
    expect(() =>
      botWorkflowNotificationClaim(receipt, { ...metadata, botHostId: "remote" })
    ).toThrow("无权")
  })

  it("requires a trusted local group lease and leaves ordinary invocations unchanged", () => {
    expect(botGroupResumeCheckpoint(context, metadata)).toBe("checkpoint")
    expect(botGroupResumeCheckpoint({ source: "desktop" }, {})).toBeUndefined()
    expect(() => botGroupResumeCheckpoint({ ...context, source: "desktop" }, metadata)).toThrow()
    expect(() =>
      botGroupResumeCheckpoint({ ...context, localRunLease: undefined }, metadata)
    ).toThrow()
    expect(() => botGroupResumeCheckpoint(context, { ...metadata, botHostId: "remote" })).toThrow()
    expect(() => botGroupResumeCheckpoint(context, { ...metadata, botGroupId: null })).toThrow()
    expect(() => botGroupResumeCheckpoint(context, { ...metadata, botGroupId: " " })).toThrow()
    expect(() => botGroupResumeCheckpoint(context, { ...metadata, botId: "" })).toThrow()
    expect(() =>
      botGroupResumeCheckpoint(
        { ...context, localRunLease: { ...context.localRunLease, managedExternally: false } },
        metadata
      )
    ).toThrow()
  })

  it("refuses stale, tool, ambiguous and human-gated checkpoints", () => {
    const state = {
      config: { configurable: { checkpoint_id: "checkpoint" } },
      next: ["model_request"]
    }
    expect(() => assertBotModelCheckpoint("checkpoint", state)).not.toThrow()
    for (const changed of [
      { ...state, config: { configurable: { checkpoint_id: "newer" } } },
      { ...state, next: ["tools"] },
      { ...state, next: [] },
      { ...state, next: ["model_request", "tools"] },
      { ...state, tasks: [{ interrupts: [{ value: "approval" }] }] }
    ])
      expect(() => assertBotModelCheckpoint("checkpoint", changed)).toThrow("检查点")
  })

  it("accepts a private continuation only from the managed local Bot owner", () => {
    const privateContext = {
      ...context,
      resumeCheckpointId: undefined,
      continueBotTaskCheckpointId: "saved"
    }
    const privateMetadata = { botHostId: "local", botId: "a" }
    expect(botTaskContinuationCheckpoint(privateContext, privateMetadata)).toBe("saved")
    expect(botTaskContinuationCheckpoint({ source: "desktop" }, {})).toBeUndefined()
    for (const denied of [
      { ...privateContext, source: "desktop" as const },
      { ...privateContext, localRunLease: undefined },
      { ...privateContext, localRunLease: { ...context.localRunLease, managedExternally: false } },
      { ...privateContext, resumeCheckpointId: "group-checkpoint" },
      { ...privateContext, continueBotTaskCheckpointId: " " },
      { ...privateContext, continueBotTaskCheckpointId: "x".repeat(201) }
    ])
      expect(() => botTaskContinuationCheckpoint(denied, privateMetadata)).toThrow("无权")
    expect(() =>
      botTaskContinuationCheckpoint(privateContext, { ...privateMetadata, botHostId: "remote" })
    ).toThrow("无权")
    expect(() =>
      botTaskContinuationCheckpoint(privateContext, { ...privateMetadata, botGroupId: "g" })
    ).toThrow("无权")
    const groupContext = { ...privateContext, verifyResolvedThread: () => null }
    expect(
      botTaskContinuationCheckpoint(groupContext, { ...privateMetadata, botGroupId: "g" })
    ).toBe("saved")
    for (const botGroupId of ["", " ", 1, {}, []])
      expect(() =>
        botTaskContinuationCheckpoint(groupContext, { ...privateMetadata, botGroupId })
      ).toThrow("无权")
    expect(() =>
      botTaskContinuationCheckpoint(
        { ...groupContext, source: "desktop" },
        { ...privateMetadata, botGroupId: "g" }
      )
    ).toThrow("无权")
  })

  it("allows newer completed private history but refuses another pending model, tool or approval", () => {
    const state = {
      config: { configurable: { checkpoint_id: "newer-private" } },
      next: [] as string[]
    }
    expect(() => assertBotTaskContinuationCheckpoint("saved", state)).not.toThrow()
    expect(() =>
      assertBotTaskContinuationCheckpoint("saved", {
        config: { configurable: { checkpoint_id: "saved" } },
        next: ["model_request"]
      })
    ).not.toThrow()
    for (const denied of [
      { ...state, next: ["model_request"] },
      { ...state, next: ["tools"] },
      { ...state, next: ["model_request", "tools"] },
      { ...state, tasks: [{ interrupts: [{ value: "approval" }] }] },
      { ...state, config: { configurable: { checkpoint_id: "" } } }
    ])
      expect(() => assertBotTaskContinuationCheckpoint("saved", denied)).toThrow("检查点")
    expect(() => assertBotTaskContinuationCheckpoint("", state)).toThrow("检查点")
  })

  it("resumes the original graph after an interrupted model step without replaying a tool or user message", async () => {
    let writes = 0
    const controller = new AbortController()
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: "group-model-resume" } }
    const build = (pause: boolean) =>
      createAgent({
        model: new FakeListChatModel({ responses: ["unused"] }),
        checkpointer,
        tools: [
          tool(() => String(++writes), {
            name: "write_once",
            description: "Counter",
            schema: z.object({})
          })
        ],
        middleware: [
          createCurrentRunMessageQueueMiddleware("group-task", (active) => {
            if (active && pause && writes) controller.abort()
          }),
          createMiddleware({
            name: "modelFixture",
            wrapModelCall: (request) => {
              request.runtime.signal?.throwIfAborted()
              return request.messages.some((message) => ToolMessage.isInstance(message))
                ? new AIMessage("Original result: 1")
                : new AIMessage({
                    content: "",
                    tool_calls: [{ id: "write", name: "write_once", args: {} }]
                  })
            }
          })
        ]
      })
    const first = build(true)
    await expect(
      first.invoke(
        { messages: [new HumanMessage({ id: "original-user", content: "Write once" })] },
        { ...config, signal: controller.signal }
      )
    ).rejects.toThrow()
    expect(writes).toBe(1)
    const resume = build(false)
    const snapshot = (await resume.getState(config)) as unknown as Parameters<
      typeof assertBotModelCheckpoint
    >[1]
    const checkpointId = snapshot.config?.configurable?.checkpoint_id
    expect(typeof checkpointId).toBe("string")
    if (typeof checkpointId !== "string") throw new Error("No saved checkpoint")
    assertBotModelCheckpoint(checkpointId, snapshot)
    const result = await resume.invoke(null, config)
    expect(writes).toBe(1)
    expect(result.messages.filter((message) => HumanMessage.isInstance(message))).toHaveLength(1)
    expect(result.messages.at(-1)?.content).toBe("Original result: 1")
  })

  it("rejects an old model checkpoint after another invocation advances the same conversation", async () => {
    const controller = new AbortController()
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: "shared-private-thread" } }
    const build = (pause: boolean) =>
      createAgent({
        model: new FakeListChatModel({ responses: ["unused"] }),
        checkpointer,
        middleware: [
          createCurrentRunMessageQueueMiddleware("shared-run", (active) => {
            if (active && pause) controller.abort()
          }),
          createMiddleware({
            name: "privateHistoryFixture",
            wrapModelCall: (request) => {
              request.runtime.signal?.throwIfAborted()
              return new AIMessage(
                request.messages.at(-1)?.content === "Private correction" ? "Private kept" : "Group"
              )
            }
          })
        ]
      })
    const background = build(true)
    await expect(
      background.invoke(
        { messages: [new HumanMessage({ id: "original", content: "Background task" })] },
        { ...config, signal: controller.signal }
      )
    ).rejects.toThrow()
    const snapshot = (await background.getState(config)) as unknown as Parameters<
      typeof assertBotModelCheckpoint
    >[1]
    const checkpointId = snapshot.config?.configurable?.checkpoint_id
    if (typeof checkpointId !== "string") throw new Error("No model checkpoint")
    assertBotModelCheckpoint(checkpointId, snapshot)
    const foreground = build(false)
    const result = await foreground.invoke(
      { messages: [new HumanMessage({ id: "private", content: "Private correction" })] },
      config
    )
    expect(result.messages.at(-1)?.content).toBe("Private kept")
    expect(result.messages.some((message) => message.id === "private")).toBe(true)
    // A newer invocation legitimately advanced this physical thread. Restoring
    // the old branch must not discard its newer private conversation history.
    const resultState = (await foreground.getState(config)) as unknown as Parameters<
      typeof assertBotModelCheckpoint
    >[1]
    expect(() => assertBotModelCheckpoint(checkpointId, resultState)).toThrow("检查点")
    expect(() => assertBotTaskContinuationCheckpoint(checkpointId, resultState)).not.toThrow()
    expect(resultState.next).toEqual([])
  })
  it("continues private background work on newer history without replaying its completed tool", async () => {
    let writes = 0
    const controller = new AbortController()
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: "private-background-continuation" } }
    const build = (pause: boolean) =>
      createAgent({
        model: new FakeListChatModel({ responses: ["unused"] }),
        checkpointer,
        tools: [
          tool(() => String(++writes), {
            name: "write_once",
            description: "Counter",
            schema: z.object({})
          })
        ],
        middleware: [
          createCurrentRunMessageQueueMiddleware("background", (active) => {
            if (active && pause && writes) controller.abort()
          }),
          createMiddleware({
            name: "privateContinuationFixture",
            wrapModelCall: (request) => {
              request.runtime.signal?.throwIfAborted()
              const human = request.messages.filter((message) => HumanMessage.isInstance(message))
              const latest = human.at(-1)
              if (latest?.content === "Private correction: cedar")
                return new AIMessage("Private kept")
              if (latest?.content === "Recall private")
                return new AIMessage(
                  human.find((message) => message.id === "private")?.content ?? "Lost"
                )
              if (latest?.additional_kwargs.cmb_internal_coordinator_notification === true)
                return new AIMessage(`Original result: ${writes}`)
              return new AIMessage({
                content: "",
                tool_calls: [{ id: "write", name: "write_once", args: {} }]
              })
            }
          })
        ]
      })
    const initial = build(true)
    await expect(
      initial.invoke(
        { messages: [new HumanMessage({ id: "original", content: "Write once" })] },
        { ...config, signal: controller.signal }
      )
    ).rejects.toThrow()
    expect(writes).toBe(1)
    const saved = (await initial.getState(config)) as unknown as Parameters<
      typeof assertBotModelCheckpoint
    >[1]
    const checkpoint = saved.config?.configurable?.checkpoint_id
    if (typeof checkpoint !== "string") throw new Error("Missing original checkpoint")
    const active = build(false)
    await active.invoke(
      { messages: [new HumanMessage({ id: "private", content: "Private correction: cedar" })] },
      config
    )
    assertBotTaskContinuationCheckpoint(checkpoint, await active.getState(config))
    const resumed = await active.invoke(
      {
        messages: [
          new HumanMessage({
            id: "internal",
            content: "Continue original background task",
            additional_kwargs: { cmb_internal_coordinator_notification: true }
          })
        ]
      },
      config
    )
    expect(resumed.messages.at(-1)?.content).toBe("Original result: 1")
    expect(resumed.messages.filter((message) => message.id === "original")).toHaveLength(1)
    expect(resumed.messages.find((message) => message.id === "private")?.content).toBe(
      "Private correction: cedar"
    )
    expect(writes).toBe(1)
    const recalled = await active.invoke(
      { messages: [new HumanMessage({ id: "recall", content: "Recall private" })] },
      config
    )
    expect(recalled.messages.at(-1)?.content).toBe("Private correction: cedar")
    expect(writes).toBe(1)
  })
})
