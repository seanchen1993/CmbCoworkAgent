import { describe, expect, it, vi, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
import { BotMemoryService } from "./memory"

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
  it.each(["edit", "delete", "archive", "disable", "close"] as const)(
    "discards a summary returned after %s without changing the current files",
    async (change) => {
      const root = mkdtempSync(join(tmpdir(), "bot-memory-late-"))
      const memory = new BotMemoryService(root)
      const entry = memory.write("a", { name: "Synthetic preference", content: "Prefer blue" })
      const apply = vi.spyOn(memory, "applySummary")
      let active = true
      let finish: (() => void) | undefined
      let started!: () => void
      const pending = new Promise<void>((resolve) => (started = resolve))
      fixture.extraction.mockImplementation(
        (options) =>
          new Promise<void>((resolve) => {
            finish = () => {
              options.apply([
                {
                  action: "create",
                  type: "user",
                  filename: "user_stale.md",
                  name: "Stale preference",
                  description: "Synthetic old summary",
                  content: "Prefer blue"
                }
              ])
              resolve()
            }
            started()
          })
      )
      const maintainer = createBotMemoryMaintainer(memory, () => active)
      try {
        maintainer.enqueue({ ...turn, editVersion: memory.editVersion("a") })
        await pending
        if (change === "edit")
          memory.write("a", { ...entry, expectedVersion: entry.version, content: "Prefer red" })
        if (change === "delete") memory.remove("a", entry.id, entry.version)
        if (change === "archive") active = false
        if (change === "disable") fixture.enabled = false
        const expected = memory.list("a")
        const closing = change === "close" ? maintainer.close() : undefined
        finish!()
        finish = undefined
        await closing
        await tick()
        expect(apply).not.toHaveBeenCalled()
        expect(memory.list("a")).toEqual(expected)
      } finally {
        finish?.()
        await maintainer.close()
        await memory.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
