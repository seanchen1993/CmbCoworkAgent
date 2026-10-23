import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { BotStore } from "../src/main/bots/store"
import { LocalBotHost } from "../src/main/bots/host"
import { ImGatewayWsClient } from "../src/main/services/im/gateway-ws-client"
import { BotImChannelService } from "../src/main/services/im/bot-channel-service"
import type { BotImBinding } from "../src/shared/bots/im-channel"
import type { BotTask } from "../src/shared/bots/contracts"

async function main() {
  const base = process.env.BOT_IM_TEST_GATEWAY_URL
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
    throw new Error(
      "Run this with tools/bot-channel-tests/run-local-journey.py; loopback test gateway required"
    )
  const wait = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20000
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const post = async (
    kind: "dm" | "group",
    text: string,
    id = randomUUID(),
    sender = "local-owner-open",
    robot: "bot" | "legacy" = "bot"
  ) => {
    const response = await fetch(
      base +
        (robot === "bot"
          ? "/api/v1/platform/zhaohu/bot/callback"
          : "/api/v1/platform/zhaohu/callback"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgId: id,
          msgType: kind === "group" ? "at" : "text",
          timestamp: 1780000000000,
          fromId: sender,
          toId: robot === "bot" ? "local-bot-robot-open" : "local-robot-open",
          msgContent: text,
          netWorkStatus: 1,
          ...(kind === "group" ? { groupOpenId: "local-group-open", groupName: "本地验收群" } : {})
        })
      }
    )
    assert.equal(response.status, 200, await response.text())
  }
  const messages = async (): Promise<
    {
      fromId: string
      content: string
      path: string
      groupOpenId?: string
      toId?: string
      requestId: string
    }[]
  > => (await fetch(base + "/local-bot-platform/messages")).json()
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const bot = store.create({
    name: "本地网关验收 Bot",
    instructions: "Reply to text",
    color: "#123456",
    modelRef: null
  })
  const runs: BotTask[] = [],
    errors: unknown[] = [],
    legacy: string[] = []
  let workId = ""
  const host: LocalBotHost = new LocalBotHost(
    store,
    {
      onAvailable: () => () => {},
      acquire: (_bot, task) => ({
        release() {},
        execute: async () => {
          runs.push(task)
          host.mockExecution(task)
          if (task.origin.kind === "work_result")
            return { state: "completed", result: "已回报：" + JSON.parse(task.message).result }
          if (task.workId) return { state: "completed", result: "任务结果：" + task.message }
          const source = { taskId: task.id, callId: task.id, key: task.id }
          if (task.message === "create")
            workId = (
              await host.createWork(
                {
                  botId: task.botId,
                  operationId: task.id,
                  title: "网关读书会通知",
                  goal: "周六下午3点"
                },
                source
              )
            ).work.id
          else if (task.message === "revise") host.sendWork(source, workId, "改为周日下午4点")
          else if (task.message === "complete" || task.message === "continue")
            await host.changeWorkFromTool(
              source,
              workId,
              host.getWork(task.botId, workId).version,
              task.message
            )
          return { state: "completed", result: "已处理：" + task.message }
        }
      })
    },
    2,
    (error) => errors.push(error)
  )
  const client = new ImGatewayWsClient({
    url: () => base.replace("http:", "ws:") + "/ws/desktop",
    token: () => "local-test-identity-only",
    appVersion: "bot-im-journey",
    onBotEvent: (event) => service.receive(event),
    onRemoteEvent: async (event) => {
      legacy.push(event.message.text)
      const ack = { eventId: event.eventId, leaseId: event.lease.id }
      await client.sendAcknowledgement({ ...ack, type: "received" })
      assert.equal((await client.acquireBotPermit(ack)).status, "granted")
      await client.sendAcknowledgement({ ...ack, type: "accepted" })
      await client.submitReply({
        schemaVersion: 1,
        eventId: event.eventId,
        deliveryId: event.eventId,
        conversationKey: event.conversationKey,
        idempotencyKey: event.eventId + ":reply:0",
        segment: { index: 0, count: 1 },
        message: { type: "text", content: "原机器人回复：" + event.message.text }
      })
      await client.sendAcknowledgement({ ...ack, type: "completed" })
    },
    isProactiveRouteConfirmed: (key, principal) => service.isRouteConfirmed(key, principal)
  })
  const service = new BotImChannelService(
    client,
    "local-mysql-verification",
    () => host,
    (error) => errors.push(error)
  )
  const bind = async (kind: "dm" | "group"): Promise<BotImBinding> => {
    const pending = await service.create(bot.id, kind, randomUUID())
    assert(pending.instruction)
    if (kind === "group") {
      await post(kind, pending.instruction, randomUUID(), "not-the-desktop-owner")
      assert.equal(
        (await service.list(bot.id)).items.find((b) => b.id === pending.id)?.state,
        "pending"
      )
    }
    await post(kind, pending.instruction)
    let active: BotImBinding | undefined
    await wait(async () => {
      active = (await service.list(bot.id)).items.find((b) => b.id === pending.id)
      return active?.state === "active"
    }, kind + " binding")
    return active!
  }
  try {
    service.start()
    client.start()
    await wait(() => client.supportsBotChannel(), "authenticated Bot negotiation")
    assert.equal(client.getStatus().principalId, "local-bot-owner")
    const group = await bind("group")
    assert.equal(group.peerLabel, "本地验收群")
    const first = randomUUID()
    await post("group", "create", first, "member-a")
    await post("group", "create", first, "member-a")
    await wait(
      () => runs.length === 2 && store.recentTasks().every((t) => t.state === "completed"),
      "one task despite duplicate delivery"
    )
    await wait(
      async () => (await messages()).some((m) => m.content === "任务结果：create"),
      "group task result"
    )
    assert.equal(host.getWork(bot.id, workId).goal, "周六下午3点")
    await post("group", "revise", randomUUID(), "member-b")
    await wait(
      async () => (await messages()).some((m) => m.content === "任务结果：revise"),
      "revised task result"
    )
    await post("group", "complete")
    await wait(() => host.getWork(bot.id, workId).state === "completed", "completion")
    await post("group", "continue")
    await wait(() => host.getWork(bot.id, workId).state === "active", "continuation")
    await wait(
      () =>
        host.imGateway.active().length === 0 &&
        store.recentTasks().every((t) => t.state === "completed"),
      "event settlement"
    )
    assert.equal(host.listWorks(bot.id).items.length, 1)
    assert.deepEqual(
      runs.filter((t) => t.workId).map((t) => t.workId),
      [workId, workId]
    )
    assert(runs.every((t) => t.mockSource?.transport === "im" && t.threadId !== bot.threadId))
    await wait(
      async () => (await messages()).some((m) => m.content === "已处理：continue"),
      "last group reply"
    )
    const groupMessages = await messages()
    assert(groupMessages.length > 3)
    assert(
      groupMessages.every(
        (m) =>
          m.fromId === "local-bot-robot-open" &&
          m.path.endsWith("/group-message/text") &&
          m.groupOpenId === "local-group-open" &&
          !m.toId
      )
    )
    await service.revoke(bot.id, group.id, group.version)
    const previousRuns = runs.length
    await post("group", "revoked route must not execute")
    const dm = await bind("dm")
    await post("dm", "personal text")
    await wait(
      async () =>
        (await messages()).some(
          (m) =>
            m.fromId === "local-bot-robot-open" &&
            m.content === "已处理：personal text" &&
            m.toId === "local-owner-open"
        ),
      "DM reply"
    )
    assert.equal(runs.length, previousRuns + 1)
    assert.equal(legacy.length, 0)
    assert.equal(runs.at(-1)!.threadId, bot.threadId)
    assert.equal(runs.at(-1)!.mockSource?.personal, true)
    host.send({ botId: bot.id, requestId: randomUUID(), message: "App 主对话回复" })
    await wait(
      async () =>
        (await messages()).some(
          (m) =>
            m.content === "已处理：App 主对话回复" &&
            m.toId === "local-owner-open" &&
            m.fromId === "local-bot-robot-open"
        ),
      "desktop reply mirrored to owner DM"
    )
    await post("dm", "create")
    await wait(
      async () =>
        (await messages()).some(
          (m) => m.content === "已回报：任务结果：create" && m.toId === "local-owner-open"
        ),
      "personal task result through shared main conversation"
    )
    const personalWorkId = workId
    assert.equal(host.getWork(bot.id, personalWorkId).source, undefined)
    assert.equal(host.getWork(bot.id, personalWorkId).parentThreadId, bot.threadId)
    host.send({ botId: bot.id, requestId: randomUUID(), message: "revise" })
    await wait(
      async () =>
        (await messages()).filter(
          (m) => m.content === "已回报：任务结果：revise" && m.toId === "local-owner-open"
        ).length === 1,
      "desktop revises personal task"
    )
    await post("dm", "revise")
    await wait(
      async () =>
        (await messages()).filter(
          (m) => m.content === "已回报：任务结果：revise" && m.toId === "local-owner-open"
        ).length === 2,
      "IM revises the same personal task"
    )
    assert.equal(workId, personalWorkId)
    const personalRuns = runs.filter((t) => t.workId === personalWorkId)
    assert.equal(personalRuns.length, 3)
    assert.equal(new Set(personalRuns.map((t) => t.threadId)).size, 1)
    assert.deepEqual(
      personalRuns.map((t) => Boolean(t.mockSource?.personal)),
      [true, false, true]
    )
    assert.equal(
      (await messages()).filter((m) => m.toId && m.content.startsWith("任务结果：")).length,
      0
    )
    await post("dm", "complete")
    await wait(
      () => host.getWork(bot.id, personalWorkId).state === "completed",
      "DM completes shared task"
    )
    await post("dm", "continue")
    await wait(
      () => host.getWork(bot.id, personalWorkId).state === "active",
      "DM continues shared task"
    )
    await wait(
      () => store.recentTasks().every((t) => t.state === "completed"),
      "personal tasks settled"
    )
    // Both robots remain live on the same desktop connection, including identical platform IDs.
    const sharedId = randomUUID()
    await post("dm", "separate bot work", sharedId)
    await post("dm", "original project work", sharedId, "local-owner-open", "legacy")
    await wait(async () => {
      const replies = await messages()
      return (
        replies.some(
          (m) => m.fromId === "local-bot-robot-open" && m.content === "已处理：separate bot work"
        ) &&
        replies.some(
          (m) =>
            m.fromId === "local-robot-open" && m.content === "原机器人回复：original project work"
        )
      )
    }, "both robot identities reply independently")
    assert.deepEqual(legacy, ["original project work"])
    await service.revoke(bot.id, dm.id, dm.version)
    const runCount = runs.length
    await post("dm", "revoked bot must prompt binding")
    await wait(
      async () =>
        (await messages()).some(
          (m) =>
            m.fromId === "local-bot-robot-open" &&
            m.toId === "local-owner-open" &&
            m.content.includes("尚未连接 Bot")
        ),
      "revoked DM binding hint"
    )
    assert.equal(runs.length, runCount)
    assert.equal(legacy.length, 1)
    await post("dm", "legacy still works", randomUUID(), "local-owner-open", "legacy")
    await wait(
      async () =>
        (await messages()).some(
          (m) => m.fromId === "local-robot-open" && m.content === "原机器人回复：legacy still works"
        ),
      "legacy survives Bot revocation"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS: real Java/MySQL/WSS + beta Host: owner DM/main-thread sharing, desktop reply mirroring, shared task create/revise/complete/continue with one result report, group isolation, duplicate suppression, two robot identities/credentials, same-ID separation, revoke without legacy fallback"
    )
  } catch (error) {
    console.error("Local fixture diagnostics", {
      runs: runs.map((t) => ({ message: t.message, work: Boolean(t.workId) })),
      errors,
      messages: await messages()
    })
    throw error
  } finally {
    service.stop()
    client.stop()
    await host.stop()
    db.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
