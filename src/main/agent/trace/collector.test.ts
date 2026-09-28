import { sanitizeTraceForCloudUpload } from "./sanitizer"
import { getTraceStageUsage } from "./stage-usage-registry"
import { createStageUsageMiddleware } from "./stage-usage-middleware"
import { TurnTraceRecorder } from "./turn-trace-recorder"
import { primeHarnessStageAttribution } from "../../services/harness-stage-attribution"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  safeStorage: {}
}))

vi.mock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../../storage", () => ({ getUserInfo: () => null }))
vi.mock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: async () => null
}))
vi.mock("../../services/adoption-tracker", () => ({
  clearAdoptionContext: () => undefined,
  setAdoptionContext: () => undefined
}))
vi.mock("../skill-eval/documents", () => ({
  buildSkillEvalTraceExtension: () => undefined
}))
vi.mock("../skill-eval/window", () => ({
  appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
  getSkillEvalWindowAssistantText: () => "",
  getSkillEvalWindowContextByRawName: () => ({})
}))

import {
  flushPendingTraceReports,
  flushTraceWriteQueue,
  hasPendingTraceReports,
  setTraceReporter,
  TraceCollector
} from "./collector"

let tracesDir = ""
let previousStorageMode: string | undefined
let previousTracesDir: string | undefined

beforeEach(async () => {
  await flushPendingTraceReports(1_000)
  await flushTraceWriteQueue()
  tracesDir = mkdtempSync(join(tmpdir(), "trace-collector-test-"))
  previousStorageMode = process.env.CMB_COWORK_TRACE_STORAGE_MODE
  previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  process.env.CMB_COWORK_TRACES_DIR = tracesDir
})

afterEach(async () => {
  await flushPendingTraceReports(1_000)
  await flushTraceWriteQueue()
  setTraceReporter({
    async report() {
      return undefined
    }
  })
  if (previousStorageMode === undefined) delete process.env.CMB_COWORK_TRACE_STORAGE_MODE
  else process.env.CMB_COWORK_TRACE_STORAGE_MODE = previousStorageMode
  if (previousTracesDir === undefined) delete process.env.CMB_COWORK_TRACES_DIR
  else process.env.CMB_COWORK_TRACES_DIR = previousTracesDir
  rmSync(tracesDir, { recursive: true, force: true })
})

describe("TraceCollector completion", () => {
  it.each(["raw", "serialized"])(
    "captures call-start stages through the real graph (%s), including generated message IDs",
    async (transport) => {
      const tracer = new TraceCollector("stage-graph", "go", "test", {
        includeSkillEval: false,
        harnessFeature: { projectId: "graph-p", slug: "f", nodeName: "plan" }
      })
      class ScriptedModel extends BaseChatModel {
        calls = 0
        _llmType(): string {
          return "stage-test"
        }
        bindTools(): this {
          return this
        }
        async _generate() {
          const first = this.calls++ === 0
          if (first) primeHarnessStageAttribution("graph-p", "f", { name: "dev", status: "进行中" })
          const message = new AIMessage({
            content: first ? "" : "done",
            // Deliberately omit provider id: the real model/graph assigns it.
            usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            tool_calls: first ? [{ id: "t", name: "read_file", args: {} }] : []
          })
          return { generations: [{ text: "", message }] }
        }
      }
      primeHarnessStageAttribution("graph-p", "f", { name: "plan", status: "进行中" })
      const agent = createAgent({
        model: new ScriptedModel({}),
        tools: [
          tool(
            async () => {
              primeHarnessStageAttribution("graph-p", "f", { name: "review", status: "进行中" })
              return "ok"
            },
            { name: "read_file", description: "Read", schema: z.object({}) }
          )
        ],
        middleware: [createStageUsageMiddleware(tracer.getTraceContext())]
      })
      const recorder = new TurnTraceRecorder({ tracer, userMessageId: "user" })
      for await (const [mode, value] of await agent.stream(
        { messages: [new HumanMessage({ id: "user", content: "go" })] },
        { streamMode: ["values"] }
      )) {
        if (mode === "values") {
          if (transport === "raw") recorder.onRawValues(value)
          else recorder.onStreamChunk("values", JSON.parse(JSON.stringify(value)))
        }
      }
      const trace = await tracer.finish("success")
      expect(trace.stageUsageComplete).toBe(true)
      expect(trace.totalModelCalls).toBe(2)
      expect(trace.stageUsage?.find((row) => row.nodeName === "plan")?.totalTokens).toBe(12)
      expect(trace.stageUsage?.find((row) => row.nodeName === "dev")?.toolCalls).toBe(1)
      expect(trace.stageUsage?.find((row) => row.nodeName === "review")?.totalTokens).toBe(12)
      expect(trace.stageUsage?.find((row) => !row.nodeName)).toBeUndefined()
    }
  )
  it("retains call-stage totals through content truncation, cloud sanitization and child traces", async () => {
    for (const traceKind of ["root", "subagent"] as const) {
      const tracer = new TraceCollector(`stage-${traceKind}`, "test", "test", {
        traceKind,
        includeSkillEval: false,
        harnessFeature: { projectId: "p", slug: "f", nodeName: "plan" }
      })
      const stageCounter = getTraceStageUsage(tracer.getTraceContext().traceId)!
      for (let i = 0; i < 1200; i++) {
        const nodeName = i < 600 ? "plan" : "dev"
        stageCounter.bindModel(`m${i}`, { nodeName })
        tracer.recordModelCall({
          messageId: `m${i}`,
          startedAt: new Date().toISOString(),
          inputMessages: [],
          outputMessage: { role: "assistant", content: "x".repeat(4000) },
          toolCalls: [],
          tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
        })
        tracer.addToolNode({ name: "read_file", toolCallId: `t${i}` })
        stageCounter.bindTool(`call:t${i}`, { nodeName })
      }
      const trace = await tracer.finish("success")
      expect(trace.harnessNodeName).toBe("plan")
      expect(trace.stageUsageComplete).toBe(true)
      expect(trace.stageUsage).toEqual(
        ["plan", "dev"].map((nodeName) => ({
          nodeName,
          toolCalls: 600,
          modelCalls: 600,
          inputTokens: 6000,
          outputTokens: 1200,
          totalTokens: 7200,
          userInputRequests: 0,
          tokenUsageReportedCalls: 600
        }))
      )
      expect(sanitizeTraceForCloudUpload(trace).stageUsage).toEqual(trace.stageUsage)
      expect(getTraceStageUsage(tracer.getTraceContext().traceId)).toBeUndefined()
    }
  })
  it("persists and reports only the first terminal outcome", async () => {
    const reportedOutcomes: string[] = []
    setTraceReporter({
      async report(trace) {
        reportedOutcomes.push(trace.outcome)
      }
    })
    const tracer = new TraceCollector("thread-cancelled", "stop this run", "model-test")

    const firstFinish = tracer.finish("cancelled", "User stopped the run")
    const duplicateFinish = tracer.finish("error", "late provider error")

    expect(duplicateFinish).toBe(firstFinish)
    const [firstTrace, duplicateTrace] = await Promise.all([firstFinish, duplicateFinish])
    await Promise.all([flushPendingTraceReports(1_000), flushTraceWriteQueue()])

    expect(firstTrace).toBe(duplicateTrace)
    expect(firstTrace.outcome).toBe("cancelled")
    expect(firstTrace.errorMessage).toBe("User stopped the run")
    expect(reportedOutcomes).toEqual(["cancelled"])

    const traceFile = join(tracesDir, firstTrace.threadId, `${firstTrace.traceId}.jsonl`)
    const persistedLines = readFileSync(traceFile, "utf8").trim().split(/\r?\n/)
    expect(persistedLines).toHaveLength(1)
    expect(JSON.parse(persistedLines[0])).toMatchObject({
      traceId: firstTrace.traceId,
      outcome: "cancelled",
      errorMessage: "User stopped the run"
    })
  })

  it("lets graceful shutdown wait for a scheduled report", async () => {
    let releaseReport: (() => void) | undefined
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve
    })
    setTraceReporter({
      async report() {
        await reportGate
      }
    })
    const tracer = new TraceCollector("thread-shutdown", "finish before quit", "model-test")

    await tracer.finish("cancelled")
    expect(hasPendingTraceReports()).toBe(true)

    const flush = flushPendingTraceReports(1_000)
    releaseReport?.()

    await expect(flush).resolves.toBe(true)
    expect(hasPendingTraceReports()).toBe(false)
  })
})

describe("TraceCollector tool usage", () => {
  it("keeps exact named counts after node eviction and cloud truncation", async () => {
    const tracer = new TraceCollector("tool-overflow", "count", "model", {
      includeSkillEval: false
    })
    for (let i = 0; i < 1100; i++) {
      const name = i % 10 === 0 ? "request_user_input" : "read_file"
      const params = { name, toolCallId: `call-${i}`, input: { text: "x".repeat(4000) } }
      tracer.addToolNode(params)
      tracer.addToolNode(params)
    }
    const trace = await tracer.finish("cancelled")
    expect(trace.totalToolCalls).toBe(1100)
    expect(trace.userInputRequestCount).toBe(110)
    expect(trace.toolUsageComplete).toBe(true)
    expect(trace.nodes!.length).toBeLessThan(1100)
    const uploaded = sanitizeTraceForCloudUpload(trace)
    expect(uploaded.toolUsage).toEqual(trace.toolUsage)
    expect(uploaded.userInputRequestCount).toBe(110)
    expect(uploaded.toolUsage!.reduce((sum, tool) => sum + tool.count, 0)).toBe(1100)
  })

  it("marks legacy total-only observations as incomplete", async () => {
    const tracer = new TraceCollector("tool-total-only", "count", "model", {
      includeSkillEval: false
    })
    tracer.addTerminalNode({ type: "error", metadata: { toolCallCount: 3 } })
    const trace = await tracer.finish("error")
    expect(trace.totalToolCalls).toBe(3)
    expect(trace.toolUsageComplete).toBe(false)
    expect(trace).not.toHaveProperty("userInputRequestCount")
  })
})
