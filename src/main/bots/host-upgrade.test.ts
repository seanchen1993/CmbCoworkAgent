import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotHost, type BotRuntimePort, type BotRuntimeRequest } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { requestBotHostUpgrade } from "./host-upgrade"
import { botUpgradeAllows } from "./host-build"
import { BotWorkflowStore } from "./workflow-store"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Host lifecycle did not settle")
    await delay(10)
  }
}
async function fixture(runtime?: BotRuntimePort) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-bot-upgrade-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const host = new BotHost(store, runtime)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex")
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\cmb-upgrade-${token}` : join(directory, "s.sock")
  let restarts = 0
  const server = new BotRpcServer(host, token, async () => {
    restarts++
  })
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    hostId: host.id,
    token,
    socketPath,
    pid: process.pid
  })
  cleanup.push(() => client.close())
  return { host, store, client, restarts: () => restarts }
}

it("fences an idle Host before restart ACK and preserves queued work for the next Host", async () => {
  let executions = 0
  const runtime: BotRuntimePort = {
    execute: async () => {
      executions++
      return "done"
    }
  }
  const f = await fixture(runtime)
  const bot = f.store.createBot({ nonce: "bot", name: "B" })
  const receipt = f.store.send({ nonce: "send", conversationId: bot.conversationId, text: "queue" })
  expect(await requestBotHostUpgrade(f.client, await f.client.call("status"), "next-build")).toBe(
    true
  )
  await until(() => f.restarts() === 1)
  f.host.tick()
  expect(executions).toBe(0)
  expect(f.store.getRun(receipt.runIds[0]).status).toBe("queued")
  await expect(f.client.call("snapshot")).rejects.toMatchObject({ code: "host_restarting" })
  const next = new BotHost(f.store, runtime)
  cleanup.push(() => next.stop())
  next.start()
  await until(() => f.store.getRun(receipt.runIds[0]).status === "succeeded")
  expect(executions).toBe(1)
})

it("keeps active work and approval replies available while blocking new work across build versions", async () => {
  let complete!: (value: string) => void
  let running!: BotRuntimeRequest
  const f = await fixture({
    execute: (request) =>
      new Promise((resolve) => {
        running = request
        complete = resolve
      })
  })
  const bot = f.store.createBot({ nonce: "bot", name: "B" })
  const receipt = f.store.send({
    nonce: "send",
    conversationId: bot.conversationId,
    text: "active"
  })
  f.host.start()
  await until(() => Boolean(complete))
  expect(await requestBotHostUpgrade(f.client, await f.client.call("status"), "next-build")).toBe(
    false
  )
  expect(f.restarts()).toBe(0)
  expect((await f.client.call("status")).error).toContain("有待更新")
  await expect(
    f.client.call("send", { nonce: "new", conversationId: bot.conversationId, text: "new" })
  ).rejects.toThrow("有待更新")
  const lease = running.lease
  const action = { routine: { prompt: "完整审批内容".repeat(2000) + "末尾授权范围" } }
  const approval = f.store.requestInteraction(lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action)
  })
  expect((await f.client.call("snapshot")).interactions[0].promptTruncated).toBe(true)
  const details = await f.client.call("interactionDetail", {
    conversationId: bot.conversationId,
    runId: receipt.runIds[0],
    interactionId: approval.id
  })
  expect(details.interaction.prompt).toBe(JSON.stringify(action))
  await expect(
    f.client.call("interactionDetail", {
      conversationId: bot.conversationId,
      runId: "wrong-run",
      interactionId: approval.id
    })
  ).rejects.toThrow()
  await f.client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
  const workflow = BotWorkflowStore.open(f.store, lease, "review", {
    script: 'export const meta={name:"Check",description:"Check"};return 1;',
    maxConcurrency: 1,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: {}
  })
  const child = f.store.workflowChildren.reserve(workflow, lease, {
    prompt: "Child check",
    label: "Check",
    phase: null,
    agentIndex: 1,
    toolStreamKey: "a".repeat(64) + "_c0",
    durableCallKey: "a".repeat(64) + "_n0"
  })
  const address = {
    conversationId: bot.conversationId,
    runId: child.id,
    revision: child.revision,
    nonce: "child-control"
  }
  await expect(
    f.client.call("workflowControl", { ...address, operation: "message", text: "New work" })
  ).rejects.toThrow("有待更新")
  await expect(
    f.client.call("workflowControl", {
      ...address,
      revision: child.revision + 1,
      operation: "cancel"
    })
  ).rejects.toThrow("状态已变化")
  expect((await f.client.call("workflowControl", { ...address, operation: "cancel" })).status).toBe(
    "cancelled"
  )
  complete("done")
  await until(() => f.store.getRun(receipt.runIds[0]).status === "succeeded")
  expect(await requestBotHostUpgrade(f.client, await f.client.call("status"), "next-build")).toBe(
    true
  )
})

it("keeps only inspection and existing-work controls available during an upgrade", () => {
  for (const method of [
    "interactionDetail",
    "provideSecret",
    "computerOpen",
    "computerTake",
    "fileChunk",
    "filePreview",
    "cancelFilePreview",
    "thread",
    "autoReviewSettings"
  ] as const)
    expect(botUpgradeAllows(method)).toBe(true)
  for (const method of [
    "send",
    "create",
    "saveRoutine",
    "emitEvent",
    "runRoutine",
    "saveSecret",
    "recover",
    "changeAutoReview",
    "worktreeMerge"
  ] as const)
    expect(botUpgradeAllows(method)).toBe(false)
  expect(botUpgradeAllows("workflowControl", { operation: "cancel" })).toBe(true)
  expect(botUpgradeAllows("workflowControl", { operation: "message" })).toBe(false)
})

it("rejects stale host identities and keeps legacy hosts available for inspection without force killing", async () => {
  const f = await fixture()
  await expect(f.client.restartIfIdle("another-host")).rejects.toThrow("身份已变化")
  const status = await f.client.call("status")
  expect(await requestBotHostUpgrade(f.client, status, status.buildId)).toBe(false)
  expect(f.client.upgradePending).toBeNull()
  expect(await requestBotHostUpgrade(f.client, { ...status, buildId: undefined })).toBe(false)
  expect(f.client.upgradePending).toContain("不支持平滑升级")
  expect((await f.client.call("snapshot")).bots).toEqual([])
  expect(f.restarts()).toBe(0)
})
