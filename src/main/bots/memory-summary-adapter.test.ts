import { describe, expect, it, vi, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fixture = vi.hoisted(() => ({
  enabled: true,
  extraction: vi.fn(),
  route: vi.fn(),
  routingMode: "pinned" as "pinned" | "auto",
  config: vi.fn(),
  defaultConfig: vi.fn(),
  model: vi.fn(),
  verify: vi.fn()
}))
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      fixture.model(options)
    }
    invoke = fixture.verify
  }
}))
vi.mock("../storage", () => ({
  isMemoryEnabled: () => fixture.enabled,
  getGlobalRoutingMode: () => fixture.routingMode
}))
vi.mock("../routing", () => ({ resolveModel: fixture.route }))
vi.mock("../models/registry", () => ({
  getModelConfigByRef: fixture.config,
  getDefaultModelConfig: fixture.defaultConfig
}))
vi.mock("../memory/summarizer", () => ({ summarizeAndSave: fixture.extraction }))
import { createBotMemoryMaintainer } from "./memory-summary-adapter"
import { BotMemoryService } from "./memory"
import { SelectedModelUnavailableError } from "../models/selection-error"
import { isBotMemoryEnabled } from "./memory-policy"

const turn = {
  botId: "a",
  threadId: "thread-a",
  modelRef: null,
  editVersion: 1,
  conversation: "USER: Prefer TypeScript",
  userText: "Prefer TypeScript"
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const approval = (count = 1, quote = turn.userText): string =>
  JSON.stringify({
    userFacts: [{ quote, kind: "preference", fact: "Prefer TypeScript" }],
    reviews: Array.from({ length: count }, (_, index) => ({ index, factIndexes: [0] })),
    approved: true
  })
beforeEach(() => {
  vi.clearAllMocks()
  fixture.enabled = true
  fixture.routingMode = "pinned"
  fixture.config.mockReturnValue({ model: "test", apiKey: "synthetic-test-key" })
  fixture.defaultConfig.mockReturnValue(null)
  fixture.route.mockResolvedValue(null)
  fixture.verify.mockResolvedValue({ content: approval() })
})

const preference = {
  action: "create" as const,
  type: "user" as const,
  filename: "user_format.md",
  name: "Standing format preference",
  description: "Synthetic durable preference",
  content: "For project Cedar, use Summary, Verification and Follow-up in future reports."
}

describe("Bot automatic memory verification", () => {
  it.each([
    ["enabled", false, true],
    ["disabled", true, false],
    ["inherit", false, false],
    ["inherit", true, true]
  ] as const)(
    "uses Bot memory %s over global %s before extraction and commit",
    async (memoryMode, global, enabled) => {
      fixture.enabled = global
      const root = mkdtempSync(join(tmpdir(), "bot-memory-policy-"))
      const memory = new BotMemoryService(root)
      fixture.extraction.mockImplementation(async (options) => options.apply([preference]))
      const maintainer = createBotMemoryMaintainer(
        memory,
        () => true,
        () => isBotMemoryEnabled({ memoryMode })
      )
      try {
        maintainer.enqueue({ ...turn, editVersion: 0 })
        await tick()
        expect(fixture.extraction).toHaveBeenCalledTimes(enabled ? 1 : 0)
        expect(fixture.verify).toHaveBeenCalledTimes(enabled ? 1 : 0)
        expect(memory.list("a")).toHaveLength(enabled ? 1 : 0)
      } finally {
        await maintainer.close()
        await memory.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(["disabled", "enabled-again"] as const)(
    "discards an in-flight summary after Bot memory is %s",
    async (change) => {
      const root = mkdtempSync(join(tmpdir(), "bot-memory-policy-change-"))
      const memory = new BotMemoryService(root)
      let version = 1
      let enabled = true
      let finish!: () => void
      let started!: () => void
      const pending = new Promise<void>((resolve) => (started = resolve))
      fixture.extraction.mockImplementation(async (options) => options.apply([preference]))
      fixture.verify.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ content: approval() })
            started()
          })
      )
      const maintainer = createBotMemoryMaintainer(
        memory,
        (_id, expected) => expected === version,
        () => enabled
      )
      try {
        maintainer.enqueue({ ...turn, editVersion: 0, botVersion: version })
        await pending
        enabled = false
        version++
        if (change === "enabled-again") {
          enabled = true
          version++
        }
        finish()
        await tick()
        expect(memory.list("a")).toEqual([])
      } finally {
        finish?.()
        await maintainer.close()
        await memory.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each([false, true])(
    "runs the original extractor before an independent approval of %s",
    async (approved) => {
      const root = mkdtempSync(join(tmpdir(), "bot-memory-original-extractor-"))
      const memory = new BotMemoryService(root)
      const original =
        await vi.importActual<typeof import("../memory/summarizer")>("../memory/summarizer")
      fixture.extraction.mockImplementation(original.summarizeAndSave)
      fixture.verify
        .mockResolvedValueOnce({
          content: JSON.stringify({ operations: [preference], memory_md: "# Memory Index" })
        })
        .mockImplementationOnce(async () => {
          expect(memory.list("a")).toEqual([])
          return { content: approved ? approval() : JSON.stringify({ approved }) }
        })
      const maintainer = createBotMemoryMaintainer(memory, () => true)
      try {
        maintainer.enqueue({ ...turn, editVersion: 0 })
        await tick()
        expect(fixture.verify).toHaveBeenCalledTimes(2)
        expect(memory.list("a")).toHaveLength(approved ? 1 : 0)
        expect(fixture.verify.mock.calls[0][0][0].content).toContain("memory curation agent")
        expect(fixture.verify.mock.calls[1][0][0].content).toContain(
          "Audit proposed private long-term memory"
        )
      } finally {
        await maintainer.close()
        await memory.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    '{"approved":false}',
    '{"approved":true}',
    approval(0),
    approval(2),
    approval(1, "Assistant-only task ID"),
    approval().replace('"preference"', '"task_event"'),
    approval().replace('"kind":"preference"', '"kind":["preference"]'),
    approval().replace('"factIndexes":[0]', '"factIndexes":[1]'),
    approval().replace('"factIndexes":[0]', '"factIndexes":[]'),
    approval().replace('"quote":"Prefer TypeScript"', '"quote":" "'),
    approval().replace('"index":0', '"index":-1'),
    approval().replace('"index":0', '"index":0.5'),
    '{"approved":"true"}',
    '{"approved":true,"unexpected":"override"}',
    '[{"approved":true}]',
    "unparseable",
    ""
  ])("does not persist an unapproved or invalid verdict: %s", async (content) => {
    const root = mkdtempSync(join(tmpdir(), "bot-memory-review-"))
    const memory = new BotMemoryService(root)
    memory.write("a", { name: "Existing preference", content: "Prefer blue" })
    const existing = memory.list("a")[0]
    fixture.extraction.mockImplementation(async (options) => {
      options.apply([
        {
          ...preference,
          name: "Temporary test correction",
          content: "The null-name test was not run."
        }
      ])
    })
    fixture.verify.mockResolvedValue({ content })
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue({ ...turn, editVersion: memory.editVersion("a") })
      await tick()
      expect(memory.list("a")).toEqual([existing])
      expect(fixture.verify).toHaveBeenCalledOnce()
    } finally {
      await maintainer.close()
      await memory.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reviews durable creates and updates before committing, using only the target Bot's prior entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-memory-review-"))
    const memory = new BotMemoryService(root)
    memory.write("a", { name: "Existing preference", content: "Prefer blue" })
    const existing = memory.list("a")[0]
    memory.write("b", { name: "Other Bot", content: "Private other-Bot information" })
    const update = {
      ...preference,
      action: "update" as const,
      filename: `${existing.id}.md`,
      content: "Prefer red"
    }
    fixture.extraction.mockImplementation(async (options) => options.apply([update, preference]))
    fixture.verify.mockImplementation(async (messages, options) => {
      expect(memory.list("a")).toEqual([existing])
      expect(messages[0].getType()).toBe("system")
      const evidence = JSON.parse(messages[1].content)
      expect(evidence.conversation).toBe(turn.conversation)
      expect(evidence.userStatements).toEqual([turn.userText])
      expect(evidence.proposedChanges).toEqual([update, preference])
      expect(evidence.currentMemories).toEqual([existing])
      expect(JSON.stringify(evidence)).not.toContain("Private other-Bot information")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return { content: "<think>internal</think>\n```json\n" + approval(2) + "\n```" }
    })
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue({ ...turn, editVersion: memory.editVersion("a") })
      await tick()
      expect(fixture.verify).toHaveBeenCalledOnce()
      expect(memory.list("a")).toHaveLength(2)
      expect(
        memory
          .list("a")
          .find((entry) => entry.id === existing.id)
          ?.content.trim()
      ).toBe("Prefer red")
      expect(memory.list("a").some((entry) => entry.content.trim() === preference.content)).toBe(
        true
      )
    } finally {
      await maintainer.close()
      await memory.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not request verification for empty or skip-only proposals", async () => {
    const memory = {
      editVersion: () => 1,
      summaryDirectory: () => "/fixture/bots/a/memory",
      list: () => [],
      applySummary: vi.fn()
    } as unknown as BotMemoryService
    fixture.extraction.mockImplementation(async (options) => {
      options.apply([{ action: "skip", filename: "existing.md" }])
    })
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    maintainer.enqueue(turn)
    await tick()
    expect(fixture.verify).not.toHaveBeenCalled()
    expect(memory.applySummary).not.toHaveBeenCalled()
    await maintainer.close()
  })

  it("rejects invented update filenames without a request or a partial commit", async () => {
    const memory = {
      editVersion: () => 1,
      summaryDirectory: () => "/fixture/bots/a/memory",
      list: () => [],
      applySummary: vi.fn()
    } as unknown as BotMemoryService
    fixture.extraction.mockImplementation(async (options) => {
      expect(options.scopeHint).toContain("EXACT filename")
      options.apply([
        preference,
        { ...preference, action: "update", filename: "reference_invented.md" }
      ])
    })
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue(turn)
      await tick()
      expect(fixture.verify).not.toHaveBeenCalled()
      expect(memory.applySummary).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledOnce()
    } finally {
      await maintainer.close()
      warning.mockRestore()
    }
  })

  it("uses the existing total deadline to abort verification without writing memory", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const memory = {
      editVersion: () => 1,
      summaryDirectory: () => "/fixture/bots/a/memory",
      list: () => [],
      applySummary: vi.fn()
    } as unknown as BotMemoryService
    fixture.extraction.mockImplementation(async (options) => options.apply([preference]))
    let reviewSignal: AbortSignal | undefined
    fixture.verify.mockImplementation(
      (_messages, options) =>
        new Promise((_resolve, reject) => {
          reviewSignal = options.signal
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true
          })
        })
    )
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue(turn)
      await tick()
      expect(reviewSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(reviewSignal?.aborted).toBe(true)
      expect(memory.applySummary).not.toHaveBeenCalled()
      await maintainer.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await maintainer.close()
      vi.useRealTimers()
    }
  })

  it.each(["edit", "delete", "archive", "disable", "close", "failure"] as const)(
    "does not commit an approved proposal after %s during verification",
    async (change) => {
      const root = mkdtempSync(join(tmpdir(), "bot-memory-review-"))
      const memory = new BotMemoryService(root)
      const entry = memory.write("a", { name: "Existing preference", content: "Prefer blue" })
      const apply = vi.spyOn(memory, "applySummary")
      let active = true
      let finish!: () => void
      let started!: () => void
      const pending = new Promise<void>((resolve) => (started = resolve))
      fixture.extraction.mockImplementation(async (options) => options.apply([preference]))
      fixture.verify.mockImplementation(
        (_messages, options) =>
          new Promise((resolve, reject) => {
            finish = () =>
              change === "failure"
                ? reject(new Error("Synthetic verification failure"))
                : resolve({ content: approval() })
            expect(options.signal).toBeInstanceOf(AbortSignal)
            started()
          })
      )
      const warning = vi.spyOn(console, "error").mockImplementation(() => {})
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
        finish()
        await closing
        await tick()
        expect(apply).not.toHaveBeenCalled()
        expect(memory.list("a")).toEqual(expected)
      } finally {
        finish?.()
        await maintainer.close()
        await memory.close()
        warning.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

describe("Bot memory extraction wiring", () => {
  it("passes only private filenames into extraction, keeping shared and group references out", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-memory-extraction-scope-"))
    const memory = new BotMemoryService(root)
    const own = memory.write("a", { name: "Private", content: "Private" })
    memory.write("a", { name: "Shared", content: "Shared", scope: { kind: "shared" } })
    memory.writeInContext("a", { name: "Group", content: "Group" }, { groupId: "g" })
    fixture.extraction.mockResolvedValue(undefined)
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue({ ...turn, editVersion: memory.editVersion("a") })
      await tick()
      expect(fixture.extraction).toHaveBeenCalledWith(
        expect.objectContaining({ allowedFilenames: [`${own.id}.md`] })
      )
    } finally {
      await maintainer.close()
      await memory.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.each(["missing_config", "missing_credentials"] as const)(
    "does not fall back or send private content after pinned routing reports %s",
    async (reason) => {
      fixture.route.mockRejectedValue(new SelectedModelUnavailableError("custom:pinned", reason))
      fixture.defaultConfig.mockReturnValue({ model: "other", apiKey: "synthetic-default-key" })
      const memory = { editVersion: () => 1 } as unknown as BotMemoryService
      const maintainer = createBotMemoryMaintainer(memory, () => true)
      try {
        maintainer.enqueue({ ...turn, modelRef: "custom:pinned" })
        await tick()
        expect(fixture.defaultConfig).not.toHaveBeenCalled()
        expect(fixture.model).not.toHaveBeenCalled()
        expect(fixture.extraction).not.toHaveBeenCalled()
        expect(fixture.verify).not.toHaveBeenCalled()
      } finally {
        await maintainer.close()
      }
    }
  )

  it.each([null, { model: "pinned", apiKey: "  " }])(
    "skips a pinned configuration that disappears or loses credentials after routing: %s",
    async (config) => {
      fixture.route.mockResolvedValue({ resolvedModelId: "custom:pinned" })
      fixture.config.mockReturnValue(config)
      fixture.defaultConfig.mockReturnValue({ model: "other", apiKey: "synthetic-default-key" })
      const memory = { editVersion: () => 1 } as unknown as BotMemoryService
      const maintainer = createBotMemoryMaintainer(memory, () => true)
      try {
        maintainer.enqueue({ ...turn, modelRef: "custom:pinned" })
        await tick()
        expect(fixture.config).toHaveBeenCalledWith("custom:pinned")
        expect(fixture.defaultConfig).not.toHaveBeenCalled()
        expect(fixture.model).not.toHaveBeenCalled()
        expect(fixture.extraction).not.toHaveBeenCalled()
      } finally {
        await maintainer.close()
      }
    }
  )

  it.each([
    { mode: "pinned" as const, modelRef: "custom:pinned", routed: "custom:pinned" },
    { mode: "auto" as const, modelRef: "custom:pinned", routed: "custom:economy" },
    { mode: "pinned" as const, modelRef: null, routed: "custom:default" }
  ])("retains valid $mode routing for $modelRef", async ({ mode, modelRef, routed }) => {
    fixture.routingMode = mode
    fixture.route.mockResolvedValue({ resolvedModelId: routed })
    fixture.config.mockImplementation((ref) => ({ model: ref, apiKey: "synthetic-selected-key" }))
    fixture.extraction.mockResolvedValue(undefined)
    const memory = {
      editVersion: () => 1,
      summaryDirectory: () => "/fixture/bots/a/memory",
      list: () => []
    } as unknown as BotMemoryService
    const maintainer = createBotMemoryMaintainer(memory, () => true)
    try {
      maintainer.enqueue({ ...turn, modelRef })
      await tick()
      expect(fixture.route).toHaveBeenCalledWith({
        taskSource: "memory_summarize",
        threadId: turn.threadId,
        requestedModelId: modelRef ?? undefined,
        routingMode: mode
      })
      expect(fixture.model).toHaveBeenCalledWith(expect.objectContaining({ model: routed }))
      expect(fixture.defaultConfig).not.toHaveBeenCalled()
      expect(fixture.extraction).toHaveBeenCalledOnce()
    } finally {
      await maintainer.close()
    }
  })

  it.each([
    { mode: "auto" as const, modelRef: "custom:requested", fallback: true },
    { mode: "pinned" as const, modelRef: null, fallback: true },
    { mode: "pinned" as const, modelRef: "custom:pinned", fallback: false }
  ])(
    "keeps the existing routing-error boundary for $mode/$modelRef",
    async ({ mode, modelRef, fallback }) => {
      fixture.routingMode = mode
      fixture.route.mockRejectedValue(new Error("Synthetic routing service failure"))
      fixture.config.mockReturnValue(null)
      fixture.defaultConfig.mockReturnValue({ model: "default", apiKey: "synthetic-default-key" })
      fixture.extraction.mockResolvedValue(undefined)
      const memory = {
        editVersion: () => 1,
        summaryDirectory: () => "/fixture/bots/a/memory",
        list: () => []
      } as unknown as BotMemoryService
      const maintainer = createBotMemoryMaintainer(memory, () => true)
      try {
        maintainer.enqueue({ ...turn, modelRef })
        await tick()
        expect(fixture.defaultConfig).toHaveBeenCalledTimes(Number(fallback))
        expect(fixture.extraction).toHaveBeenCalledTimes(Number(fallback))
        expect(fixture.model).toHaveBeenCalledTimes(Number(fallback))
      } finally {
        await maintainer.close()
      }
    }
  )

  it("uses the original summarizer only for the private namespace and honors enablement at commit", async () => {
    const apply = vi.fn(),
      directory = vi.fn(() => "/fixture/bots/a/memory")
    const memory = {
      editVersion: () => 1,
      summaryDirectory: directory,
      list: () => [],
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
    expect(apply).not.toHaveBeenCalled()
    fixture.enabled = false
    commit!([])
    maintainer.enqueue(turn)
    await tick()
    expect(apply).not.toHaveBeenCalled()
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
