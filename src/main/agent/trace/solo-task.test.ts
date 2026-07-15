import { tmpdir } from "os"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] }
}))

import type { TraceCollector, TraceCollectorOptions } from "./collector"
import {
  getSoloTaskOwnerIdFromStreamPayload,
  SOLO_TASK_OWNER_METADATA_KEY,
  SoloTaskTraceManager
} from "./solo-task"
import type { TraceContext, TraceOutcome } from "./types"

class FakeTracer {
  readonly modelCalls: Array<Record<string, unknown>> = []
  readonly llmNodes: Array<Record<string, unknown>> = []
  readonly endedLlmNodes: Array<Record<string, unknown>> = []
  readonly stepToolCalls: Array<Record<string, unknown>> = []
  readonly toolNodes: Array<Record<string, unknown>> = []
  readonly toolResults: Array<Record<string, unknown>> = []
  readonly terminals: Array<Record<string, unknown>> = []
  readonly usedSkills: string[][] = []
  readonly skillSources: string[][] = []
  readonly evolvedSkills: string[][] = []
  modelName: string | undefined
  stepCount = 0
  endedStepCount = 0

  setModelName(name: string): void {
    this.modelName = name
  }

  setUsedSkills(skills: string[]): void {
    this.usedSkills.push(skills)
  }

  setSkillSource(skillSource: string[]): void {
    this.skillSources.push(skillSource)
  }

  setEvolvedSkills(skills: string[]): void {
    this.evolvedSkills.push(skills)
  }

  beginLlmNode(params: Record<string, unknown>): string {
    this.llmNodes.push(params)
    return `llm:${this.llmNodes.length}`
  }

  endLlmNode(params: Record<string, unknown>): void {
    this.endedLlmNodes.push(params)
  }

  recordModelCall(call: Record<string, unknown>): void {
    this.modelCalls.push(call)
  }

  beginStep(): void {
    this.stepCount += 1
  }

  recordToolCall(call: Record<string, unknown>): void {
    this.stepToolCalls.push(call)
  }

  endStep(): void {
    this.endedStepCount += 1
  }

  addToolNode(params: Record<string, unknown>): string {
    this.toolNodes.push(params)
    return `tool:${this.toolNodes.length}`
  }

  addToolResultNode(params: Record<string, unknown>): string {
    this.toolResults.push(params)
    return `tool-result:${this.toolResults.length}`
  }

  addTerminalNode(params: Record<string, unknown>): string {
    this.terminals.push(params)
    return `terminal:${this.terminals.length}`
  }
}

const parent: TraceContext = {
  traceId: "root-trace",
  threadId: "root-thread",
  rootNodeId: "trace:root-trace",
  observabilitySchemaVersion: 1,
  traceKind: "root",
  executionMode: "normal",
  rootTraceId: "root-trace",
  rootThreadId: "root-thread",
  harnessFeature: {
    projectId: "project-1",
    slug: "feature-1",
    nodeName: "Dev",
    nodeStatus: "进行中"
  }
}

function middlewareRequest(ownerId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    runtime: { configurable: { [SOLO_TASK_OWNER_METADATA_KEY]: ownerId } },
    messages: [{ type: "human", content: `prompt for ${ownerId}` }],
    state: {},
    ...extra
  }
}

function createHarness(
  options: { failCreate?: boolean; throwingTracer?: boolean; failModelRecord?: boolean } = {}
): {
  manager: SoloTaskTraceManager
  tracers: Map<string, FakeTracer>
  creations: Array<{
    threadId: string
    message: string
    modelId: string
    options: TraceCollectorOptions
  }>
  finishes: Array<{ tracer: TraceCollector; outcome: TraceOutcome; error?: string }>
} {
  const tracers = new Map<string, FakeTracer>()
  const creations: Array<{
    threadId: string
    message: string
    modelId: string
    options: TraceCollectorOptions
  }> = []
  const finishes: Array<{ tracer: TraceCollector; outcome: TraceOutcome; error?: string }> = []
  const throwingTracer =
    options.throwingTracer || options.failModelRecord
      ? new Proxy(new FakeTracer(), {
          get(target, property, receiver) {
            if (
              (options.throwingTracer &&
                (property === "beginLlmNode" || property === "addToolNode")) ||
              (options.failModelRecord && property === "recordModelCall")
            ) {
              return () => {
                throw new Error("telemetry exploded")
              }
            }
            return Reflect.get(target, property, receiver)
          }
        })
      : undefined

  const manager = new SoloTaskTraceManager({
    parent,
    modelId: "model-a",
    dependencies: {
      createTracer: (threadId, message, modelId, traceOptions) => {
        creations.push({ threadId, message, modelId, options: traceOptions })
        if (options.failCreate) return undefined
        const tracer = throwingTracer ?? new FakeTracer()
        tracers.set(traceOptions.subagentRunId ?? threadId, tracer)
        return tracer as unknown as TraceCollector
      },
      finishTracer: (tracer, outcome, error) => {
        finishes.push({ tracer, outcome, error })
      },
      runSideEffect: (_scope, effect) => {
        try {
          effect()
        } catch {
          // Mirrors runTraceSideEffect: telemetry must never escape into the run.
        }
      }
    }
  })

  return { manager, tracers, creations, finishes }
}

describe("SoloTaskTraceManager", () => {
  it("creates a linked task trace and captures model, token, tool, and terminal data", async () => {
    const { manager, tracers, creations, finishes } = createHarness()
    manager.startTask({
      ownerId: "task/call:1",
      description: "inspect the repository",
      subagentType: "Explore"
    })

    expect(creations).toHaveLength(1)
    expect(creations[0]).toMatchObject({
      threadId: "root-thread__task_task_call_1",
      message: "inspect the repository",
      modelId: "model-a",
      options: {
        traceKind: "subagent",
        executionMode: "normal",
        rootTraceId: "root-trace",
        rootThreadId: "root-thread",
        parentTraceId: "root-trace",
        parentThreadId: "root-thread",
        parentSpanId: "task:task/call:1",
        linkType: "parent_child",
        subagentKind: "task",
        subagentRunId: "task/call:1",
        handoffAction: "task",
        handoffSourceAgent: "main",
        handoffTargetAgent: "Explore",
        harnessFeature: parent.harnessFeature,
        includeSkillEval: false
      }
    })
    expect(manager.hasCapturedTask("task/call:1")).toBe(false)

    const beforeModel = manager.middleware.beforeModel
    if (typeof beforeModel !== "function") throw new Error("beforeModel hook missing")
    await beforeModel(
      {
        skillsMetadata: [{ name: "repo-review", path: "README.md", version: "1.2.3" }]
      } as never,
      { configurable: { [SOLO_TASK_OWNER_METADATA_KEY]: "task/call:1" } } as never
    )

    const response = {
      id: "child-ai-1",
      content: "I inspected it",
      additional_kwargs: { reasoning_content: "I should inspect the repository first." },
      tool_calls: [{ id: "child-tool-1", name: "read_file", args: { path: "README.md" } }],
      usage_metadata: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      response_metadata: { model_name: "provider-model" }
    }
    const modelResult = await manager.middleware.wrapModelCall!(
      middlewareRequest("task/call:1") as never,
      (async () => response) as never
    )
    expect(modelResult).toBe(response)
    expect(manager.hasCapturedTask("task/call:1")).toBe(true)

    const tracer = tracers.get("task/call:1")!
    expect(tracer.modelName).toBe("provider-model")
    expect(tracer.modelCalls).toHaveLength(1)
    expect(tracer.modelCalls[0]).toMatchObject({
      messageId: "child-ai-1",
      outputMessage: {
        content: "I inspected it",
        reasoning: "I should inspect the repository first."
      },
      tokenUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
    })
    expect(tracer.endedLlmNodes[0]).toMatchObject({
      metadata: { reasoning: "I should inspect the repository first." }
    })
    expect(tracer.stepToolCalls).toEqual([{ name: "read_file", args: { path: "README.md" } }])

    const toolResult = { type: "tool", content: "file contents", status: "success" }
    const returnedToolResult = await manager.middleware.wrapToolCall!(
      middlewareRequest("task/call:1", {
        toolCall: { id: "child-tool-1", name: "read_file", args: { path: "README.md" } }
      }) as never,
      (async () => toolResult) as never
    )
    expect(returnedToolResult).toBe(toolResult)
    expect(tracer.toolNodes).toHaveLength(1)
    expect(tracer.toolResults[0]).toMatchObject({
      toolCallId: "child-tool-1",
      output: "file contents",
      status: "success"
    })
    expect(tracer.usedSkills.at(-1)).toEqual(["repo-review-v1.2.3"])

    manager.finishTask("task/call:1", "success", "done")
    manager.finishTask("task/call:1", "success", "duplicate")
    expect(tracer.terminals).toHaveLength(1)
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ outcome: "success", error: undefined })
  })

  it("keeps concurrent task owners isolated", async () => {
    const { manager, tracers, finishes } = createHarness()
    manager.startTask({ ownerId: "owner-a", description: "A" })
    manager.startTask({ ownerId: "owner-b", description: "B" })

    await Promise.all([
      manager.middleware.wrapModelCall!(
        middlewareRequest("owner-a") as never,
        (async () => ({
          id: "ai-a",
          content: "A result",
          usage_metadata: { input_tokens: 10, output_tokens: 1 }
        })) as never
      ),
      manager.middleware.wrapModelCall!(
        middlewareRequest("owner-b") as never,
        (async () => ({
          id: "ai-b",
          content: "B result",
          usage_metadata: { input_tokens: 20, output_tokens: 2 }
        })) as never
      )
    ])

    expect(tracers.get("owner-a")?.modelCalls[0]).toMatchObject({
      messageId: "ai-a",
      tokenUsage: { inputTokens: 10, outputTokens: 1 }
    })
    expect(tracers.get("owner-b")?.modelCalls[0]).toMatchObject({
      messageId: "ai-b",
      tokenUsage: { inputTokens: 20, outputTokens: 2 }
    })

    manager.finishActiveTasks("cancelled", "parent cancelled")
    expect(finishes.map((finish) => finish.outcome)).toEqual(["cancelled", "cancelled"])
  })

  it("does not alter handler results or errors when trace mutations fail", async () => {
    const { manager } = createHarness({ throwingTracer: true })
    manager.startTask({ ownerId: "owner-failure" })

    const response = { id: "ai-safe", content: "still returned" }
    await expect(
      manager.middleware.wrapModelCall!(
        middlewareRequest("owner-failure") as never,
        (async () => response) as never
      )
    ).resolves.toBe(response)

    const originalError = new Error("provider failed")
    await expect(
      manager.middleware.wrapModelCall!(
        middlewareRequest("owner-failure") as never,
        (async () => {
          throw originalError
        }) as never
      )
    ).rejects.toBe(originalError)
  })

  it("keeps root accounting active when child trace construction fails", async () => {
    const { manager } = createHarness({ failCreate: true })
    manager.startTask({ ownerId: "no-trace" })
    const response = { id: "ai-root-fallback", content: "fallback" }

    await expect(
      manager.middleware.wrapModelCall!(
        middlewareRequest("no-trace") as never,
        (async () => response) as never
      )
    ).resolves.toBe(response)
    expect(manager.hasCapturedTask("no-trace")).toBe(false)
  })

  it("keeps root accounting active when the child model record is incomplete", async () => {
    const { manager } = createHarness({ failModelRecord: true })
    manager.startTask({ ownerId: "partial-trace" })
    const response = { id: "ai-partial", content: "returned despite telemetry failure" }

    await expect(
      manager.middleware.wrapModelCall!(
        middlewareRequest("partial-trace") as never,
        (async () => response) as never
      )
    ).resolves.toBe(response)
    expect(manager.hasCapturedTask("partial-trace")).toBe(false)
  })
})

describe("getSoloTaskOwnerIdFromStreamPayload", () => {
  it("reads only a non-empty owner id from messages stream metadata", () => {
    expect(
      getSoloTaskOwnerIdFromStreamPayload([
        { content: "chunk" },
        { [SOLO_TASK_OWNER_METADATA_KEY]: " owner-1 " }
      ])
    ).toBe("owner-1")
    expect(getSoloTaskOwnerIdFromStreamPayload([{ content: "chunk" }, {}])).toBeUndefined()
    expect(getSoloTaskOwnerIdFromStreamPayload({})).toBeUndefined()
  })
})
