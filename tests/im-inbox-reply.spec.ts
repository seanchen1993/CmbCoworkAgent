import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImInboxService, IM_MANAGED_INBOX_DIRECTORY } from "../src/main/services/im/inbox-service"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import {
  imFeatureReplyPrefix,
  imInboxReplyPrefix,
  imProjectModeReplyPrefix,
  imThreadReplyPrefix
} from "../src/main/services/im/reply-context"
import {
  IM_REPLY_TRUNCATION_NOTICE,
  buildImEventReplies,
  buildImProactiveReplies,
  eventShortCode,
  segmentImMarkdownText,
  segmentImReplyText
} from "../src/main/services/im/reply-segmentation"
import {
  assertRemoteImReplyV1,
  IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS,
  type RemoteImReplyV1
} from "../src/shared/im-gateway-contract"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import { getEventReporter, setEventReporter } from "../src/main/services/event-reporter"
import type { ImGatewayClientPort } from "../src/main/services/im/gateway-client"
import type { ImEventStore, ImReplyOutboxRecord } from "../src/main/services/im/event-store"

async function testManagedInboxCreationAndReuse(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-inbox-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => Date.parse("2026-07-23T08:00:00.000Z")
  }
  const conversations = new ImConversationStateStore(dependencies)
  await conversations.ensureConversation({
    conversationKey: "conversation/private/value",
    principalId: "principal-1"
  })
  const threads = new Map<string, ThreadRow>()
  let id = 0
  const service = new ImInboxService({
    conversationState: conversations,
    openworkDirectory: () => root,
    createId: () => `generated-${++id}`,
    createThread: (threadId, metadata) => {
      const row: ThreadRow = {
        thread_id: threadId,
        created_at: Date.now(),
        updated_at: Date.now(),
        metadata: JSON.stringify(metadata),
        status: "idle",
        thread_values: null,
        title: typeof metadata?.title === "string" ? metadata.title : null
      }
      threads.set(threadId, row)
      return row
    },
    getThread: (threadId) => threads.get(threadId) ?? null,
    ensureDirectory: async () => undefined
  })

  try {
    const first = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.equal(first.kind, "inbox")
    const realRoot = await realpath(root)
    assert(first.workspacePath.startsWith(join(realRoot, IM_MANAGED_INBOX_DIRECTORY)))
    assert(!first.workspacePath.includes("conversation/private/value"))
    const metadata = JSON.parse(threads.get(first.threadId)!.metadata!) as Record<string, unknown>
    assert.equal(metadata.targetKind, "inbox")
    assert.equal(metadata.remoteReadOnly, true)
    assert.equal(metadata.memoryEnabled, false)
    assert.deepEqual(metadata.imDeliveryContext, {
      provider: "zhaohu",
      principalId: "principal-1",
      conversationKey: "conversation/private/value",
      targetId: first.targetId
    })

    const second = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.deepEqual(second, first)
    assert.equal(threads.size, 1)

    threads.delete(first.threadId)
    const repaired = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.notEqual(repaired.targetId, first.targetId)
    assert.notEqual(repaired.threadId, first.threadId)
    assert.equal(threads.size, 1)
    assert.deepEqual(conversations.getActiveTarget("conversation/private/value"), repaired)
    const inboxStates = conversations
      .listTargets("conversation/private/value")
      .filter(({ snapshot }) => snapshot.kind === "inbox")
      .map(({ state, suspendReason }) => ({ state, suspendReason }))
    assert.deepEqual(inboxStates, [
      { state: "suspended", suspendReason: "INBOX_THREAD_MISSING" },
      { state: "active", suspendReason: null }
    ])
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}

function testReplySegmentationAndStableEnvelope(): void {
  const emojiText = "😀".repeat(2_799)
  const emojiSegments = segmentImReplyText(emojiText)
  assert(emojiSegments.length > 1)
  assert.equal(
    emojiSegments.map((segment) => segment.replace(/^\[\d\/\d\] /u, "")).join(""),
    emojiText
  )
  assert(emojiSegments.every((segment) => segment.length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS))

  const prefixed = segmentImReplyText("甲".repeat(7_000), { prefix: "【项目 / 功能】" })
  assert(prefixed.length > 1)
  for (const [index, segment] of prefixed.entries()) {
    const expectedStart =
      index === 0
        ? `【项目 / 功能】\n[1/${prefixed.length}] `
        : `[${index + 1}/${prefixed.length}] `
    assert(segment.startsWith(expectedStart))
    if (index > 0) assert(!segment.includes("【项目 / 功能】"))
    assert(Array.from(segment).length <= 2_800)
  }

  const truncated = segmentImReplyText("长".repeat(40_000))
  assert.equal(truncated.length, 8)
  assert(truncated[7].includes(IM_REPLY_TRUNCATION_NOTICE))
  assert(truncated.every((segment) => Array.from(segment).length <= 2_800))

  const event = {
    eventId: "event-stable-id",
    conversationKey: "conversation-1"
  }
  const first = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  const replay = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  assert.deepEqual(replay, first)
  assert.equal(first[0].segment.index, 0)
  assert(first.every((reply) => reply.segment.count === first.length))
  for (const reply of buildImEventReplies({ event, text: emojiText })) {
    assertRemoteImReplyV1(reply)
  }
  assert.throws(
    () =>
      assertRemoteImReplyV1({
        ...first[0],
        message: { type: "text", content: "😀".repeat(2_000) }
      }),
    /UTF-16/u
  )
  const uniqueSupplementary = Array.from({ length: 2_000 }, (_unused, index) =>
    String.fromCodePoint(0x1f300 + index)
  ).join("")
  const singleOverflow = segmentImReplyText(uniqueSupplementary, {
    maxSegments: 1,
    singleSegmentOverflow: { minimumHeadCharacters: 300, minimumTailCharacters: 300 }
  })[0]
  const [head, tail] = singleOverflow.split(`\n\n${IM_REPLY_TRUNCATION_NOTICE}\n\n`)
  assert(head && tail)
  assert(uniqueSupplementary.startsWith(head))
  assert(uniqueSupplementary.endsWith(tail))
  assert(Array.from(head).length + Array.from(tail).length < 2_000)
  assert(singleOverflow.length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS)
  assert.equal(eventShortCode("event-stable-id"), eventShortCode("event-stable-id"))
  assert.match(eventShortCode("event-stable-id"), /^[A-F0-9]{8}$/)

  assert.equal(imInboxReplyPrefix(), "【远程收件箱】")
  assert.equal(imThreadReplyPrefix("  接口   排障  "), "【会话：接口 排障】")
  assert.equal(
    imFeatureReplyPrefix({
      projectName: "支付平台",
      projectId: "project-pay",
      featureTitle: "快捷支付",
      featureSlug: "quick-pay",
      threadTitle: "验收会话",
      switched: true
    }),
    "【Feature：支付平台 / 快捷支付｜会话：验收会话】（非当前绑定会话）"
  )
  assert.equal(
    imProjectModeReplyPrefix({
      projectName: "支付平台",
      featureName: "快捷支付",
      nodeName: "Dev-代码实现",
      nodeStatus: "进行中"
    }),
    [
      "【项目模式会话返回】",
      "项目：【支付平台】",
      "特性：【快捷支付】",
      "当前阶段：Dev-代码实现",
      "阶段状态：进行中",
      // f80fb47b 把模型正文和这段抬头分开：末尾的空串是那一行分隔空行，
      // 少了它正文会直接贴在「阶段状态」后面。
      "模型返回：",
      ""
    ].join("\n")
  )
}

function fenceLines(segment: string): number {
  return segment.split("\n").filter((line) => /^ {0,3}(```|~~~)/u.test(line)).length
}

/**
 * Every Markdown segment becomes a card of its own, so each has to render
 * alone: the header in paragraphs of its own, and no code fence left open
 * across a cut. The same content goes out unconverted as text, so none of this
 * may rely on it being rendered.
 */
function testMarkdownSegmentsRenderOnTheirOwn(): void {
  assert.deepEqual(segmentImMarkdownText("# 标题\n\n正文", { prefix: "【远程收件箱】" }), [
    "【远程收件箱】\n\n# 标题\n\n正文"
  ])
  const projectPrefix = imProjectModeReplyPrefix({
    projectName: "支付平台",
    featureName: "快捷支付",
    nodeName: "Dev-代码实现",
    nodeStatus: "进行中"
  })
  assert.equal(
    segmentImMarkdownText("答复", { prefix: projectPrefix })[0],
    "【项目模式会话返回】\n\n项目：【支付平台】\n\n特性：【快捷支付】\n\n当前阶段：Dev-代码实现\n\n阶段状态：进行中\n\n模型返回：\n\n答复"
  )

  // The cut prefers the paragraph break, and the marker stays off the heading.
  const sections = segmentImMarkdownText(
    `${"甲".repeat(2_000)}\n\n# 第二部分\n${"乙".repeat(2_000)}`
  )
  assert.equal(sections.length, 2)
  assert(sections[1].startsWith("[2/2]\n\n# 第二部分\n"), sections[1].slice(0, 40))

  const code = Array.from({ length: 400 }, (_unused, index) => `print("第 ${index} 行")`)
  const source = `开头\n\n\`\`\`python\n${code.join("\n")}\n\`\`\`\n\n结尾`
  const withCode = segmentImMarkdownText(source, { prefix: "【会话：排障】" })
  assert(withCode.length > 1)
  for (const [index, segment] of withCode.entries()) {
    assert(Array.from(segment).length <= 2_800, `segment ${index} is over the limit`)
    assert.equal(fenceLines(segment) % 2, 0, `segment ${index} leaves a code fence open`)
  }
  assert(
    withCode[1].startsWith(`[2/${withCode.length}]\n\n\`\`\`python\n`),
    `the next segment reopens the fence with its info string: ${withCode[1].slice(0, 40)}`
  )
  const joined = withCode.join("\n")
  for (const line of code) {
    assert.equal(joined.split(line).length - 1, 1, `${line} must appear exactly once`)
  }
  assert(withCode.at(-1)!.endsWith("结尾"))
  // A replay must match the durable outbox byte for byte.
  assert.deepEqual(segmentImMarkdownText(source, { prefix: "【会话：排障】" }), withCode)

  const tableRows = Array.from(
    { length: 350 },
    (_unused, index) => `| row${index} | ${"值".repeat(8)} |`
  )
  const tableHeader = "| 名称 | 内容 |\n| --- | --- |\n"
  const tableSegments = segmentImMarkdownText(`${tableHeader}${tableRows.join("\n")}`)
  assert(tableSegments.length > 1)
  for (const segment of tableSegments) {
    assert.match(segment, /^\[\d\/\d\]\n\n\| 名称 \| 内容 \|\n\| --- \| --- \|\n/u)
    assert(segment.length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS)
  }
  const joinedTable = tableSegments.join("\n")
  for (const row of tableRows) {
    assert.equal(joinedTable.split(row).length - 1, 1, `table row must remain whole: ${row}`)
  }

  const emojiMarkdown = segmentImMarkdownText("😀".repeat(2_000))
  assert(emojiMarkdown.length > 1)
  assert.equal(
    emojiMarkdown.map((segment) => segment.replace(/^\[\d\/\d\]\n\n/u, "")).join(""),
    "😀".repeat(2_000)
  )
  assert(emojiMarkdown.every((segment) => segment.length <= IM_REPLY_MAX_SEGMENT_UTF16_CHARACTERS))

  const endless = segmentImMarkdownText(`\`\`\`\n${"代码\n".repeat(20_000)}\`\`\``)
  assert.equal(endless.length, 8)
  assert(
    endless[7].endsWith(`\`\`\`\n\n${IM_REPLY_TRUNCATION_NOTICE}`),
    `the notice follows the closed fence: ${endless[7].slice(-60)}`
  )
  assert(
    endless.every((segment) => Array.from(segment).length <= 2_800 && fenceLines(segment) % 2 === 0)
  )

  const event = { eventId: "event-markdown", conversationKey: "conversation-1" }
  assert.equal(
    buildImEventReplies({ event, text: "**完成**", format: "markdown" })[0].message.type,
    "markdown"
  )
  assert.equal(buildImEventReplies({ event, text: "完成" })[0].message.type, "text")
  assert.throws(
    () =>
      buildImProactiveReplies({
        deliveryId: "delivery-overflow",
        conversationKey: "conversation-1",
        text: "长".repeat(4_000),
        format: "markdown",
        segmentation: {
          maxSegments: 1,
          singleSegmentOverflow: { minimumHeadCharacters: 300, minimumTailCharacters: 300 }
        }
      }),
    /only defined for text replies/u
  )
}

/**
 * Markdown leaves as markdown only on a connection that agreed to it, and only
 * for a conversation not in /文字模式; the reply mode is not even read when the
 * gateway could not take it. A markdown segment refused as a payload goes out
 * again at once as text under the same key — any other refusal stays refused.
 */
async function testMarkdownGoesOutOnlyWhereAgreedAndWanted(): Promise<void> {
  const run = async (options: {
    supportsMarkdown?: boolean
    textMode?: boolean
    refuseMarkdownWith?: string
  }) => {
    const records: ImReplyOutboxRecord[] = (["markdown", "text"] as const).map((contentFormat) => ({
      outboxId: `outbox-${contentFormat}`,
      deliveryId: `delivery-${contentFormat}`,
      eventId: null,
      conversationKey: "conversation-1",
      idempotencyKey: `delivery-${contentFormat}:reply:0`,
      segmentIndex: 0,
      segmentCount: 1,
      content: "## 结论",
      contentFormat,
      state: "pending",
      platformReplyId: null,
      attemptCount: 0,
      nextAttemptAt: null,
      reasonCode: null,
      createdAt: 1,
      updatedAt: 1
    }))
    const find = (outboxId: string): ImReplyOutboxRecord =>
      records.find((record) => record.outboxId === outboxId)!
    const submitted: Array<{ key: string; type: string }> = []
    const modeReads: string[] = []
    const gateway = {
      submitReply: async (reply: RemoteImReplyV1) => {
        submitted.push({ key: reply.idempotencyKey, type: reply.message.type })
        if (reply.message.type === "markdown" && options.refuseMarkdownWith) {
          throw Object.assign(new Error("refused"), {
            reasonCode: options.refuseMarkdownWith,
            permanent: true
          })
        }
        return { state: "accepted" as const, platformReplyId: `platform-${reply.idempotencyKey}` }
      },
      ...(options.supportsMarkdown === undefined
        ? {}
        : { supportsMarkdownReplies: () => options.supportsMarkdown === true })
    } as unknown as ImGatewayClientPort
    const eventStore = {
      listOutbox: () => records.filter((record) => record.state === "pending"),
      markOutboxSending: async (outboxId: string) => {
        find(outboxId).state = "sending"
        return find(outboxId)
      },
      markOutboxSent: async (outboxId: string) => {
        find(outboxId).state = "sent"
        return find(outboxId)
      },
      markOutboxFailed: async (outboxId: string, reasonCode: string) => {
        find(outboxId).state = "failed"
        find(outboxId).reasonCode = reasonCode
        return find(outboxId)
      }
    } as unknown as ImEventStore
    const client = new ImReplyClient(
      gateway,
      eventStore,
      () => 0,
      (conversationKey) => {
        modeReads.push(conversationKey)
        return options.textMode === true
      }
    )
    await client.sendPending()
    return { submitted, modeReads, records }
  }
  const types = (entries: Array<{ type: string }>): string[] => entries.map((entry) => entry.type)

  const agreed = await run({ supportsMarkdown: true })
  assert.deepEqual(types(agreed.submitted), ["markdown", "text"])

  const released = await run({})
  assert.deepEqual(types(released.submitted), ["text", "text"])
  assert.deepEqual(released.modeReads, [], "no reply mode is read for a gateway without markdown")

  const declined = await run({ supportsMarkdown: false })
  assert.deepEqual(types(declined.submitted), ["text", "text"])

  const textMode = await run({ supportsMarkdown: true, textMode: true })
  assert.deepEqual(types(textMode.submitted), ["text", "text"])
  assert.deepEqual(textMode.modeReads, ["conversation-1"], "read once, for the markdown reply only")

  const refused = await run({ supportsMarkdown: true, refuseMarkdownWith: "INVALID_PAYLOAD" })
  assert.deepEqual(refused.submitted.slice(0, 2), [
    { key: "delivery-markdown:reply:0", type: "markdown" },
    { key: "delivery-markdown:reply:0", type: "text" }
  ])
  assert.equal(refused.records[0].state, "sent", "the answer still arrives, as text")

  const forbidden = await run({ supportsMarkdown: true, refuseMarkdownWith: "PRINCIPAL_MISMATCH" })
  assert.deepEqual(forbidden.submitted.slice(0, 1), [
    { key: "delivery-markdown:reply:0", type: "markdown" }
  ])
  assert.equal(
    forbidden.submitted.filter((entry) => entry.key === "delivery-markdown:reply:0").length,
    1,
    "any other refusal is not retried as text"
  )
  assert.equal(forbidden.records[0].state, "failed")
}

async function testConcurrentOutboxDrainUsesSingleSender(): Promise<void> {
  const record: ImReplyOutboxRecord = {
    outboxId: "outbox-1",
    deliveryId: "delivery-1",
    eventId: "event-1",
    conversationKey: "conversation-1",
    idempotencyKey: "delivery-1:reply:0",
    segmentIndex: 0,
    segmentCount: 1,
    content: "done",
    state: "pending",
    platformReplyId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    reasonCode: null,
    createdAt: 1,
    updatedAt: 1
  }
  let submitCount = 0
  let releaseSubmit: () => void = () => undefined
  const submitGate = new Promise<void>((resolve) => {
    releaseSubmit = resolve
  })
  const gateway = {
    submitReply: async () => {
      submitCount += 1
      await submitGate
      return { state: "accepted" as const, platformReplyId: "platform-1" }
    }
  } as ImGatewayClientPort
  const eventStore = {
    listOutbox: (state?: string) =>
      (!state || state === "pending") && record.state === "pending" ? [record] : [],
    markOutboxSending: async () => {
      record.state = "sending"
      record.attemptCount += 1
      return record
    },
    markOutboxSent: async () => {
      record.state = "sent"
      return record
    }
  } as unknown as ImEventStore
  const firstClient = new ImReplyClient(gateway, eventStore)
  const secondClient = new ImReplyClient(gateway, eventStore)
  const first = firstClient.sendPending()
  const second = secondClient.sendPending()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(submitCount, 1)
  releaseSubmit()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.deepEqual(secondResult, firstResult)
  assert.equal(record.attemptCount, 1)
}

async function testSegmentDeliveryStopsBehindUnconfirmedPredecessor(): Promise<void> {
  const records: ImReplyOutboxRecord[] = [0, 1].map((segmentIndex) => ({
    outboxId: `outbox-${segmentIndex}`,
    deliveryId: "delivery-ordered",
    eventId: "event-ordered",
    conversationKey: "conversation-1",
    idempotencyKey: `delivery-ordered:reply:${segmentIndex}`,
    segmentIndex,
    segmentCount: 2,
    content: `segment-${segmentIndex}`,
    state: "pending",
    platformReplyId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    reasonCode: null,
    createdAt: 1,
    updatedAt: 1
  }))
  let now = 1
  let failFirstAttempt = true
  const submitted: number[] = []
  const gateway = {
    submitReply: async (reply: { segment: { index: number } }) => {
      submitted.push(reply.segment.index)
      if (failFirstAttempt) {
        failFirstAttempt = false
        throw new Error("transient")
      }
      return { state: "accepted" as const, platformReplyId: `platform-${reply.segment.index}` }
    }
  } as ImGatewayClientPort
  const eventStore = {
    listOutbox: () => records,
    markOutboxSending: async (outboxId: string) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "sending"
      record.attemptCount += 1
      return record
    },
    markOutboxSent: async (outboxId: string) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "sent"
      return record
    },
    rescheduleOutbox: async (outboxId: string, nextAttemptAt: number) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "pending"
      record.nextAttemptAt = nextAttemptAt
      return record
    }
  } as unknown as ImEventStore
  const client = new ImReplyClient(gateway, eventStore, () => now)

  assert.deepEqual(await client.sendPending(), {
    sent: 0,
    unknown: 0,
    failed: 0,
    deferred: 1
  })
  assert.deepEqual(submitted, [0], "segment 1 must stay blocked while segment 0 is unconfirmed")

  now = 5_000
  assert.deepEqual(await client.sendPending(), {
    sent: 2,
    unknown: 0,
    failed: 0,
    deferred: 0
  })
  assert.deepEqual(submitted, [0, 0, 1])
}

/**
 * The dashboard counts outbound messages from here, and two things about that
 * are easy to get wrong: a retry is the same message coming back, and "who the
 * message is for" is already recorded on the envelope.
 */
async function testOutboundDeliveryIsCountedOncePerMessage(): Promise<void> {
  const reported: Record<string, unknown>[] = []
  const previousReporter = getEventReporter()
  setEventReporter({
    report: async (event) => {
      if (event.eventName === "im.message.delivered") reported.push({ ...event.properties })
      return { ok: true } as never
    }
  })
  try {
    const outcomes: Array<"accepted" | "retryable"> = ["retryable", "retryable", "accepted"]
    const record: ImReplyOutboxRecord = {
      outboxId: "outbox-count",
      deliveryId: "delivery-count",
      // A reply to an inbound event. A proactive push is inserted with a null
      // event id, which is what the instrumentation reads to tell them apart.
      eventId: "event-1",
      conversationKey: "conversation/private/value",
      idempotencyKey: "idem-count",
      segmentIndex: 0,
      segmentCount: 1,
      content: "done",
      state: "pending",
      platformReplyId: null,
      attemptCount: 0,
      nextAttemptAt: null,
      reasonCode: null,
      createdAt: 1,
      updatedAt: 1
    }
    const gateway = {
      submitReply: async () => {
        const next = outcomes.shift()
        if (next === "accepted") return { state: "accepted" as const, platformReplyId: "p-1" }
        throw Object.assign(new Error("transient"), { reasonCode: "GATEWAY_UNAVAILABLE" })
      }
    } as ImGatewayClientPort
    const eventStore = {
      listOutbox: () => (record.state === "pending" ? [record] : []),
      markOutboxSending: async () => {
        record.state = "sending"
        record.attemptCount += 1
        return record
      },
      markOutboxSent: async () => {
        record.state = "sent"
        return record
      },
      rescheduleOutbox: async () => {
        record.state = "pending"
        return record
      }
    } as unknown as ImEventStore

    const client = new ImReplyClient(gateway, eventStore, () => 0)
    await client.sendPending()
    await client.sendPending()
    await client.sendPending()

    assert.equal(record.attemptCount, 3, "the message really was submitted three times")
    assert.deepEqual(
      reported,
      [{ direction: "outbound", kind: "reply", outcome: "sent" }],
      "one message must be counted once — the two retries are the same message coming " +
        `back, not three messages sent; got ${JSON.stringify(reported)}`
    )
  } finally {
    setEventReporter(previousReporter)
  }
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["testOutboundDeliveryIsCountedOncePerMessage", testOutboundDeliveryIsCountedOncePerMessage],
  ["testManagedInboxCreationAndReuse", testManagedInboxCreationAndReuse],
  ["testReplySegmentationAndStableEnvelope", testReplySegmentationAndStableEnvelope],
  ["testMarkdownSegmentsRenderOnTheirOwn", testMarkdownSegmentsRenderOnTheirOwn],
  ["testMarkdownGoesOutOnlyWhereAgreedAndWanted", testMarkdownGoesOutOnlyWhereAgreedAndWanted],
  ["testConcurrentOutboxDrainUsesSingleSender", testConcurrentOutboxDrainUsesSingleSender],
  [
    "testSegmentDeliveryStopsBehindUnconfirmedPredecessor",
    testSegmentDeliveryStopsBehindUnconfirmedPredecessor
  ]
]

async function main(): Promise<void> {
  for (const [name, test] of tests) {
    await test()
    console.log(`PASS ${name}`)
  }
  console.log("im-inbox-reply.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
