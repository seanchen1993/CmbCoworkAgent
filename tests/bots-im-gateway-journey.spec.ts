import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { snapshotBotDeliveryFile } from "../src/main/bots/file-copy"
import type { BotDeliveredFile } from "../src/shared/bots/file-delivery"
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
      imageId?: string
      fileId?: string
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
  let mediaRoot: string | undefined
  let mediaFiles: BotDeliveredFile[] = []
  let rejectedImage: BotDeliveredFile | undefined
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
          if (task.workId && host.getWork(task.botId, task.workId).goal === "media:work")
            return { state: "completed", result: "任务文件已交付", files: mediaFiles }
          if (task.message === "media:direct")
            return { state: "completed", result: "图片和文档已准备", files: mediaFiles }
          if (task.message === "media:upload-failure")
            return { state: "completed", result: "开始交付图片", files: [rejectedImage!] }
          if (task.message === "media:work") {
            await host.createWork(
              {
                botId: task.botId,
                operationId: task.id,
                title: "图片与附件验收",
                goal: "media:work"
              },
              { taskId: task.id, callId: task.id, key: task.id }
            )
            return { state: "completed", result: "已创建文件任务" }
          }
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
    (error) => errors.push(error),
    () => false
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
    if (process.env.BOT_IM_MEDIA_ONLY === "1") {
      assert(client.supportsBotFiles())
      mediaRoot = await mkdtemp(join(tmpdir(), "bot-media-journey-"))
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQb3gLAAJ+AZ1KaAMtAAAAAElFTkSuQmCC",
        "base64"
      )
      const save = async (name: string, bytes: Buffer): Promise<BotDeliveredFile> => {
        const filePath = join(mediaRoot!, name)
        await writeFile(filePath, bytes)
        return {
          name,
          filePath,
          ...(await snapshotBotDeliveryFile(mediaRoot!, filePath, new AbortController().signal))
        }
      }
      // Small, valid Office documents; verify exact retained bytes at the platform boundary.
      const office = (sheet: boolean) => {
        const zip = new AdmZip()
        const main = sheet ? "xl/workbook.xml" : "word/document.xml"
        const type = sheet ? "spreadsheetml.sheet" : "wordprocessingml.document"
        zip.addFile(
          "[Content_Types].xml",
          Buffer.from(
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>${sheet ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ""}</Types>`
          )
        )
        zip.addFile(
          "_rels/.rels",
          Buffer.from(
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`
          )
        )
        zip.addFile(
          main,
          Buffer.from(
            sheet
              ? '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="rId1"/></sheets></workbook>'
              : '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Attachment delivery test</w:t></w:r></w:p></w:body></w:document>'
          )
        )
        if (sheet) {
          zip.addFile(
            "xl/_rels/workbook.xml.rels",
            Buffer.from(
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
            )
          )
          zip.addFile(
            "xl/worksheets/sheet1.xml",
            Buffer.from(
              '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'
            )
          )
        }
        return zip.toBuffer()
      }
      mediaFiles = await Promise.all([
        save("截图.png", png),
        save("报告.docx", office(false)),
        save("统计.xlsx", office(true))
      ])
      rejectedImage = await save("reject-upload.png", png)
      const uploads = async (): Promise<
        Array<{ id: string; name: string; kind: string; size: number; sha256: string }>
      > => (await fetch(base + "/local-bot-platform/uploads")).json()
      const mediaMessages = async () => (await messages()).filter((m) => m.imageId || m.fileId)
      const checkDelivery = async (kind: "dm" | "group", send: () => Promise<void> | void) => {
        const before = (await mediaMessages()).length
        await send()
        await wait(
          async () => (await mediaMessages()).length === before + mediaFiles.length,
          kind + " media delivery"
        )
        const received = (await mediaMessages()).slice(before)
        const resources = await uploads()
        assert.equal(received.filter((m) => m.imageId).length, 1)
        assert.equal(received.filter((m) => m.fileId).length, 2)
        for (const message of received) {
          assert.equal(message.fromId, "local-bot-robot-open")
          assert.equal(
            message.path,
            `/local-bot-platform/robot-service/${kind === "group" ? "group-message" : "single-message"}/${message.imageId ? "image" : "file"}`
          )
          assert.equal(message.groupOpenId, kind === "group" ? "local-group-open" : undefined)
          assert.equal(message.toId, kind === "dm" ? "local-owner-open" : undefined)
          const upload = resources.find(
            (entry) => entry.id === (message.imageId ?? message.fileId)
          )!
          const file = mediaFiles.find((entry) => entry.name === upload.name)!
          assert.equal(upload.size, file.size)
          assert.equal(
            upload.sha256,
            createHash("sha256")
              .update(await readFile(file.attachmentPath!))
              .digest("hex")
          )
          assert.equal(upload.kind, message.imageId ? "image" : "file")
        }
        await new Promise((resolve) => setTimeout(resolve, 2200))
        assert.equal(
          (await mediaMessages()).length,
          before + mediaFiles.length,
          "no duplicate publication"
        )
      }
      await bind("group")
      const duplicate = randomUUID()
      await checkDelivery("group", async () => {
        await post("group", "media:direct", duplicate)
        await post("group", "media:direct", duplicate)
      })
      await checkDelivery("group", () => post("group", "media:work"))
      await bind("dm")
      await checkDelivery("dm", () => post("dm", "media:direct"))
      await checkDelivery("dm", () => post("dm", "media:work"))
      await checkDelivery("dm", () => {
        host.send({ botId: bot.id, requestId: randomUUID(), message: "media:direct" })
      })
      assert.deepEqual(errors, [])
      // Upload rejection must remain visible, with no IMAGE message and no automatic retry.
      const beforeFailure = (await mediaMessages()).length
      await post("group", "media:upload-failure")
      await wait(
        async () =>
          (await messages()).some(
            (m) => m.groupOpenId === "local-group-open" && m.content?.includes("附件未全部发送成功")
          ),
        "upload failure notice"
      )
      assert.equal((await mediaMessages()).length, beforeFailure)
      assert.equal(errors.length, 1)
      assert.equal((errors[0] as { reasonCode?: string }).reasonCode, "IMAGE_UPLOAD_FAILED")
      const delivered = await mediaMessages()
      assert.equal(new Set(delivered.map((m) => m.requestId)).size, delivered.length)
      console.log(
        "PASS: real Java/MySQL/WebSocket/HTTP: native PNG + DOCX/XLSX, direct group/DM, independent group/DM work, App mirror, byte hashes, original audiences, duplicate suppression and upload failure notice"
      )
      return
    }
    if (process.env.BOT_IM_REBIND_ONLY === "1") {
      const original = await bind("dm"),
        group = await bind("group")
      const next = store.create({
        name: "新私聊 Bot",
        instructions: "Reply",
        color: "#123456",
        modelRef: null
      })
      const operationId = randomUUID()
      // Reproduce an older/retried App request with no replacement metadata.
      const pending = await client.botBindingCommand(
        { action: "create", botId: next.id, kind: "dm", label: next.name },
        operationId
      )
      assert(!("items" in pending) && pending.instruction)
      const failuresBefore = (await messages()).filter((m) =>
        m.content.startsWith("绑定未成功")
      ).length
      await post("dm", pending.instruction)
      await wait(
        async () =>
          (await messages()).filter((m) => m.content.startsWith("绑定未成功")).length >
          failuresBefore,
        "real gateway rejects the occupied private route"
      )
      assert.equal(
        (await service.list(next.id)).items.find((b) => b.id === pending.id)?.state,
        "pending"
      )
      // The normal App create API must repair that route without a UI-only flag.
      const retried = await service.create(next.id, "dm", operationId)
      assert.equal(retried.id, pending.id)
      assert(retried.instruction)
      await post("dm", retried.instruction)
      assert.equal(
        (await service.list(next.id)).items.find((b) => b.id === pending.id)?.state,
        "active",
        "new Bot should replace the occupied DM through existing gateway APIs"
      )
      assert.equal(
        (await service.list(bot.id)).items.find((b) => b.id === original.id)?.state,
        "revoked"
      )
      assert.equal(
        (await service.list(bot.id)).items.find((b) => b.id === group.id)?.state,
        "active"
      )
      await post("dm", "replacement bot reply")
      await wait(
        async () => (await messages()).some((m) => m.content === "已处理：replacement bot reply"),
        "new Bot replies through the real callback/WSS route"
      )
      assert.equal(runs.at(-1)?.botId, next.id)
      assert.equal(runs.at(-1)?.threadId, next.threadId)
      await post("group", "original group still works")
      await wait(
        async () =>
          (await messages()).some((m) => m.content === "已处理：original group still works"),
        "existing group retained"
      )
      await post("dm", "legacy after replacement", randomUUID(), "local-owner-open", "legacy")
      await wait(
        async () =>
          (await messages()).some((m) => m.content === "原机器人回复：legacy after replacement"),
        "legacy robot retained"
      )
      assert.deepEqual(errors, [])
      console.log(
        "PASS: unchanged Java gateway rejects an occupied DM; App repairs a stale create retry, new Bot binds and replies, group and legacy robot remain live"
      )
      return
    }
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
      async () => (await messages()).some((m) => m.content === "任务结果：周六下午3点"),
      "group task result"
    )
    assert.equal(host.getWork(bot.id, workId).goal, "周六下午3点")
    await post("group", "revise", randomUUID(), "member-b")
    await wait(
      async () => (await messages()).some((m) => m.content === "任务结果：改为周日下午4点"),
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
    assert.equal(host.listWorks(bot.id).items.length, 0, "group work is absent from private tasks")
    const groupConversationId = runs[0].mockSource!.bindingId
    assert.deepEqual(
      host.imConversationWorks(bot.id, groupConversationId).items.map((work) => work.id),
      [workId]
    )
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
          (m) => m.content === "已回报：任务结果：周六下午3点" && m.toId === "local-owner-open"
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
          (m) => m.content === "已回报：任务结果：改为周日下午4点" && m.toId === "local-owner-open"
        ).length === 1,
      "desktop revises personal task"
    )
    await post("dm", "revise")
    await wait(
      async () =>
        (await messages()).filter(
          (m) => m.content === "已回报：任务结果：改为周日下午4点" && m.toId === "local-owner-open"
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
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
