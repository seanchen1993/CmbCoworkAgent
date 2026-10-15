import { describe, expect, it, vi, beforeEach } from "vitest"

const fixture = vi.hoisted(() => ({
  enabled: true,
  extraction: vi.fn(),
  route: vi.fn(),
  model: vi.fn()
}))
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      fixture.model(options)
    }
  }
}))
vi.mock("../storage", () => ({
  isMemoryEnabled: () => fixture.enabled,
  getGlobalRoutingMode: () => "pinned"
}))
vi.mock("../routing", () => ({ resolveModel: fixture.route }))
vi.mock("../models/registry", () => ({
  getModelConfigByRef: () => ({ model: "test", apiKey: "synthetic-test-key" }),
  getDefaultModelConfig: () => null
}))
vi.mock("../memory/summarizer", () => ({ summarizeAndSave: fixture.extraction }))
import { createBotMemoryMaintainer } from "./memory-summary-adapter"
import type { BotMemoryService } from "./memory"

const turn = {
  botId: "a",
  threadId: "thread-a",
  modelRef: null,
  editVersion: 1,
  conversation: "USER: Prefer TypeScript"
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.enabled = true
  fixture.route.mockResolvedValue(null)
})

describe("Bot memory extraction wiring", () => {
  it("uses the original summarizer only for the private namespace and honors enablement at commit", async () => {
    const apply = vi.fn(),
      directory = vi.fn(() => "/fixture/bots/a/memory")
    const memory = {
      editVersion: () => 1,
      summaryDirectory: directory,
      applySummary: apply
    } as unknown as BotMemoryService
    let commit: ((operations: []) => void) | undefined
    fixture.extraction.mockImplementation(async (options) => {
      commit = options.apply
    })
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    maintainer.enqueue(turn)
    await tick()
    expect(fixture.extraction).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryDir: "/fixture/bots/a/memory",
        signal: expect.any(AbortSignal)
      })
    )
    expect(fixture.model).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, timeout: 30_000 })
    )
    commit!([])
    expect(apply).toHaveBeenCalledTimes(1)
    fixture.enabled = false
    commit!([])
    maintainer.enqueue(turn)
    await tick()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(fixture.extraction).toHaveBeenCalledTimes(1)
    await maintainer.close()
  })
  it("skips archived Bots and stale queued summaries before resolving the model", async () => {
    let active = false,
      version = 1
    const memory = { editVersion: () => version } as unknown as BotMemoryService
    const maintainer = createBotMemoryMaintainer(memory, () => active)
    maintainer.enqueue(turn)
    await tick()
    active = true
    version = 2
    maintainer.enqueue(turn)
    await tick()
    expect(fixture.route).not.toHaveBeenCalled()
    expect(fixture.extraction).not.toHaveBeenCalled()
    await maintainer.close()
  })
})
