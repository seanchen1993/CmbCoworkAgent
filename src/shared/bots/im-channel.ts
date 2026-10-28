import { assertRemoteImEventV1, type RemoteImEventV1 } from "../im-gateway-contract"

/** Negotiated separately from the existing personal IM/project protocol. */
export const BOT_IM_EXTENSION = "bot-channel-v1"
export interface BotImRoute {
  bindingId: string
  botId: string
  kind: "dm" | "group"
  label: string
  version: number
  senderId: string
}
export interface BotImEvent {
  event: RemoteImEventV1
  route: BotImRoute
}
export interface BotImBinding {
  id: string
  botId: string
  kind: "dm" | "group"
  label: string
  version: number
  state: "pending" | "active" | "revoked" | "expired"
  conversationKey: string | null
  expiresAt: string
  createdAt: string
  instruction?: string
  peerLabel?: string
}
export type BotImCommand =
  | { action: "create"; botId: string; kind: "dm" | "group"; label: string }
  | { action: "list"; botId: string; before?: string }
  | { action: "revoke"; bindingId: string; expectedVersion: number }
export interface BotImBindingPage {
  items: BotImBinding[]
  before: string | null
}

/** Local read model only: no gateway credentials or private account identifiers. */
export interface BotImConversation {
  id: string
  botId: string
  bindingId: string
  /** Native execution thread, present after the first admitted group message. */
  threadId?: string
  title: string
  state: "active" | "revoked"
  connected: boolean
  activity: import("./contracts").BotConversationActivity
}

function object(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("IM Bot 数据格式无效")
  const data = value as Record<string, unknown>
  if (
    required.some((key) => !(key in data)) ||
    Object.keys(data).some((key) => ![...required, ...optional].includes(key))
  )
    throw new Error("IM Bot 数据字段不匹配")
  return data
}
/** Opaque gateway identifiers; local Bot and filesystem IDs use their own stricter validator. */
export function botImExternalId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value))
    throw new Error("IM Bot 标识无效")
  return value
}
function common(data: Record<string, unknown>): void {
  botImExternalId(data.botId)
  if (data.kind !== "dm" && data.kind !== "group") throw new Error("IM Bot 受众无效")
  if (typeof data.label !== "string" || !data.label.trim() || data.label.length > 100)
    throw new Error("IM Bot 名称无效")
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 1)
    throw new Error("IM Bot 授权版本无效")
}
export function assertBotImEvent(value: unknown): asserts value is BotImEvent {
  const payload = object(value, ["event", "route"])
  assertRemoteImEventV1(payload.event)
  const route = object(payload.route, [
    "bindingId",
    "botId",
    "kind",
    "label",
    "version",
    "senderId"
  ])
  common(route)
  botImExternalId(route.bindingId)
  botImExternalId(route.senderId)
}
export function assertBotImBinding(value: unknown): asserts value is BotImBinding {
  const binding = object(
    value,
    [
      "id",
      "botId",
      "kind",
      "label",
      "version",
      "state",
      "conversationKey",
      "expiresAt",
      "createdAt"
    ],
    ["instruction", "peerLabel"]
  )
  common(binding)
  botImExternalId(binding.id)
  if (
    binding.peerLabel !== undefined &&
    (typeof binding.peerLabel !== "string" ||
      !binding.peerLabel.trim() ||
      binding.peerLabel.length > 100)
  )
    throw new Error("IM 会话名称无效")
  if (!["pending", "active", "revoked", "expired"].includes(String(binding.state)))
    throw new Error("IM Bot 绑定状态无效")
  for (const key of ["createdAt", "expiresAt"]) {
    if (typeof binding[key] !== "string" || !Number.isFinite(Date.parse(binding[key])))
      throw new Error("IM Bot 时间无效")
  }
  if (binding.conversationKey !== null) botImExternalId(binding.conversationKey)
  if (binding.state === "active" && !binding.conversationKey) throw new Error("IM Bot 路由缺失")
  if (
    binding.instruction !== undefined &&
    (binding.state !== "pending" ||
      typeof binding.instruction !== "string" ||
      !/^\/绑定Bot [A-Za-z0-9_-]{24}$/.test(binding.instruction))
  )
    throw new Error("IM Bot 绑定指令无效")
}
export function assertBotImBindingResult(
  value: unknown
): asserts value is BotImBinding | BotImBindingPage {
  if (value && typeof value === "object" && "items" in value) {
    const page = object(value, ["items", "before"])
    if (!Array.isArray(page.items) || page.items.length > 40) throw new Error("IM Bot 分页无效")
    page.items.forEach(assertBotImBinding)
    if (
      page.before !== null &&
      (typeof page.before !== "string" || !/^[1-9]\d{0,18}$/.test(page.before))
    )
      throw new Error("IM Bot 游标无效")
  } else assertBotImBinding(value)
}

export interface BotImClient {
  stopConversation(botId: string, conversationId: string): Promise<void>
  conversationWorks?(
    botId: string,
    conversationId: string,
    cursor?: string,
    query?: string
  ): Promise<import("./work").BotWorkPage>
  /** Local retained group history remains readable while disconnected or revoked. */
  conversationHistory?(
    botId: string,
    conversationId: string,
    before?: string
  ): Promise<{ items: import("./mock-channel").BotMockFeedEntry[]; before: string | null }>
  history(
    botId: string,
    bindingId: string,
    before?: string
  ): Promise<{ items: import("./mock-channel").BotMockFeedEntry[]; before: string | null }>
  status(): Promise<{ connected: boolean; available: boolean }>
  list(botId: string, before?: string): Promise<BotImBindingPage>
  create(botId: string, kind: "dm" | "group", operationId: string): Promise<BotImBinding>
  revoke(botId: string, bindingId: string, version: number): Promise<BotImBinding>
  /** Remove an inactive record from this device's configuration list, retaining history. */
  remove(botId: string, bindingId: string): Promise<void>
}

/** Local binding ID scopes pages to one IM audience; never use the platform group ID. */
export function botImBrowserScope(bindingId: string, botId: string): string {
  return `im-${bindingId}--${botId}`
}
