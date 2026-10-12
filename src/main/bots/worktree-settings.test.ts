import { beforeEach, expect, it, vi } from "vitest"
const read = vi.hoisted(() => vi.fn())
vi.mock("./model-config", () => ({ readBotModelSnapshot: read }))
import { BotWorktreeSettings } from "./worktree-settings"
import { botWorktreeOperation, botWorktreeTimeouts } from "./worktree-contract"

beforeEach(() => read.mockReset())
const input = { op: "prepare" as const, workspacePath: "/project", appDataRoot: "/workspaces" }
it("uses current configured Git budgets, allows rollback time, and forwards no model credentials", async () => {
  const settings = new BotWorktreeSettings("models.private")
  read.mockResolvedValue({
    workflowWorktreeTimeoutMinutes: 17,
    workflowWorktreeRemoveTimeoutMinutes: 4,
    models: [{ apiKey: "private" }]
  })
  const prepared = await settings.prepare(input, 60_000)
  expect(prepared).toEqual({
    input: { ...input, timeouts: { createMinutes: 17, removeMinutes: 4 } },
    timeoutMs: 21 * 60_000
  })
  expect(botWorktreeOperation.parse(prepared.input)).toEqual(prepared.input)
  read.mockResolvedValue({
    workflowWorktreeTimeoutMinutes: 2,
    workflowWorktreeRemoveTimeoutMinutes: 1
  })
  expect((await settings.prepare(input, 60_000)).input.timeouts).toEqual({
    createMinutes: 2,
    removeMinutes: 1
  })
})
it("keeps maintenance independent from model publication while retaining the last valid limits", async () => {
  const settings = new BotWorktreeSettings("models.private")
  read.mockRejectedValue(new Error("ENOENT"))
  expect((await settings.prepare(input, 60_000)).input.timeouts).toEqual({
    createMinutes: 3,
    removeMinutes: 1
  })
  read.mockResolvedValue({
    workflowWorktreeTimeoutMinutes: 12,
    workflowWorktreeRemoveTimeoutMinutes: 3
  })
  await settings.prepare(input, 60_000)
  read.mockRejectedValue(new Error("model configuration publication pending"))
  expect((await settings.prepare(input, 60_000)).input.timeouts).toEqual({
    createMinutes: 12,
    removeMinutes: 3
  })
  read.mockResolvedValue({
    workflowWorktreeTimeoutMinutes: Number.MAX_SAFE_INTEGER,
    workflowWorktreeRemoveTimeoutMinutes: -1
  })
  expect((await settings.prepare(input, 60_000)).input.timeouts).toEqual({
    createMinutes: 3,
    removeMinutes: 1
  })
})
it("rejects unbounded or malformed worker limits", () => {
  for (const invalid of [
    { createMinutes: 0, removeMinutes: 1 },
    { createMinutes: 121, removeMinutes: 1 },
    { createMinutes: 1.5, removeMinutes: 1 },
    { createMinutes: 3, removeMinutes: 11 },
    { createMinutes: 3, removeMinutes: 1, apiKey: "unexpected" }
  ])
    expect(botWorktreeTimeouts.safeParse(invalid).success).toBe(false)
})
