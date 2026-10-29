import { expect, it } from "vitest"
import { basicSdkInput, runBasicSdk, validateBasicInput, validateBasicResult } from "./basic-sdk"
import type { ModObject } from "../../../shared/mods/types"

it("keeps native command name limits and Chinese descriptions aligned with authoring", () => {
  for (const name of ["检查文本", "text review", "", "a".repeat(65), null])
    expect(() => validateBasicInput("command.register", { name, description: "检查文本" }))
      .toThrow("MODS_COMMAND_SPEC")
  for (const name of ["text-review", "text_review_1", "a".repeat(64)])
    expect(() => validateBasicInput("command.register", { name, description: "检查文本" }))
      .not.toThrow()
})

it("preserves strict messages selectors and validates the original API return format", async () => {
  const input = basicSdkInput("session.messages", [{ as: "api", agentId: "actual-child" }])
  expect(input).toEqual({ as: "api", agentId: "actual-child" })
  for (const args of [[null], [{ as: "summary" }], [{ agentId: "" }], [{ extra: true }], [{}, {}]])
    expect(() => basicSdkInput("session.messages", args)).toThrow()
  const controller = new AbortController()
  const calls: unknown[] = []
  const value = await runBasicSdk("session.messages", input, {
    threadId: "main", workspace: "/project", plugin: "P", registry: new Map(),
    signal: controller.signal,
    readConversation: async (received, signal) => {
      calls.push(received, signal)
      return [{ role: "user", content: [{ type: "image", source: { data: "pixel" } }] }]
    }
  })
  expect(calls).toEqual([input, controller.signal])
  expect(() => validateBasicResult("session.messages", value, input)).not.toThrow()
  expect(() => validateBasicResult("session.messages", value, {})).toThrow("MODS_SDK_RESULT")
  expect(() => validateBasicResult("session.messages", { deny: "closed" }, input)).not.toThrow()
  expect(() => validateBasicResult("session.messages", { deny: "closed" }, {})).toThrow()
})

it("keeps the legacy summary backend and honestly rejects selectors without a real backend", async () => {
  const calls: string[] = []
  const context = { threadId: "main", workspace: "/project", plugin: "P", registry: new Map(),
    signal: new AbortController().signal,
    readSession: async (method: string) => { calls.push(method); return [] }
  }
  expect(await runBasicSdk("session.messages", {}, context)).toEqual([])
  await expect(runBasicSdk("session.messages", { as: "api" }, context))
    .rejects.toMatchObject({ code: "MODS_CONVERSATION_UNAVAILABLE" })
  expect(calls).toEqual(["session.messages"])
})

it("preserves usage options and rejects invalid breakdowns and grid widths", () => {
  expect(basicSdkInput("session.usage", [])).toEqual({})
  expect(basicSdkInput("session.usage", [{ breakdown: "full", columns: 60 }])).toEqual({
    breakdown: "full",
    columns: 60
  })
  for (const value of [null, false, [], "summary"])
    expect(() => basicSdkInput("session.usage", [value])).toThrow("MODS_SESSION_USAGE_ARGUMENT")
  const invalidInputs: ModObject[] = [
    { breakdown: "unknown" },
    { columns: 0 },
    { columns: 1.5 },
    { columns: -1 }
  ]
  for (const value of invalidInputs)
    expect(() => validateBasicInput("session.usage", value)).toThrow("MODS_SESSION_USAGE_ARGUMENT")
})

it("distinguishes unknown usage from fabricated or invalid numeric readings", () => {
  expect(() =>
    validateBasicResult("session.usage", { context: { window: 32000 }, rateLimits: [] })
  ).not.toThrow()
  const invalidContexts: ModObject[] = [
    { window: 0 },
    { window: 1000, tokens: -1 },
    { window: 1000, percent: 101 }
  ]
  for (const context of invalidContexts)
    expect(() => validateBasicResult("session.usage", { context, rateLimits: [] })).toThrow(
      "MODS_SDK_RESULT"
    )
  expect(() =>
    validateBasicResult("session.usage", {
      context: { window: 1000 },
      rateLimits: [{ kind: "limit", percentUsed: 20, resetsAt: "invalid" }]
    })
  ).toThrow("MODS_SDK_RESULT")
  expect(() =>
    validateBasicResult("session.usage", {
      context: { window: 1000 },
      rateLimits: [],
      cost: { usd: -1 }
    })
  ).toThrow("MODS_SDK_RESULT")
})

it("routes session.compact through the host mutation boundary", async () => {
  const calls: Array<{ instructions: string; aborted: boolean }> = []
  const signal = new AbortController().signal
  const result = await runBasicSdk("session.compact", { instructions: "Keep API decisions." }, {
    threadId: "thread",
    workspace: "/workspace",
    plugin: "example",
    registry: new Map(),
    signal,
    compactSession: async (instructions, receivedSignal) => {
      calls.push({ instructions, aborted: receivedSignal.aborted })
      return {
        messages: [{ role: "user", text: "summary", toolUses: [] }],
        tokensBefore: 1200,
        tokensAfter: 240
      }
    }
  })
  expect(result).toEqual({
    messages: [{ role: "user", text: "summary", toolUses: [] }],
    tokensBefore: 1200,
    tokensAfter: 240
  })
  expect(calls).toEqual([{ instructions: "Keep API decisions.", aborted: false }])
  expect(() => validateBasicInput("session.compact", { instructions: "x".repeat(32001) })).toThrow(
    "MODS_CONTEXT_COMPACTION_INSTRUCTIONS"
  )
  expect(() => validateBasicResult("session.compact", { messages: [] })).toThrow(
    "MODS_SDK_RESULT"
  )
  expect(() =>
    validateBasicResult("session.compact", {
      messages: [{ role: "user", text: "summary", toolUses: [] }],
      filePath: "/conversation_history/internal-only.md"
    })
  ).toThrow("MODS_SDK_RESULT")
})
