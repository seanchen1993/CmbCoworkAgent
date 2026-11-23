import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { ApprovalRequest } from "../../types"
import { ApprovalDecisionBroker } from "../../agent/approval-decision-broker"
import { botInteractionRoutes } from "./bot-interaction-route"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] }
}))
import { ImRemoteApprovalService } from "./remote-approval-service"

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
)

function setup(cardAccepted = true, enabled = true, desktop = false) {
  const broker = new ApprovalDecisionBroker()
  let current = true
  const resolve = vi.fn()
  const record = vi.fn(async (input) => input)
  const remove = vi.fn(async () => {})
  const enqueue = vi.fn(async () => [])
  const cards = {
    publish: vi.fn(async (_input: unknown) => (cardAccepted ? { interactionId: "card" } : null)),
    interactions: { findByRequestRef: () => ({ interactionId: "card", targetLabel: "Feature" }) },
    resolveDetached: vi.fn()
  }
  const service = new ImRemoteApprovalService({
    broker,
    cards: cards as never,
    audits: { record, remove } as never,
    events: { enqueueProactiveReplies: enqueue, markOutboxFailed: vi.fn() },
    getSettings: () => ({ enabled: true, remoteApprovalEnabled: enabled }) as never,
    getThread: (id) =>
      id === "stage" ? ({ metadata: JSON.stringify({ workspacePath: tmpdir() }) } as never) : null,
    conversations: { getReplyMode: () => "card" } as never,
    createCode: () => "AABB01",
    warn: vi.fn()
  })
  const releaseTransport = botInteractionRoutes.setTransport(() => true)
  const releaseRoute = botInteractionRoutes.register({
    threadId: "stage",
    realm: "realm",
    principalId: "owner",
    conversationKey: "group",
    prefix: "【Feature】",
    kind: "group",
    ...(desktop ? { botBindingRef:"binding:room:1" } : {botEventId:"trigger"}),
    senderId: "other-member",
    isCurrent: () => current
  })
  cleanups.push(() => {
    service.dispose()
    releaseRoute()
    releaseTransport()
  })
  const request = {
    id: "request",
    tool_call: { id: "tool", name: "execute" },
    allowed_approval_types: ["approve", "reject"],
    operation: "execute",
    command: "git status --short",
    cwd: tmpdir()
  } as ApprovalRequest
  const register = () =>
    broker.register({
      threadId: "stage__worker",
      runtimeThreadId: "stage__worker",
      request,
      resolve
    })
  const click = (overrides = {}) =>
    service.resolveCardClick({
      interactionId: "card",
      requestRef: "AABB01",
      decision: "approve",
      principalId: "owner",
      conversationKey: "group",
      ...overrides
    })
  return {
    service,
    broker,
    register,
    resolve,
    record,
    remove,
    enqueue,
    cards,
    click,
    revoke: () => {
      current = false
    }
  }
}

it("routes a project child approval to its group and applies one owner-checked card receipt", async () => {
  const ctx = setup()
  expect(ctx.service.canPublish("stage__worker")).toBe(true)
  ctx.register()
  await vi.waitFor(() => expect(ctx.cards.publish).toHaveBeenCalledOnce())
  const published = ctx.cards.publish.mock.calls[0][0] as unknown as {
    build: (tag: string) => unknown
  }
  expect(published).toMatchObject({
    kind: "approval",
    botEventId: "trigger",
    threadId: "stage",
    conversationKey: "group"
  })
  expect(JSON.stringify(published.build("tag"))).toContain("仅绑定 Bot 的本人")
  expect(await ctx.click({ principalId: "other" })).toContain("不属于")
  expect(await ctx.click({ conversationKey: "other-group" })).toContain("不属于")
  expect(
    await ctx.service.resolveCode({
      code: "AABB01",
      decision: "approve",
      principalId: "owner",
      conversationKey: "group"
    })
  ).toContain("点击审批卡片")
  expect(ctx.resolve).not.toHaveBeenCalled()
  expect(await ctx.click()).toContain("一次性批准")
  expect(ctx.record).toHaveBeenCalledOnce()
  expect(ctx.resolve).toHaveBeenCalledWith({ type: "approve", tool_call_id: "tool" })
  await ctx.click()
  expect(ctx.resolve).toHaveBeenCalledOnce()
})

it("keeps an old gateway's rejected group card on desktop without exposing actionable text approval", async () => {
  const ctx = setup(false)
  ctx.register()
  await vi.waitFor(() => expect(ctx.enqueue).toHaveBeenCalledOnce())
  expect(JSON.stringify(ctx.enqueue.mock.calls)).toContain("网关尚未升级")
  expect(JSON.stringify(ctx.enqueue.mock.calls)).not.toContain("/批准")
  expect(ctx.broker.get("request")).not.toBeNull()
  expect(await ctx.click()).toContain("不存在")
  expect(ctx.resolve).not.toHaveBeenCalled()
})

it("preserves the remote approval setting", () => {
  const ctx = setup(true, false)
  expect(ctx.service.canPublish("stage__worker")).toBe(false)
  ctx.register()
  expect(ctx.cards.publish).not.toHaveBeenCalled()
  expect(ctx.resolve).not.toHaveBeenCalled()
})

it.each(["revoke", "desktop", "audit-failure"])(
  "does not resume a group operation after %s during audit",
  async (mode) => {
    const ctx = setup()
    ctx.register()
    await vi.waitFor(() => expect(ctx.cards.publish).toHaveBeenCalledOnce())
    ctx.record.mockImplementationOnce(async () => {
      if (mode === "revoke") ctx.revoke()
      if (mode === "desktop")
        ctx.broker.decide({
          source: { kind: "desktop", webContentsId: 1 },
          requestId: "request",
          decision: { type: "reject", tool_call_id: "tool" }
        })
      if (mode === "audit-failure") throw new Error("disk failure")
      return {} as never
    })
    await ctx.click()
    expect(ctx.resolve).not.toHaveBeenCalledWith({ type: "approve", tool_call_id: "tool" })
    if (mode === "audit-failure") expect(ctx.broker.get("request")).not.toBeNull()
    else expect(ctx.remove).toHaveBeenCalledWith("request")
  }
)


it("keeps desktop-origin group approvals owner-only and invalidates them on revocation", async () => {
  const ctx = setup(true,true,true)
  expect(ctx.service.canPublish("stage__worker")).toBe(true)
  ctx.register()
  await vi.waitFor(() => expect(ctx.cards.publish).toHaveBeenCalledOnce())
  expect(ctx.cards.publish.mock.calls[0][0]).toMatchObject({botBindingRef:"binding:room:1",conversationKey:"group"})
  await ctx.click({principalId:"other-member"})
  expect(ctx.resolve).not.toHaveBeenCalled()
  ctx.revoke()
  await ctx.click()
  expect(ctx.resolve).not.toHaveBeenCalled()
})
