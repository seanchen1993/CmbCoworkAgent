import { userIdentityKey } from "../../shared/user-identity"
import {
  isMarketSkillShortcutKey,
  PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT,
  type MarketSkillShortcutBinding,
  type MarketSkillShortcutResult,
  type MarketSkillShortcutSelection,
  type MarketSkillShortcutTarget,
  type MarketSkillShortcutUpdate
} from "../../shared/market-skill-shortcut"
import { getUserInfo } from "../storage"
import { readBoundedResponse } from "./market-source-access"

const MARKET_ROUTE = "/api/trajectories/marketplace"
const SHORTCUT_QUERY = new URLSearchParams({
  conversationShortcut: PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT
})
const MAX_BINDING_BYTES = 16 * 1024
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

type ListedTarget = MarketSkillShortcutTarget & { marketName: string; filename: string }
type ListedBinding = Omit<MarketSkillShortcutBinding, "target"> & { target: ListedTarget | null }

class ShortcutRequestError extends Error {
  constructor(
    readonly code: "changed" | "forbidden" | "unavailable",
    message: string
  ) {
    super(message)
  }
}

export function marketShortcutChanged(): never {
  throw new ShortcutRequestError("changed", "会话导航已更新，请重试")
}

export async function marketShortcutResult<T>(
  action: () => Promise<T>
): Promise<MarketSkillShortcutResult<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    if (error instanceof ShortcutRequestError) {
      return { ok: false, code: error.code, error: error.message }
    }
    return { ok: false, code: "unavailable", error: "暂时无法处理会话导航，请稍后重试" }
  }
}

export function getMarketShortcutSession() {
  const user = getUserInfo()
  const accessToken = user?.ystAccessToken?.trim()
  if (!accessToken) throw new ShortcutRequestError("forbidden", "请登录后使用会话导航")
  const key = userIdentityKey(user)
  const isCurrent = (): boolean => {
    const current = getUserInfo()
    return Boolean(current?.ystAccessToken?.trim()) && userIdentityKey(current) === key
  }
  return { accessToken, isCurrent }
}

export type MarketShortcutSession = ReturnType<typeof getMarketShortcutSession>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isMarketName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !/\p{Cc}/u.test(value)
  )
}

function parseListedTarget(value: unknown, skillNameOverride: unknown): ListedTarget {
  const item = record(value)
  if (
    !item ||
    !isMarketSkillShortcutKey(item.id) ||
    !isMarketName(item.name) ||
    typeof item.description !== "string" ||
    item.description.length > 4_096 ||
    typeof item.filename !== "string" ||
    item.filename.length > 512 ||
    typeof item.extra_json !== "string"
  ) {
    throw new Error("Invalid skill in the market shortcut list")
  }
  const extra = record(JSON.parse(item.extra_json))
  if (extra?.conversationShortcut !== PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT) {
    throw new Error("Skill is missing the market shortcut marker")
  }

  const skillName = skillNameOverride ?? item.name
  if (!isMarketName(skillName)) throw new Error("Invalid skill name in the market shortcut list")
  const label =
    typeof item.chinese_name === "string" && item.chinese_name.length <= 256
      ? item.chinese_name.trim()
      : ""
  return {
    itemId: item.id,
    marketName: item.name,
    filename: item.filename,
    name: label || item.name,
    description: item.description,
    skillName
  }
}

function parseMarketShortcutBinding(value: unknown): ListedBinding {
  const data = record(value)
  const shortcut = record(data?.shortcut)
  if (
    !shortcut ||
    shortcut.slot !== PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT ||
    !isMarketSkillShortcutKey(shortcut.revision) ||
    typeof shortcut.canManage !== "boolean" ||
    !Array.isArray(data?.items) ||
    data.items.length > 1
  ) {
    throw new Error("Market skill list does not support scoped shortcuts")
  }
  const assignedItemId = shortcut.canManage ? shortcut.assignedItemId : null
  if (assignedItemId !== null && !isMarketSkillShortcutKey(assignedItemId)) {
    throw new Error("Invalid market shortcut assignment")
  }
  const target = data.items.length ? parseListedTarget(data.items[0], shortcut.skillName) : null
  if (target && shortcut.canManage && assignedItemId !== target.itemId) {
    throw new Error("Market shortcut assignment does not match the listed skill")
  }
  return { revision: shortcut.revision, canManage: shortcut.canManage, assignedItemId, target }
}

async function requestShortcut(
  session: MarketShortcutSession,
  route: string,
  init: RequestInit,
  accept: string,
  timeout = 10_000
): Promise<Response> {
  if (!session.isCurrent()) marketShortcutChanged()
  const base = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("Market base URL is not configured")
  const url = new URL(base + MARKET_ROUTE + route)
  if (url.protocol !== "https:") throw new Error("Market shortcut requires HTTPS")

  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${session.accessToken}`)
  headers.set("Accept", accept)
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers
  })
  const isCurrent = session.isCurrent()
  if (!response.ok || !isCurrent) await response.body?.cancel().catch(() => undefined)
  if (!isCurrent || response.status === 409 || response.status === 412) marketShortcutChanged()
  if (response.status === 401 || response.status === 403) {
    throw new ShortcutRequestError("forbidden", "当前账号没有此操作的权限")
  }
  if (!response.ok) throw new Error("Market shortcut response unavailable")
  return response
}

export async function getMarketShortcutBinding(
  session = getMarketShortcutSession()
): Promise<ListedBinding> {
  const response = await requestShortcut(
    session,
    `/list/skill?${SHORTCUT_QUERY}`,
    {},
    "application/json"
  )
  const body = await readBoundedResponse(response, MAX_BINDING_BYTES)
  if (!session.isCurrent()) marketShortcutChanged()
  if (!body) throw new Error("Market shortcut list is unavailable")
  return parseMarketShortcutBinding(JSON.parse(body.toString("utf8")))
}

export async function updateMarketShortcutBinding(
  input: MarketSkillShortcutUpdate
): Promise<MarketSkillShortcutBinding> {
  if (
    !isMarketSkillShortcutKey(input?.revision) ||
    !isMarketSkillShortcutKey(input.itemId) ||
    !isMarketName(input.marketName) ||
    typeof input.enabled !== "boolean"
  ) {
    throw new Error("Invalid market shortcut update")
  }
  const session = getMarketShortcutSession()
  // Require the opt-in list protocol before sending a metadata-only write.
  const before = await getMarketShortcutBinding(session)
  if (!before.canManage) {
    throw new ShortcutRequestError("forbidden", "当前账号没有配置会话导航的权限")
  }
  if (
    before.revision !== input.revision ||
    (!input.enabled && before.assignedItemId !== input.itemId)
  ) {
    marketShortcutChanged()
  }

  const body = new FormData()
  body.set("resource_type", "skill")
  body.set("name", input.marketName)
  body.set("item_id", input.itemId)
  body.set("shortcut_revision", input.revision)
  body.set(
    "extra_json",
    JSON.stringify({
      conversationShortcut: input.enabled ? PROJECT_PLUGIN_SKILL_SHORTCUT_SLOT : null
    })
  )
  const response = await requestShortcut(
    session,
    `/skill/${encodeURIComponent(input.marketName)}?${SHORTCUT_QUERY}`,
    { method: "PUT", body },
    "application/json"
  )
  await response.body?.cancel().catch(() => undefined)

  const after = await getMarketShortcutBinding(session)
  if (!after.canManage || after.assignedItemId !== (input.enabled ? input.itemId : null)) {
    marketShortcutChanged()
  }
  return after
}

export async function verifyMarketShortcutTarget(
  session: MarketShortcutSession,
  selection: MarketSkillShortcutSelection
): Promise<ListedTarget> {
  if (
    !isMarketSkillShortcutKey(selection?.itemId) ||
    !isMarketSkillShortcutKey(selection.revision)
  ) {
    throw new Error("Invalid market shortcut selection")
  }
  const binding = await getMarketShortcutBinding(session)
  if (binding.target?.itemId !== selection.itemId || binding.revision !== selection.revision) {
    marketShortcutChanged()
  }
  return binding.target
}

export async function fetchMarketShortcutPackage(
  session: MarketShortcutSession,
  selection: MarketSkillShortcutSelection,
  target: ListedTarget
) {
  const query = new URLSearchParams(SHORTCUT_QUERY)
  query.set("itemId", selection.itemId)
  query.set("shortcutRevision", selection.revision)
  const response = await requestShortcut(
    session,
    `/download/skill/${encodeURIComponent(target.marketName)}?${query}`,
    {},
    "application/octet-stream",
    30_000
  )
  if (response.headers.get("X-Marketplace-Item-Id") !== target.itemId) {
    await response.body?.cancel().catch(() => undefined)
    marketShortcutChanged()
  }

  const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/i)?.[1]
  const format = /\.(zip|md)$/i.exec(filename || target.filename)?.[1]?.toLowerCase()
  if (!format) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("Unsupported skill package")
  }
  const body = await readBoundedResponse(response, MAX_PACKAGE_BYTES)
  if (!session.isCurrent()) marketShortcutChanged()
  if (!body) throw new Error("Market skill package unavailable")
  return { fileName: `market-skill.${format}`, buffer: new Uint8Array(body).buffer }
}
