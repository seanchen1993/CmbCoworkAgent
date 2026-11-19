import { createHash } from "node:crypto"
import {
  canCurrentUserViewMarketItem,
  buildUploaderIdCandidates
} from "../../shared/market-item-visibility"
import { getMarketSourceAccess, type MarketSourceAccess } from "../../shared/market-source-access"
import { marketSkillUrl, readMarketSkillCatalog } from "./market-skill-catalog"
import { userIdentityKey } from "../../shared/user-identity"
import {
  isMarketSkillShortcutKey,
  parseMarketSkillShortcutConfig,
  type MarketSkillShortcutBinding,
  type MarketSkillShortcutResult,
  type MarketSkillShortcutSelection,
  type MarketSkillShortcutTarget
} from "../../shared/market-skill-shortcut"
import { getUserInfo } from "../storage"
import { resolveUpdateSource } from "../updater/channel-config"
import { fetchLatestJson } from "../updater/checker"
import { readBoundedResponse } from "./market-source-access"

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const EMPTY_BINDING = { revision: "unavailable", target: null } as const

type ListedTarget = MarketSkillShortcutTarget & {
  filename: string
  sha256?: string
  sourceAccess?: MarketSourceAccess
}
type ListedBinding = Omit<MarketSkillShortcutBinding, "target"> & { target: ListedTarget | null }

class MarketShortcutError extends Error {
  constructor(
    readonly code: "changed" | "unavailable",
    message: string
  ) {
    super(message)
  }
}

export function marketShortcutChanged(): never {
  throw new MarketShortcutError("changed", "会话导航已更新，请重试")
}

export async function marketShortcutResult<T>(
  action: () => Promise<T>
): Promise<MarketSkillShortcutResult<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return error instanceof MarketShortcutError
      ? { ok: false, code: error.code, error: error.message }
      : { ok: false, code: "unavailable", error: "暂时无法处理会话导航，请稍后重试" }
  }
}

export function getMarketShortcutSession() {
  const user = getUserInfo()
  const key = userIdentityKey(user)
  return { user, isCurrent: () => userIdentityKey(getUserInfo()) === key }
}

type MarketShortcutSession = ReturnType<typeof getMarketShortcutSession>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function loadPublishedShortcut() {
  const source = resolveUpdateSource(import.meta.env.VITE_UPDATE_SERVER_URL ?? "")
  if (!source.baseUrl) return null
  const manifest = await fetchLatestJson(source.baseUrl, source.manifestFile)
  return parseMarketSkillShortcutConfig(manifest.conversationShortcuts?.projectPluginCreation)
}

export async function getMarketShortcutBinding(
  session = getMarketShortcutSession()
): Promise<ListedBinding> {
  const config = await loadPublishedShortcut()
  if (!session.isCurrent()) marketShortcutChanged()
  if (!config) return EMPTY_BINDING

  const items = (await readMarketSkillCatalog()).map(record)
  if (!session.isCurrent()) marketShortcutChanged()
  const byId = items.filter((item) => item?.id === config.itemId)
  const item = byId[0]
  if (byId.length !== 1 || !item || item.name !== config.marketName) return EMPTY_BINDING
  // The legacy download addresses a name. A pinned hash can verify bytes when
  // that name is ambiguous in the catalog.
  const uniqueName = items.filter((row) => row?.name === config.marketName).length === 1
  if (!config.sha256 && !uniqueName) return EMPTY_BINDING

  const marketIdentity = {
    user_id: typeof item.user_id === "string" ? item.user_id : undefined,
    extra_json: typeof item.extra_json === "string" ? item.extra_json : undefined
  }
  const ids = [session.user?.sapId, session.user?.ystId].flatMap(buildUploaderIdCandidates)
  if (!canCurrentUserViewMarketItem(marketIdentity, session.user?.sapId, ids, session.user?.pathName)) {
    return EMPTY_BINDING
  }

  const sourceAccess = uniqueName ? getMarketSourceAccess(marketIdentity, session.user) : undefined
  const filename = typeof item.filename === "string" ? item.filename : ""
  const label = typeof item.chinese_name === "string" ? item.chinese_name.trim().slice(0, 256) : ""
  const revision = createHash("sha256")
    .update(JSON.stringify([config, filename, item.version, item.updated_at, sourceAccess]))
    .digest("hex")
  return {
    revision,
    target: {
      itemId: config.itemId,
      marketName: config.marketName,
      filename,
      name: label || config.marketName,
      description: typeof item.description === "string" ? item.description.slice(0, 4_096) : "",
      skillName: config.skillName ?? config.marketName,
      sha256: config.sha256,
      sourceAccess
    }
  }
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
  target: ListedTarget
) {
  if (!session.isCurrent()) marketShortcutChanged()
  const response = await fetch(
    marketSkillUrl(`/download/skill/${encodeURIComponent(target.marketName)}`),
    {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: "Bearer your-api-token" }
    }
  )
  const body = await readBoundedResponse(response, MAX_PACKAGE_BYTES)
  if (!session.isCurrent()) marketShortcutChanged()
  if (!body) throw new Error("Market skill package unavailable")
  if (target.sha256 && createHash("sha256").update(body).digest("hex") !== target.sha256) {
    throw new MarketShortcutError(
      "unavailable",
      "安装包与发布清单的 SHA-256 不一致，请联系管理员核对"
    )
  }

  const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/i)?.[1]
  const format = /\.(zip|md)$/i
    .exec(filename || target.filename || "package.zip")?.[1]
    ?.toLowerCase()
  if (!format) throw new Error("Unsupported skill package")
  return { fileName: `market-skill.${format}`, buffer: new Uint8Array(body).buffer }
}
