import { userIdentityKey } from "../../shared/user-identity"
import {
  isMarketSkillShortcutKey,
  type MarketSkillShortcutBinding,
  type MarketSkillShortcutResult,
  type MarketSkillShortcutSelection,
  type MarketSkillShortcutUpdate
} from "../../shared/market-skill-shortcut"
import { getUserInfo } from "../storage"
import { readBoundedResponse } from "./market-source-access"

const ROUTE = "/api/trajectories/marketplace/conversation-shortcuts/project-plugin-creation"
const MAX_BINDING_BYTES = 16 * 1024
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

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

export function parseMarketShortcutBinding(value: unknown): MarketSkillShortcutBinding {
  const data = record(value)
  if (!data || !isMarketSkillShortcutKey(data.revision) || typeof data.canManage !== "boolean") {
    throw new Error("Invalid market shortcut binding")
  }
  const target = record(data.target)
  if (
    data.target !== null &&
    (!target ||
      !isMarketSkillShortcutKey(target.itemId) ||
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.length > 256 ||
      typeof target.description !== "string" ||
      target.description.length > 4_096 ||
      typeof target.skillName !== "string" ||
      !target.skillName.trim() ||
      target.skillName.length > 256)
  ) {
    throw new Error("Invalid market shortcut target")
  }
  const assignedItemId = data.canManage ? data.assignedItemId : null
  if (assignedItemId !== null && !isMarketSkillShortcutKey(assignedItemId)) {
    throw new Error("Invalid market shortcut assignment")
  }
  return {
    revision: data.revision,
    canManage: data.canManage,
    assignedItemId,
    target: target
      ? {
          itemId: target.itemId as string,
          name: (target.name as string).trim(),
          description: target.description as string,
          skillName: (target.skillName as string).trim()
        }
      : null
  }
}

async function fetchShortcut(
  session: MarketShortcutSession,
  route: string,
  init: RequestInit,
  accept: string,
  limit: number
): Promise<{ body: Buffer; headers: Headers }> {
  if (!session.isCurrent()) marketShortcutChanged()
  const base = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("Market base URL is not configured")
  const url = new URL(base + ROUTE + route)
  if (url.protocol !== "https:") throw new Error("Market shortcut requires HTTPS")
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(limit === MAX_PACKAGE_BYTES ? 30_000 : 10_000),
    headers: { ...init.headers, Authorization: `Bearer ${session.accessToken}`, Accept: accept }
  })
  const body = await readBoundedResponse(response, limit)
  if (!session.isCurrent()) marketShortcutChanged()
  if (response.status === 409 || response.status === 412) marketShortcutChanged()
  if (response.status === 401 || response.status === 403) {
    throw new ShortcutRequestError("forbidden", "当前账号没有此操作的权限")
  }
  if (!body) throw new Error("Market shortcut response unavailable")
  return { body, headers: response.headers }
}

export async function getMarketShortcutBinding(
  session = getMarketShortcutSession()
): Promise<MarketSkillShortcutBinding> {
  const { body } = await fetchShortcut(session, "", {}, "application/json", MAX_BINDING_BYTES)
  return parseMarketShortcutBinding(JSON.parse(body.toString("utf8")))
}

export async function updateMarketShortcutBinding(
  input: MarketSkillShortcutUpdate
): Promise<MarketSkillShortcutBinding> {
  if (
    !isMarketSkillShortcutKey(input?.revision) ||
    (input.itemId !== null && !isMarketSkillShortcutKey(input.itemId))
  ) {
    throw new Error("Invalid market shortcut update")
  }
  const { body } = await fetchShortcut(
    getMarketShortcutSession(),
    "",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: input.itemId, revision: input.revision })
    },
    "application/json",
    MAX_BINDING_BYTES
  )
  return parseMarketShortcutBinding(JSON.parse(body.toString("utf8")))
}

export async function verifyMarketShortcutTarget(
  session: MarketShortcutSession,
  selection: MarketSkillShortcutSelection
) {
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
  selection: MarketSkillShortcutSelection
) {
  const query = new URLSearchParams({ itemId: selection.itemId, revision: selection.revision })
  const { body, headers } = await fetchShortcut(
    session,
    `/installation?${query}`,
    {},
    "application/octet-stream",
    MAX_PACKAGE_BYTES
  )
  const format = headers.get("X-Skill-Package-Format")
  if (format !== "zip" && format !== "md") throw new Error("Unsupported skill package")
  return {
    fileName: `market-skill.${format}`,
    buffer: new Uint8Array(body).buffer
  }
}
