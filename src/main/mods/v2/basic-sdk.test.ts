import { expect, it } from "vitest"
import { basicSdkInput, runBasicSdk, validateBasicInput, validateBasicResult } from "./basic-sdk"
import type { ModObject } from "../../../shared/mods/types"

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
})
