import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillProposalWindowContext } from "../skill-evolution/proposal-window"
import {
  createSkillEvolutionTool,
  requestSkillConfirmation,
  requestSkillIntent,
  type SkillConfirmRequest,
  type SkillIntentRequest
} from "./skill-evolution-tool"

type ResponseHandler = (event: unknown, payload: Record<string, unknown>) => void | boolean

const { handlers, send, getCustomSkillsDir } = vi.hoisted(() => ({
  handlers: new Map<string, ResponseHandler>(),
  send: vi.fn(),
  getCustomSkillsDir: vi.fn<() => string>()
}))

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: ResponseHandler) => handlers.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }]
  }
}))
vi.mock("../../storage", () => ({
  getCustomSkillsDir,
  clearDisabledSkillsForSkillDir: vi.fn(),
  findExistingSkillById: vi.fn(),
  invalidateEnabledSkillsCache: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  send.mockClear()
})

const intent = {
  requestId: "side-intent",
  threadId: "side",
  summary: "Suggested skill",
  toolCallCount: 1,
  turnCount: 1,
  mode: "mode_a_rule",
  context: buildSkillProposalWindowContext([])
} satisfies SkillIntentRequest

const confirmation = {
  requestId: "side-confirm",
  threadId: "side",
  skillId: "skill",
  name: "Suggested skill",
  description: "Skill description",
  content: "Skill content"
}

it("settles both side decisions immediately while leaving the parent request active", async () => {
  vi.useFakeTimers()
  const lifetime = new AbortController()
  const sideIntent = requestSkillIntent(intent, lifetime.signal)
  const sideConfirmation = requestSkillConfirmation(confirmation, lifetime.signal)
  const parent = requestSkillIntent({ ...intent, requestId: "parent-intent", threadId: "parent" })
  expect(send).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(3)

  lifetime.abort()
  handlers.get("skill:intentResponse")?.(null, { requestId: intent.requestId, accepted: true })
  handlers.get("skill:confirmResponse")?.(null, { requestId: confirmation.requestId, approved: true })
  expect(vi.getTimerCount()).toBe(1)
  await expect(sideIntent).resolves.toBe(false)
  await expect(sideConfirmation).resolves.toEqual({ approved: false })

  handlers.get("skill:intentResponse")?.(null, { requestId: "parent-intent", accepted: true })
  await expect(parent).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("drops decisions that reach IPC after the side conversation closes", async () => {
  vi.useFakeTimers()
  const signal = AbortSignal.abort()

  await expect(requestSkillIntent(intent, signal)).resolves.toBe(false)
  await expect(requestSkillConfirmation(confirmation, signal)).resolves.toEqual({ approved: false })
  expect(send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("closes only the matching side request on expiry or abort", async () => {
  vi.useFakeTimers()
  const threadId = `btw-${randomUUID()}-${randomUUID()}`
  const controller = new AbortController()
  const sideIntent = requestSkillIntent({ ...intent, threadId }, controller.signal)
  const sideConfirmation = requestSkillConfirmation({ ...confirmation, threadId })
  const answerIntent = handlers.get("skill:intentResponse")!

  expect(answerIntent(null, { requestId: confirmation.requestId, accepted: true })).toBe(false)
  expect(vi.getTimerCount()).toBe(2)
  controller.abort()
  expect(send).toHaveBeenLastCalledWith("skill:btwRequestClosed", {
    threadId, requestId: intent.requestId, kind: "intent"
  })
  expect(answerIntent(null, { requestId: intent.requestId, accepted: true })).toBe(false)
  expect(await sideIntent).toBe(false)

  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  expect(send).toHaveBeenLastCalledWith("skill:btwRequestClosed", {
    threadId, requestId: confirmation.requestId, kind: "confirm"
  })
  handlers.get("skill:confirmResponse")!(null, { requestId: confirmation.requestId, approved: true })
  expect(await sideConfirmation).toEqual({ approved: false })
})

it.each([false, true])("stops the tool's skill creation on side close (approval already received=%s)", async approved => {
  vi.useFakeTimers()
  const directory = mkdtempSync(join(tmpdir(), "skill-evolve-close-"))
  getCustomSkillsDir.mockReturnValue(directory)
  const controller = new AbortController()
  const { skillId, name, description, content } = confirmation
  const input = { action: "create", name, description, content } as const
  const sideRequest = Promise.withResolvers<SkillConfirmRequest>()
  const ordinaryRequest = Promise.withResolvers<SkillConfirmRequest>()
  send.mockImplementationOnce((_channel, request) => sideRequest.resolve(request))
  try {
    const side = createSkillEvolutionTool({ threadId: "side", abortSignal: controller.signal })
      .invoke({ ...input, skillId })
    const { requestId } = await sideRequest.promise
    const respond = handlers.get("skill:confirmResponse")!
    if (approved) respond(null, { requestId, approved: true })
    controller.abort()
    if (!approved) respond(null, { requestId, approved: true })
    await expect(side).resolves.toContain("Skill creation cancelled")
    expect(existsSync(join(directory, skillId))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    send.mockImplementationOnce((_channel, request) => ordinaryRequest.resolve(request))
    const ordinary = createSkillEvolutionTool({ threadId: "parent" }).invoke({ ...input, skillId })
    respond(null, { requestId: (await ordinaryRequest.promise).requestId, approved: true })
    await expect(ordinary).resolves.toContain('"success":true')
    expect(readFileSync(join(directory, skillId, "SKILL.md"), "utf8")).toBe(content)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
