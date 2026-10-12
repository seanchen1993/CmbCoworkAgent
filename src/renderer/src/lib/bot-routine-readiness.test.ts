import { afterEach, expect, it, vi } from "vitest"
import { toggleBotRoutine } from "./bot-routine-toggle"
import {
  acknowledgePendingRoutine,
  inspectPendingRoutine,
  rememberPendingRoutine
} from "./bot-routine-pending"
import type { BotRoutine } from "../../../shared/bot-types"
import type { BotSaveRoutineInput } from "../../../shared/bot-routines"
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const data = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key)
  })
  const routine: BotRoutine = {
    id: "routine",
    botId: "bot",
    name: "Reviewed",
    prompt: "Review",
    enabled: false,
    desiredEnabled: true,
    effectiveState: "needs_setup",
    activationRequired: true,
    nextAt: null,
    revision: 1,
    createdAt: 1,
    timezone: "UTC",
    schedule: { kind: "event", topic: "isolated" }
  }
  return {
    data,
    routine,
    input: {
      botId: "bot",
      routine,
      dataEpoch: "initial",
      editorSupport: true,
      mutationSupport: true,
      isLive: () => true,
      isCurrentEpoch: () => true,
      save: vi.fn<(request: BotSaveRoutineInput) => Promise<unknown>>(async () => undefined),
      recover: vi.fn(),
      setup: vi.fn()
    }
  }
}
it("sends optional desired intent only to a capable Host and preserves the reviewed identity", async () => {
  const f = fixture()
  await toggleBotRoutine({ ...f.input, readinessSupport: true })
  expect(f.input.save.mock.calls[0][0]).toMatchObject({
    id: f.routine.id,
    revision: 1,
    expectedDataEpoch: "initial",
    enabled: true,
    desiredEnabled: true
  })
  expect(inspectPendingRoutine("bot", "routine", "initial").kind).toBe("empty")
  const legacy = fixture()
  await toggleBotRoutine(legacy.input)
  expect(legacy.input.save.mock.calls[0][0]).not.toHaveProperty("desiredEnabled")
})
it("missing dependencies open the original setup owner without storing or sending an impossible enable", async () => {
  const f = fixture()
  expect(
    await toggleBotRoutine({
      ...f.input,
      readinessSupport: true,
      routine: { ...f.routine, skillIssue: "Unverified", skillIssueCode: "skill_unverified" }
    })
  ).toBe(false)
  expect(f.input.setup).toHaveBeenCalledOnce()
  expect(f.input.save).not.toHaveBeenCalled()
  expect(f.data.size).toBe(0)
})
it("a lost activation ACK remains exact across inverse toggle and epoch replacement", async () => {
  const f = fixture()
  f.input.save.mockRejectedValue(Error("ACK lost"))
  await expect(toggleBotRoutine({ ...f.input, readinessSupport: true })).rejects.toThrow("ACK lost")
  const pending = inspectPendingRoutine("bot", "routine", "initial")
  expect(pending).toMatchObject({ kind: "valid", input: { enabled: true, desiredEnabled: true } })
  expect(
    await toggleBotRoutine({
      ...f.input,
      readinessSupport: true,
      routine: { ...f.routine, enabled: true, revision: 2, effectiveState: "active" }
    })
  ).toBe(false)
  expect(f.input.save).toHaveBeenCalledOnce()
  expect(inspectPendingRoutine("bot", "routine", "initial")).toEqual(pending)
  expect(inspectPendingRoutine("bot", "routine", "restored").kind).toBe("obsolete")
})
it("legacy pending bytes stay unfilled, and optional intent requires its original exact acknowledgement", () => {
  const f = fixture()
  const request = {
    botId: "bot",
    id: "routine",
    revision: 1,
    nonce: "original",
    name: "Reviewed",
    prompt: "Review",
    timezone: "UTC",
    enabled: false,
    schedule: { kind: "event" as const, topic: "isolated" }
  }
  const raw = JSON.stringify({ dataEpoch: "initial", input: request })
  f.data.set("bot-routine-pending:bot:routine", raw)
  expect(inspectPendingRoutine("bot", "routine", "initial")).toMatchObject({
    kind: "valid",
    input: request
  })
  expect(f.data.get("bot-routine-pending:bot:routine")).toBe(raw)
  expect(acknowledgePendingRoutine({ ...request, desiredEnabled: true }, "initial")).toBe(false)
  expect(acknowledgePendingRoutine(request, "initial")).toBe(true)
  rememberPendingRoutine({ ...request, desiredEnabled: true }, "initial")
  expect(acknowledgePendingRoutine(request, "initial")).toBe(false)
  expect(acknowledgePendingRoutine({ ...request, desiredEnabled: true }, "initial")).toBe(true)
})
