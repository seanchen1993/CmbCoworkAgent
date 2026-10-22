import {
  BotError,
  BOT_AVATAR_SHAPES,
  BOT_REQUEST_RECEIPT_LIMIT,
  type BotRequestCheck,
  type BotAvatarShape,
  type CreateBotInput,
  type SendBotMessageInput,
  type UpdateBotInput,
  type WriteBotMemoryInput,
  type BotScheduleInput,
  type BotGroupInput,
  type BotGroupHistoryCursor,
  type SendBotGroupMessageInput
} from "./contracts"

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BotError("INVALID_INPUT", "请求格式无效")
  }
  return input as Record<string, unknown>
}

function identifiers(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8)
    throw new BotError("INVALID_INPUT", "请选择 1 至 8 个 Bot")
  const result = input.map(botIdentifier)
  if (new Set(result).size !== result.length)
    throw new BotError("INVALID_INPUT", "Bot 成员不能重复")
  return result
}
export function parseGroup(input: unknown): BotGroupInput {
  const item = record(input)
  return { name: boundedString(item.name, "群聊名称", 120), memberIds: identifiers(item.memberIds) }
}
export function parseGroupMessage(input: unknown): SendBotGroupMessageInput {
  const item = record(input)
  const text = boundedString(item.text, "消息", 30_000)
  const leading = (item.text as string).length - (item.text as string).trimStart().length
  const targetBotIds = identifiers(item.targetBotIds)
  let previousEnd = 0
  if (item.mentions !== undefined && (!Array.isArray(item.mentions) || item.mentions.length > 128))
    throw new BotError("INVALID_INPUT", "群提及格式无效")
  const mentions = (item.mentions as unknown[] | undefined)?.map((value) => {
    const mention = record(value)
    const start = Number(mention.start) - leading,
      end = Number(mention.end) - leading
    const label = boundedString(mention.label, "提及名称", 200)
    const botId = mention.botId === null ? null : botIdentifier(mention.botId)
    if (
      !Number.isSafeInteger(mention.start) ||
      !Number.isSafeInteger(mention.end) ||
      start < previousEnd ||
      end <= start ||
      end > text.length ||
      text.slice(start, end) !== `@${label}` ||
      (botId !== null && !targetBotIds.includes(botId))
    )
      throw new BotError("INVALID_INPUT", "群提及与消息或收件人不一致")
    previousEnd = end
    return { start, end, botId, label }
  })
  // Reply authors are resolved from the same-group record by BotStore, never from IPC data.
  if (!item.replyToId && mentions?.length && !mentions.some((mention) => mention.botId === null)) {
    const mentioned = new Set(mentions.map((mention) => mention.botId))
    if (targetBotIds.some((id) => !mentioned.has(id)))
      throw new BotError("INVALID_INPUT", "收件人与已选择的群提及不一致")
  }
  return {
    groupId: botIdentifier(item.groupId),
    requestId: botIdentifier(item.requestId),
    text,
    targetBotIds,
    ...(item.replyToId !== undefined ? { replyToId: botIdentifier(item.replyToId) } : {}),
    ...(mentions?.length ? { mentions } : {})
  }
}
export function parseHistoryCursor(value: unknown): number | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new BotError("INVALID_INPUT", "历史游标无效")
  return Number(value)
}

export function parseGroupHistoryCursor(value: unknown): BotGroupHistoryCursor | undefined {
  if (value == null || typeof value === "number") return parseHistoryCursor(value)
  const item = record(value)
  if (Object.keys(item).length !== 1 || !("targetMessageId" in item))
    throw new BotError("INVALID_INPUT", "历史游标无效")
  return { targetMessageId: botIdentifier(item.targetMessageId) }
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new BotError("INVALID_INPUT", `${label}格式或长度无效`)
  }
  const text = value.trim()
  if (!allowEmpty && !text) throw new BotError("INVALID_INPUT", `${label}不能为空`)
  return text
}

export function botIdentifier(value: unknown): string {
  const id = boundedString(value, "标识", 128)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BotError("INVALID_INPUT", "标识格式无效")
  return id
}

export function parseCreateBot(input: unknown): CreateBotInput {
  const item = record(input)
  const color = boundedString(item.color, "头像颜色", 7)
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new BotError("INVALID_INPUT", "头像颜色无效")
  if (item.shape != null && !BOT_AVATAR_SHAPES.includes(item.shape as BotAvatarShape))
    throw new BotError("INVALID_INPUT", "头像形状无效")
  return {
    name: boundedString(item.name, "名称", 80),
    instructions: boundedString(item.instructions, "职责", 8_000, true),
    modelRef: item.modelRef == null ? null : boundedString(item.modelRef, "模型", 256),
    color,
    ...(item.label !== undefined ? { label: boundedString(item.label, "标签", 80, true) } : {}),
    ...(item.shape != null ? { shape: item.shape as BotAvatarShape } : {})
  }
}

export function parseUpdateBot(input: unknown): UpdateBotInput {
  const item = record(input)
  if (
    !Number.isSafeInteger(item.expectedVersion) ||
    Number(item.expectedVersion) < 1 ||
    typeof item.archived !== "boolean"
  ) {
    throw new BotError("INVALID_INPUT", "Bot 版本或归档状态无效")
  }
  return {
    ...parseCreateBot(item),
    id: botIdentifier(item.id),
    expectedVersion: Number(item.expectedVersion),
    archived: item.archived
  }
}

export function parseSendBotMessage(input: unknown): SendBotMessageInput {
  const item = record(input)
  return {
    botId: botIdentifier(item.botId),
    requestId: botIdentifier(item.requestId),
    message: boundedString(item.message, "消息", 64_000),
    ...(item.workId == null ? {} : { workId: botIdentifier(item.workId) }),
    ...(item.replyToId !== undefined ? { replyToId: botIdentifier(item.replyToId) } : {})
  }
}

export function parseBotRequestChecks(input: unknown): BotRequestCheck[] {
  if (!Array.isArray(input) || input.length > BOT_REQUEST_RECEIPT_LIMIT)
    throw new BotError("INVALID_INPUT", "发送回执查询过多或格式无效")
  const seen = new Set<string>()
  return input.map((value) => {
    const item = record(value)
    const requestId = botIdentifier(item.requestId)
    if (
      seen.has(requestId) ||
      typeof item.messageHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.messageHash)
    )
      throw new BotError("INVALID_INPUT", "发送回执标识重复或摘要无效")
    seen.add(requestId)
    return { requestId, messageHash: item.messageHash }
  })
}

export function memoryVersion(value: unknown): string {
  const version = boundedString(value, "记忆版本", 64)
  if (!/^[a-f0-9]{64}$/.test(version)) throw new BotError("INVALID_INPUT", "记忆版本无效")
  return version
}

export function parseWriteBotMemory(input: unknown): WriteBotMemoryInput {
  const item = record(input)
  return {
    ...(item.id == null
      ? {}
      : { id: botIdentifier(item.id), expectedVersion: memoryVersion(item.expectedVersion) }),
    name: boundedString(item.name, "记忆名称", 120),
    content: boundedString(item.content, "记忆内容", 12_000)
  }
}

export function parseSchedule(input: unknown): BotScheduleInput {
  const item = record(input)
  if (
    !["once", "daily", "weekly", "interval"].includes(String(item.frequency)) ||
    typeof item.enabled !== "boolean"
  )
    throw new BotError("INVALID_INPUT", "定时配置无效")
  const result: BotScheduleInput = {
    name: boundedString(item.name, "任务名称", 120),
    message: boundedString(item.message, "任务内容", 30_000),
    frequency: item.frequency as BotScheduleInput["frequency"],
    enabled: item.enabled
  }
  if (result.frequency === "once") {
    const date = boundedString(item.runAt, "执行时间", 64)
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
      !Number.isFinite(Date.parse(date))
    )
      throw new BotError("INVALID_INPUT", "请指定含时区的执行时间")
    result.runAt = new Date(date).toISOString()
  }
  if (result.frequency === "daily" || result.frequency === "weekly") {
    const time = boundedString(item.runAtTime, "执行时刻", 5)
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new BotError("INVALID_INPUT", "执行时刻无效")
    result.runAtTime = time
  }
  if (result.frequency === "weekly") {
    if (!Number.isInteger(item.weekday) || Number(item.weekday) < 0 || Number(item.weekday) > 6)
      throw new BotError("INVALID_INPUT", "星期无效")
    result.weekday = Number(item.weekday)
  }
  if (result.frequency === "interval") {
    if (
      !Number.isInteger(item.intervalMinutes) ||
      Number(item.intervalMinutes) < 5 ||
      Number(item.intervalMinutes) > 525_600
    )
      throw new BotError("INVALID_INPUT", "间隔须为 5 至 525600 分钟")
    result.intervalMinutes = Number(item.intervalMinutes)
  }
  return result
}

export function parseExistingVersion(input: unknown): { id: string; version: number } | undefined {
  if (input == null) return undefined
  const item = record(input)
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1)
    throw new BotError("INVALID_INPUT", "版本无效")
  return { id: botIdentifier(item.id), version: Number(item.version) }
}

export function parseCreateBotWork(input: unknown): import("./work").CreateBotWorkInput {
  const item = record(input)
  if (
    Object.keys(item).some(
      (key) =>
        !["botId", "operationId", "title", "goal", "contextMessageIds", "workspace"].includes(key)
    )
  )
    throw new BotError("INVALID_INPUT", "工作参数包含不支持字段")
  const ids = item.contextMessageIds
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.length > 12 || new Set(ids).size !== ids.length)
  )
    throw new BotError("INVALID_INPUT", "工作上下文引用无效")
  return {
    botId: botIdentifier(item.botId),
    operationId: botIdentifier(item.operationId),
    title: boundedString(item.title, "工作标题", 160),
    goal: boundedString(item.goal, "工作目标", 30000),
    ...(Array.isArray(ids) ? { contextMessageIds: ids.map(botIdentifier) } : {}),
    ...(item.workspace === undefined ? {} : { workspace: parseBotWorkWorkspace(item.workspace) })
  }
}
export function parseBotWorkWorkspace(input: unknown): import("./work").BotWorkWorkspaceRequest {
  const item = record(input)
  if (item.kind === "directory" && Object.keys(item).every((k) => ["kind", "path"].includes(k))) {
    const path = boundedString(item.path, "工作目录", 4096)
    if (/[\u0000-\u001f]/u.test(path)) throw new BotError("INVALID_INPUT", "工作目录包含无效字符")
    return { kind: "directory", path }
  }
  if (item.kind === "project" && Object.keys(item).every((k) => ["kind", "projectId"].includes(k)))
    return { kind: "project", projectId: boundedString(item.projectId, "项目标识", 512) }
  throw new BotError("INVALID_INPUT", "请选择目录或已有项目作为工作区")
}
export function parseBotWorkLifecycle(input: unknown) {
  const item = record(input)
  if (
    Object.keys(item).some(
      (key) => !["botId", "workId", "expectedVersion", "operationId", "action"].includes(key)
    ) ||
    !["complete", "continue"].includes(String(item.action)) ||
    !Number.isSafeInteger(item.expectedVersion) ||
    Number(item.expectedVersion) < 1
  )
    throw new BotError("INVALID_INPUT", "工作状态操作无效")
  return {
    botId: botIdentifier(item.botId),
    workId: botIdentifier(item.workId),
    operationId: botIdentifier(item.operationId),
    expectedVersion: Number(item.expectedVersion),
    action: item.action as "complete" | "continue"
  }
}
