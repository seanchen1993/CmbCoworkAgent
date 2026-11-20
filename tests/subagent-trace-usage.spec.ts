/** Real Workflow runner + collector, with a deterministic model stream. No API calls. */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { createStageUsageMiddleware } from "../src/main/agent/trace/stage-usage-middleware"
import { primeHarnessStageAttribution } from "../src/main/services/harness-stage-attribution"
import type { TraceContext } from "../src/main/agent/trace/types"
import type { AgentTrace } from "../src/main/agent/trace/types"
import type { WorkflowSubagentDeps } from "../src/main/agent/workflow/subagent"

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "child-trace-usage-"))
  const previous = {
    home: process.env.CMB_COWORK_AGENT_HOME,
    traces: process.env.CMB_COWORK_TRACES_DIR,
    mode: process.env.CMB_COWORK_TRACE_STORAGE_MODE
  }
  process.env.CMB_COWORK_AGENT_HOME = root
  process.env.CMB_COWORK_TRACES_DIR = join(root, "traces")
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  const { TraceCollector, getTraceReporter, setTraceReporter, flushTraceWriteQueue } =
    await import("../src/main/agent/trace/collector")
  const { runWorkflowSubagent } = await import("../src/main/agent/workflow/subagent")
  const previousReporter = getTraceReporter()
  try {
    for (const fails of [false, true]) {
      const parent = new TraceCollector("parent", "delegate", "test", {
        includeSkillEval: false,
        harnessFeature: { projectId: "p", slug: "f", nodeName: "plan" }
      })
      let resolveTrace!: (trace: AgentTrace) => void
      const reported = new Promise<AgentTrace>((resolve) => {
        resolveTrace = resolve
      })
      setTraceReporter({
        async report(trace) {
          resolveTrace(trace)
        }
      })
      const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      const deps = {
        parentThreadId: "parent",
        traceContext: parent.getTraceContext(),
        defaultModelId: "test",
        cleanupThread: async () => {},
        isRetryableApiError: () => false,
        createRuntime: async (options: { traceContext: TraceContext }) => ({
          stream: async (input: { messages: unknown[] }) =>
            (async function* () {
              const middleware = createStageUsageMiddleware(options.traceContext)
              primeHarnessStageAttribution("p", "f", { name: "plan", status: "进行中" })
              const messages = [
                ...input.messages,
                await middleware.wrapModelCall!({} as never, async () => {
                  primeHarnessStageAttribution("p", "f", { name: "dev", status: "进行中" })
                  return new AIMessage({
                    id: "a1",
                    content: "",
                    usage_metadata: usage,
                    tool_calls: [{ id: "tool-1", name: "read_file", args: { path: "x.ts" } }]
                  })
                })
              ]
              yield ["values", { messages: [...messages] }]
              yield ["values", { messages: [...messages] }]
              await middleware.wrapToolCall!(
                { toolCall: { id: "tool-1", name: "read_file" } } as never,
                async () => ({ content: "ok" }) as never
              )
              if (fails) throw new Error("test model failed")
              messages.push(new ToolMessage({ id: "t1", content: "ok", tool_call_id: "tool-1" }))
              messages.push(
                await middleware.wrapModelCall!(
                  {} as never,
                  async () => new AIMessage({ id: "a2", content: "done", usage_metadata: usage })
                )
              )
              yield ["values", { messages }]
            })()
        })
      } as unknown as WorkflowSubagentDeps
      const execution = runWorkflowSubagent(deps, {
        runId: `trace-test-${fails}`,
        agentIndex: 0,
        label: "test",
        prompt: "read x.ts",
        signal: new AbortController().signal
      })
      if (fails) await assert.rejects(execution, /test model failed/)
      else assert.equal((await execution).text, "done")
      let timer: ReturnType<typeof setTimeout> | undefined
      const trace = await Promise.race([
        reported,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("trace not reported")), 5000)
        })
      ]).finally(() => clearTimeout(timer))
      assert.equal(trace.traceKind, "subagent")
      assert.equal(trace.rootTraceId, parent.traceId)
      assert.equal(trace.parentTraceId, parent.traceId)
      assert.equal(trace.stageUsageComplete, true)
      assert.equal(trace.harnessNodeName, "plan")
      assert.equal(trace.stageUsage?.find((row) => row.nodeName === "plan")?.totalTokens, 120)
      assert.equal(trace.stageUsage?.find((row) => row.nodeName === "dev")?.toolCalls, 1)
      assert.equal(
        trace.stageUsage?.find((row) => row.nodeName === "dev")?.totalTokens,
        fails ? 0 : 120
      )
      assert.equal(trace.toolUsageComplete, true)
      assert.deepEqual(trace.toolUsage, [{ name: "read_file", count: 1 }])
      assert.equal(trace.userInputRequestCount, 0)
      assert.equal(trace.totalModelCalls, fails ? 1 : 2)
      assert.equal(trace.totalTokens, fails ? 120 : 240)
      assert.equal(trace.totalInputTokens, fails ? 100 : 200)
      assert.equal(trace.totalOutputTokens, fails ? 20 : 40)
      assert.equal(trace.totalToolCalls, 1)
      assert.equal(trace.outcome, fails ? "error" : "success")
      await parent.finish("success")
      console.log(
        `PASS Workflow child ${trace.outcome}: models=${trace.totalModelCalls}, tokens=${trace.totalTokens}, tools=1`
      )
    }
  } finally {
    await flushTraceWriteQueue()
    setTraceReporter(previousReporter)
    for (const [key, value] of Object.entries({
      CMB_COWORK_AGENT_HOME: previous.home,
      CMB_COWORK_TRACES_DIR: previous.traces,
      CMB_COWORK_TRACE_STORAGE_MODE: previous.mode
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
