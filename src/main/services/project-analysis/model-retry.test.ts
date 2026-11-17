import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAgentRunEvent } from "../../../shared/project-agent-run"
import {
  ProjectModelRequestError,
  ProjectModelOutputError,
  streamProjectModel,
  type ProjectAnalysisModel
} from "./model-stream"
import { createProjectRunReporter } from "./run-progress"
import { ProjectModelCheckpoint, type ProjectModelCheckpointState } from "./model-checkpoint"

const pause = vi.hoisted(() => vi.fn())
vi.mock("node:timers/promises", () => ({ setTimeout: pause }))
beforeEach(() => {
  pause.mockReset().mockResolvedValue(undefined)
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => vi.restoreAllMocks())
const httpError = (status: number, headers?: Headers) =>
  Object.assign(new Error(`HTTP ${status}`), { status, headers })
const successfulStream: ProjectAnalysisModel["stream"] = async () =>
  (async function* () {
    yield new AIMessageChunk({ content: "完整结果", response_metadata: { finish_reason: "stop" } })
  })()
const run = (stream: typeof successfulStream, signal = new AbortController().signal) =>
  streamProjectModel({ stream }, [], signal, createProjectRunReporter(), "模型调用")

describe("isolated project model retries", () => {
  it.each([undefined, "length", "error"])(
    "does not accept a partial response (finish reason: %s)",
    async (reason) => {
      const stream = vi.fn(successfulStream).mockImplementationOnce(async () =>
        (async function* () {
          yield new AIMessageChunk({
            content: "半份报告",
            response_metadata: { finish_reason: reason }
          })
        })()
      )
      const messages = [new HumanMessage("原始数据与要求")]
      const result = await streamProjectModel(
        { stream },
        messages,
        new AbortController().signal,
        createProjectRunReporter(),
        "报告"
      )
      expect(result.content).toBe("完整结果")
      expect(messages).toHaveLength(1)
      expect(stream).toHaveBeenCalledTimes(2)
      if (reason === "length") {
        expect(stream.mock.calls[1][0]).toHaveLength(2)
        expect(String(stream.mock.calls[1][0][1].content)).toContain("精简")
      }
    }
  )
  it("retains completed review steps while excluding truncated replies from continuation checkpoints", async () => {
    let state: ProjectModelCheckpointState = { completed: {} }
    let persisted = ""
    const reporter = createProjectRunReporter()
    const signal = new AbortController().signal
    const firstMessages = [new HumanMessage("第一批")]
    const secondMessages = [new HumanMessage("第二批")]
    const first = vi.fn(() => run(successfulStream))
    const broken = vi.fn(async () =>
      (async function* () {
        yield new AIMessageChunk({
          content: "未完成审阅",
          response_metadata: { finish_reason: "length" }
        })
      })()
    )
    const checkpoint = new ProjectModelCheckpoint(state, () => {
      persisted = JSON.stringify(state)
    })
    await checkpoint.run("model", firstMessages, "第一批", signal, reporter, first)
    await expect(
      checkpoint.run("model", secondMessages, "第二批", signal, reporter, () => run(broken))
    ).rejects.toBeInstanceOf(ProjectModelRequestError)
    expect(broken).toHaveBeenCalledTimes(7)
    state = JSON.parse(persisted)
    expect(Object.keys(state.completed)).toHaveLength(1)
    expect(state.pendingStep).toBe("第二批")
    expect(persisted).not.toContain("未完成审阅")
    const resumed = new ProjectModelCheckpoint(state, () => undefined)
    await resumed.run("model", firstMessages, "第一批", signal, reporter, first)
    await resumed.run("model", secondMessages, "第二批", signal, reporter, () =>
      run(successfulStream)
    )
    expect(first).toHaveBeenCalledTimes(1)
    expect(Object.keys(state.completed)).toHaveLength(2)
    expect(state.pendingStep).toBeUndefined()
  })
  it("retries malformed SSE JSON and never accepts filtered partial text", async () => {
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"))
    expect((await run(stream)).content).toBe("完整结果")
    stream.mockClear().mockImplementation(async () =>
      (async function* () {
        yield new AIMessageChunk({
          content: "半段正文",
          response_metadata: { finish_reason: "content_filter" }
        })
      })()
    )
    await expect(run(stream)).rejects.toThrow("服务端过滤")
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it.each(["reasoning-only", "no-chunks", "whitespace"])(
    "retries %s responses without marking the empty stream complete",
    async (kind) => {
      const stream = vi.fn(successfulStream).mockImplementationOnce(async () =>
        (async function* () {
          if (kind === "reasoning-only")
            yield new AIMessageChunk({
              content: "",
              additional_kwargs: { reasoning_content: "private-reasoning" },
              response_metadata: { finish_reason: "length" },
              usage_metadata: {
                input_tokens: 50,
                output_tokens: 32000,
                total_tokens: 32050,
                output_token_details: { reasoning: 32000 }
              }
            })
          if (kind === "whitespace") yield new AIMessageChunk("   ")
        })()
      )
      const events: ProjectAgentRunEvent[] = []
      expect(
        (
          await streamProjectModel(
            { stream },
            [],
            new AbortController().signal,
            createProjectRunReporter((event) => events.push(event)),
            "数据审阅"
          )
        ).content
      ).toBe("完整结果")
      expect(stream).toHaveBeenCalledTimes(2)
      const finished = events.filter(
        (event) =>
          event.type === "step" && event.step.kind === "model" && event.step.elapsedMs !== undefined
      )
      expect(finished.map((event) => event.type === "step" && event.step.status)).toEqual([
        "failed",
        "completed"
      ])
      expect(JSON.stringify(events)).not.toContain("private-reasoning")
      if (kind === "reasoning-only") {
        expect(JSON.stringify(events)).toContain("达到输出上限（length）")
        expect(JSON.stringify(events)).toContain("思考 32000 token")
      }
    }
  )
  it("keeps the empty-response diagnosis after the six-retry budget is exhausted", async () => {
    const stream = vi.fn(async () =>
      (async function* () {
        yield new AIMessageChunk({ content: "", response_metadata: { finish_reason: "stop" } })
      })()
    )
    const error = await run(stream).catch((error) => error)
    expect(error).toBeInstanceOf(ProjectModelRequestError)
    expect(error.retries).toBe(6)
    expect(error.cause).toBeInstanceOf(ProjectModelOutputError)
    expect(error.message).toContain("没有返回正文")
    expect(stream).toHaveBeenCalledTimes(7)
  })
  it("does not retry a service-side content filter as a transient empty response", async () => {
    const stream = vi.fn(async () =>
      (async function* () {
        yield new AIMessageChunk({
          content: "",
          response_metadata: { finish_reason: "content_filter" }
        })
      })()
    )
    await expect(run(stream)).rejects.toThrow("服务端内容过滤")
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it("retries HTTP 433 over streaming only and reports each retry", async () => {
    const events: ProjectAgentRunEvent[] = []
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433))
    const messages = [new HumanMessage("检查全量项目")]
    const result = await streamProjectModel(
      { stream },
      messages,
      new AbortController().signal,
      createProjectRunReporter((event) => events.push(event)),
      "全量数据审阅 2/5"
    )
    expect(result.content).toBe("完整结果")
    expect(stream).toHaveBeenCalledTimes(3)
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1500, 3000])
    expect(stream.mock.calls.every(([sent]) => sent === messages)).toBe(true)
    expect(JSON.stringify(events)).toContain("自动重试 2/6")
    expect(JSON.stringify(events)).toContain("HTTP 433")
  })
  it.each([408, 429, 433, 500, 502, 503, 504])(
    "stops after six retries for HTTP %s, matching the pinned runtime budget",
    async (status) => {
      const stream = vi.fn(successfulStream).mockRejectedValue(httpError(status))
      const error = await run(stream).catch((error) => error)
      expect(error).toBeInstanceOf(ProjectModelRequestError)
      expect(error).toMatchObject({ status, retries: 6 })
      expect(stream).toHaveBeenCalledTimes(7)
      expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1500, 3000, 6000, 12000, 24000, 48000])
    }
  )
  it.each([400, 401, 403, 422])(
    "does not retry configuration/authentication errors (HTTP %s)",
    async (status) => {
      const stream = vi.fn(successfulStream).mockRejectedValue(httpError(status))
      await expect(run(stream)).rejects.toMatchObject({ status })
      expect(stream).toHaveBeenCalledTimes(1)
      expect(pause).not.toHaveBeenCalled()
    }
  )
  it("honors bounded Retry-After and can cancel during backoff", async () => {
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433, new Headers({ "retry-after": "120" })))
    await run(stream)
    expect(pause.mock.calls[0][0]).toBe(120000)
    const controller = new AbortController()
    pause.mockImplementationOnce(async (_ms, _value, { signal }) => {
      controller.abort()
      signal.throwIfAborted()
    })
    stream.mockClear().mockRejectedValue(httpError(433))
    await expect(run(stream, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it("can recover on the sixth retry instead of exhausting the earlier three-retry budget", async () => {
    const stream = vi.fn(successfulStream)
    for (let i = 0; i < 6; i++) stream.mockRejectedValueOnce(httpError(433))
    expect((await run(stream)).content).toBe("完整结果")
    expect(stream).toHaveBeenCalledTimes(7)
    expect(pause).toHaveBeenCalledTimes(6)
  })
  it("varies backoff with jitter and caps an unreasonable gateway cooldown", async () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.999)
    const stream = vi
      .fn(successfulStream)
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433))
      .mockRejectedValueOnce(httpError(433, new Headers({ "retry-after": "9999999" })))
    await run(stream)
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 3998, 120000])
  })
  it("discards a broken partial stream and resets visible output before retry", async () => {
    const stream = vi.fn(successfulStream).mockImplementationOnce(async () =>
      (async function* () {
        yield new AIMessageChunk("未完成的旧片段")
        throw new Error("socket ECONNRESET")
      })()
    )
    const events: ProjectAgentRunEvent[] = []
    const result = await streamProjectModel(
      { stream },
      [],
      new AbortController().signal,
      createProjectRunReporter((event) => events.push(event)),
      "分析",
      true
    )
    expect(result.content).toBe("完整结果")
    expect(events.filter((event) => event.type === "text" && event.reset)).toHaveLength(2)
    expect(stream).toHaveBeenCalledTimes(2)
  })
})
