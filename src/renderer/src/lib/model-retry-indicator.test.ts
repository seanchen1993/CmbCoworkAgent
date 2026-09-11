import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { hasModelRetryProgress, liveAssistantContentWatermark } from "./model-retry-indicator"
import type { LiveStreamMessage } from "./live-stream-messages"

const ai = (content: LiveStreamMessage["content"], type = "ai"): LiveStreamMessage => ({
  id: Math.random().toString(36).slice(2),
  type,
  content
})

describe("模型重试横幅的内容水位", () => {
  it("空流水位为 0", () => {
    expect(liveAssistantContentWatermark(undefined)).toBe(0)
    expect(liveAssistantContentWatermark([])).toBe(0)
  })

  it("累计所有助手消息的正文长度", () => {
    expect(liveAssistantContentWatermark([ai("abc"), ai("de")])).toBe(5)
  })

  it("数组型 content 按 text 块累计", () => {
    const message = ai([
      { type: "text", text: "hello" },
      { type: "text", text: "!" }
    ])
    expect(liveAssistantContentWatermark([message])).toBe(6)
  })

  it("不数工具结果和用户消息——它们不是模型的回答", () => {
    const messages: LiveStreamMessage[] = [
      ai("ok"),
      { id: "t", type: "tool", content: "一大段工具输出" },
      { id: "h", type: "human", content: "用户又说了一句" },
      { id: "s", type: "system", content: "系统提示" }
    ]
    expect(liveAssistantContentWatermark(messages)).toBe(2)
  })

  it("不数 reasoning——只吐思考内容的重答仍然是没有结果", () => {
    const message: LiveStreamMessage = { id: "r", type: "ai", content: "", reasoning: "想了很久" }
    expect(liveAssistantContentWatermark([message])).toBe(0)
  })

  it("未知 type 按助手计——角色判定是排除法，不能漏算新类型", () => {
    expect(liveAssistantContentWatermark([ai("abcd", "AIMessageChunk")])).toBe(4)
    expect(liveAssistantContentWatermark([ai("abcd", "some_future_type")])).toBe(4)
  })
})

describe("横幅退场判据", () => {
  it("内容涨过水位才算模型重新产出了", () => {
    const before = [ai("已经写了一半")]
    const watermark = liveAssistantContentWatermark(before)

    // 举横幅的那一刻：存量内容不构成进展，否则断流前的半截回答会立刻误清横幅
    expect(hasModelRetryProgress(watermark, before)).toBe(false)

    expect(hasModelRetryProgress(watermark, [...before, ai("续上了")])).toBe(true)
  })

  it("重答另起一条消息也算进展", () => {
    const watermark = liveAssistantContentWatermark([ai("")])
    expect(hasModelRetryProgress(watermark, [ai(""), ai("这次有内容了")])).toBe(true)
  })

  it("空回复被重试后模型又给了空回复，不算进展", () => {
    // 门禁第 2 次续跑的场景：横幅必须继续挂着，直到预算耗尽走失败路径
    const watermark = liveAssistantContentWatermark([ai("")])
    expect(hasModelRetryProgress(watermark, [ai(""), ai("")])).toBe(false)
  })

  it("只有工具调用没有正文时不算进展", () => {
    // 模型重答时先去调工具是合理的，但用户还没看到任何回答，横幅该留着
    const watermark = liveAssistantContentWatermark([ai("")])
    const toolOnly: LiveStreamMessage[] = [
      ai(""),
      { id: "t", type: "tool", content: "工具跑完了，输出很长很长" }
    ]
    expect(hasModelRetryProgress(watermark, toolOnly)).toBe(false)
  })
})

describe("主前台流必须自己会撤横幅", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./thread-context.tsx", import.meta.url)),
    "utf8"
  )

  /**
   * 这条守卫存在的原因：门禁续跑横幅原本指望 processSchedulerEvent 里 message-delta
   * 那条 defensive clear 来撤，但那条只在「调度任务」的流里，主前台聊天流根本走不到。
   * 主前台流当时只有两个撤销点——显式 model_retry_clear（只有传输层重试会发）和
   * isLoading 转 false 的兜底——于是门禁的横幅一挂就是一整轮。
   */
  it("handleStreamUpdate 里有不依赖 isLoading 的撤销点", () => {
    const start = source.indexOf("const handleStreamUpdate = useCallback(")
    expect(start).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, source.indexOf("// Fallback clear:", start))
    expect(body).toContain("hasModelRetryProgress(")
    expect(body).toContain("liveAssistantContentWatermark(")
    // 撤销必须发生在 isLoading 兜底之前，否则又退回「挂满一整轮」
    expect(body).toContain("modelRetry: null")
  })

  it("举横幅时不锚水位，留给 handleStreamUpdate 锚", () => {
    const start = source.indexOf('case "model_retry":')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, start + 700)
    expect(body).toContain("contentWatermark: null")
    // model_retry 是传输层直接回调，此刻读 streamDataRef 会拿到偏旧的值
    expect(body).not.toContain("streamDataRef")
  })
})
