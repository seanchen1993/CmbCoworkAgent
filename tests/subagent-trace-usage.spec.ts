/** Real Workflow runner + collector, with a deterministic model stream. No API calls. */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
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
      const parent = new TraceCollector("parent", "delegate", "test", { includeSkillEval: false })
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
        createRuntime: async () => ({
          stream: async (input: { messages: unknown[] }) =>
            (async function* () {
              const messages = [
                ...input.messages,
                new AIMessage({
                  id: "a1",
                  content: "",
                  usage_metadata: usage,
                  tool_calls: [{ id: "tool-1", name: "read_file", args: { path: "x.ts" } }]
                })
              ]
              yield ["values", { messages: [...messages] }]
              yield ["values", { messages: [...messages] }]
              if (fails) throw new Error("test model failed")
              messages.push(new ToolMessage({ id: "t1", content: "ok", tool_call_id: "tool-1" }))
              messages.push(new AIMessage({ id: "a2", content: "done", usage_metadata: usage }))
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
      assert.equal(trace.totalModelCalls, fails ? 1 : 2)
      assert.equal(trace.totalTokens, fails ? 120 : 240)
      assert.equal(trace.totalInputTokens, fails ? 100 : 200)
      assert.equal(trace.totalOutputTokens, fails ? 20 : 40)
      assert.equal(trace.totalToolCalls, 1)
      assert.equal(trace.outcome, fails ? "error" : "success")
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
