import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { BotFeatureTurns } from "./feature-turns"
import type { AgentRunDelivery, AgentRunExecutionContext } from "../agent/agent-run-service"
import { botInteractionRoutes } from "../services/im/bot-interaction-route"
import {
  addFeatureSession,
  bindManagedFeatureSession,
  featureDetail,
  linkExistingFeatureSession,
  publishFeatureRun,
  recoverFeatureOperations,
  startFeatureTurn
} from "./feature-service"
import { LocalBotHost } from "./host"
import { runBotFeatureCommand } from "./feature-command"
import {
  beginHarnessFeatureCatalogRead,
  harnessProjectDeleted,
  onHarnessFeatureCatalogChange
} from "../harness-board/feature-catalog-lifecycle"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"
import { requestUserInput, getPendingUserInputForThread } from "../services/user-input"
import { notificationService } from "../services/notification-service"
import type { AppNotification } from "../../shared/app-notifications"
import type { ApprovalRequest } from "../types"

const io = vi.hoisted(() => ({
  host: vi.fn(),
  thread: vi.fn(),
  featureThreads: vi.fn(),
  page: vi.fn(),
  save: vi.fn(),
  start: vi.fn(),
  pending: vi.fn(),
  active: vi.fn(),
  workflowBusy: vi.fn(),
  approval: vi.fn(),
  snapshot: vi.fn(),
  access: vi.fn(),
  validate: vi.fn(),
  create: vi.fn(),
  dataRoot: vi.fn(),
  grant: vi.fn()
}))
vi.mock("./local-service", () => ({ getLocalBotHost: io.host }))
vi.mock("../storage", () => ({
  isMemoryEnabled: () => false,
  getBuiltinRobotSettings: () => ({ enabled: false })
}))
vi.mock("../db", () => ({
  getDb: vi.fn(),
  saveToDisk: vi.fn(),
  flushStrict: vi.fn(),
  getThread: io.thread,
  getThreadCore: io.thread,
  getFeatureThreadSummaries: io.featureThreads,
  getThreadMessagesPage: io.page,
  upsertThreadMessages: io.save
}))
vi.mock("../harness-board/managed-run-store", () => ({ managedRunStore: { getRun: io.snapshot } }))
vi.mock("../harness-board/service", () => ({
  readHarnessFeatureMetadata: (m: { harnessFeature: unknown }) => m.harnessFeature,
  resolveHarnessFeatureCurrentStage: async () => ({ name: "设计", status: "in_progress" })
}))
vi.mock("../harness-board/human-gate-service", () => ({
  hasPendingHumanGateForThread: () => false
}))
vi.mock("../harness-board/notifications", () => ({
  harnessNotifications: { pending: () => [], get: () => undefined }
}))
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => tmpdir() }
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("../services/notification-channels", () => ({ publishNotificationLifecycle: vi.fn() }))
vi.mock("../services/notification-read-model", () => ({
  invalidateNotificationProjection: vi.fn()
}))
vi.mock("../services/app-notifications", () => {
  const notes = new Map<string, AppNotification>()
  return {
    appNotificationStore: {
      insert: (note: AppNotification) => notes.set(note.notificationId, note),
      get: (id: string) => notes.get(id),
      updatePending: (note: AppNotification) => notes.set(note.notificationId, note)
    }
  }
})
vi.mock("../services/user-input", async (original) => ({
  ...(await original<typeof import("../services/user-input")>()),
  summarizePendingUserInputForRuntimeThread: io.pending
}))
vi.mock("../agent/runtime", () => ({ hasPendingApprovalForRuntimeThread: io.approval }))
vi.mock("../agent/agent-run-service", () => ({
  startAgentRun: io.start,
  hasActiveTopLevelAgentRun: io.active
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: { isBusyForThreadAsync: io.workflowBusy }
}))
vi.mock("../services/im/remote-access-service", () => ({
  imRemoteAccessService: { getThreadGrant: io.grant }
}))
vi.mock("../agent/renderer-stream-mirror", () => ({ notifyRemoteThreadChanged: vi.fn() }))
vi.mock("../app-data-root", async (original) => ({
  ...(await original<typeof import("../app-data-root")>()),
  getCmbCoworkAgentDataRoot: io.dataRoot
}))
vi.mock("../services/im/feature-binding-service", () => ({
  imFeatureBindingService: { validateFeature: io.validate, featureAccess: io.access },
  desktopFeatureCatalog: { validateFeature: io.validate, featureAccess: io.access }
}))
vi.mock("../harness-board/auto-mode-controller", () => ({
  withIdleManagedFeature: (_p: string, _s: string, run: () => unknown) => run()
}))
vi.mock("../services/thread-service", () => ({ createThreadService: io.create }))
vi.mock("./feature-window", () => ({ featureDelivery: () => ({}) }))
vi.mock("../harness-board/auto-mode-action-executor", () => ({
  prepareManagedAgentRun: (
    threadId: string,
    m: { modelMessage: string; userMessageId: string }
  ) => ({ request: { threadId, message: m.modelMessage, userMessageId: m.userMessageId } }),
  startPreparedManagedAgentRun: async (
    p: { request: Parameters<typeof startFeatureTurn>[1] },
    _: unknown,
    op: string
  ) => startFeatureTurn(op, p.request, {} as AgentRunDelivery)
}))

const feature = { projectId: "project", slug: "report", title: "授权报表", projectName: "市场" }
const privateScope = { botId: "bot", audience: "desktop" }
const groupScope = { botId: "bot", audience: "im:group-a" }
const incoming = {
  botId: "bot",
  id: "job",
  threadId: "parent",
  createdAt: 100,
  mockSource: {
    transport: "im",
    audienceKey: groupScope.audience,
    bindingId: "group-a",
    eventId: "event-a"
  }
}
let root: string, db: NativeSqliteAdapter, store: BotStore, host: LocalBotHost
let resolveTurn: () => void = () => {},
  context: AgentRunExecutionContext,
  disconnect: () => void
const notice = vi.fn(),
  files = vi.fn()
const rows = new Map<
  string,
  { thread_id: string; title: string; created_at: number; metadata: string; status?: string }
>()
function child(id: string, runId?: string) {
  rows.set(id, {
    thread_id: id,
    title: id,
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: root,
      harnessFeature: { ...feature, runId },
      cmb_thread_incarnation: "created-" + id
    })
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), "bot-feature-"))
  db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  store = new BotStore(db)
  rows.clear()
  child("parent")
  rows.get("parent")!.metadata = JSON.stringify({ botId: "bot" })
  host = {
    featureStore: store.features,
    featureTasks: LocalBotHost.prototype.featureTasks,
    featureTurns: new BotFeatureTurns(),
    featureChanged: vi.fn(),
    getBot: () => ({ id: "bot", threadId: "parent" }),
    featureTask: () => incoming,
    featureToolTask: () => incoming,
    imChannel: { validateSource: vi.fn(), featureNotice: notice, publishFiles: files },
    imGateway: {
      binding: () => ({
        id: "group-a",
        realm: "test",
        principal: "owner",
        binding: { state: "active", version: 1, kind: "group", conversationKey: "conversation-a" }
      }),
      event: () => ({ payload: { event: { eventId: "event-a" }, route: { senderId: "sender" } } })
    }
  } as unknown as LocalBotHost
  io.host.mockReturnValue(host)
  io.dataRoot.mockReturnValue(root)
  io.thread.mockImplementation((id) => rows.get(id))
  io.featureThreads.mockImplementation((projectId, slug) =>
    [...rows.values()]
      .reverse()
      .filter((row) => {
        const feature = JSON.parse(row.metadata).harnessFeature
        return feature?.projectId === projectId && feature?.slug === slug
      })
      .map((row) => ({
        ...row,
        channelGrantState: io.grant(row.thread_id)?.state ?? null
      }))
  )
  io.access.mockResolvedValue({ valid: true, feature, project: { id: "project", name: "市场" } })
  io.validate.mockResolvedValue({
    valid: true,
    workspacePath: root,
    feature,
    project: { id: "project", name: "市场" }
  })
  io.create.mockImplementation(async () => {
    const id = "child-" + io.create.mock.calls.length
    child(id)
    return { thread_id: id }
  })
  io.active.mockImplementation((id) => !!host.featureTurns.operation(id))
  io.pending.mockReturnValue({ count: 0, questions: [] })
  io.start.mockImplementation(async (request, _delivery, ctx) => {
    context = ctx
    return {
      threadId: request.threadId,
      completion: new Promise<void>((r) => {
        resolveTurn = r
      })
    }
  })
  disconnect = botInteractionRoutes.setTransport(() => true)
})
afterEach(async () => {
  resolveTurn()
  await new Promise<void>((done) => setImmediate(done))
  disconnect()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

it("unlinks deleted Features in every owning conversation, aborts only their turns and retains exclusive history", async () => {
  const featureStore = host.featureStore
  const owners = [privateScope, groupScope, { botId: "other-bot", audience: "im:group-b" }].map(
    (scope) => featureStore.follow(scope, feature)
  )
  const [privateOwner, groupOwner] = owners
  const sibling = featureStore.follow(groupScope, { ...feature, slug: "other" })
  const otherProject = featureStore.follow(groupScope, { ...feature, projectId: "other-project" })
  const otherTurn = host.featureTurns.begin(sibling, "other-thread", "other-op")
  const op = featureStore.begin(groupOwner, "job", "managed", "manage", []).receipt
  featureStore.active(op.id, undefined, "old-run")
  const turn = host.featureTurns.begin(groupOwner, "child-thread", op.id)
  featureStore.addSession(privateOwner, "private-thread", "incarnation")
  const stop = onHarnessFeatureCatalogChange((id, slugs) =>
    LocalBotHost.prototype.reconcileProjectFeatures.call(host, id, slugs)
  )
  try {
    const older = beginHarnessFeatureCatalogRead([feature.projectId])
    const current = beginHarnessFeatureCatalogRead([feature.projectId])
    current.observed(feature.projectId, [sibling])
    current.finish()
    older.observed(feature.projectId, [])
    older.finish()
    expect(
      featureStore
        .list(groupScope)
        .map((it) => it.id)
        .sort()
    ).toEqual([sibling.id, otherProject.id].sort())
    expect(featureStore.list(privateScope)).toEqual([])
    expect(host.featureChanged).toHaveBeenCalledTimes(3)
    for (const owner of owners) {
      expect(() => featureStore.owner(owner.id)).toThrow("未跟进")
      expect(host.featureChanged).toHaveBeenCalledWith(owner, owner)
    }
    expect(turn.signal.aborted).toBe(true)
    expect(otherTurn.signal.aborted).toBe(false)
    expect(featureStore.findReceipt(op.id)).toBeUndefined()
    expect(() => featureStore.addSession(groupOwner, "late", "instance")).toThrow("未跟进")
    expect(() => featureStore.begin(groupOwner, "job", "again", "session", [])).toThrow("未跟进")
    expect(featureStore.sessionClaims(["private-thread"]).get("private-thread")?.followId).toBe(
      privateOwner.id
    )
    publishFeatureRun({ botOperationId: op.id, runId: "old-run" } as Parameters<
      typeof publishFeatureRun
    >[0])
    expect(notice).not.toHaveBeenCalled()
    harnessProjectDeleted(feature.projectId)
    harnessProjectDeleted(feature.projectId)
    expect(otherTurn.signal.aborted).toBe(true)
    expect(featureStore.list(groupScope).map((it) => it.id)).toEqual([otherProject.id])
    expect(host.featureChanged).toHaveBeenCalledTimes(4)
  } finally {
    stop()
    turn.release()
    otherTurn.release()
  }
})

it("does not recreate a follow if deletion wins an in-flight access check", async () => {
  let finish!: () => void
  io.access.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { valid: true, feature, project: { id: feature.projectId, name: feature.projectName } }
  })
  const pending = runBotFeatureCommand(host, "job", { action: "follow", ...feature })
  harnessProjectDeleted(feature.projectId)
  finish()
  await expect(pending).rejects.toThrow("已删除")
  expect(host.featureStore.list(groupScope)).toEqual([])
})

it("creates one native project thread per instruction, sends its questions and attachments to its owner, and continues that thread", async () => {
  const command = {
    action: "session" as const,
    ...feature,
    requestKey: "open",
    message: "核对导出字段"
  }
  const result = await runBotFeatureCommand(host, "job", command)
  expect(result).toMatchObject({
    feature: { sessions: [{ threadId: "child-1", phase: "running" }] }
  })
  expect(io.start.mock.calls[0][0]).toMatchObject({ managedExecution: false })
  expect(context.remotePolicy?.sharedTaskContext).toBe(true)
  expect(context.allowDeferredUserInputRenderer).toBe(true)
  expect(await runBotFeatureCommand(host, "job", command)).toEqual(result)
  expect(io.create).toHaveBeenCalledTimes(1)
  await expect(
    runBotFeatureCommand(host, "job", { ...command, message: "another instruction" })
  ).rejects.toThrow("请求标识")
  const owner = host.featureStore.follow(groupScope, feature)
  io.pending.mockReturnValue({ count: 1, questions: ["请选择字段"] })
  expect(featureDetail(host, owner).sessions[0]).toMatchObject({
    phase: "question",
    questions: ["请选择字段"]
  })
  io.pending.mockReturnValue({ count: 0 })
  io.approval.mockReturnValue(true)
  expect(featureDetail(host, owner).sessions[0].phase).toBe("approval")
  io.approval.mockReturnValue(false)
  expect(botInteractionRoutes.get("child-1")).toMatchObject({
    realm: "test",
    conversationKey: "conversation-a",
    botEventId: "event-a",
    senderId: "sender"
  })
  const file = join(root, "prd.md")
  writeFileSync(file, "approved content")
  const tool = context.additionalTools!.find((t) => t.name === "bot_deliver_files")!
  await tool.invoke({ files: [file] })
  expect(files).toHaveBeenCalledTimes(1)
  const retained = files.mock.calls[0][2][0]
  writeFileSync(file, "rewritten content")
  expect(readFileSync(retained.filePath, "utf8")).toBe("approved content")
  expect(retained.filePath).toContain("mock-group-a")
  expect(io.save.mock.calls.at(-1)?.[0]).toBe("parent")
  expect(io.save.mock.calls.at(-1)?.[1][1].name).toBe("bot_deliver_files")
  await context.onFinalAssistant?.({ messageId: "answer", finalText: "字段已核对" })
  context.onRunTerminated?.({ outcome: "success", code: "normal" })
  resolveTurn()
  await vi.waitFor(() => expect(notice).toHaveBeenCalledTimes(1))
  expect(notice.mock.calls[0][0]).toBe(incoming)
  expect(notice.mock.calls[0][2]).toContain("字段已核对")
  expect(botInteractionRoutes.get("child-1")).toBeNull()
  expect(featureDetail(host, owner).sessions[0].phase).toBe("idle")
  await runBotFeatureCommand(host, "job", {
    action: "continue",
    ...feature,
    requestKey: "resume",
    threadId: "child-1",
    message: "补上日期"
  })
  expect(io.create).toHaveBeenCalledTimes(1)
  expect(io.start).toHaveBeenCalledTimes(2)
  context.onRunTerminated?.({ outcome: "success", code: "normal" })
  resolveTurn()
  await vi.waitFor(() => expect(notice).toHaveBeenCalledTimes(2))
})

it("follows without configuring a workspace and checks current access before a remote history read", async () => {
  io.validate.mockResolvedValue({ valid: false, message: "请先配置会话工作区" })
  await runBotFeatureCommand(host, "job", { action: "follow", ...feature })
  const [follow] = host.featureStore.list(groupScope)
  expect(follow.title).toBe(feature.title)
  expect(io.validate).not.toHaveBeenCalled()
  await expect(
    runBotFeatureCommand(host, "job", {
      action: "session",
      ...feature,
      message: "核对字段",
      requestKey: "open"
    })
  ).rejects.toThrow("工作区")
  expect(io.create).not.toHaveBeenCalled()
  expect(io.start).not.toHaveBeenCalled()
  io.access.mockResolvedValue({ valid: false, message: "远程访问已关闭" })
  await expect(
    runBotFeatureCommand(host, "job", { action: "read", followId: follow.id })
  ).rejects.toThrow("远程访问已关闭")
  expect(io.page).not.toHaveBeenCalled()
})

it("projects persisted Feature links to the exact private and group conversations in the desktop picker", () => {
  const profile = { name: "项目助手", instructions: "", modelRef: null, color: "#168bea" }
  const bot = store.create(profile)
  const group = {
    id: "remote-group",
    botId: bot.id,
    kind: "group" as const,
    state: "active" as const,
    label: "绑定",
    peerLabel: "项目群",
    conversationKey: "room",
    version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  }
  const route = store.imGateway.register("realm", "owner", group)
  store.im.importImBinding({ ...group, id: route.id, channelKey: group.conversationKey })
  store.features.follow({ botId: bot.id, audience: "desktop" }, feature)
  store.features.follow({ botId: bot.id, audience: "im:" + route.id }, feature)
  expect(store.features.targets(feature)).toMatchObject([
    { linked: true, groupId: route.id, label: "项目群", botId: bot.id },
    { linked: true, label: bot.name, botId: bot.id }
  ])
  expect(store.features.targets({ ...feature, projectId: "other" }).every((t) => !t.linked)).toBe(
    true
  )
  expect(store.features.targets({ ...feature, slug: "other" }).every((t) => !t.linked)).toBe(true)
  store.imGateway.register("realm", "owner", { ...group, peerLabel: "新群名" })
  expect(store.features.targets(feature)[0].label).toBe("新群名")
  store.im.revoke(bot.id, route.id, 1)
  expect(store.features.targets(feature).filter((t) => t.groupId)).toEqual([])
  store.imGateway.register("realm", "owner", { ...group, state: "revoked", version: 2 })
  // The gateway gives a rebound group a new binding AND conversation key.
  const rebound = { ...group, id: "replacement", conversationKey: "room-2" }
  const newRoute = store.imGateway.register("realm", "owner", rebound)
  store.im.importImBinding({ ...rebound, id: newRoute.id, channelKey: rebound.conversationKey })
  const newScope = { botId: bot.id, audience: "im:" + newRoute.id }
  expect(store.features.targets(feature).filter((t) => t.groupId)).toMatchObject([
    { groupId: newRoute.id, linked: false }
  ])
  const first = store.features.follow(newScope, feature)
  expect(store.features.follow(newScope, feature).id).toBe(first.id)
  const otherGroup = { ...group, id: "different-room", conversationKey: "room-3" }
  const otherRoute = store.imGateway.register("realm", "owner", otherGroup)
  store.im.importImBinding({ ...otherGroup, id: otherRoute.id, channelKey: otherGroup.conversationKey })
  expect(store.features.targets(feature).filter((t) => t.groupId)).toMatchObject([
    { groupId: newRoute.id, label: "项目群", linked: true },
    { groupId: otherRoute.id, label: "项目群", linked: false }
  ])
  expect(store.features.list({ botId: bot.id, audience: "im:" + route.id })).toHaveLength(1)
  expect(store.features.list(newScope)).toHaveLength(1)
  store.update({ ...bot, expectedVersion: bot.version, archived: true })
  expect(store.features.targets()).toEqual([])
  expect(store.features.targets(feature).map((t) => t.unavailable)).toEqual(["archived", "archived"])
})

it("reuses the same group task for concurrent Bot follow requests and desktop retries", async () => {
  const follow = () => runBotFeatureCommand(host, "job", { action: "follow", ...feature })
  const requests = [follow(), follow()]
  const owner = store.features.follow(groupScope, feature)
  await expect(Promise.all(requests)).resolves.toMatchObject([{ id: owner.id }, { id: owner.id }])
  store.features.lifecycle(owner, "complete", 1)
  await follow()
  expect(store.features.taskRows(groupScope)).toMatchObject([
    { id: owner.id, state: "completed", version: 2 }
  ])
})

it("keeps two groups and private follows separate even when they follow the same Feature", async () => {
  const own = host.featureStore.follow(groupScope, feature)
  const other = host.featureStore.follow({ ...groupScope, audience: "im:group-b" }, feature)
  expect(host.featureStore.list(privateScope)).toEqual([])
  expect(host.featureStore.follow(groupScope, feature).id).toBe(own.id)
  child("shared")
  await linkExistingFeatureSession(host, own, "shared")
  await expect(linkExistingFeatureSession(host, other, "shared")).rejects.toThrow("其他对话")
  await expect(
    runBotFeatureCommand(host, "job", { action: "read", followId: other.id, threadId: "shared" })
  ).rejects.toThrow("当前对话")
  expect(featureDetail(host, other).sessions).toEqual([])
  io.page.mockReturnValue({
    messages: [
      { role: "assistant", content: "<think>private</think>approved" },
      { role: "tool", content: "secret" }
    ]
  })
  expect(
    await runBotFeatureCommand(host, "job", {
      action: "read",
      followId: own.id,
      threadId: "shared"
    })
  ).toMatchObject({ history: [{ role: "assistant", text: "approved" }] })
  rows.get("shared")!.status = "error"
  expect(featureDetail(host, own).sessions[0].phase).toBe("failed")
  rows.get("shared")!.status = "interrupted"
  expect(featureDetail(host, own).sessions[0].phase).toBe("interrupted")
  io.grant.mockReturnValue({ state: "active" })
  expect(featureDetail(host, own).sessions[0].phase).toBe("unavailable")
  io.grant.mockReturnValue(null)
  rows.get("shared")!.created_at++
  expect(featureDetail(host, own).sessions[0].phase).toBe("unavailable")
})

it("discovers native sessions before and after following, and reserves a session only when a Bot continues it", async () => {
  child("prior-review")
  const owner = host.featureStore.follow(groupScope, feature)
  const personal = host.featureStore.follow(privateScope, feature)
  child("new-review")
  child("foreign-managed", "another-run")
  child("remote-grant")
  child("revoked-grant")
  child("remote-origin")
  const remote = rows.get("remote-origin")!
  remote.metadata = JSON.stringify({ ...JSON.parse(remote.metadata), remoteThread: true })
  const grants: Record<string, string> = { "remote-grant": "suspended", "revoked-grant": "revoked" }
  io.grant.mockImplementation((id: string) => (grants[id] ? { state: grants[id] } : null))
  child("another-feature")
  rows.get("another-feature")!.metadata = JSON.stringify({
    harnessFeature: { projectId: "unrelated", slug: feature.slug },
    workspacePath: root
  })
  io.page.mockReturnValue({ messages: [{ role: "user", content: "验收范围" }] })
  const read = (threadId: string) =>
    runBotFeatureCommand(host, "job", { action: "read", followId: owner.id, threadId })
  for (const threadId of ["prior-review", "new-review"]) {
    expect(await read(threadId)).toMatchObject({ history: [{ text: "验收范围" }] })
    expect(featureDetail(host, personal).sessions.map((s) => s.threadId)).toContain(threadId)
  }
  for (const threadId of [
    "another-feature",
    "foreign-managed",
    "remote-grant",
    "revoked-grant",
    "remote-origin",
    "parent"
  ])
    await expect(read(threadId)).rejects.toThrow()
  expect(io.page).toHaveBeenCalledTimes(2)
  const resume = {
    action: "continue" as const,
    ...feature,
    threadId: "prior-review",
    message: "补充验收标准"
  }
  io.active.mockReturnValueOnce(true)
  await expect(
    runBotFeatureCommand(host, "job", { ...resume, requestKey: "busy" })
  ).rejects.toThrow("仍在运行")
  io.workflowBusy.mockResolvedValueOnce(true)
  await expect(
    runBotFeatureCommand(host, "job", { ...resume, requestKey: "workflow-busy" })
  ).rejects.toThrow("等待后台任务")
  io.validate
    .mockResolvedValueOnce({ valid: true, workspacePath: root, feature, project: { name: "市场" } })
    .mockResolvedValueOnce({ valid: false, message: "工作区已失效" })
  await expect(
    runBotFeatureCommand(host, "job", { ...resume, requestKey: "workspace-changed" })
  ).rejects.toThrow("工作区已失效")
  expect(host.featureStore.sessions(owner.id)).toEqual([])
  await runBotFeatureCommand(host, "job", { ...resume, requestKey: "continue" })
  expect(io.start.mock.calls[0][0].threadId).toBe("prior-review")
  expect(featureDetail(host, personal).sessions.map((s) => s.threadId)).toEqual(["new-review"])
  context.onRunTerminated?.({ outcome: "success", code: "normal" })
  resolveTurn()
  await vi.waitFor(() => expect(host.featureTurns.activity(owner.id)).toBeUndefined())
  host.featureStore.deleteScope(owner.botId, owner.audience)
  expect(featureDetail(host, personal).sessions.map((s) => s.threadId)).toEqual(["new-review"])
})

it("tracks new stage sessions under one owned managed run, distinguishes stopping progression from interrupting an owned turn", async () => {
  const owner = host.featureStore.follow(groupScope, feature)
  const other = host.featureStore.follow(privateScope, feature)
  const op = host.featureStore.begin(owner, "job", "start", "manage", []).receipt
  host.featureStore.active(op.id, undefined, "run")
  const identity = { projectId: feature.projectId, featureId: feature.slug, runId: "run" }
  for (const nodeId of ["design", "build"]) {
    child(nodeId, "run")
    bindManagedFeatureSession({ ...identity, nodeId }, nodeId, op.id)
  }
  const run = {
    ...identity,
    botOperationId: op.id,
    status: "running",
    decisionBaseline: { nodeId: "build" },
    currentSession: { threadId: "build" }
  }
  io.snapshot.mockImplementation(() => ({ snapshot: run }))
  expect(featureDetail(host, owner)).toMatchObject({
    run: { nodeId: "build", currentThreadId: "build" },
    sessions: [{ threadId: "build" }, { threadId: "design" }]
  })
  expect(featureDetail(host, other).run).toBeUndefined()
  await startFeatureTurn(
    op.id,
    { threadId: "build", message: "推进", userMessageId: "stage-two" },
    {} as AgentRunDelivery
  )
  const stopped = { ...run, status: "cancelled" } as Parameters<typeof publishFeatureRun>[0]
  publishFeatureRun(stopped)
  publishFeatureRun(stopped)
  expect(notice).toHaveBeenCalledTimes(1)
  expect(context.signal?.aborted).toBe(false)
  expect(host.featureTurns.interrupt(other.id, "build")).toBe(false)
  expect(host.featureTurns.interrupt(owner.id, "build")).toBe(true)
  expect(context.signal?.aborted).toBe(true)
  context.onRunCancelled?.()
  resolveTurn()
  await vi.waitFor(() => expect(host.featureTurns.operation("build")).toBeUndefined())
  expect(host.featureTurns.interrupt(owner.id, "build")).toBe(false)
})

it("rejects a revoked origin before recording a user message or starting the project stream", async () => {
  const owner = host.featureStore.follow(groupScope, feature)
  child("project-chat")
  addFeatureSession(host, owner, "project-chat")
  const op = host.featureStore.begin(owner, "job", "later", "session", []).receipt
  host.featureStore.active(op.id, "project-chat")
  io.validate.mockImplementationOnce(async () => {
    vi.mocked(host.imChannel.validateSource).mockImplementation(() => {
      throw new Error("已解绑")
    })
    return { valid: true }
  })
  const startStream = vi.fn()
  await expect(
    startFeatureTurn(
      op.id,
      { threadId: "project-chat", message: "继续", userMessageId: "late" },
      {} as AgentRunDelivery,
      undefined,
      startStream
    )
  ).rejects.toThrow("已解绑")
  expect(startStream).not.toHaveBeenCalled()
  expect(io.start).not.toHaveBeenCalled()
  expect(botInteractionRoutes.get("project-chat")).toBeNull()
})

it("recovers interrupted submissions without replay and fails closed after the original group revokes access", () => {
  const owner = host.featureStore.follow(groupScope, feature)
  child("project-chat")
  addFeatureSession(host, owner, "project-chat")
  const op = host.featureStore.begin(owner, "job", "new", "session", []).receipt
  host.featureStore.active(op.id, "project-chat")
  recoverFeatureOperations(host, host.featureStore.unfinished())
  expect(notice).toHaveBeenCalledTimes(1)
  expect(host.featureStore.receipt(op.id).state).toBe("failed")
  expect(io.start).not.toHaveBeenCalled()
  const next = host.featureStore.begin(owner, "job", "again", "continue", []).receipt
  host.featureStore.active(next.id, "project-chat")
  vi.mocked(host.imChannel.validateSource).mockImplementation(() => {
    throw new Error("已解绑")
  })
  recoverFeatureOperations(host, host.featureStore.unfinished())
  expect(notice).toHaveBeenCalledTimes(1)
  expect(host.featureStore.receipt(next.id).error).toBe("已解绑")
})

it.each([true, false])(
  "resumes the originating project runtime after a real group question, card accepted=%s",
  async (accepted) => {
    const { ImRemoteUserInputService, imRemoteUserInputService } =
      await import("../services/im/remote-user-input-service")
    imRemoteUserInputService.dispose()
    const publish = vi.fn(async () => (accepted ? { interactionId: "card-a" } : null))
    const enqueue = vi.fn(async () => [])
    const service = new ImRemoteUserInputService({
      conversations: { getReplyMode: () => "card" } as never,
      getSettings: () => ({ enabled: true }) as never,
      cards: {
        publish,
        interactions: { findByRequestRef: () => null },
        resolveDetached() {}
      } as never,
      events: { enqueueProactiveReplies: enqueue } as never,
      createCode: () => "AABB01"
    })
    const owner = host.featureStore.follow(groupScope, feature)
    try {
      await runBotFeatureCommand(host, "job", {
        action: "session",
        ...feature,
        requestKey: "ask",
        message: "核对导出范围"
      })
      const runtimeId = accepted ? "child-1" : "child-1__worker"
      const wait = requestUserInput({
        threadId: runtimeId,
        allowDeferredRenderer: context.allowDeferredUserInputRenderer,
        abortSignal: context.signal,
        questions: [
          {
            id: "scope",
            header: "导出范围",
            question: "报表需要包含哪些记录？",
            options: [
              { label: "仅有效记录", description: "排除已失效记录" },
              { label: "全部记录", description: "包括历史记录" }
            ]
          }
        ]
      })
      await vi.waitFor(() =>
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: "child-1",
            kind: "user_input",
            botEventId: "event-a",
            conversationKey: "conversation-a"
          })
        )
      )
      expect(host.featureTurns.activity(owner.id)).toEqual({
        phase: "question",
        threadId: "child-1"
      })
      expect(featureDetail(host, owner)).toMatchObject({
        phase: "question",
        sessions: [{ phase: "question" }]
      })
      const id = getPendingUserInputForThread(runtimeId)!.requestId
      const submit = (conversationKey: string) =>
        accepted
          ? service.resolveCardAnswers({
              principalId: "owner",
              conversationKey,
              requestId: id,
              feedback: [{ key: "q0", value: "0" }]
            })
          : service.resolveAnswer({
              principalId: "owner",
              conversationKey,
              botSenderId: "other-group-member",
              argument: "AABB01 1"
            })
      expect(await submit("conversation-b")).toContain("不属于")
      expect(getPendingUserInputForThread(runtimeId)?.requestId).toBe(id)
      if (!accepted) await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1))
      expect(await submit("conversation-a")).toContain("任务将继续")
      expect((await wait).answers.scope).toMatchObject({ type: "option", label: "仅有效记录" })
      expect(host.featureTurns.activity(owner.id)?.phase).toBe("running")
      expect(await submit("conversation-a")).not.toContain("任务将继续")
      expect(notice).not.toHaveBeenCalled()
      await context.onFinalAssistant?.({ messageId: "done", finalText: "按有效记录继续生成报表。" })
      context.onRunTerminated?.({ outcome: "success", code: "normal" })
      resolveTurn()
      await vi.waitFor(() =>
        expect(notice).toHaveBeenCalledWith(
          incoming,
          expect.any(String),
          expect.stringContaining("按有效记录")
        )
      )
      expect(host.featureTurns.activity(owner.id)).toBeUndefined()
    } finally {
      service.dispose()
    }
  }
)

it.each(["disconnect", "outbox", "revoke"])(
  "handles %s while publishing a project question without losing its audience",
  async (failure) => {
    const { ImRemoteUserInputService } = await import("../services/im/remote-user-input-service")
    let finishPublish!: (result: null) => void
    const warn = vi.fn()
    const publish = vi.fn(
      () =>
        new Promise<null>((done) => {
          finishPublish = done
        })
    )
    const enqueue = vi.fn(async () => {
      throw new Error("outbox unavailable")
    })
    const service = new ImRemoteUserInputService({
      getSettings: () => ({ enabled: true }) as never,
      cards: { publish, interactions: { findByRequestRef: () => null } } as never,
      events: { enqueueProactiveReplies: enqueue } as never,
      warn
    })
    const controller = new AbortController()
    try {
      await runBotFeatureCommand(host, "job", {
        action: "session",
        ...feature,
        requestKey: "check-notice",
        message: "核对范围"
      })
      const waiting = requestUserInput({
        threadId: "child-1",
        allowDeferredRenderer: true,
        abortSignal: controller.signal,
        questions: [
          {
            id: "scope",
            header: "范围",
            question: "是否包含历史记录？",
            options: [
              { label: "包含", description: "包括历史记录" },
              { label: "跳过", description: "仅当前记录" }
            ]
          }
        ]
      }).catch(() => {})
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
      if (failure === "disconnect") disconnect()
      if (failure === "revoke") vi.spyOn(host.imGateway, "binding").mockReturnValue(null)
      finishPublish(null)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(getPendingUserInputForThread("child-1")).not.toBeNull()
      expect(enqueue).toHaveBeenCalledTimes(failure === "outbox" ? 1 : 0)
      expect(notice).toHaveBeenCalledTimes(failure === "revoke" ? 0 : 1)
      if (failure !== "revoke")
        expect(notice).toHaveBeenCalledWith(
          incoming,
          expect.any(String),
          expect.stringContaining("等你回答")
        )
      controller.abort()
      await waiting
    } finally {
      controller.abort()
      service.dispose()
    }
  }
)

it("discards an expired project decision after a restart while keeping its native run", () => {
  const owner = host.featureStore.follow(groupScope, feature)
  const op = host.featureStore.begin(owner, "job", "restart", "manage", {}).receipt
  host.featureStore.active(op.id, undefined, "restored-run")
  host.featureStore.setDecision(op, "expired-note", "stage", true)
  io.snapshot.mockReturnValue({
    snapshot: { runId: "restored-run", botOperationId: op.id, status: "running" }
  })
  recoverFeatureOperations(host, host.featureStore.unfinished())
  expect(host.featureStore.taskRows(groupScope)[0].phase).toBe("managed")
  expect(notice).not.toHaveBeenCalled()
})

it("notifies only the requesting group of local approval and tracks native managed decisions across stage turns", async () => {
  const owner = host.featureStore.follow(groupScope, feature)
  const op = host.featureStore.begin(owner, "job", "managed", "manage", {}).receipt
  host.featureStore.active(op.id, undefined, "owned-run")
  child("stage", "owned-run")
  bindManagedFeatureSession(
    { projectId: "project", featureId: "report", runId: "owned-run", nodeId: "prd" },
    "stage",
    op.id
  )
  await startFeatureTurn(
    op.id,
    { threadId: "stage", message: "生成报表", userMessageId: "turn" } as never,
    {} as AgentRunDelivery
  )
  const resolve = vi.fn()
  const approve = (id: string, runtimeThreadId: string) =>
    approvalDecisionBroker.register({
      threadId: runtimeThreadId,
      runtimeThreadId,
      request: {
        id,
        tool_call: { id: "call" },
        command: "sensitive local arguments"
      } as ApprovalRequest,
      resolve
    })
  try {
    approve("other", "stage-other")
    expect(notice).not.toHaveBeenCalled()
    approve("owned", "stage__executor")
    expect(notice).toHaveBeenCalledTimes(1)
    expect(featureDetail(host, owner)).toMatchObject({
      phase: "approval",
      sessions: [{ phase: "approval" }]
    })
    expect(notice.mock.calls[0][0]).toBe(incoming)
    expect(notice.mock.calls[0][2]).toContain("等待本机操作审批")
    expect(notice.mock.calls[0][2]).not.toContain("sensitive")
    expect(host.featureTurns.activity(owner.id)?.phase).toBe("approval")
    expect(
      approvalDecisionBroker.decide({
        source: { kind: "desktop", webContentsId: 1 },
        requestId: "owned",
        decision: { type: "approve", tool_call_id: "call" }
      }).accepted
    ).toBe(true)
    approvalDecisionBroker.unregister("owned")
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(host.featureTurns.activity(owner.id)?.phase).toBe("running")
    for (const type of ["human_gate", "biz_retry"]) {
      const value = notificationService.create({
        kind: "decision",
        type,
        title: "阶段确认",
        message: "请确认本阶段输出",
        targets: ["app_view", "im"],
        payload: {
          projectId: "project",
          featureId: "report",
          sourceThreadId: "stage",
          runId: "owned-run"
        }
      })
      if (type === "biz_retry") {
        expect(notice.mock.calls.at(-1)?.[0]).toBe(incoming)
        expect(notice.mock.calls.at(-1)?.[2]).toContain("请在 App 的项目模式中处理")
      } else {
        expect(botInteractionRoutes.get("stage")?.featureGate?.slug).toBe(feature.slug)
        expect(notice).toHaveBeenCalledTimes(1)
      }
      expect(host.featureStore.taskRows(groupScope)[0]).toMatchObject({
        phase: "decision",
        attentionThreadId: "stage"
      })
      notificationService.finish(value.notificationId, {
        status: "resolved",
        channel: "desktop",
        reasonCode: "confirmed",
        result: "通过"
      })
      expect(host.featureStore.taskRows(groupScope)[0].phase).toBe("managed")
      if (type === "human_gate") {
        context.onRunTerminated?.({ outcome: "success", code: "normal" })
        resolveTurn()
        await vi.waitFor(() => expect(host.featureTurns.activity(owner.id)).toBeUndefined())
      }
    }
    expect(host.featureStore.taskRows({ ...groupScope, audience: "im:other" })).toEqual([])
  } finally {
    approvalDecisionBroker.unregister("owned")
    approvalDecisionBroker.unregister("other")
  }
})
