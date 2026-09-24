import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  safeStorage: {}
}))
vi.mock("../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../storage", () => ({ getUserInfo: () => null }))
vi.mock("../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: () => null
}))
vi.mock("./adoption-tracker", () => ({
  clearAdoptionContext: () => undefined,
  setAdoptionContext: () => undefined
}))

const { TraceCollector } = await import("../agent/trace/collector")
const { TurnTraceRecorder } = await import("../agent/trace/turn-trace-recorder")

/**
 * 这些用例钉的是定时任务上报空壳 trace 的问题。
 *
 * scheduler.ts 自己 new 了一个 TraceCollector，却在整个流式循环里一次都没喂过它：
 * 没有 recordModelCall，没有 recordToolCall，只有 setModelId / setModelName /
 * setRoutingTrace / finish。于是每条定时任务 trace 上报时 token、模型调用、工具
 * 调用全是 0，看板上只有调用次数、耗时和时间是真的。
 *
 * 表现出来就是：一个用户当天只跑了定时任务，活跃用户列表里 Token 一列是 0；
 * 只要混进一条正常聊天 trace，sum 就非 0 了。当时先怀疑是查询没命中那条 doc，
 * 其实 doc 命中了（调用次数和最近活跃时间都是从它读的），空的是 doc 本身。
 */

function ai(id: string, content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id, type: "ai", content, ...extra }
  }
}

function human(id: string, content: string): unknown {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: { id, type: "human", content }
  }
}

function toolResult(id: string, toolCallId: string, content: string): unknown {
  return {
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: { id, type: "tool", tool_call_id: toolCallId, name: "ls", content }
  }
}

const REMINDER_PROMPT = "你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：该写周报了"

/** 一次定时任务运行：提醒词进去，模型查了下目录，再回一句。 */
function scheduledRunSnapshot(): unknown {
  return {
    messages: [
      human("u1", REMINDER_PROMPT),
      ai("a1", "", {
        tool_calls: [{ id: "call-1", name: "ls", args: { path: "docs" } }],
        usage_metadata: { input_tokens: 420, output_tokens: 30, total_tokens: 450 },
        response_metadata: { model_name: "deepseek-v4-flash" }
      }),
      toolResult("t1", "call-1", "docs/weekly.md"),
      ai("a2", "该写周报啦 📝", {
        usage_metadata: { input_tokens: 610, output_tokens: 24, total_tokens: 634 }
      })
    ]
  }
}

describe("定时任务 trace 的采集", () => {
  it("跑完一轮后 token / 模型调用 / 工具调用都不再是 0", async () => {
    const tracer = new TraceCollector("thread-sched", REMINDER_PROMPT, "model-a")
    const recorder = new TurnTraceRecorder({ tracer, userMessageId: "u1" })

    recorder.onStreamChunk("values", scheduledRunSnapshot())
    const trace = await tracer.finish("success")

    // 这四个字段就是看板 sum 聚合读的东西，修复前全是 0。
    expect(trace.totalInputTokens).toBe(1030)
    expect(trace.totalOutputTokens).toBe(54)
    expect(trace.totalTokens).toBe(1084)
    expect(trace.totalModelCalls).toBe(2)
    expect(trace.totalToolCalls).toBeGreaterThan(0)
  })

  it("同一份快照重复到达不会把用量算两遍", async () => {
    // values 快照会随流反复下发，锚在本轮 user message 上才不会重复累加。
    const tracer = new TraceCollector("thread-sched", REMINDER_PROMPT, "model-a")
    const recorder = new TurnTraceRecorder({ tracer, userMessageId: "u1" })

    recorder.onStreamChunk("values", scheduledRunSnapshot())
    recorder.onStreamChunk("values", scheduledRunSnapshot())
    recorder.onStreamChunk("values", scheduledRunSnapshot())
    const trace = await tracer.finish("success")

    expect(trace.totalModelCalls).toBe(2)
    expect(trace.totalTokens).toBe(1084)
  })

  it("没有任何模型调用时仍然是 0，不会凭空造数", async () => {
    // 比如工作区缺失、早早 finish("error") 的那种运行。
    const tracer = new TraceCollector("thread-sched", REMINDER_PROMPT, "model-a")
    const trace = await tracer.finish("error", "No workspace directory")

    expect(trace.totalTokens).toBe(0)
    expect(trace.totalModelCalls).toBe(0)
  })
})

describe("scheduler 的接线", () => {
  const schedulerSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./scheduler.ts"),
    "utf8"
  )

  it("流式循环把每个 chunk 交给 TurnTraceRecorder", () => {
    expect(schedulerSource).toContain("new TurnTraceRecorder(")
    expect(schedulerSource).toContain("traceRecorder.onStreamChunk(")
  })

  it("喂给记录器的是原始 data 的深拷，不是 serializeForRun 的投影帧", () => {
    // serializeForRun 是为压 IPC 体积存在的：values 帧会被投影成 tail/append
    // 增量，messages 帧还会把 tool_calls 删掉。复用它，输入上下文窗口取不全、
    // 工具调用也会丢。这条挡住"顺手复用 frame.data"这种简化。
    expect(schedulerSource).toContain(
      "traceRecorder.onStreamChunk(mode, JSON.parse(JSON.stringify(data)))"
    )
  })
})
