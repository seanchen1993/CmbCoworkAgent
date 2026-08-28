import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Search,
  ShoppingBag,
  Sparkles,
  Plug,
  Puzzle,
  Trash2,
  CheckCircle,
  Plus,
  Zap,
  Tag,
  Star,
  User,
  Edit,
  X,
  BarChart3,
  Check,
  Calendar,
  ChevronDown, ArrowLeft
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAppStore } from "@/lib/store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { McpConnectorConfig, PluginManifest, PluginMetadata, SkillMetadata } from "@/types"
import { UniversalUploadDialog } from "./UniversalUploadDialog"
import { MarketDetailView } from "./MarketDetailView"
import { SkillDetail } from "../SkillsPanel"
import { MCPConnectorDetail } from "../MCPConnectorDetail"
import { PluginDetailPanel } from "../PluginsPanel"
import {
  buildMarketInstalledFlags,
  marketInstalledVersionStorage,
  MarketUpdateBadge,
  normalizeMarketVersion,
  UpdateVersionTooltip
} from "./MarketUpdateBadge"
import {
  getOrgSkillUploaderProfile,
  renderUploaderProfile,
  type UploaderProfile
} from "./MarketUploaderProfile"
import { marketInstalledSourceStorage } from "./market-installed-source-storage"
import {
  isAutoOptimizedMarketItem,
  marketApi,
  MarketApiResponse,
  MarketItem,
  MarketItemType
} from "../../../api/market"
import { USE_MARKET_MOCK_ON_ERROR } from "../../../api/market-flags"
import {
  deleteInstalledMarketPlugin,
  findInstalledPluginForMarketItem,
  installMarketPluginUpdate
} from "./market-plugin-update"
import { getMarketMockResponse } from "./MarketMockData"
import {
  formatTopUserOrgName,
  getDefaultRange,
  parseTopUsersFromAgg,
  type DashboardTraceDetail,
  type DashboardTraceViewMode
} from "../../dashboard/use-dashboard"
import { TraceExplorer } from "../../dashboard/TraceHistoryDialog"
import { toast } from "sonner"
import {
  buildUploaderIdCandidates,
  getUploaderIdCandidates,
  getAllSkills,
  getSkillMetricByName,
  sortSkillItemsByUsage,
  type SkillSortMode,
  type SkillUsageSummaryMetric
} from "../../../lib/skill-data-service"
import {
  ORG_SKILL_MARKET_TYPE,
  OrgSkillMarketContent,
  OrgSkillMarketIntroIcon,
  OrgSkillMarketTabTrigger,
  orgSkillTabIntro
} from "./OrgSkillMarketTab"

// Local storage helper functions for tracking user uploads
const UPLOADED_ITEMS_KEY = "marketplace_uploaded_items"
const LOCAL_UPLOADED_SKILL_PATHS_KEY = "skills_panel_uploaded_skill_paths"
const MARKET_ALL_USER_CACHE_KEY = "market_panel_query_all_user_cache_v1"
const MARKET_FRONTEND_PAGE_SIZE = 10

interface MarketPanelAllUserItem {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

interface MarketPanelAllUserCachePayload {
  cachedAt: string
  users: MarketPanelAllUserItem[]
}

let marketAllUserRefreshPromise: Promise<MarketPanelAllUserItem[]> | null = null

function normalizeSkillName(value?: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
}

function normalizeSkillPathKey(skillPath: string): string {
  return String(skillPath || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase()
}

function getSecondaryCategory(category?: string): string {
  if (!category) return ""
  const parts = category
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0]
  return parts.slice(1).join("/")
}

function getPrimaryCategory(category?: string): string {
  if (!category) return ""
  const parts = category
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return ""
  return parts[0]
}

function getCategoryFilterName(category?: string): string {
  return getSecondaryCategory(category) || "未分类"
}

interface UploadedItemRecord {
  name: string
  type: MarketItemType
  uploadedAt: string
}

interface LocalUploadedSkillPathRecord {
  path: string
  uploadedAt?: string
}

function parseMarkdownFrontmatterMetadata(content: string | null): Record<string, string> | undefined {
  if (typeof content !== "string") return undefined

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return undefined

  const metadata: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(":")
    if (colonIndex <= 0) continue
    const key = line.slice(0, colonIndex).trim()
    const rawValue = line.slice(colonIndex + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, "")
    if (key && value) metadata[key] = value
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function formatMarketVersionLabel(version?: string | null): string {
  const normalized = normalizeMarketVersion(version)
  return normalized ? `v${normalized}` : "未知版本"
}

function readUploadedSkillNamesFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(UPLOADED_ITEMS_KEY)
    const parsed: UploadedItemRecord[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()

    const names = new Set<string>()
    for (const item of parsed) {
      if (!item || item.type !== "skill") continue
      const normalized = normalizeSkillName(item.name)
      if (normalized) names.add(normalized)
    }
    return names
  } catch (error) {
    console.warn("[MarketPanel] Failed to read uploaded skill names from localStorage:", error)
    return new Set()
  }
}

function readLocalUploadedSkillPathSetFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LOCAL_UPLOADED_SKILL_PATHS_KEY)
    const parsed: LocalUploadedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()

    const paths = new Set<string>()
    for (const item of parsed) {
      if (!item?.path) continue
      paths.add(normalizeSkillPathKey(item.path))
    }
    return paths
  } catch (error) {
    console.warn("[MarketPanel] Failed to read local uploaded skill paths from localStorage:", error)
    return new Set()
  }
}

function normalizeMarketPanelAllUserItem(value: unknown): MarketPanelAllUserItem | null {
  if (!value || typeof value !== "object") return null

  const record = value as Record<string, unknown>
  const sapId = String(record.sapId || "").trim()
  if (!sapId) return null

  const userName = String(record.userName || "").trim()
  const orgName = String(record.orgName || "").trim()
  const upperOrgLv0 = String(record.upperOrgLv0 || "").trim()
  const upperOrgLv1 = String(record.upperOrgLv1 || "").trim()

  return {
    sapId,
    userName,
    orgName,
    upperOrgLv0: upperOrgLv0 || undefined,
    upperOrgLv1: upperOrgLv1 || undefined
  }
}

function normalizeMarketPanelAllUsers(value: unknown): MarketPanelAllUserItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeMarketPanelAllUserItem(item))
    .filter((item): item is MarketPanelAllUserItem => item !== null)
}

function readMarketPanelAllUsersFromStorage(): MarketPanelAllUserItem[] | null {
  try {
    const raw = localStorage.getItem(MARKET_ALL_USER_CACHE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      const users = normalizeMarketPanelAllUsers(parsed)
      return users.length > 0 ? users : null
    }

    const payload =
      parsed && typeof parsed === "object" ? (parsed as MarketPanelAllUserCachePayload) : null
    const users = normalizeMarketPanelAllUsers(payload?.users)
    return users.length > 0 ? users : null
  } catch (error) {
    console.warn("[MarketPanel] Failed to read cached all-user list:", error)
    return null
  }
}

function writeMarketPanelAllUsersToStorage(users: MarketPanelAllUserItem[]): void {
  try {
    const payload: MarketPanelAllUserCachePayload = {
      cachedAt: new Date().toISOString(),
      users: normalizeMarketPanelAllUsers(users)
    }
    localStorage.setItem(MARKET_ALL_USER_CACHE_KEY, JSON.stringify(payload))
  } catch (error) {
    console.warn("[MarketPanel] Failed to write cached all-user list:", error)
  }
}

async function refreshMarketPanelAllUsers(): Promise<MarketPanelAllUserItem[]> {
  if (marketAllUserRefreshPromise) return marketAllUserRefreshPromise

  marketAllUserRefreshPromise = (async () => {
    if (typeof window.api?.dashboard?.queryAllUser !== "function") {
      throw new Error("queryAllUser API unavailable")
    }

    const response = await window.api.dashboard.queryAllUser()
    if (!response.success || !response.data) {
      throw new Error(response.error || "获取全量用户信息失败")
    }

    const users = normalizeMarketPanelAllUsers(response.data)
    writeMarketPanelAllUsersToStorage(users)
    return users
  })()

  try {
    return await marketAllUserRefreshPromise
  } finally {
    marketAllUserRefreshPromise = null
  }
}

async function loadMarketPanelAllUsersPreferCache(options?: {
  onCacheHit?: (users: MarketPanelAllUserItem[]) => void
  onFreshData?: (users: MarketPanelAllUserItem[]) => void
  onRefreshError?: (error: unknown) => void
}): Promise<MarketPanelAllUserItem[]> {
  const cachedUsers = readMarketPanelAllUsersFromStorage()
  if (cachedUsers) {
    options?.onCacheHit?.(cachedUsers)
    void refreshMarketPanelAllUsers()
      .then((freshUsers) => {
        options?.onFreshData?.(freshUsers)
      })
      .catch((error) => {
        options?.onRefreshError?.(error)
      })
    return cachedUsers
  }

  const freshUsers = await refreshMarketPanelAllUsers()
  options?.onFreshData?.(freshUsers)
  return freshUsers
}

interface SkillUserUsage {
  sapId: string
  userName: string
  orgName: string
  count: number
}

interface SkillUsageDetail {
  users: SkillUserUsage[]
  // 去重用户数（仅统计非空 ystId 用户）
  uniqueUsersCount?: number
  // 空用户调用次数（ystId 为空或缺失）
  emptyUserCalls?: number
}

function resolveUploaderProfile(
  profiles: Record<string, UploaderProfile>,
  userId?: string | null
): UploaderProfile | null {
  const normalizedUserId = userId?.trim()
  if (!normalizedUserId) return null

  const directProfile = profiles[normalizedUserId]
  if (directProfile) return directProfile

  const candidates = buildUploaderIdCandidates(normalizedUserId)
  for (const candidate of candidates) {
    const profile = profiles[candidate]
    if (profile) return profile
  }

  return (
    Object.values(profiles).find((profile) =>
      candidates.some((candidate) => profile.sapId.includes(candidate))
    ) ?? null
  )
}

interface UserInfoLite {
  sapId?: string
  ystId?: string
  pathName?: string
}

type MarketExtraJson = {
  skills?: string[]
  grayUserIds?: string[]
  grayOrgs?: string[]
  updated_at?: string
}

function parseMarketExtraJson(extraJson?: string): MarketExtraJson {
  if (!extraJson?.trim()) return {}
  try {
    const parsed = JSON.parse(extraJson) as MarketExtraJson
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function getGrayUserIdsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  if (!Array.isArray(parsed.grayUserIds)) return []
  return Array.from(
    new Set(
      parsed.grayUserIds
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function getGrayOrgsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  if (!Array.isArray(parsed.grayOrgs)) return []
  return Array.from(
    new Set(
      parsed.grayOrgs
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function getMarketUpdatedAt(item: Pick<MarketItem, "created_at" | "updated_at" | "extra_json">): string {
  return parseMarketExtraJson(item.extra_json).updated_at || item.updated_at || item.created_at
}

function matchesMarketSearchQuery(item: Pick<MarketItem, "name" | "chinese_name" | "description" | "user_id">, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true

  return Boolean(
    item.chinese_name?.toLowerCase().includes(normalizedQuery) ||
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.description?.toLowerCase().includes(normalizedQuery) ||
      item.user_id?.toLowerCase().includes(normalizedQuery)
  )
}

function formatMarketListDateTime(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}/${month}/${day}`
}

function splitEnvIds(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(/[,\n;\s]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  )
}

function getMarketAdminYstIds(): Set<string> {
  return splitEnvIds(import.meta.env.VITE_ADMIN_YST_IDS)
}

const MARKET_ADMIN_YST_IDS = getMarketAdminYstIds()

function canCurrentUserEditOrDeleteMarketItem(
  item: Pick<MarketItem, "canDelete" | "ip">,
  localIp?: string | null,
  isCurrentUserMarketAdmin = false
): boolean {
  return Boolean(
    isCurrentUserMarketAdmin || item.canDelete || (item.ip && localIp && item.ip === localIp)
  )
}

function doesMarketUserIdMatchCurrentUser(
  rawUserId: string | null | undefined,
  currentUserIdCandidates: Iterable<string>,
  currentUserSapId?: string | null | undefined
): boolean {
  const normalizedCurrentIds = Array.from(
    new Set([
      ...Array.from(currentUserIdCandidates, (value) => String(value || "").trim()).filter(Boolean),
      ...buildUploaderIdCandidates(currentUserSapId || undefined)
    ])
  )
  if (!rawUserId || normalizedCurrentIds.length === 0) return false

  const targetCandidates = getUploaderIdCandidates(rawUserId)
  return targetCandidates.some((candidate) =>
    normalizedCurrentIds.some(
      (currentId) =>
        currentId === candidate || currentId.includes(candidate) || candidate.includes(currentId)
    )
  )
}

function canCurrentUserViewMarketItem(
  item: MarketItem,
  currentUserSapId: string | null | undefined,
  currentUserIdCandidates: Iterable<string>,
  currentUserPathName?: string | null | undefined
): boolean {
  if (doesMarketUserIdMatchCurrentUser(item.user_id, currentUserIdCandidates, currentUserSapId)) {
    return true
  }
  const grayUserIds = getGrayUserIdsFromExtraJson(item.extra_json)
  const grayOrgs = getGrayOrgsFromExtraJson(item.extra_json)
  
  if (grayUserIds.length === 0 && grayOrgs.length === 0) return true
  
  if (grayUserIds.length > 0 && grayUserIds.some((userId) =>
    doesMarketUserIdMatchCurrentUser(userId, currentUserIdCandidates, currentUserSapId)
  )) {
    return true
  }
  
  if (grayOrgs.length > 0 && currentUserPathName && grayOrgs.some((org) =>
    currentUserPathName.includes(org)
  )) {
    return true
  }
  
  return false
}

type UploadFilterMode = "mine" | "installed" | "featured" | "certified"

const uploadFilterOptions: Array<{ value: UploadFilterMode; label: string }> = [
  { value: "mine", label: "我上传的" },
  { value: "installed", label: "我安装的" },
  { value: "featured", label: "精品" },
  { value: "certified", label: "认证" }
]

const uploadFilterValues = new Set<UploadFilterMode>(
  uploadFilterOptions.map((option) => option.value)
)

function getSkillStatsRange(): { from: string; to: string } {
  // 和 Dashboard 的默认月维度保持一致，避免前后口径不一致。
  return getDefaultRange("month")
}

const localStorageHelper = {
  // Get all items uploaded by current user
  getUploadedItems(): UploadedItemRecord[] {
    try {
      const stored = localStorage.getItem(UPLOADED_ITEMS_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  },

  // Add item to uploaded items list
  addUploadedItem(name: string, type: MarketItemType): void {
    try {
      const items = this.getUploadedItems()
      const newItem: UploadedItemRecord = {
        name,
        type,
        uploadedAt: new Date().toISOString()
      }
      // Remove existing item with same name and type if exists
      const filteredItems = items.filter((item) => !(item.name === name && item.type === type))
      filteredItems.push(newItem)
      localStorage.setItem(UPLOADED_ITEMS_KEY, JSON.stringify(filteredItems))
    } catch (error) {
      console.error("Failed to save uploaded item to localStorage:", error)
    }
  },

  // Remove item from uploaded items list
  removeUploadedItem(name: string, type: MarketItemType): void {
    try {
      const items = this.getUploadedItems()
      const filteredItems = items.filter((item) => !(item.name === name && item.type === type))
      localStorage.setItem(UPLOADED_ITEMS_KEY, JSON.stringify(filteredItems))
    } catch (error) {
      console.error("Failed to remove uploaded item from localStorage:", error)
    }
  },

  // Check if user can delete this item (user uploaded it)
  canDeleteItem(name: string, type: MarketItemType): boolean {
    const items = this.getUploadedItems()
    return items.some((item) => item.name === name && item.type === type)
  }
}

interface MarketItemCardProps {
  item: MarketItem
  onOpenDetail: (item: MarketItem) => void
  onDelete: (item: MarketItem) => void
  onUpdate: (item: MarketItem) => void
  onDownload: (item: MarketItem, downloadToLocal?: boolean) => void
  onUpdateInstall: (item: MarketItem) => void
  onUninstall: (item: MarketItem) => void // 新增卸载回调
  isDownloading?: boolean
  isInstalled?: boolean // 新增已安装状态
  isUpdating?: boolean // 新增更新中状态
  installedVersion?: string | null
  updateAvailable?: boolean
  marketTypeLabel: string
  skillCallCount?: number | null
  skillUserCount?: number | null
  uploaderProfile?: UploaderProfile | null
  showResolvedUploader?: boolean
  installDisabledReason?: string
  showProjectModeTag?: boolean
}

function MarketItemCard({
  item,
  onOpenDetail,
  onDelete,
  onUpdate,
  onDownload,
  onUpdateInstall,
  onUninstall,
  isDownloading = false,
  isInstalled = false,
  isUpdating = false,
  installedVersion = null,
  updateAvailable = false,
  marketTypeLabel,
  skillCallCount = null,
  skillUserCount = null,
  uploaderProfile = null,
  showResolvedUploader = false,
  installDisabledReason,
  showProjectModeTag = false
}: MarketItemCardProps) {
  const formatMetricValue = (value: number | null): string => {
    if (value === null) return "0"
    if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`
    if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
    return String(value)
  }

  const handleInstallDownload = () => {
    onDownload(item, false)
  }

  const handleUpdateInstall = () => {
    onUpdateInstall(item)
  }

  const handleUninstall = () => {
    onUninstall(item)
  }

  const ip = localStorage.getItem("localIp")
  const isFeatured = item.featured === "精品"
  const itemTag = item.tag?.trim()
  const isSkillCard = skillCallCount !== null || skillUserCount !== null
  const installActionDisabled = !!installDisabledReason
  const uploadTimeLabel = formatMarketListDateTime(item.created_at)

  const installDisabledTooltip = (
    <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
      {installDisabledReason}
    </TooltipContent>
  )

  return (
    <div
      className="group flex h-full cursor-pointer flex-col rounded-2xl border border-border bg-background-elevated p-5 transition-all duration-200 hover:border-border-emphasis hover:bg-background-interactive hover:shadow-[rgba(0,0,0,0.10)_0px_4px_20px]"
      onClick={() => onOpenDetail(item)}
    >
      {/* Header: name + badges */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {item.chinese_name ? (
              <h3 className="text-[15px] font-medium leading-snug text-foreground">
                {item.chinese_name}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">({item.name})</span>
              </h3>
            ) : (
              <h3 className="text-[15px] font-medium leading-snug text-foreground">{item.name}</h3>
            )}
            {isFeatured && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] font-medium text-status-warning">
                <Star className="size-3 fill-current" />
                精品
              </span>
            )}
            {isAutoOptimizedMarketItem(item) && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-info/30 bg-status-info/10 px-2 py-0.5 text-[11px] font-medium text-status-info">
                <Sparkles className="size-3" />
                系统优化
              </span>
            )}
            {itemTag && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {itemTag}
              </span>
            )}
            {item.category && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background-interactive px-2 py-0.5 text-[11px] text-muted-foreground">
                <Tag className="size-3 shrink-0" />
                {item.category}
              </span>
            )}
            {isInstalled && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-nominal/30 bg-status-nominal/10 px-2 py-0.5 text-[11px] font-medium text-status-nominal">
                <CheckCircle className="size-3" />
                已安装
              </span>
            )}
            {showProjectModeTag && item.project_mode_supported === true && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-nominal/30 bg-status-nominal/10 px-2 py-0.5 text-[11px] font-medium text-status-nominal">
                项目模式
              </span>
            )}
            {updateAvailable && (
              <MarketUpdateBadge
                typeLabel={marketTypeLabel}
                installedVersion={installedVersion}
                currentVersion={item.version}
              />
            )}
          </div>
          {item.description && (
            <p className="mt-2 line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">
              {item.description}
            </p>
          )}
        </div>
        {isSkillCard && (
          <div className="ml-3 flex flex-col items-end gap-1.5 shrink-0">
            {skillCallCount !== null && (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-status-info/25 bg-status-info/10 px-2 py-1 text-status-info">
                <BarChart3 className="size-3 shrink-0" />
                <span className="text-[11px] opacity-75">本月调用</span>
                <span className="text-[12px] font-semibold tabular-nums">
                  {formatMetricValue(skillCallCount)}
                </span>
              </div>
            )}
            {skillUserCount !== null && (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-status-nominal/25 bg-status-nominal/10 px-2 py-1 text-status-nominal">
                <User className="size-3 shrink-0" />
                <span className="text-[11px] opacity-75">本月用户</span>
                <span className="text-[12px] font-semibold tabular-nums">
                  {formatMetricValue(skillUserCount)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Featured auto-update notice */}
      {/*{isFeatured && isInstalled && (*/}
      {/*  <div className="text-xs text-[#c4956a] bg-[#fdf3e7] border border-[#f5d9c4] rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5">*/}
      {/*    <Zap className="size-3 shrink-0" />*/}
      {/*    精品技能无需手动更新，系统将自动安装最新版本*/}
      {/*  </div>*/}
      {/*)}*/}

      {/* Footer: metadata + actions */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {uploadTimeLabel ? (
            <div className="flex items-center gap-1">
              <Calendar className="size-3 shrink-0" />
              <span>上传于 {uploadTimeLabel}</span>
            </div>
          ) : null}
          {/*{item.version && (*/}
          {/*  <div className="flex items-center gap-1">*/}
          {/*    <GitBranch className="size-3 shrink-0" />*/}
          {/*    <span>*/}
          {/*      {updateAvailable && installedVersion*/}
          {/*        ? `${formatMarketVersionLabel(installedVersion)} -> `*/}
          {/*        : ""}*/}
          {/*      {formatMarketVersionLabel(item.version)}*/}
          {/*    </span>*/}
          {/*  </div>*/}
          {/*)}*/}
          {item.user_id ? (
            <div className="flex items-center gap-1">
              <User className="size-3 shrink-0" />
              {showResolvedUploader ? (
                renderUploaderProfile(uploaderProfile, item.user_id)
              ) : (
                <span>用户 {item.user_id}</span>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isDownloading || isUpdating ? (
            <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <>
              {isInstalled ? (
                isFeatured ? (
                  <span className="inline-flex items-center gap-1 rounded-lg border border-status-warning/25 bg-status-warning/10 px-2.5 py-1 text-[11px] text-status-warning">
                    <Zap className="size-3" />
                    自动保持最新
                  </span>
                ) : installActionDisabled ? (
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex cursor-not-allowed">
                          <Button
                            variant="outline"
                            size="sm"
                            className="pointer-events-none h-7 gap-1 rounded-lg border-border bg-background-interactive px-3 text-xs text-muted-foreground opacity-90"
                            disabled
                            aria-disabled="true"
                          >
                            <Plus className="size-3" />
                            无需安装
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {installDisabledTooltip}
                    </Tooltip>
                  </TooltipProvider>
                ) : updateAvailable ? (
                  <UpdateVersionTooltip
                    typeLabel={marketTypeLabel}
                    installedVersion={installedVersion}
                    currentVersion={item.version}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="market-update-bounce h-7 cursor-pointer gap-1 rounded-lg border-status-nominal/35 bg-status-nominal/10 px-3 text-xs text-status-nominal hover:bg-status-nominal/15"
                      onClick={handleUpdateInstall}
                    >
                      <Plus className="size-3" />
                      更新
                    </Button>
                  </UpdateVersionTooltip>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 cursor-pointer gap-1 rounded-lg border-border bg-background-interactive px-3 text-xs text-muted-foreground hover:bg-secondary"
                    onClick={handleUpdateInstall}
                  >
                    <Plus className="size-3" />
                    重装
                  </Button>
                )
              ) : (
                installActionDisabled ? (
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex cursor-not-allowed">
                          <Button
                            size="sm"
                            className="pointer-events-none h-7 gap-1 rounded-lg border-0 bg-muted px-3 text-xs text-muted-foreground opacity-85"
                            disabled
                            aria-disabled="true"
                          >
                            <Plus className="size-3" />
                            无需安装
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {installDisabledTooltip}
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 cursor-pointer gap-1 rounded-lg border-0 bg-button px-3 text-xs text-button-foreground hover:bg-button/90"
                    onClick={handleInstallDownload}
                  >
                    <Plus className="size-3" />
                    安装
                  </Button>
                )
              )}
              {isInstalled && !isFeatured && !installActionDisabled && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer gap-1 rounded-lg border-status-critical/30 px-2.5 text-xs text-status-critical hover:bg-status-critical/10"
                  onClick={handleUninstall}
                  title="卸载"
                >
                  <Trash2 className="size-3" />
                  卸载
                </Button>
              )}
              {canCurrentUserEditOrDeleteMarketItem(item, ip) && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 cursor-pointer gap-1 rounded-lg border-border bg-background-interactive px-2.5 text-xs text-muted-foreground hover:bg-secondary"
                    onClick={() => onUpdate(item)}
                    title="编辑"
                  >
                    <Edit className="size-3" />
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 cursor-pointer gap-1 rounded-lg border-status-critical/30 px-2.5 text-xs text-status-critical hover:bg-status-critical/10"
                    onClick={() => onDelete(item)}
                    title="删除"
                  >
                    <Trash2 className="size-3" />
                    删除
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

type DetailViewMode = "list" | "detail"
type SkillPreviewKind = "text" | "html" | "image" | "pdf"

interface MarketListScrollState {
  activeTab: MarketItemType
  viewportTop: number
  cardListTop: number
}

interface PluginDetailData {
  skills: string[]
  mcpServers: string[]
  mcpServerDetails: Awaited<ReturnType<typeof window.api.plugins.getDetail>>["mcpServerDetails"]
  hookCount: number
  hooks: Array<Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]>
  manifest: PluginManifest | null
}

function getFileExt(filename: string): string {
  const idx = filename.lastIndexOf(".")
  if (idx < 0) return ""
  return filename.slice(idx + 1).toLowerCase()
}

function isAllowedDetailFile(type: MarketItemType, filename: string): boolean {
  const ext = getFileExt(filename)
  if (type === "skill" || type === "orgSkill") return ext === "zip" || ext === "md"
  if (type === "plugin") return ext === "zip"
  return ext === "json"
}

export function MarketPanel(): React.JSX.Element {
  const {
    marketInitialSkillCategory,
    marketInitialSkillSearchQuery,
    marketInitialSkillDetailName,
    setMarketInitialSkillDetailName,
    marketInitialSkillFilters,
    marketInitialTab,
    bumpPluginVersion
  } = useAppStore()
  const [activeTab, setActiveTab] = useState<MarketItemType>("skill")
  const [searchQueries, setSearchQueries] = useState<Record<MarketItemType, string>>({
    skill: "",
    orgSkill: "",
    mcp: "",
    plugin: ""
  })
  const [marketPageNums, setMarketPageNums] = useState<Record<MarketItemType, number>>({
    skill: 1,
    orgSkill: 1,
    mcp: 1,
    plugin: 1
  })
  const [uploadFilterModes, setUploadFilterModes] = useState<UploadFilterMode[]>([])
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [pendingInitialCategoryFilter, setPendingInitialCategoryFilter] = useState<string | null>(
    null
  )
  const [skillsData, setSkillsData] = useState<MarketItem[]>([])
  const [mcpsData, setMcpsData] = useState<MarketItem[]>([])
  const [pluginsData, setPluginsData] = useState<MarketItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloadingItems, setDownloadingItems] = useState<Set<string>>(new Set())
  const [updatingItems, setUpdatingItems] = useState<Set<string>>(new Set()) // 新增更新中状态
  const [installedSkills, setInstalledSkills] = useState<string[]>([]) // 新增已安装skills列表
  const [installedMcps, setInstalledMcps] = useState<string[]>([]) // 新增已安装MCPs列表
  const [installedPlugins, setInstalledPlugins] = useState<string[]>([]) // 新增已安装Plugins列表
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; item: MarketItem | null }>({
    open: false,
    item: null
  })
  const [uploadDialog, setUploadDialog] = useState(false)
  const [updateDialog, setUpdateDialog] = useState<{ open: boolean; item: MarketItem | null }>({
    open: false,
    item: null
  })
  const [reloadToken, setReloadToken] = useState(0)
  const [detailMode, setDetailMode] = useState<DetailViewMode>("list")
  const [skillSortMode, setSkillSortMode] = useState<SkillSortMode>("calls_desc")
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null)
  const [selectedItemSnapshot, setSelectedItemSnapshot] = useState<MarketItem | null>(null)
  const [pendingOrgSkillDetailName, setPendingOrgSkillDetailName] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [skillDetailSkill, setSkillDetailSkill] = useState<SkillMetadata | null>(null)
  const [skillDetailSelectedFile, setSkillDetailSelectedFile] = useState<string | null>(null)
  const [skillDetailContent, setSkillDetailContent] = useState<string | null>(null)
  const [skillDetailPreviewKind, setSkillDetailPreviewKind] = useState<SkillPreviewKind>("text")
  const [skillDetailBinaryBase64, setSkillDetailBinaryBase64] = useState<string | null>(null)
  const [skillDetailBinaryMimeType, setSkillDetailBinaryMimeType] = useState<string | null>(null)
  const [mcpDetailConnector, setMcpDetailConnector] = useState<McpConnectorConfig | null>(null)
  const [pluginDetailPlugin, setPluginDetailPlugin] = useState<PluginMetadata | null>(null)
  const [pluginDetailData, setPluginDetailData] = useState<PluginDetailData | null>(null)
  const pluginDetailFileBlobRef = useRef<Blob | null>(null)
  const [skillUsageSummary, setSkillUsageSummary] = useState<
    Record<string, SkillUsageSummaryMetric>
  >({})
  const [selectedSkillUsage, setSelectedSkillUsage] = useState<SkillUsageDetail | null>(null)
  const [skillUsageLoading, setSkillUsageLoading] = useState(false)
  const [selectedSkillTraces, setSelectedSkillTraces] = useState<DashboardTraceDetail[]>([])
  const [skillTraceViewMode, setSkillTraceViewMode] = useState<DashboardTraceViewMode>("thread")
  const [skillTracesLoading, setSkillTracesLoading] = useState(false)
  const [skillTracesError, setSkillTracesError] = useState<string | null>(null)
  const [skillTraceDialogOpen, setSkillTraceDialogOpen] = useState(false)
  const [canViewSkillUserDetail, setCanViewSkillUserDetail] = useState(false)
  const [uploaderProfiles, setUploaderProfiles] = useState<Record<string, UploaderProfile>>({})
  const [currentUserUploadCandidates, setCurrentUserUploadCandidates] = useState<string[]>([])
  const [currentUserSapId, setCurrentUserSapId] = useState<string | null>(null)
  const [currentUserPathName, setCurrentUserPathName] = useState<string | null>(null)
  const [isCurrentUserMarketAdmin, setIsCurrentUserMarketAdmin] = useState(false)
  const [adminModeEnabled, setAdminModeEnabled] = useState(false)
  const [uploadedSkillNames, setUploadedSkillNames] = useState<Set<string>>(() =>
    readUploadedSkillNamesFromStorage()
  )
  const listScrollAreaRef = useRef<HTMLDivElement | null>(null)
  const listCardContainerRef = useRef<HTMLDivElement | null>(null)
  const savedListScrollRef = useRef<MarketListScrollState>({
    activeTab: "skill",
    viewportTop: 0,
    cardListTop: 0
  })
  const hasSavedListScrollRef = useRef(false)
  const shouldRestoreListScrollRef = useRef(false)
  const installedSkillsRef = useRef<string[]>([])
  const installedMcpsRef = useRef<string[]>([])
  const installedPluginsRef = useRef<string[]>([])
  const updateNoticeShownRef = useRef<Set<string>>(new Set())
  const uploaderProfilesRequestIdRef = useRef(0)
  const openItemDetailRef = useRef<(item: MarketItem) => Promise<void>>(async () => {})
  const previousActiveTabRef = useRef<MarketItemType>(activeTab)
  const currentUserCandidateSet = useMemo(
    () => new Set(currentUserUploadCandidates),
    [currentUserUploadCandidates]
  )
  const currentLocalIp = localStorage.getItem("localIp")
  const isAdminModeActive = isCurrentUserMarketAdmin && adminModeEnabled
  const uploadedSkillDisabledReason = "这个技能已经存在于“我上传的技能”里，无需重复安装。"
  const uploadedSkillNameSetRef = useRef<Set<string>>(uploadedSkillNames)

  const getItemKey = (item: MarketItem) => item.id || item.name
  const getMarketTypeLabel = (type: MarketItemType) =>
    type === "skill"
      ? "技能"
      : type === "orgSkill"
        ? "组织级技能"
        : type === "mcp"
          ? "MCP连接器"
          : "插件"
  const getMarketTypePluralLabel = (type: MarketItemType) =>
    type === "skill"
      ? "Skills"
      : type === "orgSkill"
        ? "组织级技能"
        : type === "mcp"
          ? "MCPs"
          : "Plugins"
  const getMarketSearchPlaceholder = (type: MarketItemType) =>
    type === "skill"
      ? "搜索技能名、描述或 user_id…"
      : type === "orgSkill"
        ? "搜索组织级技能…"
        : type === "mcp"
          ? "搜索 MCP、描述或 user_id…"
          : "搜索插件名、描述或 user_id…"
  const tabIntros: Record<MarketItemType, { title: string; description: string }> = {
    skill: {
      title: "Skills 是可直接调用的专项能力",
      description:
        "安装后可以在对话中选择或自动调用，用来完成写作、检索、分析、生成文件等具体任务。"
    },
    [ORG_SKILL_MARKET_TYPE]: orgSkillTabIntro,
    mcp: {
      title: "MCPs 是连接外部工具和数据源的通道",
      description:
        "安装后可让 Agent 访问数据库、系统服务、业务 API 或远程工具，扩展它能读取和操作的范围。"
    },
    plugin: {
      title: "Plugins 是打包好的功能扩展",
      description: "安装后可一次性提供技能、MCP 连接器、钩子或界面能力，适合成套分发完整工作流。"
    }
  }
  const activeTabIntro = tabIntros[activeTab]
  const activeSearchQuery = searchQueries[activeTab] ?? ""

  const setMarketPageForTab = useCallback((tab: MarketItemType, pageNum: number) => {
    const numericPageNum = Number.isFinite(pageNum) ? Math.floor(pageNum) : 1
    const nextPageNum = Math.max(1, numericPageNum)
    setMarketPageNums((prev) =>
      prev[tab] === nextPageNum ? prev : { ...prev, [tab]: nextPageNum }
    )
  }, [])

  const resetMarketPageForTab = useCallback((tab: MarketItemType) => {
    setMarketPageNums((prev) => (prev[tab] === 1 ? prev : { ...prev, [tab]: 1 }))
  }, [])

  const setActiveMarketPage = useCallback(
    (pageNum: number) => {
      setMarketPageForTab(activeTab, pageNum)
      if (activeTab !== ORG_SKILL_MARKET_TYPE) {
        listCardContainerRef.current?.scrollTo({ top: 0 })
      }
    },
    [activeTab, setMarketPageForTab]
  )

  const setSearchQueryForTab = useCallback(
    (tab: MarketItemType, query: string) => {
      setSearchQueries((prev) => (prev[tab] === query ? prev : { ...prev, [tab]: query }))
      resetMarketPageForTab(tab)
    },
    [resetMarketPageForTab]
  )

  const getScrollAreaViewport = useCallback((root: HTMLDivElement | null): HTMLDivElement | null => {
    if (!root) return null
    if (root.matches("[data-radix-scroll-area-viewport]")) return root
    return root.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null
  }, [])

  const captureListScrollPosition = useCallback(() => {
    savedListScrollRef.current = {
      activeTab,
      viewportTop: getScrollAreaViewport(listScrollAreaRef.current)?.scrollTop ?? 0,
      cardListTop: listCardContainerRef.current?.scrollTop ?? 0
    }
    hasSavedListScrollRef.current = true
  }, [activeTab, getScrollAreaViewport])

  const restoreListScrollPosition = useCallback(() => {
    const savedPosition = savedListScrollRef.current
    if (!hasSavedListScrollRef.current || savedPosition.activeTab !== activeTab) return

    const viewport = getScrollAreaViewport(listScrollAreaRef.current)
    if (viewport) viewport.scrollTop = savedPosition.viewportTop
    if (listCardContainerRef.current) listCardContainerRef.current.scrollTop = savedPosition.cardListTop
  }, [activeTab, getScrollAreaViewport])

  const resetDetailState = () => {
    setDetailError(null)
    setSkillDetailSkill(null)
    setSkillDetailSelectedFile(null)
    setSkillDetailContent(null)
    setSkillDetailPreviewKind("text")
    setSkillDetailBinaryBase64(null)
    setSkillDetailBinaryMimeType(null)
    setMcpDetailConnector(null)
    setPluginDetailPlugin(null)
    setPluginDetailData(null)
    pluginDetailFileBlobRef.current = null
    setSelectedSkillUsage(null)
    setSelectedSkillTraces([])
    setSkillTracesLoading(false)
    setSkillTracesError(null)
    setSkillTraceDialogOpen(false)
  }

  const applySkillDetailMarkdown = useCallback(
    (baseSkill: SkillMetadata, filePath: string, markdownContent: string) => {
      const metadata = parseMarkdownFrontmatterMetadata(markdownContent)
      setSkillDetailSelectedFile(filePath)
      setSkillDetailContent(markdownContent)
      setSkillDetailSkill({
        ...baseSkill,
        path: filePath,
        version: metadata?.version?.trim() || baseSkill.version,
        metadata
      })
    },
    []
  )

  const loadSkillPreviewFromInstallFile = async (
    baseSkill: SkillMetadata,
    filename: string,
    blob: Blob
  ) => {
    setSkillDetailSelectedFile(filename)
    setSkillDetailContent(null)
    setSkillDetailBinaryBase64(null)
    setSkillDetailBinaryMimeType(null)

    const ext = getFileExt(filename)
    if (ext === "md") {
      setSkillDetailPreviewKind("text")
      const text = await blob.text()
      applySkillDetailMarkdown(baseSkill, filename, text)
      return
    }
    if (ext === "zip") {
      setSkillDetailPreviewKind("text")
      const arrayBuffer = await blob.arrayBuffer()
      const extracted = await window.api.skills.extractMarkdownFromZip(arrayBuffer, filename)
      if (extracted.success && extracted.content) {
        applySkillDetailMarkdown(baseSkill, extracted.filePath || "SKILL.md", extracted.content)
      } else {
        setSkillDetailContent(extracted.error || "Zip 中未找到可预览的 markdown 文件。")
      }
      return
    }
    setSkillDetailPreviewKind("text")
    setSkillDetailContent(`文件类型 .${ext || "未知"} 已通过安装接口获取，当前不支持直接内容预览。`)
  }

  const triggerReload = () => {
    setReloadToken((prev) => prev + 1)
  }

  const loadSkillUserStats = useCallback(async (skillName: string) => {
    if (!skillName?.trim()) {
      setSelectedSkillUsage({ users: [] })
      return
    }
    if (typeof window.api?.dashboard?.skillUserStats !== "function") {
      setSelectedSkillUsage({ users: [] })
      return
    }

    setSkillUsageLoading(true)
    try {
      const range = getSkillStatsRange()
      const response = await window.api.dashboard.skillUserStats(range, "month", skillName)
      if (!response.success || !response.data) {
        throw new Error(response.error || "获取 Skill 用户明细失败")
      }

      const topUsers = parseTopUsersFromAgg(response.data)
      // 与后端聚合字段 `unique_users_count` 对齐，作为详情头部“使用用户数”的优先来源。
      const uniqueUsersCount =
        (response.data as { aggregations?: { unique_users_count?: { value?: number } } })
          .aggregations?.unique_users_count?.value ?? topUsers.length
      // 空用户调用次数来自 `empty_user_calls.filtered.doc_count`。
      const emptyUserCalls =
        (
          response.data as {
            aggregations?: { empty_user_calls?: { filtered?: { doc_count?: number } } }
          }
        ).aggregations?.empty_user_calls?.filtered?.doc_count ?? 0
      setSelectedSkillUsage({ users: topUsers, uniqueUsersCount, emptyUserCalls })
    } catch (err) {
      console.warn(`[MarketPanel] Failed to load skill user stats for ${skillName}:`, err)
      setSelectedSkillUsage({ users: [] })
    } finally {
      setSkillUsageLoading(false)
    }
  }, [])

  const loadSkillRecentTraces = useCallback(async (skillName: string, viewMode = skillTraceViewMode) => {
    if (!skillName?.trim()) {
      setSelectedSkillTraces([])
      return
    }
    if (typeof window.api?.dashboard?.marketSkillRecentTraces !== "function") {
      setSelectedSkillTraces([])
      setSkillTracesError("当前版本不支持 Skill Trace 查询")
      return
    }

    setSkillTracesLoading(true)
      setSkillTracesError(null)
    try {
      const range = getSkillStatsRange()
      const response = await window.api.dashboard.marketSkillRecentTraces(skillName, range, 10, viewMode)
      if (!response.success || !response.data) {
        throw new Error(response.error || "获取 Skill Trace 失败")
      }
      setSelectedSkillTraces(response.data)
    } catch (err) {
      console.warn(`[MarketPanel] Failed to load skill traces for ${skillName}:`, err)
      setSelectedSkillTraces([])
      setSkillTracesError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillTracesLoading(false)
    }
  }, [skillTraceViewMode])

  const loadDashboardPermission = useCallback(async () => {
    try {
      if (typeof window.api?.dashboard?.isAllowed !== "function") {
        setCanViewSkillUserDetail(false)
        return
      }
      const allowed = await window.api.dashboard.isAllowed()
      setCanViewSkillUserDetail(Boolean(allowed))
    } catch (err) {
      console.warn("[MarketPanel] Failed to load dashboard permission:", err)
      setCanViewSkillUserDetail(false)
    }
  }, [])

  useEffect(() => {
    uploadedSkillNameSetRef.current = uploadedSkillNames
  }, [uploadedSkillNames])

  const loadCurrentUserUploadCandidates = useCallback(async () => {
    try {
      if (typeof window.api?.models?.getUserInfo !== "function") {
        setCurrentUserUploadCandidates([])
        setCurrentUserSapId(null)
        setIsCurrentUserMarketAdmin(false)
        setAdminModeEnabled(false)
        return
      }
      const userInfo = (await window.api.models.getUserInfo()) as UserInfoLite | null
      setCurrentUserSapId(userInfo?.sapId?.trim() || null)
      setCurrentUserPathName(userInfo?.pathName?.trim() || null)
      const currentYstId = userInfo?.ystId?.trim() || ""
      const isAdmin = Boolean(currentYstId && MARKET_ADMIN_YST_IDS.has(currentYstId))
      setIsCurrentUserMarketAdmin(isAdmin)
      if (!isAdmin) setAdminModeEnabled(false)
      const normalizedIds = [userInfo?.sapId, userInfo?.ystId]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
      const candidates = Array.from(
        new Set(normalizedIds.flatMap((id) => buildUploaderIdCandidates(id)))
      )
      setCurrentUserUploadCandidates(candidates)
    } catch (err) {
      console.warn("[MarketPanel] Failed to load current user upload candidates:", err)
      setCurrentUserUploadCandidates([])
      setCurrentUserSapId(null)
      setCurrentUserPathName(null)
      setIsCurrentUserMarketAdmin(false)
      setAdminModeEnabled(false)
    }
  }, [])

  const loadUploaderProfiles = useCallback(async (sapIds: string[]) => {
    const requestId = ++uploaderProfilesRequestIdRef.current
    const rawUserIds = Array.from(new Set(sapIds.map((id) => id.trim()).filter(Boolean)))
    if (rawUserIds.length === 0) {
      setUploaderProfiles({})
      return
    }

    try {
      const applyProfiles = (allUsers: MarketPanelAllUserItem[]) => {
        if (requestId !== uploaderProfilesRequestIdRef.current) return

        const nextMap: Record<string, UploaderProfile> = {}
        for (const rawUserId of rawUserIds) {
          const lookupIds = buildUploaderIdCandidates(rawUserId)
          const target = allUsers.find((user) =>
            lookupIds.some((lookupId) => user.sapId.includes(lookupId))
          )
          if (!target) continue
          nextMap[rawUserId] = {
            sapId: target.sapId,
            userName: target.userName,
            orgName: formatTopUserOrgName(
              target.orgName || "",
              target.upperOrgLv1 || "",
              target.upperOrgLv0 || ""
            ),
            upperOrgLv0: target.upperOrgLv0,
            upperOrgLv1: target.upperOrgLv1
          }
        }
        setUploaderProfiles(nextMap)
      }

      await loadMarketPanelAllUsersPreferCache({
        onCacheHit: applyProfiles,
        onFreshData: applyProfiles,
        onRefreshError: (error) => {
          console.warn("[MarketPanel] Failed to refresh uploader profiles cache:", error)
        }
      })
    } catch (err) {
      if (requestId !== uploaderProfilesRequestIdRef.current) return
      console.warn("[MarketPanel] Failed to load uploader profiles:", err)
      setUploaderProfiles({})
    }
  }, [])

  // 新增：加载已安装的skills列表
  const loadInstalledSkills = async () => {
    try {
      if (window.api?.skills?.list) {
        const skillsMetadata = await window.api.skills.list()
        const skillNames = skillsMetadata.map((skill) => skill.name)
        const uploadedNames = readUploadedSkillNamesFromStorage()
        const uploadedPaths = readLocalUploadedSkillPathSetFromStorage()
        const uploadedInstalledNames = new Set<string>()
        for (const skill of skillsMetadata) {
          if (skill.source !== "user") continue
          const normalizedName = normalizeSkillName(skill.name)
          const normalizedPath = normalizeSkillPathKey(skill.path)
          if (uploadedPaths.has(normalizedPath) || uploadedNames.has(normalizedName)) {
            uploadedInstalledNames.add(normalizedName)
          }
        }
        setUploadedSkillNames(uploadedInstalledNames)
        setInstalledSkills(skillNames)
      }
    } catch (error) {
      console.error("Failed to load installed skills:", error)
    }
  }

  // 新增：加载已安装的MCPs列表
  const loadInstalledMcps = async () => {
    try {
      if (window.api?.mcp?.list) {
        const mcpsMetadata = await window.api.mcp.list()
        const mcpNames = mcpsMetadata.map((mcp) => mcp.name)
        setInstalledMcps(mcpNames)
      }
    } catch (error) {
      console.error("Failed to load installed mcps:", error)
    }
  }

  // 新增：加载已安装的Plugins列表
  const loadInstalledPlugins = async () => {
    try {
      if (window.api?.plugins?.list) {
        const pluginsMetadata = await window.api.plugins.list()
        const pluginNames = pluginsMetadata.map((plugin) => plugin.name)
        setInstalledPlugins(pluginNames)
      }
    } catch (error) {
      console.error("Failed to load installed plugins:", error)
    }
  }

  // 在组件��载时获取已安装的skills、MCPs和Plugins列表
  useEffect(() => {
    loadInstalledSkills()
    loadInstalledMcps()
    loadInstalledPlugins()
    void loadDashboardPermission()
    void loadCurrentUserUploadCandidates()
  }, [loadDashboardPermission, loadCurrentUserUploadCandidates])

  useEffect(() => {
    if (canViewSkillUserDetail) return
    setSkillUsageLoading(false)
    setSelectedSkillUsage(null)
  }, [canViewSkillUserDetail])

  useEffect(() => {
    if (marketInitialTab) {
      const detailName = marketInitialSkillDetailName?.trim() || null
      setActiveTab(marketInitialTab as MarketItemType)
      setDetailMode("list")
      setSelectedItemKey(null)
      setSelectedItemSnapshot(null)
      setPendingOrgSkillDetailName(marketInitialTab === "orgSkill" ? detailName : null)
      resetDetailState()
      setCategoryFilter(null)
      setPendingInitialCategoryFilter(null)
      setSearchQueryForTab(marketInitialTab as MarketItemType, detailName || "")
      useAppStore.setState({
        marketInitialTab: null,
        marketInitialSkillDetailName: null,
        marketInitialSkillCategory: null,
        marketInitialSkillSearchQuery: null,
        marketInitialSkillFilters: null
      })
      return
    }

    const hasInitialCategory = !!marketInitialSkillCategory
    const hasInitialSearch = !!marketInitialSkillSearchQuery?.trim()
    const hasInitialDetail = !!marketInitialSkillDetailName?.trim()
    const hasInitialFilters = marketInitialSkillFilters !== null
    if (!hasInitialCategory && !hasInitialSearch && !hasInitialDetail && !hasInitialFilters) return

    setActiveTab("skill")
    setDetailMode("list")
    setSelectedItemKey(null)
    setUploadFilterModes(
      (marketInitialSkillFilters ?? []).filter((filter): filter is UploadFilterMode =>
        uploadFilterValues.has(filter as UploadFilterMode)
      )
    )
    if (hasInitialDetail) {
      setPendingInitialCategoryFilter(null)
      setCategoryFilter(null)
    } else if (hasInitialCategory) {
      setPendingInitialCategoryFilter(marketInitialSkillCategory)
    } else {
      // 按名称跳转搜索时，避免历史分类筛选把结果“过滤没了”。
      setPendingInitialCategoryFilter(null)
      setCategoryFilter(null)
    }
    setSearchQueryForTab(
      "skill",
      marketInitialSkillDetailName?.trim() || marketInitialSkillSearchQuery?.trim() || ""
    )
    useAppStore.setState({
      marketInitialSkillCategory: null,
      marketInitialSkillSearchQuery: null,
      marketInitialSkillFilters: null
    })
  }, [
    marketInitialSkillCategory,
    marketInitialSkillDetailName,
    marketInitialSkillFilters,
    marketInitialSkillSearchQuery,
    marketInitialTab,
    setSearchQueryForTab
  ])

  // 同步已安装状态，不触发额外的 market 接口请求
  useEffect(() => {
    setSkillsData((prev) =>
      prev.map((item) => {
        const isInstalled =
          installedSkills.includes(item.name) ||
          installedSkills.some((str) => item.name === str || item.filename?.includes(str))
        return {
          ...item,
          canDelete: localStorageHelper.canDeleteItem(item.name, "skill"),
          ...buildMarketInstalledFlags(item, "skill", isInstalled)
        }
      })
    )
  }, [installedSkills])

  useEffect(() => {
    installedSkillsRef.current = installedSkills
  }, [installedSkills])

  useEffect(() => {
    if (activeTab === ORG_SKILL_MARKET_TYPE) {
      setUploaderProfiles({})
      return
    }
    const sourceItems =
      activeTab === "skill" ? skillsData : activeTab === "mcp" ? mcpsData : pluginsData
    const sapIds = sourceItems.map((item) => item.user_id?.trim() || "").filter(Boolean)
    void loadUploaderProfiles(sapIds)
  }, [activeTab, skillsData, mcpsData, pluginsData, loadUploaderProfiles, reloadToken])

  useEffect(() => {
    setMcpsData((prev) =>
      prev.map((item) => ({
        ...item,
        canDelete: localStorageHelper.canDeleteItem(item.name, "mcp"),
        ...buildMarketInstalledFlags(item, "mcp", installedMcps.includes(item.name))
      }))
    )
  }, [installedMcps])

  useEffect(() => {
    installedMcpsRef.current = installedMcps
  }, [installedMcps])

  useEffect(() => {
    setPluginsData((prev) =>
      prev.map((item) => ({
        ...item,
        canDelete: localStorageHelper.canDeleteItem(item.name, "plugin"),
        ...buildMarketInstalledFlags(item, "plugin", installedPlugins.includes(item.name))
      }))
    )
  }, [installedPlugins])

  useEffect(() => {
    installedPluginsRef.current = installedPlugins
  }, [installedPlugins])

  // 新增：更新安装功能
  const handleUpdateInstall = async (item: MarketItem) => {
    if (item.installDisabledReason) {
      toast.info(item.installDisabledReason)
      return
    }
    const itemKey = item.id || item.name

    // 添加到更新中集合
    setUpdatingItems((prev) => new Set(prev).add(itemKey))

    try {
      const itemName = item.name || item.id || ""

      if (!itemName) {
        console.error("Item name is required for update install")
        return
      }

      if (activeTab === "plugin") {
        const response = await installMarketPluginUpdate(item)

        if (response.success) {
          console.log(`Successfully updated and installed ${item.name}`)
          toast.success(
            `已为您更新并安装「${item.name}」到${getMarketTypeLabel(activeTab)}，请新开一个会话试试效果。`
          )
          await loadInstalledPlugins()
          bumpPluginVersion()
          triggerReload()
        } else {
          console.error("Update install failed:", response.error)
          setError(response.error || "更新安装失败")
        }
        return
      }

      // 根据类型处理已有的安装项目
      if (activeTab === "skill" && window.api?.skills?.delete) {
        try {
          // 查找已安装的skill路径
          const skillsMetadata = await window.api.skills.list()
          const existingSkill = skillsMetadata.find((skill) => skill.name === itemName)

          if (existingSkill) {
            console.log(`Deleting existing skill: ${existingSkill.path}`)
            await window.api.skills.delete(existingSkill.path)
          }
        } catch (deleteError) {
          console.warn("Failed to delete existing skill, continuing with install:", deleteError)
        }
      } else if (activeTab === "mcp" && window.api?.mcp?.delete) {
        try {
          // 查找已安装的mcp路径
          const mcpsMetadata = await window.api.mcp.list()
          const existingMcp = mcpsMetadata.find((mcp) => mcp.name === itemName)

          if (existingMcp) {
            console.log(`Deleting existing mcp: ${existingMcp.id}`)
            await window.api.mcp.delete(existingMcp.id)
          }
        } catch (deleteError) {
          console.warn("Failed to delete existing mcp, continuing with install:", deleteError)
        }
      }

      // 下载并安装最新版本
      const response = await marketApi.downloadItem(
        itemName,
        activeTab,
        false,
        item.featured === "精品",
        item
      )

      if (response.success) {
        console.log(`Successfully updated and installed ${item.name}`)
        if (activeTab === "orgSkill") {
          marketInstalledSourceStorage.addName(itemName, activeTab)
          marketInstalledSourceStorage.addName(item.chinese_name || "", activeTab)
        }
        marketInstalledVersionStorage.setVersion(itemName, activeTab, item.version)
        toast.success(
          `已为您更新并安装「${item.name}」到${getMarketTypeLabel(activeTab)}，请新开一个会话试试效果。`
        )

        // 重新加载对应类型的已安装列表
        if (activeTab === "skill") {
          await loadInstalledSkills()
        } else if (activeTab === "mcp") {
          await loadInstalledMcps()
        }
        triggerReload()
      } else {
        console.error("Update install failed:", response.error)
        setError(response.error || "更新安装失败")
      }
    } catch (error) {
      console.error("Failed to update install item:", error)
      setError(error instanceof Error ? error.message : "更新安装失败")
    } finally {
      // 从更新中集合移除
      setUpdatingItems((prev) => {
        const newSet = new Set(prev)
        newSet.delete(itemKey)
        return newSet
      })
    }
  }

  // Load data for current tab
  useEffect(() => {
    const getMarketDataByTab = async (tab: MarketItemType): Promise<MarketApiResponse> => {
      switch (tab) {
        case "mcp":
          return marketApi.getMcps()
        case "plugin":
          return marketApi.getPlugins()
        default:
          return { success: false, error: "未知资源类型" }
      }
    }

    const addItemFlags = (items: MarketItem[], type: MarketItemType): MarketItem[] => {
      return items.map((item) => {
        const normalizedSkillName = normalizeSkillName(item.name)
        const isInstalled =
          type === "skill"
            ? installedSkillsRef.current.includes(item.name) ||
              installedSkillsRef.current.some(
                (str) => item.name === str || item.filename?.includes(str)
              )
            : type === "mcp"
              ? installedMcpsRef.current.includes(item.name)
              : installedPluginsRef.current.includes(item.name)

        return {
          ...item,
          canDelete: localStorageHelper.canDeleteItem(item.name, type),
          installDisabledReason:
            type === "skill" && uploadedSkillNameSetRef.current.has(normalizedSkillName)
              ? uploadedSkillDisabledReason
              : undefined,
          ...buildMarketInstalledFlags(item, type, isInstalled)
        }
      })
    }

    const setTabData = (type: MarketItemType, items: MarketItem[]) => {
      switch (type) {
        case "skill":
          setSkillsData(items)
          break
        case "mcp":
          setMcpsData(items)
          break
        case "plugin":
          setPluginsData(items)
          break
      }
    }

    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        if (activeTab === "skill") {
          const skillRes = await getAllSkills()
          if ((!skillRes.success || !skillRes.data) && USE_MARKET_MOCK_ON_ERROR) {
            console.warn(
              `[MarketPanel] getAllSkills failed, fallback to mock data. error=${skillRes.error}`
            )
            const mockResponse = getMarketMockResponse("skill")
            setSkillUsageSummary({})
            setTabData("skill", addItemFlags(mockResponse.data || [], "skill"))
            setError(null)
            return
          }
          if (!skillRes.success || !skillRes.data) {
            setError(skillRes.error || "加载数据失败")
            setSkillUsageSummary({})
            setTabData("skill", [])
            return
          }

          setSkillUsageSummary(skillRes.summary || {})
          setTabData("skill", addItemFlags(skillRes.data || [], "skill"))
          return
        }

        if (activeTab === "orgSkill") {
          return
        }

        let response = await getMarketDataByTab(activeTab)

        if ((!response.success || !response.data) && USE_MARKET_MOCK_ON_ERROR) {
          console.warn(
            `[MarketPanel] API failed on ${activeTab}, fallback to mock data. error=${response.error}`
          )
          response = getMarketMockResponse(activeTab)
          setError(null)
        } else if (!response.success || !response.data) {
          setError(response.error || "加载数据失败")
          setTabData(activeTab, [])
          return
        }

        setTabData(activeTab, addItemFlags(response.data || [], activeTab))
      } catch (error) {
        console.error("Failed to load market data:", error)
        if (USE_MARKET_MOCK_ON_ERROR) {
          console.warn(`[MarketPanel] Exception on ${activeTab}, fallback to mock data.`, error)
          const mockResponse = getMarketMockResponse(activeTab)
          setTabData(activeTab, addItemFlags(mockResponse.data || [], activeTab))
          setError(null)
        } else {
          setError(error instanceof Error ? error.message : "加载数据失败")
          setTabData(activeTab, [])
        }
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [activeTab, reloadToken, uploadedSkillDisabledReason])

  useEffect(() => {
    const previousActiveTab = previousActiveTabRef.current
    previousActiveTabRef.current = activeTab
    hasSavedListScrollRef.current = false
    shouldRestoreListScrollRef.current = false
    setDetailMode("list")
    setSelectedItemKey(null)
    setSelectedItemSnapshot(null)
    if (previousActiveTab === "orgSkill" && activeTab !== "orgSkill") {
      setPendingOrgSkillDetailName(null)
    }
    resetDetailState()
    setCategoryFilter(null)
  }, [activeTab])

  useEffect(() => {
    if (detailMode === "detail") return
    setAdminModeEnabled(false)
  }, [detailMode])

  const getCurrentData = () => {
    switch (activeTab) {
      case "skill":
        return skillsData
      case "orgSkill":
        return []
      case "mcp":
        return mcpsData
      case "plugin":
        return pluginsData
      default:
        return []
    }
  }

  const currentData = getCurrentData()
  useEffect(() => {
    if (loading) return
    const updatedItems = currentData.filter((item) => item.installed && item.updateAvailable)
    if (updatedItems.length === 0) return

    const noticeKey = `${activeTab}:${updatedItems
      .map((item) => `${item.name}@${item.version || ""}`)
      .join("|")}`
    if (updateNoticeShownRef.current.has(noticeKey)) return

    updateNoticeShownRef.current.add(noticeKey)
    const firstItem = updatedItems[0]
    const extraCount = updatedItems.length - 1
    toast.info(
      extraCount > 0
        ? `已安装的「${firstItem.name}」等 ${updatedItems.length} 个${getMarketTypeLabel(activeTab)}有更新，可点击更新安装。`
        : `已安装的「${firstItem.name}」有更新，可点击更新安装。`
    )
  }, [activeTab, currentData, loading])

  const selectedItem =
    selectedItemKey !== null
      ? currentData.find((item) => getItemKey(item) === selectedItemKey) ||
        (selectedItemSnapshot && getItemKey(selectedItemSnapshot) === selectedItemKey
          ? selectedItemSnapshot
          : null)
      : null
  const selectedSkillMetrics =
    activeTab === "skill" && selectedItem
      ? getSkillMetricByName(skillUsageSummary, selectedItem.name)
      : null
  const selectedSkillCallCount = activeTab === "skill" ? (selectedSkillMetrics?.calls ?? 0) : null
  const selectedSkillUserCount =
    activeTab === "skill"
      ? // 详情视图优先用实时查询值；若未加载到则回退列表汇总值。
        (selectedSkillUsage?.uniqueUsersCount ?? selectedSkillMetrics?.users ?? 0)
      : null
  const shouldResolveUploader = activeTab !== ORG_SKILL_MARKET_TYPE
  let selectedUploaderProfile: UploaderProfile | null = null
  if (selectedItem) {
    if (activeTab === ORG_SKILL_MARKET_TYPE) {
      selectedUploaderProfile = getOrgSkillUploaderProfile(selectedItem)
    } else if (shouldResolveUploader && selectedItem.user_id) {
      selectedUploaderProfile = resolveUploaderProfile(uploaderProfiles, selectedItem.user_id)
    }
  }
  const selectedUploaderFallback =
    selectedItem?.user_id || selectedItem?.managerName || selectedItem?.managerDepartment
  const selectedSkillUsageRows = useMemo(() => {
    const users = selectedSkillUsage?.users ?? []
    const emptyUserCalls = selectedSkillUsage?.emptyUserCalls ?? 0
    if (emptyUserCalls <= 0) return users
    // 在用户明细表追加“空用户”占位行，显式展示空用户调用次数。
    return [
      ...users,
      {
        sapId: "__empty_user__",
        userName: "空用户（未记录）",
        orgName: "",
        count: emptyUserCalls
      }
    ]
  }, [selectedSkillUsage])

  useEffect(() => {
    if (activeTab !== "skill") return
    if (!canViewSkillUserDetail) return
    if (detailMode !== "detail") return
    if (!selectedItem?.name) return
    if (skillUsageLoading) return
    if (selectedSkillUsage !== null) return
    void loadSkillUserStats(selectedItem.name)
  }, [
    activeTab,
    canViewSkillUserDetail,
    detailMode,
    selectedItem,
    skillUsageLoading,
    selectedSkillUsage,
    loadSkillUserStats
  ])

  useEffect(() => {
    if (activeTab !== "skill") return
    if (detailMode !== "detail") return
    if (!selectedItem?.name) return
    void loadSkillRecentTraces(selectedItem.name)
  }, [activeTab, detailMode, selectedItem?.name, loadSkillRecentTraces])

  const loadDetailDataForItem = async (item: MarketItem) => {
    setDetailLoading(true)
    resetDetailState()
    try {
      const installFile =
        activeTab === "orgSkill"
          ? await marketApi.fetchOrgSkillInstallFile(item)
          : await marketApi.fetchInstallFile(item.name, activeTab)
      const installFilename = installFile.filename || item.filename || `${item.name}`

      if (!isAllowedDetailFile(activeTab, installFilename)) {
        throw new Error(
          activeTab === "skill"
            ? "Skill 详情文件仅支持 .zip 或 .md"
            : activeTab === "plugin"
              ? "Plugin 详情文件仅支持 .zip"
              : "MCP 详情文件仅支持 .json"
        )
      }

      if (activeTab === "skill" || activeTab === "orgSkill") {
        const baseSkill: SkillMetadata = {
          name: item.name,
          description: item.description || "Market skill",
          path: installFilename,
          source: "user",
          version: item.version ? formatMarketVersionLabel(item.version) : "v1.0.0"
        }
        setSkillDetailSkill(baseSkill)
        await loadSkillPreviewFromInstallFile(baseSkill, installFilename, installFile.blob)
      } else if (activeTab === "mcp") {
        const text = await installFile.blob.text()
        const parsed = JSON.parse(text)
        const mcpServerConfig = parsed?.mcpServers
          ? Object.values(parsed.mcpServers)[0]
          : parsed?.url
            ? parsed
            : null

        if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
          throw new Error("MCP 文件内容不合法，无法解析连接器信息")
        }

        const config = mcpServerConfig as Record<string, unknown>
        const isStdio = typeof config.command === "string" && config.command.trim().length > 0
        const url = typeof config.url === "string" ? config.url : ""
        setMcpDetailConnector({
          id: item.name,
          name: typeof config.name === "string" ? config.name : item.name,
          kind: isStdio ? "stdio" : "remote",
          url: isStdio ? undefined : url,
          command: isStdio ? (config.command as string) : undefined,
          args:
            isStdio &&
            Array.isArray(config.args) &&
            config.args.every((arg): arg is string => typeof arg === "string")
              ? config.args
              : undefined,
          env:
            isStdio && config.env && typeof config.env === "object" && !Array.isArray(config.env)
              ? Object.fromEntries(
                  Object.entries(config.env as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string"
                  )
                )
              : undefined,
          enabled: false,
          lazyLoad: false,
          createdAt: item.created_at,
          updatedAt: getMarketUpdatedAt(item)
        })
      } else if (activeTab === "plugin") {
        // The zip is already downloaded above; parse it (without installing) to
        // surface real Skill/MCP/Hook counts instead of hardcoded zeros.
        pluginDetailFileBlobRef.current = installFile.blob
        const buffer = await installFile.blob.arrayBuffer()
        const detail = await window.api.plugins.inspectZip(buffer)
        setPluginDetailPlugin({
          id: item.name,
          name: item.name,
          version: item.version || "unknown",
          description: item.description || "",
          author: item.user_id ? `用户 ${item.user_id}` : "未知作者",
          path: installFilename,
          enabled: false,
          skillCount: detail.skills.length,
          mcpServerCount: detail.mcpServers.length,
          hookCount: detail.hookCount,
          createdAt: item.created_at,
          updatedAt: getMarketUpdatedAt(item)
        })
        setPluginDetailData({
          ...detail,
          manifest: detail.manifest ?? {
            name: item.name,
            version: item.version,
            description: item.description,
            author: item.user_id ? `用户 ${item.user_id}` : undefined
          }
        })
      }
    } catch (detailError) {
      console.error("Failed to load detail data:", detailError)
      setDetailError(detailError instanceof Error ? detailError.message : "加载详情失败")
    } finally {
      setDetailLoading(false)
    }
  }

  const isMineUploadedItem = useCallback(
    (item: MarketItem): boolean => {
      if (localStorageHelper.canDeleteItem(item.name, activeTab)) return true
      return doesMarketUserIdMatchCurrentUser(item.user_id, currentUserCandidateSet, currentUserSapId)
    },
    [activeTab, currentUserCandidateSet, currentUserSapId]
  )

  const toggleUploadFilterMode = useCallback((mode: UploadFilterMode) => {
    setUploadFilterModes((prev) =>
      prev.includes(mode) ? prev.filter((item) => item !== mode) : [...prev, mode]
    )
  }, [])

  const uploadFilterLabel = useMemo(() => {
    if (uploadFilterModes.length === 0) return "全部项目"
    if (uploadFilterModes.length === 1) {
      return uploadFilterOptions.find((option) => option.value === uploadFilterModes[0])?.label
    }
    return `已选 ${uploadFilterModes.length} 项`
  }, [uploadFilterModes])

  const filteredData = useMemo(
    () =>
      currentData.filter((item) => {
        if (
          activeTab !== ORG_SKILL_MARKET_TYPE &&
          !canCurrentUserViewMarketItem(item, currentUserSapId, currentUserCandidateSet, currentUserPathName)
        ) {
          return false
        }
        const matchesSearch = matchesMarketSearchQuery(item, activeSearchQuery)
        if (!matchesSearch) return false
        if (
          uploadFilterModes.length > 0 &&
          !uploadFilterModes.some((mode) => {
            if (mode === "mine") return isMineUploadedItem(item)
            if (mode === "installed") return item.installed
            if (mode === "featured") return item.featured === "精品"
            if (mode === "certified") return item.tag?.trim() === "认证"
            return false
          })
        ) {
          return false
        }

        if (!categoryFilter) return true
        return getCategoryFilterName(item.category) === categoryFilter
      }),
    [
      activeSearchQuery,
      activeTab,
      categoryFilter,
      currentData,
      currentUserCandidateSet,
      currentUserSapId,
      isMineUploadedItem,
      uploadFilterModes
    ]
  )

  const sortedSkillData = useMemo(() => {
    if (activeTab !== "skill") return filteredData
    if (filteredData.length === 0) return []
    return sortSkillItemsByUsage(filteredData, skillUsageSummary, skillSortMode)
  }, [activeTab, filteredData, skillSortMode, skillUsageSummary])
  const visibleMarketData = activeTab === "skill" ? sortedSkillData : filteredData
  const activeMarketPageNum = marketPageNums[activeTab] ?? 1
  const marketTotalItems = visibleMarketData.length
  const marketTotalPages = Math.max(1, Math.ceil(marketTotalItems / MARKET_FRONTEND_PAGE_SIZE))
  const safeMarketPageNum = Math.min(Math.max(1, activeMarketPageNum), marketTotalPages)
  const paginatedMarketData = useMemo(() => {
    const startIndex = (safeMarketPageNum - 1) * MARKET_FRONTEND_PAGE_SIZE
    return visibleMarketData.slice(startIndex, startIndex + MARKET_FRONTEND_PAGE_SIZE)
  }, [safeMarketPageNum, visibleMarketData])
  const hasPreviousMarketPage = safeMarketPageNum > 1
  const hasNextMarketPage = safeMarketPageNum < marketTotalPages
  const emptyResultMessage = activeSearchQuery.trim()
    ? "未找到匹配的项目"
    : uploadFilterModes.length > 1
      ? "未找到符合筛选的项目"
      : uploadFilterModes[0] === "mine"
        ? "未找到你上传的项目"
        : uploadFilterModes[0] === "installed"
          ? "未找到你安装的项目"
          : uploadFilterModes[0] === "featured"
            ? "未找到精品项目"
            : uploadFilterModes[0] === "certified"
              ? "未找到认证项目"
              : "暂无可用项目"

  useEffect(() => {
    if (activeTab === ORG_SKILL_MARKET_TYPE) return
    resetMarketPageForTab(activeTab)
  }, [
    activeSearchQuery,
    activeTab,
    categoryFilter,
    resetMarketPageForTab,
    skillSortMode,
    uploadFilterModes
  ])

  useEffect(() => {
    if (activeTab === ORG_SKILL_MARKET_TYPE) return
    if (activeMarketPageNum === safeMarketPageNum) return
    setMarketPageForTab(activeTab, safeMarketPageNum)
  }, [activeMarketPageNum, activeTab, safeMarketPageNum, setMarketPageForTab])

  const marketCategoryStats = useMemo(() => {
    const categoryCounter = new Map<string, { primary: string; count: number }>()
    for (const item of currentData) {
      const categoryName = getCategoryFilterName(item.category)
      const primaryName = getPrimaryCategory(item.category) || "未分类"
      const existing = categoryCounter.get(categoryName)
      if (!existing) {
        categoryCounter.set(categoryName, { primary: primaryName, count: 1 })
      } else {
        existing.count += 1
        // 若出现同名二级类归属多个一级类，保持稳定且可预期的排序键
        if (primaryName.localeCompare(existing.primary, "zh-CN") < 0) {
          existing.primary = primaryName
        }
      }
    }

    return Array.from(categoryCounter.entries())
      .map(([name, value]) => ({ name, count: value.count, primary: value.primary }))
      .sort((a, b) => {
        if (a.primary !== b.primary) return a.primary.localeCompare(b.primary, "zh-CN")
        return a.name.localeCompare(b.name, "zh-CN")
      })
  }, [currentData])

  useEffect(() => {
    if (!pendingInitialCategoryFilter) return
    if (activeTab !== "skill") return
    if (loading) return

    const matchedCategory =
      marketCategoryStats.find((category) => category.name === pendingInitialCategoryFilter)
        ?.name ?? pendingInitialCategoryFilter
    setCategoryFilter(matchedCategory)
    setPendingInitialCategoryFilter(null)
  }, [activeTab, loading, marketCategoryStats, pendingInitialCategoryFilter])

  const openItemDetail = async (item: MarketItem) => {
    if (detailMode === "list") {
      captureListScrollPosition()
    }
    setSelectedItemKey(getItemKey(item))
    setSelectedItemSnapshot(item)
    setDetailMode("detail")
    const detailTasks: Array<Promise<void>> = []

    if (activeTab === "skill") {
      setSelectedSkillUsage(null)
      setSkillTraceViewMode("thread")
      setSkillUsageLoading(false)
    } else {
      setSelectedSkillUsage(null)
    }

    if (item.featured === "精品" && activeTab === "skill") {
      await Promise.all(detailTasks)
      return
    }

    detailTasks.push(loadDetailDataForItem(item))
    await Promise.all(detailTasks)
  }
  openItemDetailRef.current = openItemDetail

  useEffect(() => {
    const detailName = marketInitialSkillDetailName?.trim()
    if (!detailName || activeTab !== "skill" || loading) return
    const targetItem = skillsData.find(
      (item) =>
        item.name === detailName &&
        canCurrentUserViewMarketItem(item, currentUserSapId, currentUserCandidateSet, currentUserPathName)
    )
    if (!targetItem) {
      if (skillsData.length > 0) setMarketInitialSkillDetailName(null)
      return
    }

    setMarketInitialSkillDetailName(null)
    void openItemDetailRef.current(targetItem)
  }, [
    activeTab,
    currentUserCandidateSet,
    loading,
    marketInitialSkillDetailName,
    currentUserSapId,
    setMarketInitialSkillDetailName,
    skillsData
  ])

  const backToList = () => {
    shouldRestoreListScrollRef.current =
      hasSavedListScrollRef.current && savedListScrollRef.current.activeTab === activeTab
    setDetailMode("list")
    setSelectedItemKey(null)
    setSelectedItemSnapshot(null)
    resetDetailState()
  }

  useLayoutEffect(() => {
    if (detailMode !== "list" || !shouldRestoreListScrollRef.current) return

    let firstFrame = 0
    let secondFrame = 0
    firstFrame = window.requestAnimationFrame(() => {
      restoreListScrollPosition()
      secondFrame = window.requestAnimationFrame(() => {
        restoreListScrollPosition()
        shouldRestoreListScrollRef.current = false
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [detailMode, restoreListScrollPosition])

  const handleDelete = (item: MarketItem) => {
    setDeleteDialog({ open: true, item })
  }

  const handleUninstall = async (item: MarketItem) => {
    if (item.installDisabledReason) {
      toast.info(item.installDisabledReason)
      return
    }
    const itemName = item.name || item.id || ""
    if (!itemName) return

    try {
      if ((activeTab === "skill" || activeTab === "orgSkill") && window.api?.skills?.delete) {
        const skillsMetadata = await window.api.skills.list()
        const itemNameCandidates = new Set([itemName, item.chinese_name].filter(Boolean))
        const existingSkill = skillsMetadata.find(
          (skill) =>
            itemNameCandidates.has(skill.name) ||
            (item.filename ? skill.path.includes(item.filename) : false)
        )
        if (existingSkill) {
          await window.api.skills.delete(existingSkill.path)
        }
        marketInstalledVersionStorage.removeVersion(itemName, activeTab)
        if (activeTab === "orgSkill") {
          marketInstalledSourceStorage.removeName(itemName, activeTab)
          marketInstalledSourceStorage.removeName(item.chinese_name || "", activeTab)
        }
        await loadInstalledSkills()
      } else if (activeTab === "mcp" && window.api?.mcp?.delete) {
        const mcpsMetadata = await window.api.mcp.list()
        const existingMcp = mcpsMetadata.find((mcp) => mcp.name === itemName)
        if (existingMcp) {
          await window.api.mcp.delete(existingMcp.id)
        }
        marketInstalledVersionStorage.removeVersion(itemName, activeTab)
        await loadInstalledMcps()
      } else if (activeTab === "plugin") {
        const pluginsMetadata = await window.api.plugins.list()
        const existingPlugin = findInstalledPluginForMarketItem(pluginsMetadata, item)
        if (existingPlugin) {
          await deleteInstalledMarketPlugin(existingPlugin)
        }
        marketInstalledVersionStorage.removeVersion(itemName, activeTab)
        await loadInstalledPlugins()
        bumpPluginVersion()
      }
      setSelectedItemSnapshot((prev) =>
        prev && getItemKey(prev) === getItemKey(item)
          ? {
              ...prev,
              installed: false,
              updateAvailable: false,
              installedVersion: undefined
            }
          : prev
      )
    } catch (error) {
      console.error("Failed to uninstall item:", error)
      setError(error instanceof Error ? error.message : "卸载失败")
    }
  }

  const confirmDelete = async () => {
    if (!deleteDialog.item) return

    try {
      const itemName = deleteDialog.item.name || deleteDialog.item.id || ""
      // 修复type=undefined的问题：使用当前activeTab作为type
      const itemType = deleteDialog.item.type || activeTab

      if (!itemName) {
        console.error("Item name is required for deletion")
        return
      }

      const response = await marketApi.deleteItem(itemName, itemType)
      if (response.message) {
        // Remove item from localStorage tracking
        localStorageHelper.removeUploadedItem(itemName, itemType)

        // Remove item from local state
        const itemId = deleteDialog.item.id || deleteDialog.item.name
        switch (itemType) {
          case "skill":
            setSkillsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
            break
          case "mcp":
            setMcpsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
            break
          case "plugin":
            setPluginsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
            break
        }

        if (selectedItemKey === itemId) {
          backToList()
        }
      }
    } catch (error) {
      console.error("Failed to delete item:", error)
      setError(error instanceof Error ? error.message : "删除失败")
    } finally {
      setDeleteDialog({ open: false, item: null })
    }
  }

  const handleDownload = async (item: MarketItem, downloadToLocal = false) => {
    if (!downloadToLocal && item.installDisabledReason) {
      toast.info(item.installDisabledReason)
      return
    }
    const itemKey = item.id || item.name

    // Add to downloading set
    setDownloadingItems((prev) => new Set(prev).add(itemKey))

    try {
      const itemName = item.name || item.id || ""

      if (!itemName) {
        console.error("Item name is required for download")
        return
      }

      // Use current activeTab as the type and pass the downloadToLocal flag
      const response = await marketApi.downloadItem(
        itemName,
        activeTab,
        downloadToLocal,
        item.featured === "精品",
        item
      )
      if (response.success) {
        console.log(`Downloaded ${item.name}`)

        // Show different success messages based on download type
        if (downloadToLocal) {
          toast.success(`「${item.name}」已保存到本地。`)
        } else {
          if (activeTab === "orgSkill") {
            marketInstalledSourceStorage.addName(itemName, activeTab)
            marketInstalledSourceStorage.addName(item.chinese_name || "", activeTab)
          }
          marketInstalledVersionStorage.setVersion(itemName, activeTab, item.version)
          toast.success(
            `「${item.name}」已安装到${getMarketTypeLabel(activeTab)}，请新开一个会话试试效果。`
          )

          // 重新加载对应类型的已安装列表 (only for app installs, not local downloads)
          if (activeTab === "skill" || activeTab === "orgSkill") {
            await loadInstalledSkills()
          } else if (activeTab === "mcp") {
            await loadInstalledMcps()
          } else if (activeTab === "plugin") {
            await loadInstalledPlugins()
            bumpPluginVersion()
          }
        }
      } else {
        console.error("Download failed:", response.error)
        if (response.error) {
          toast.error(response.error)
        }
        setError(response.error || "下载失败")
      }
    } catch (error) {
      console.error("Failed to download item:", error)
      const errorMessage = error instanceof Error ? error.message : "下载失败"
      toast.error(errorMessage)
      setError(errorMessage)
    } finally {
      // Remove from downloading set
      setDownloadingItems((prev) => {
        const newSet = new Set(prev)
        newSet.delete(itemKey)
        return newSet
      })
    }
  }

  const handleUploadSuccess = () => {
    toast.success(`${getMarketTypeLabel(activeTab)}已上传到 Market，请新开一个会话试试效果。`)
    // Reload the current tab data
    triggerReload()
  }

  const handleUploadClick = () => {
    // Open upload dialog for all types
    setUploadDialog(true)
  }

  const handleUpdate = (item: MarketItem) => {
    setUpdateDialog({ open: true, item })
  }

  const handleUniversalUpload = async (
    file: File | null,
    name: string,
    description: string,
    category: string,
    version: string,
    guidance?: string,
    chineseName?: string,
    userId?: string,
    extraJson?: string
  ) => {
    try {
      if (!file) {
        return {
          success: false,
          error: "文件不能为空"
        }
      }

      const result = await marketApi.uploadFile(
        file,
        activeTab,
        name,
        description,
        category,
        version,
        guidance,
        chineseName,
        userId,
        extraJson
      )

      // If upload is successful, record it in localStorage
      if (result.success) {
        localStorageHelper.addUploadedItem(name, activeTab)
      }

      return result
    } catch (error) {
      console.error("Failed to upload file:", error)
      setError(error instanceof Error ? error.message : "上传失败")
      return {
        success: false,
        error: error instanceof Error ? error.message : "上传失败"
      }
    }
  }

  const handleUniversalUpdate = async (
    file: File | null,
    name: string,
    description: string,
    category: string,
    version: string,
    guidance?: string,
    chineseName?: string,
    userId?: string,
    extraJson?: string,
    ip?: string
  ) => {
    try {
      // 更新时允许文件为空，这样可以只更新元数据
      // if (!file) {
      //   return {
      //     success: false,
      //     error: "文件不能为空"
      //   }
      // }

      const result = await marketApi.updateItem(
        file, // 允许传递null
        activeTab,
        name,
        description,
        category,
        version,
        guidance,
        chineseName,
        userId,
        extraJson,
        ip
      )

      // Update is successful, no need to update localStorage since item already exists
      return result
    } catch (error) {
      console.error("Failed to update file:", error)
      setError(error instanceof Error ? error.message : "更新失败")
      return {
        success: false,
        error: error instanceof Error ? error.message : "更新失败"
      }
    }
  }

  const handleUpdateSuccess = () => {
    toast.success(`${getMarketTypeLabel(activeTab)}已更新到 Market，请新开一个会话试试效果。`)
    setUpdateDialog({ open: false, item: null })
    // Reload the current tab data
    triggerReload()
  }

  const renderDetailFilePanel = () => {
    if (!selectedItem) return null
    if (detailLoading) {
      return <div className="text-sm text-muted-foreground py-6">文件详情加载中...</div>
    }

    if (detailError) {
      return (
        <div className="rounded-lg border border-status-critical/30 bg-status-critical/10 px-4 py-3 text-sm text-status-critical">
          {detailError}
        </div>
      )
    }

    if (activeTab === "skill" || activeTab === "orgSkill") {
      if (activeTab === "skill" && selectedItem.featured === "精品") {
        return (
          <div className="rounded-xl border border-status-warning/30 bg-status-warning/10 p-6 text-sm text-status-warning">
            精品技能暂不支持查看详情文件内容，请直接安装后使用。
          </div>
        )
      }
      if (!skillDetailSkill) {
        return (
          <div className="text-sm text-muted-foreground py-6">
            暂未获取到 Skill 文件详情（通过安装接口拉取）。
          </div>
        )
      }
      return (
        <div className="border border-border rounded-lg ">
          <SkillDetail
            skill={skillDetailSkill}
            selectedFilePath={skillDetailSelectedFile}
            content={skillDetailContent}
            previewKind={skillDetailPreviewKind}
            binaryBase64={skillDetailBinaryBase64}
            binaryMimeType={skillDetailBinaryMimeType}
            isDisabled={false}
            onToggleEnabled={() => undefined}
            contentOnly={activeTab === "skill"}
            hideActions
          />
        </div>
      )
    }

    if (activeTab === "mcp") {
      if (!mcpDetailConnector) {
        return (
          <div className="text-sm text-muted-foreground py-6">
            暂未获取到 MCP 文件详情（通过安装接口拉取）。
          </div>
        )
      }
      return (
        <div className=" border border-border rounded-lg ">
          <MCPConnectorDetail
            connector={mcpDetailConnector}
            onToggleEnabled={() => undefined}
            onToggleLazyLoad={() => undefined}
            onDelete={() => undefined}
            onEdit={() => undefined}
            hideActions
            testByUrlOnly
          />
        </div>
      )
    }

    if (!pluginDetailPlugin) {
      return (
        <div className="text-sm text-muted-foreground py-6">
          暂未获取到 Plugin 文件详情（通过安装接口拉取）。
        </div>
      )
    }
    return (
      <div className="border border-border rounded-lg">
        <PluginDetailPanel
          plugin={pluginDetailPlugin}
          detail={pluginDetailData}
          onToggleEnabled={() => undefined}
          onDelete={() => undefined}
          hideActions
        />
      </div>
    )
  }

  const handleSkillTraceViewModeChange = (mode: DashboardTraceViewMode): void => {
    setSkillTraceViewMode(mode)
    if (selectedItem?.name) {
      void loadSkillRecentTraces(selectedItem.name, mode)
    }
  }

  const loadPluginSkillsForUpdateDialog = useCallback(async (): Promise<string[]> => {
    const targetItem = updateDialog.item
    if (activeTab !== "plugin" || detailMode !== "detail" || !targetItem) return []

    if (selectedItem?.name !== targetItem.name) return []

    if (pluginDetailFileBlobRef.current) {
      const buffer = await pluginDetailFileBlobRef.current.arrayBuffer()
      const detail = await window.api.plugins.inspectZip(buffer)
      const skills = Array.from(new Set(detail.skills.map((skill) => skill.trim()).filter(Boolean)))
      console.log("[MarketPanel] Refreshed plugin skills from detail file:", skills)
      return skills
    }

    const fallbackSkills = Array.from(
      new Set((pluginDetailData?.skills || []).map((skill) => skill.trim()).filter(Boolean))
    )
    console.log("[MarketPanel] Refreshed plugin skills from cached detail data:", fallbackSkills)
    return fallbackSkills
  }, [activeTab, detailMode, pluginDetailData, selectedItem?.name, updateDialog.item])

  return (
    <div className="market-theme flex flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      {detailMode === "detail" && selectedItem  && (
        <div className="border-b border-border bg-background-elevated px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="w-full flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                <ShoppingBag className="size-4 text-primary" />
              </div>
              <div className={"w-full "}>
                <div className={"w-full flex justify-between items-center"}>
                  <h2 className="text-[15px] font-medium leading-tight text-foreground">
                    {detailMode === "detail" && selectedItem
                      ? selectedItem.chinese_name || selectedItem.name
                      : "应用市场"}
                  </h2>
                  <span className="flex items-center gap-2">
                    {detailMode === "detail" &&
                    selectedItem &&
                    activeTab !== ORG_SKILL_MARKET_TYPE &&
                    isCurrentUserMarketAdmin ? (
                      <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-background-elevated px-2.5 py-1.5 text-[11px] text-muted-foreground">
                        <span>管理员模式</span>
                        <Switch
                          checked={adminModeEnabled}
                          onCheckedChange={setAdminModeEnabled}
                          aria-label="切换管理员模式"
                        />
                      </label>
                    ) : null}
                    {detailMode === "detail" && selectedItem ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={backToList}
                        className="h-8 cursor-pointer gap-1.5 rounded-lg border-primary/30 bg-primary/10 px-3.5 text-xs font-medium text-primary shadow-sm hover:bg-primary/15"
                      >
                        <ArrowLeft className="size-3.5" />
                        返回列表
                      </Button>
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {detailMode === "detail" && selectedItem ? (
        <MarketDetailView
          activeTab={activeTab}
          selectedItem={selectedItem}
          canManageSelectedItem={canCurrentUserEditOrDeleteMarketItem(
            selectedItem,
            currentLocalIp,
            isAdminModeActive
          )}
          detailFilePanel={renderDetailFilePanel()}
          canViewSkillUserDetail={canViewSkillUserDetail}
          selectedSkillCallCount={selectedSkillCallCount}
          selectedSkillUserCount={selectedSkillUserCount}
          selectedSkillUsageRows={selectedSkillUsageRows}
          skillUsageLoading={skillUsageLoading}
          selectedSkillTraces={selectedSkillTraces}
          skillTracesLoading={skillTracesLoading}
          skillTracesError={skillTracesError}
          selectedUploaderProfile={selectedUploaderProfile}
          selectedUploaderFallback={selectedUploaderFallback}
          downloadingItems={downloadingItems}
          updatingItems={updatingItems}
          getItemKey={getItemKey}
          getMarketTypeLabel={getMarketTypeLabel}
          formatMarketVersionLabel={formatMarketVersionLabel}
          isAutoOptimizedMarketItem={isAutoOptimizedMarketItem}
          onUpdateInstall={handleUpdateInstall}
          onDownload={handleDownload}
          onUninstall={handleUninstall}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onOpenSkillTraceDialog={() => setSkillTraceDialogOpen(true)}
        />
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as MarketItemType)}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <div className="px-5 pt-3 pb-0 bg-background border-b border-border">
            <TabsList className="grid w-full grid-cols-4 bg-background-interactive border border-border rounded-xl h-9 p-0.5">
              <TabsTrigger
                value="skill"
                className="rounded-lg text-xs text-muted-foreground transition-all data-[state=active]:bg-background-elevated data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Sparkles className="size-3 mr-1.5" />
                Skills
              </TabsTrigger>
              <OrgSkillMarketTabTrigger />
              <TabsTrigger
                value="mcp"
                className="rounded-lg text-xs text-muted-foreground transition-all data-[state=active]:bg-background-elevated data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Plug className="size-3 mr-1.5" />
                MCPs
              </TabsTrigger>
              <TabsTrigger
                value="plugin"
                className="rounded-lg text-xs text-muted-foreground transition-all data-[state=active]:bg-background-elevated data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                <Puzzle className="size-3 mr-1.5" />
                Plugins
              </TabsTrigger>
            </TabsList>
            <div className="mt-3 mb-3 rounded-xl border border-border bg-background-elevated px-3.5 py-3">
              <div className="flex items-start gap-2.5">
                {activeTab === "skill" ? (
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : activeTab === ORG_SKILL_MARKET_TYPE ? (
                  <OrgSkillMarketIntroIcon />
                ) : activeTab === "mcp" ? (
                  <Plug className="mt-0.5 size-4 shrink-0 text-status-nominal" />
                ) : (
                  <Puzzle className="mt-0.5 size-4 shrink-0 text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium leading-snug text-foreground">
                      {activeTabIntro.title}
                    </p>
                    {activeTab === ORG_SKILL_MARKET_TYPE ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1 rounded-lg border-primary/30 bg-primary/10 px-3 text-xs text-primary hover:bg-primary/15"
                        onClick={() => {
                          const url = `${import.meta.env.VITE_ZZJ_WEB_URL?.replace(/\/+$/, "")}/skill-market`
                          void window.electron.openExternal(url)
                        }}
                      >
                        跳转
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {activeTabIntro.description}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-hidden bg-background">
            <TabsContent value={activeTab} className="mt-0 h-full">
              <ScrollArea className="h-full" ref={listScrollAreaRef}>
                <div className="p-4 space-y-3">
                  {activeTab !== ORG_SKILL_MARKET_TYPE && (
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder={getMarketSearchPlaceholder(activeTab)}
                          value={activeSearchQuery}
                          onChange={(e) => setSearchQueryForTab(activeTab, e.target.value)}
                          className="h-9 rounded-xl border-border bg-background-elevated pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary"
                        />
                        {activeSearchQuery && (
                          <button
                            type="button"
                            aria-label="清空搜索"
                            onClick={() => setSearchQueryForTab(activeTab, "")}
                            className="absolute right-2.5 top-1/2 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background-interactive hover:text-foreground"
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>
                      <>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className="h-9 w-[132px] justify-between rounded-xl border-border bg-background-elevated px-3 text-xs font-normal text-muted-foreground hover:bg-background-interactive hover:text-foreground"
                            >
                              <span className="truncate">{uploadFilterLabel}</span>
                              <ChevronDown className="size-3.5 text-muted-foreground" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            className="w-[164px] rounded-xl border-border bg-popover p-1.5"
                          >
                            <button
                              type="button"
                              onClick={() => setUploadFilterModes([])}
                              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                                uploadFilterModes.length === 0
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground hover:bg-background-interactive"
                              }`}
                            >
                              <span>全部项目</span>
                              {uploadFilterModes.length === 0 && <Check className="size-3.5" />}
                            </button>
                            <div className="my-1 h-px bg-border" />
                            {uploadFilterOptions.map((option) => {
                              const checked = uploadFilterModes.includes(option.value)
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => toggleUploadFilterMode(option.value)}
                                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                                    checked
                                      ? "bg-accent text-accent-foreground"
                                      : "text-muted-foreground hover:bg-background-interactive"
                                  }`}
                                >
                                  <span>{option.label}</span>
                                  {checked && <Check className="size-3.5" />}
                                </button>
                              )
                            })}
                          </PopoverContent>
                        </Popover>
                        <Button
                          size="sm"
                          className="h-9 cursor-pointer gap-1.5 rounded-xl border-0 bg-button px-3 text-xs text-button-foreground hover:bg-button/90"
                          onClick={handleUploadClick}
                        >
                          <Plus className="size-3.5" />
                          {activeTab === "skill"
                            ? "上传技能"
                            : activeTab === "mcp"
                              ? "上传连接器"
                              : "上传插件"}
                        </Button>
                      </>
                    </div>
                  )}
                  {activeTab === "orgSkill" ? (
                    <OrgSkillMarketContent
                      initialSearchQuery={activeSearchQuery}
                      installedSkills={installedSkills}
                      reloadToken={reloadToken}
                      downloadingItems={downloadingItems}
                      onOpenDetail={openItemDetail}
                      onUninstall={handleUninstall}
                      initialDetailName={pendingOrgSkillDetailName}
                      onInitialDetailReady={(item) => {
                        void openItemDetailRef.current(item)
                      }}
                      onInitialDetailConsumed={() => setPendingOrgSkillDetailName(null)}
                    />
                  ) : loading ? (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <div className="mb-3 size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span className="text-sm">加载中…</span>
                    </div>
                  ) : error ? (
                    <div className="flex flex-col items-center justify-center py-16">
                      <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-status-critical/30 bg-status-critical/10">
                        <span className="text-base">❌</span>
                      </div>
                      <p className="mb-3 text-center text-sm text-status-critical">{error}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-lg border-border bg-background-interactive px-4 text-xs text-muted-foreground hover:bg-secondary"
                        onClick={() => {
                          setError(null)
                          triggerReload()
                        }}
                      >
                        重试
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
                      <aside className="rounded-2xl border border-border bg-background-elevated p-3 xl:sticky xl:top-4">
                        <div className="flex items-center justify-between mb-2 px-1">
                          <h3 className="text-xs font-medium text-muted-foreground">分类</h3>
                          {categoryFilter && (
                            <button
                              type="button"
                              onClick={() => setCategoryFilter(null)}
                              className="cursor-pointer text-xs text-primary transition-colors hover:text-primary/80"
                            >
                              清除
                            </button>
                          )}
                        </div>
                        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
                          {marketCategoryStats.length === 0 ? (
                            <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无分类</p>
                          ) : (
                            marketCategoryStats.map((category) => {
                              const isActive = categoryFilter === category.name
                              return (
                                <button
                                  key={category.name}
                                  type="button"
                                  onClick={() =>
                                    setCategoryFilter((prev) =>
                                      prev === category.name ? null : category.name
                                    )
                                  }
                                  className={`w-full flex items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer ${
                                    isActive
                                      ? "border border-primary/30 bg-accent text-accent-foreground"
                                      : "border border-transparent text-muted-foreground hover:bg-background-interactive"
                                  }`}
                                >
                                  <span className="text-[13px] leading-tight pr-2 break-all">
                                    {category.name}
                                  </span>
                                  <span
                                    className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${
                                      isActive
                                        ? "bg-primary/15 text-primary"
                                        : "bg-background-interactive text-muted-foreground"
                                    }`}
                                  >
                                    {category.count}
                                  </span>
                                </button>
                              )
                            })
                          )}
                        </div>
                      </aside>

                      <div
                        key={
                          visibleMarketData.length === 0
                            ? "market-results-empty"
                            : "market-results-list"
                        }
                        className="space-y-3 min-w-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span>
                              {categoryFilter
                                ? `当前分类：${categoryFilter}`
                                : `全部 ${getMarketTypePluralLabel(activeTab)}`}
                              {` · 筛选结果 ${visibleMarketData.length} 个 · 当前页 ${paginatedMarketData.length} 个`}
                            </span>
                            {visibleMarketData.length > 0 ? (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <span className="tabular-nums">
                                  第 {safeMarketPageNum} / {marketTotalPages} 页
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 rounded-lg border-border bg-background-elevated px-2.5 text-[11px] text-muted-foreground hover:bg-background-interactive"
                                  aria-label="上一页"
                                  onClick={() => setActiveMarketPage(safeMarketPageNum - 1)}
                                  disabled={!hasPreviousMarketPage}
                                >
                                  上一页
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 rounded-lg border-border bg-background-elevated px-2.5 text-[11px] text-muted-foreground hover:bg-background-interactive"
                                  aria-label="下一页"
                                  onClick={() => setActiveMarketPage(safeMarketPageNum + 1)}
                                  disabled={!hasNextMarketPage}
                                >
                                  下一页
                                </Button>
                              </div>
                            ) : null}
                          </div>
                          {activeTab === "skill" ? (
                            <div className="flex items-center gap-2">
                              <div className="inline-block w-[30px]">排序</div>
                              <Select
                                value={skillSortMode}
                                onValueChange={(value) => setSkillSortMode(value as SkillSortMode)}
                              >
                                <SelectTrigger className="h-7 w-[100px] rounded-lg border-border bg-background-elevated px-2 text-[11px] text-muted-foreground">
                                  <SelectValue placeholder="默认" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="default">默认</SelectItem>
                                  <SelectItem value="calls_desc">调用次数 ↓</SelectItem>
                                  <SelectItem value="calls_asc">调用次数 ↑</SelectItem>
                                  <SelectItem value="users_desc">用户数 ↓</SelectItem>
                                  <SelectItem value="users_asc">用户数 ↑</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          ) : null}
                        </div>
                        {visibleMarketData.length === 0 ? (
                          <div
                            key="market-empty-results"
                            className="flex flex-col items-center justify-center py-16 text-muted-foreground"
                          >
                            <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-border bg-background-interactive">
                              <ShoppingBag className="size-5 text-muted-foreground" />
                            </div>
                            <p className="text-sm">{emptyResultMessage}</p>
                          </div>
                        ) : (
                          <div
                            key="market-card-results"
                            ref={listCardContainerRef}
                            className="grid max-h-[calc(100vh-330px)] grid-cols-1 gap-3 overflow-y-auto pr-1 2xl:grid-cols-2"
                          >
                            {paginatedMarketData.map((item) => (
                              <MarketItemCard
                                key={getItemKey(item)}
                                item={item}
                                onOpenDetail={openItemDetail}
                                onDelete={handleDelete}
                                onUpdate={handleUpdate}
                                onDownload={handleDownload}
                                onUpdateInstall={handleUpdateInstall}
                                onUninstall={handleUninstall}
                                isDownloading={downloadingItems.has(item.id || item.name)}
                                isInstalled={item.installed}
                                isUpdating={updatingItems.has(item.id || item.name)}
                                installedVersion={item.installedVersion}
                                updateAvailable={item.updateAvailable}
                                installDisabledReason={item.installDisabledReason}
                                showProjectModeTag={activeTab === "plugin"}
                                marketTypeLabel={getMarketTypeLabel(activeTab)}
                                skillCallCount={
                                  activeTab === "skill"
                                    ? (getSkillMetricByName(skillUsageSummary, item.name)?.calls ??
                                      0)
                                    : null
                                }
                                skillUserCount={
                                  activeTab === "skill"
                                    ? (getSkillMetricByName(skillUsageSummary, item.name)?.users ??
                                      0)
                                    : null
                                }
                                uploaderProfile={
                                  shouldResolveUploader && item.user_id
                                    ? resolveUploaderProfile(uploaderProfiles, item.user_id)
                                    : null
                                }
                                showResolvedUploader={shouldResolveUploader}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </div>
        </Tabs>
      )}

      <Dialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open, item: null })}
      >
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle className="text-foreground">确认删除</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              您确定要删除 &quot;{deleteDialog.item?.name}&quot; 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-lg border-border bg-background-interactive text-muted-foreground hover:bg-secondary"
              onClick={() => setDeleteDialog({ open: false, item: null })}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              className="rounded-lg border-0"
              onClick={confirmDelete}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={skillTraceDialogOpen} onOpenChange={setSkillTraceDialogOpen}>
        <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base">
              Skill Trace 记录 · {selectedItem?.chinese_name || selectedItem?.name || "-"}
            </DialogTitle>
            <DialogDescription className="text-xs">最近 10 条 Trace 记录（本月）</DialogDescription>
          </DialogHeader>
          <TraceExplorer
            traces={selectedSkillTraces}
            loading={skillTracesLoading}
            error={skillTracesError}
            title="最近 10 条 Trace 记录（本月）"
            subtitle="选择记录定位到对话"
            viewMode={skillTraceViewMode}
            onViewModeChange={handleSkillTraceViewModeChange}
            emptyText="本月暂无该 Skill 的 trace 记录"
            showCodeStats={false}
            className="min-h-0 flex-1"
          />
        </DialogContent>
      </Dialog>

      {activeTab !== "orgSkill" && (
        <>
          {/* Use UniversalUploadDialog for all uploadable types */}
          <UniversalUploadDialog
            open={uploadDialog}
            onOpenChange={setUploadDialog}
            onSuccess={handleUploadSuccess}
            resourceType={activeTab}
            onUpload={handleUniversalUpload}
          />

          {/* Update dialog using UniversalUploadDialog component */}
          <UniversalUploadDialog
            open={updateDialog.open}
            onOpenChange={(open) => setUpdateDialog({ open, item: null })}
            onSuccess={handleUpdateSuccess}
            resourceType={activeTab}
            onUpload={handleUniversalUpdate}
            isUpdate={true}
            existingItem={
              updateDialog.item
                ? {
                    name: updateDialog.item.name,
                    description: updateDialog.item.description,
                    category: updateDialog.item.category || "研发场景",
                    version: updateDialog.item.version,
                    guidance: updateDialog.item.guidance,
                    chinese_name: updateDialog.item.chinese_name,
                    user_id: updateDialog.item.user_id,
                    extra_json: updateDialog.item.extra_json,
                    ip: updateDialog.item.ip
                  }
                : undefined
            }
            isAdminModeActive={isAdminModeActive}
            loadPluginSkills={
              activeTab === "plugin" &&
              detailMode === "detail" &&
              !!selectedItem &&
              selectedItem.name === updateDialog.item?.name
                ? loadPluginSkillsForUpdateDialog
                : undefined
            }
          />
        </>
      )}
    </div>
  )
}
