/**
 * 项目运营看板「知识文档入库率」：AI 修改的知识库内容被用户提交的百分比。
 *
 * 数据不在 ES，来自知识库服务的接口（地址见 .env 的 VITE_KNOWLEDGE_COMMIT_RATE_URL，仅内网
 * 可访问）。接口按室编号 orgId 和时间范围返回一个百分数，不传 orgId 即全部室。
 *
 * 看板的室筛选存的是室名称，接口要的是室编号。对应关系配置在 .env 的
 * VITE_KNOWLEDGE_ROOM_ORG_IDS，是「室名称: 室编号」的 JSON 对象，映射里没有的室查不了。
 * env 在构建时注入，增删室要重新打包。
 */
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"
import type {
  DashboardKnowledgeCommitRate,
  DashboardKnowledgeCommitRateUnavailableReason
} from "../../shared/dashboard-knowledge-commit-rate"

const KNOWLEDGE_COMMIT_RATE_TIMEOUT_MS = 10_000

export function getKnowledgeCommitRateUrl(): string {
  return (import.meta.env.VITE_KNOWLEDGE_COMMIT_RATE_URL as string | undefined)?.trim() || ""
}

/** 接口要本地时区的 `yyyy-MM-dd HH:mm:ss`，看板的时间范围是 UTC 的 ISO 串。 */
export function formatKnowledgeApiTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error(`无效的时间：${iso}`)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 室名称比对前统一括号：映射按手工录入，室名称来自采集到的机构路径，「(成都)」和「（成都）」
 * 两种写法都可能出现，不统一的话带地域后缀的室会被当成没配置。
 */
function normalizeRoomName(name: string): string {
  return name.trim().replace(/（/g, "(").replace(/）/g, ")")
}

/** 解析 VITE_KNOWLEDGE_ROOM_ORG_IDS。配置写错直接报错，免得被当成「该室没配置」悄悄放过。 */
export function parseRoomOrgIdMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const text = raw?.trim() ?? ""
  if (!text) return map
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("VITE_KNOWLEDGE_ROOM_ORG_IDS 不是合法的 JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("VITE_KNOWLEDGE_ROOM_ORG_IDS 应是「室名称: 室编号」的 JSON 对象")
  }
  for (const [roomName, value] of Object.entries(parsed)) {
    const orgId =
      typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : ""
    if (!orgId) throw new Error(`VITE_KNOWLEDGE_ROOM_ORG_IDS 里「${roomName}」的室编号为空`)
    map.set(normalizeRoomName(roomName), orgId)
  }
  return map
}

export function getKnowledgeRoomOrgIds(): Map<string, string> {
  return parseRoomOrgIdMap(import.meta.env.VITE_KNOWLEDGE_ROOM_ORG_IDS as string | undefined)
}

export type KnowledgeCommitRateScope =
  | { kind: "allRooms" }
  | { kind: "room"; roomName: string }
  | { kind: "unavailable"; reason: DashboardKnowledgeCommitRateUnavailableReason }

/**
 * 按室筛选和访问权限决定这次查哪个范围，规则与项目模式其它指标一致：管理员跟随室筛选，
 * 不选即全部室；非管理员只能看本室，室筛选与本室取交集。非管理员不能落到「全部室」。
 */
export function resolveKnowledgeCommitRateScope(input: {
  requestedRooms: string[]
  admin: boolean
  ownRoom: string
  unclassifiedRoom: string
}): KnowledgeCommitRateScope {
  const { requestedRooms, admin, unclassifiedRoom } = input
  if (!admin) {
    const ownRoom = input.ownRoom.trim()
    if (!ownRoom) return { kind: "unavailable", reason: "noAccess" }
    if (requestedRooms.length > 0 && !requestedRooms.includes(ownRoom)) {
      return { kind: "unavailable", reason: "noAccess" }
    }
    return { kind: "room", roomName: ownRoom }
  }
  if (requestedRooms.length === 0) return { kind: "allRooms" }
  if (requestedRooms.length > 1) return { kind: "unavailable", reason: "multipleRooms" }
  if (requestedRooms[0] === unclassifiedRoom) return { kind: "unavailable", reason: "unclassified" }
  return { kind: "room", roomName: requestedRooms[0] }
}

/**
 * 按范围查映射、再调接口。requestRate 负责真正取数，开发环境换成假值，两边走同一套范围和
 * 映射规则，dev 下看到的「给不出数」和线上一致。映射只在查单个室时才读，写错也不影响全部室。
 */
export async function computeKnowledgeCommitRate(
  scope: KnowledgeCommitRateScope,
  getRoomOrgIds: () => Map<string, string>,
  requestRate: (orgId: string | undefined) => Promise<number | null>
): Promise<DashboardKnowledgeCommitRate> {
  if (scope.kind === "unavailable") return { rate: null, unavailableReason: scope.reason }
  if (scope.kind === "allRooms") return { rate: await requestRate(undefined) }
  const orgId = getRoomOrgIds().get(normalizeRoomName(scope.roomName))
  if (!orgId) return { rate: null, unavailableReason: "roomNotMapped" }
  return { rate: await requestRate(orgId) }
}

/** 接口返回裸数值，单位是百分数（`21.27` 即 21.27%），换成 0–1 的比例；空响应视为没有数据。 */
export function parseKnowledgeCommitRate(body: string): number | null {
  const text = body.trim()
  if (!text || text === "null") return null
  const value = Number(text)
  if (!Number.isFinite(value)) {
    throw new Error(`知识文档入库率接口返回了非数值内容：${text.slice(0, 100)}`)
  }
  return value / 100
}

export interface KnowledgeCommitRateParams {
  /** 室编号，不传表示全部室。 */
  orgId?: string
  startTime: string
  endTime: string
}

export async function requestKnowledgeCommitRate(
  url: string,
  params: KnowledgeCommitRateParams,
  cancelSignal?: AbortSignal
): Promise<number | null> {
  const timeoutSignal = AbortSignal.timeout(KNOWLEDGE_COMMIT_RATE_TIMEOUT_MS)
  const signal = cancelSignal ? AbortSignal.any([cancelSignal, timeoutSignal]) : timeoutSignal
  const body = {
    ...(params.orgId ? { orgId: params.orgId } : {}),
    startTime: params.startTime,
    endTime: params.endTime
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`知识文档入库率接口返回 HTTP ${response.status}：${text.slice(0, 200)}`)
    }
    return parseKnowledgeCommitRate(text)
  } catch (error) {
    // 被同类新请求顶掉时按取消处理，外层不会把它记成错误。
    if (cancelSignal?.aborted) throw new DashboardRequestCancelledError()
    if (timeoutSignal.aborted) {
      throw new Error(`知识文档入库率接口 ${KNOWLEDGE_COMMIT_RATE_TIMEOUT_MS / 1000} 秒内未响应`)
    }
    throw error
  }
}

/** 开发环境连不上内网时代替接口的假值：全部室固定，单个室按编号给一个稳定的数。 */
export function mockKnowledgeCommitRate(orgId: string | undefined): number {
  if (!orgId) return 0.2127
  const numeric = Number(orgId)
  const seed = Number.isSafeInteger(numeric)
    ? numeric
    : Array.from(orgId).reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return (1000 + (seed % 6000)) / 10000
}
