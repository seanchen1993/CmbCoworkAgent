import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  GitBranch,
  User,
  Edit,
  Calendar,
  FileText,
  Lightbulb,
  ArrowLeft,
  BarChart3
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import type { McpConnectorConfig, PluginManifest, PluginMetadata, SkillMetadata } from "@/types"
import { UniversalUploadDialog } from "./UniversalUploadDialog"
import { SkillDetail } from "./SkillsPanel"
import { MCPConnectorDetail } from "./MCPConnectorDetail"
import { PluginDetailPanel } from "./PluginsPanel"
import { marketApi, MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"
import { getMarketMockResponse } from "./MarketMockData"
import { getDefaultRange, parseTopUsersFromAgg } from "../dashboard/use-dashboard"
import {
  getAllSkills,
  getSkillMetricByName,
  sortSkillItemsByUsage,
  type SkillSortMode,
  type SkillUsageSummaryMetric
} from "../../lib/skill-data-service"

// Local storage helper functions for tracking user uploads
const UPLOADED_ITEMS_KEY = "marketplace_uploaded_items"
const USE_MARKET_MOCK_ON_ERROR =
  String(import.meta.env.VITE_MARKET_MOCK_ON_ERROR || "false")
    .trim()
    .toLowerCase() === "true"

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

interface UploadedItemRecord {
  name: string
  type: MarketItemType
  uploadedAt: string
}

interface SkillUserUsage {
  sapId: string
  userName: string
  orgName: string
  count: number
}

interface SkillUsageDetail {
  users: SkillUserUsage[]
}

interface UploaderProfile {
  sapId: string
  userName: string
  orgName: string
}

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
  skillCallCount?: number | null
  skillUserCount?: number | null
  uploaderProfile?: UploaderProfile | null
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
                          skillCallCount = null,
                          skillUserCount = null,
                          uploaderProfile = null
                        }: MarketItemCardProps) {
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
  const isSkillCard = skillCallCount !== null || skillUserCount !== null
  const uploaderSapId = uploaderProfile?.sapId || item.user_id || ""
  const uploaderUserName = uploaderProfile?.userName || ""
  const uploaderOrgName = uploaderProfile?.orgName || ""

  return (
    <div
      className="group p-5 rounded-2xl border border-[#f0eee6] bg-[#faf9f5] hover:bg-white hover:border-[#e8e6dc] hover:shadow-[rgba(0,0,0,0.06)_0px_4px_20px] transition-all duration-200 cursor-pointer"
      onClick={() => onOpenDetail(item)}
    >
      {/* Header: name + badges */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {item.chinese_name ? (
              <h3 className="font-medium text-[15px] leading-snug text-[#141413]">
                {item.chinese_name}
                <span className="ml-1.5 text-[#87867f] font-normal text-sm">({item.name})</span>
              </h3>
            ) : (
              <h3 className="font-medium text-[15px] leading-snug text-[#141413]">{item.name}</h3>
            )}
            {isFeatured && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-[#fdf3e7] text-[#c4956a] border border-[#f5d9c4] px-2 py-0.5 rounded-full shrink-0">
                <Star className="size-3 fill-[#c4956a]" />
                精品
              </span>
            )}
            {item.category && (
              <span className="inline-flex items-center gap-1 text-[11px] text-[#5e5d59] bg-[#f5f4ed] border border-[#e8e6dc] px-2 py-0.5 rounded-full shrink-0">
                <Tag className="size-3 text-[#87867f] shrink-0" />
                {item.category}
              </span>
            )}
            {isInstalled && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-[#edf7f0] text-[#2e7d4f] border border-[#c4e8d1] px-2 py-0.5 rounded-full shrink-0">
                <CheckCircle className="size-3" />
                已安装
              </span>
            )}
          </div>
          {item.description && (
            <p className="text-sm text-[#87867f] leading-relaxed line-clamp-2 mt-2">
              {item.description}
            </p>
          )}
        </div>
      </div>

      {/* Featured auto-update notice */}
      {/*{isFeatured && isInstalled && (*/}
      {/*  <div className="text-xs text-[#c4956a] bg-[#fdf3e7] border border-[#f5d9c4] rounded-lg px-3 py-2 mb-3 flex items-center gap-1.5">*/}
      {/*    <Zap className="size-3 shrink-0" />*/}
      {/*    精品技能无需手动更新，系统将自动安装最新版本*/}
      {/*  </div>*/}
      {/*)}*/}

      {/* Footer: metadata + actions */}
      <div className="flex items-center justify-between flex-wrap gap-2 pt-3 border-t border-[#f0eee6]">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[#87867f]">
          <div className="flex items-center gap-1">
            <Calendar className="size-3 shrink-0" />
            <span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span>
          </div>
          {item.version && (
            <div className="flex items-center gap-1">
              <GitBranch className="size-3 shrink-0" />
              <span>v{item.version}</span>
            </div>
          )}
          {item.user_id && (
            <div className="flex items-center gap-1">
              <User className="size-3 shrink-0" />
              {isSkillCard ? (
                <span>
                  {uploaderSapId || "—"} / {uploaderUserName || "未知用户"} / {uploaderOrgName || "未知部门"}
                </span>
              ) : (
                <span>用户 {item.user_id}</span>
              )}
            </div>
          )}
          {skillCallCount !== null && (
            <div className="flex items-center gap-1">
              <BarChart3 className="size-3 shrink-0" />
              <span>调用 {skillCallCount}</span>
            </div>
          )}
          {skillUserCount !== null && (
            <div className="flex items-center gap-1">
              <User className="size-3 shrink-0" />
              <span>用户 {skillUserCount}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isDownloading || isUpdating ? (
            <div className="size-4 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 gap-1 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] hover:border-[#d1cfc5] shadow-[#e8e6dc_0px_0px_0px_0px,#d1cfc5_0px_0px_0px_1px] cursor-pointer rounded-lg"
                onClick={() => onOpenDetail(item)}
              >
                <FileText className="size-3" />
                详情
              </Button>
              {isInstalled ? (
                isFeatured ? (
                  <span className="text-[11px] bg-[#fdf3e7] border border-[#f5d9c4] text-[#c4956a] px-2.5 py-1 rounded-lg inline-flex items-center gap-1">
                    <Zap className="size-3" />
                    自动保持最新
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 gap-1 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] cursor-pointer rounded-lg"
                    onClick={handleUpdateInstall}
                  >
                    <Zap className="size-3" />
                    更新
                  </Button>
                )
              ) : (
                <Button
                  size="sm"
                  className="h-7 px-3 gap-1 text-xs bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 shadow-[#c4956a_0px_0px_0px_0px,#c4956a_0px_0px_0px_1px] cursor-pointer rounded-lg"
                  onClick={handleInstallDownload}
                >
                  <Zap className="size-3" />
                  安装
                </Button>
              )}
              {isInstalled && !isFeatured && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 gap-1 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] cursor-pointer rounded-lg"
                  onClick={handleUninstall}
                  title="卸载"
                >
                  <Trash2 className="size-3" />
                  卸载
                </Button>
              )}
              {(item.canDelete || (item.ip && ip && item.ip === ip)) && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 gap-1 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] cursor-pointer rounded-lg"
                    onClick={() => onUpdate(item)}
                    title="编辑"
                  >
                    <Edit className="size-3" />
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 gap-1 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] cursor-pointer rounded-lg"
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

interface PluginDetailData {
  skills: string[]
  mcpServers: string[]
  manifest: PluginManifest | null
}

function getFileExt(filename: string): string {
  const idx = filename.lastIndexOf(".")
  if (idx < 0) return ""
  return filename.slice(idx + 1).toLowerCase()
}

function isAllowedDetailFile(type: MarketItemType, filename: string): boolean {
  const ext = getFileExt(filename)
  if (type === "skill") return ext === "zip" || ext === "md"
  if (type === "plugin") return ext === "zip"
  return ext === "json"
}

export function MarketPanel(): React.JSX.Element {
  const { marketInitialSkillCategory, setMarketInitialSkillCategory } = useAppStore()
  const [activeTab, setActiveTab] = useState<MarketItemType>("skill")
  const [searchQuery, setSearchQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
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
  const [downloadSuccess, setDownloadSuccess] = useState<{ open: boolean; itemName: string }>({
    open: false,
    itemName: ""
  })
  const [uploadDialog, setUploadDialog] = useState(false)
  const [updateDialog, setUpdateDialog] = useState<{ open: boolean; item: MarketItem | null }>({
    open: false,
    item: null
  })
  const [uploadSuccess, setUploadSuccess] = useState<{ open: boolean; type: MarketItemType }>({
    open: false,
    type: "skill"
  })
  const [reloadToken, setReloadToken] = useState(0)
  const [detailMode, setDetailMode] = useState<DetailViewMode>("list")
  const [skillSortMode, setSkillSortMode] = useState<SkillSortMode>("calls_desc")
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [skillDetailSkill, setSkillDetailSkill] = useState<SkillMetadata | null>(null)
  const [skillDetailSelectedFile, setSkillDetailSelectedFile] = useState<string | null>(null)
  const [skillDetailContent, setSkillDetailContent] = useState<string | null>(null)
  const [skillDetailPreviewKind, setSkillDetailPreviewKind] = useState<SkillPreviewKind>("text")
  const [skillDetailBinaryBase64, setSkillDetailBinaryBase64] = useState<string | null>(null)
  const [skillDetailBinaryMimeType, setSkillDetailBinaryMimeType] = useState<string | null>(null)
  const [mcpDetailConnector, setMcpDetailConnector] = useState<McpConnectorConfig | null>(null)
  const [pluginDetailPlugin, setPluginDetailPlugin] = useState<PluginMetadata | null>(null)
  const [pluginDetailData, setPluginDetailData] = useState<PluginDetailData | null>(null)
  const [skillUsageSummary, setSkillUsageSummary] = useState<Record<string, SkillUsageSummaryMetric>>({})
  const [selectedSkillUsage, setSelectedSkillUsage] = useState<SkillUsageDetail | null>(null)
  const [skillUsageLoading, setSkillUsageLoading] = useState(false)
  const [canViewSkillUserDetail, setCanViewSkillUserDetail] = useState(false)
  const [uploaderProfiles, setUploaderProfiles] = useState<Record<string, UploaderProfile>>({})
  const installedSkillsRef = useRef<string[]>([])
  const installedMcpsRef = useRef<string[]>([])
  const installedPluginsRef = useRef<string[]>([])

  const getItemKey = (item: MarketItem) => item.id || item.name

  const resetDetailState = () => {
    setSkillDetailSkill(null)
    setSkillDetailSelectedFile(null)
    setSkillDetailContent(null)
    setSkillDetailPreviewKind("text")
    setSkillDetailBinaryBase64(null)
    setSkillDetailBinaryMimeType(null)
    setMcpDetailConnector(null)
    setPluginDetailPlugin(null)
    setPluginDetailData(null)
    setSelectedSkillUsage(null)
  }

  const loadSkillPreviewFromInstallFile = async (filename: string, blob: Blob) => {
    setSkillDetailSelectedFile(filename)
    setSkillDetailContent(null)
    setSkillDetailBinaryBase64(null)
    setSkillDetailBinaryMimeType(null)

    const ext = getFileExt(filename)
    if (ext === "md") {
      setSkillDetailPreviewKind("text")
      const text = await blob.text()
      setSkillDetailContent(text)
      return
    }
    if (ext === "zip") {
      setSkillDetailPreviewKind("text")
      const arrayBuffer = await blob.arrayBuffer()
      const extracted = await window.api.skills.extractMarkdownFromZip(arrayBuffer, filename)
      if (extracted.success && extracted.content) {
        setSkillDetailSelectedFile(extracted.filePath || "SKILL.md")
        setSkillDetailContent(extracted.content)
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
      setSelectedSkillUsage({ users: topUsers })
    } catch (err) {
      console.warn(`[MarketPanel] Failed to load skill user stats for ${skillName}:`, err)
      setSelectedSkillUsage({ users: [] })
    } finally {
      setSkillUsageLoading(false)
    }
  }, [])

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

  const loadUploaderProfiles = useCallback(async (sapIds: string[]) => {
    const normalizedIds = Array.from(
      new Set(
        sapIds
          .map((id) => id.trim())
          .filter(Boolean)
      )
    )
    if (normalizedIds.length === 0) {
      setUploaderProfiles({})
      return
    }

    if (typeof window.api?.dashboard?.userProfiles !== "function") {
      const fallback = Object.fromEntries(
        normalizedIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
      )
      setUploaderProfiles(fallback)
      return
    }

    try {
      const response = await window.api.dashboard.userProfiles(normalizedIds)
      if (!response.success || !response.data) {
        throw new Error(response.error || "获取上传用户信息失败")
      }
      const buckets = (
        response.data as {
          aggregations?: {
            by_sap?: {
              buckets?: Array<{
                key?: string
                user_name?: { buckets?: Array<{ key?: string }> }
                org_name?: { buckets?: Array<{ key?: string }> }
              }>
            }
          }
        }
      ).aggregations?.by_sap?.buckets ?? []

      const profileBySapId: Record<string, UploaderProfile> = {}
      for (const bucket of buckets) {
        const sapId = bucket.key?.trim()
        if (!sapId) continue
        profileBySapId[sapId] = {
          sapId,
          userName: bucket.user_name?.buckets?.[0]?.key ?? "",
          orgName: bucket.org_name?.buckets?.[0]?.key ?? ""
        }
      }

      const profileEntries = Object.entries(profileBySapId)
      const nextMap: Record<string, UploaderProfile> = {}
      for (const rawId of normalizedIds) {
        if (profileBySapId[rawId]) {
          nextMap[rawId] = profileBySapId[rawId]
          continue
        }

        const includeHit = profileEntries.find(([sapId]) => sapId.includes(rawId))?.[1]
        if (includeHit) {
          nextMap[rawId] = includeHit
        } else {
          nextMap[rawId] = { sapId: rawId, userName: "", orgName: "" }
        }
      }
      setUploaderProfiles(nextMap)
    } catch (err) {
      console.warn("[MarketPanel] Failed to load uploader profiles:", err)
      const fallback = Object.fromEntries(
        normalizedIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
      )
      setUploaderProfiles(fallback)
    }
  }, [])

  // 新增：加载已安装的skills列表
  const loadInstalledSkills = async () => {
    try {
      if (window.api?.skills?.list) {
        const skillsMetadata = await window.api.skills.list()
        const skillNames = skillsMetadata.map((skill) => skill.name)
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
  }, [loadDashboardPermission])

  useEffect(() => {
    if (canViewSkillUserDetail) return
    setSkillUsageLoading(false)
    setSelectedSkillUsage(null)
  }, [canViewSkillUserDetail])

  useEffect(() => {
    if (!marketInitialSkillCategory) return
    setActiveTab("skill")
    setDetailMode("list")
    setSelectedItemKey(null)
    setCategoryFilter(marketInitialSkillCategory)
    setSearchQuery("")
    setMarketInitialSkillCategory(null)
  }, [marketInitialSkillCategory, setMarketInitialSkillCategory])

  // 同步已安装状态，不触发额外的 market 接口请求
  useEffect(() => {
    setSkillsData((prev) =>
      prev.map((item) => ({
        ...item,
        canDelete: localStorageHelper.canDeleteItem(item.name, "skill"),
        installed:
          installedSkills.includes(item.name) ||
          installedSkills.some((str) => item.name === str || item.filename?.includes(str))
      }))
    )
  }, [installedSkills])

  useEffect(() => {
    installedSkillsRef.current = installedSkills
  }, [installedSkills])

  useEffect(() => {
    if (activeTab !== "skill") {
      setUploaderProfiles({})
      return
    }
    const sapIds = skillsData
      .map((item) => item.user_id?.trim() || "")
      .filter(Boolean)
    void loadUploaderProfiles(sapIds)
  }, [activeTab, skillsData, loadUploaderProfiles, reloadToken])

  useEffect(() => {
    setMcpsData((prev) =>
      prev.map((item) => ({
        ...item,
        canDelete: localStorageHelper.canDeleteItem(item.name, "mcp"),
        installed: installedMcps.includes(item.name)
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
        installed: installedPlugins.includes(item.name)
      }))
    )
  }, [installedPlugins])

  useEffect(() => {
    installedPluginsRef.current = installedPlugins
  }, [installedPlugins])

  // 新增：更新安装功能
  const handleUpdateInstall = async (item: MarketItem) => {
    const itemKey = item.id || item.name

    // 添加到更新中集合
    setUpdatingItems((prev) => new Set(prev).add(itemKey))

    try {
      const itemName = item.name || item.id || ""

      if (!itemName) {
        console.error("Item name is required for update install")
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
      } else if (activeTab === "plugin" && window.api?.plugins?.delete) {
        try {
          // 查找已安装的plugin路径
          const pluginsMetadata = await window.api.plugins.list()
          const existingPlugin = pluginsMetadata.find((plugin) => plugin.name === itemName)

          if (existingPlugin) {
            console.log(`Deleting existing plugin: ${existingPlugin.path}`)
            await window.api.plugins.delete(existingPlugin.path)
          }
        } catch (deleteError) {
          console.warn("Failed to delete existing plugin, continuing with install:", deleteError)
        }
      }

      // 下载并安装最新版本
      const response = await marketApi.downloadItem(itemName, activeTab, false, item.featured === "精品")

      if (response.success) {
        console.log(`Successfully updated and installed ${item.name}`)
        setDownloadSuccess({ open: true, itemName: `${item.name} (已更新安装)` })

        // 重新加载对应类型的已安装列表
        if (activeTab === "skill") {
          await loadInstalledSkills()
        } else if (activeTab === "mcp") {
          await loadInstalledMcps()
        } else if (activeTab === "plugin") {
          await loadInstalledPlugins()
        }
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
          installed: isInstalled
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
  }, [activeTab, reloadToken])

  useEffect(() => {
    setDetailMode("list")
    setSelectedItemKey(null)
    resetDetailState()
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== "skill" && categoryFilter !== null) {
      setCategoryFilter(null)
    }
  }, [activeTab, categoryFilter])

  const getCurrentData = () => {
    switch (activeTab) {
      case "skill":
        return skillsData
      case "mcp":
        return mcpsData
      case "plugin":
        return pluginsData
      default:
        return []
    }
  }

  const currentData = getCurrentData()
  const selectedItem =
    selectedItemKey !== null
      ? currentData.find((item) => getItemKey(item) === selectedItemKey) || null
      : null
  const selectedSkillMetrics =
    activeTab === "skill" && selectedItem ? getSkillMetricByName(skillUsageSummary, selectedItem.name) : null
  const selectedSkillCallCount =
    activeTab === "skill" ? selectedSkillMetrics?.calls ?? 0 : null
  const selectedSkillUserCount =
    activeTab === "skill" ? selectedSkillMetrics?.users ?? 0 : null
  const selectedUploaderProfile =
    activeTab === "skill" && selectedItem?.user_id
      ? uploaderProfiles[selectedItem.user_id] ?? null
      : null

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

  const loadDetailDataForItem = async (item: MarketItem) => {
    setDetailLoading(true)
    resetDetailState()
    try {
      const installFile = await marketApi.fetchInstallFile(item.name, activeTab)
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

      if (activeTab === "skill") {
        setSkillDetailSkill({
          name: item.name,
          description: item.description || "Market skill",
          path: installFilename,
          source: "user"
        })
        await loadSkillPreviewFromInstallFile(installFilename, installFile.blob)
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
          command: isStdio ? config.command as string : undefined,
          args:
            isStdio && Array.isArray(config.args) && config.args.every((arg): arg is string => typeof arg === "string")
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
          updatedAt: item.created_at
        })
      } else if (activeTab === "plugin") {
        setPluginDetailPlugin({
          id: item.name,
          name: item.name,
          version: item.version || "unknown",
          description: item.description || "",
          author: item.user_id ? `用户 ${item.user_id}` : "未知作者",
          path: installFilename,
          enabled: false,
          skillCount: 0,
          mcpServerCount: 0,
          createdAt: item.created_at,
          updatedAt: item.created_at
        })
        setPluginDetailData({
          skills: [],
          mcpServers: [],
          manifest: {
            name: item.name,
            version: item.version,
            description: item.description,
            author: item.user_id ? `用户 ${item.user_id}` : undefined
          }
        })
      }
    } catch (detailError) {
      console.error("Failed to load detail data:", detailError)
      setError(detailError instanceof Error ? detailError.message : "加载详情失败")
    } finally {
      setDetailLoading(false)
    }
  }

  const filteredData = currentData.filter((item) => {
    const query = searchQuery.toLowerCase()
    const matchesSearch =
      item.name.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    if (!matchesSearch) return false

    if (activeTab !== "skill" || !categoryFilter) return true
    return getSecondaryCategory(item.category) === categoryFilter
  })

  const sortedSkillData = useMemo(() => {
    if (activeTab !== "skill") return filteredData
    return sortSkillItemsByUsage(filteredData, skillUsageSummary, skillSortMode)
  }, [activeTab, filteredData, skillSortMode, skillUsageSummary])

  const skillCategoryStats = useMemo(() => {
    if (activeTab !== "skill") return []

    const categoryCounter = new Map<string, { primary: string; count: number }>()
    for (const item of skillsData) {
      const categoryName = getSecondaryCategory(item.category) || "未分类"
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
  }, [activeTab, skillsData])

  const openItemDetail = async (item: MarketItem) => {
    setSelectedItemKey(getItemKey(item))
    setDetailMode("detail")
    const detailTasks: Array<Promise<void>> = []

    if (activeTab === "skill") {
      setSelectedSkillUsage(null)
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

  const backToList = () => {
    setDetailMode("list")
    setSelectedItemKey(null)
    resetDetailState()
  }

  const handleDelete = (item: MarketItem) => {
    setDeleteDialog({ open: true, item })
  }

  const handleUninstall = async (item: MarketItem) => {
    const itemName = item.name || item.id || ""
    if (!itemName) return

    try {
      if (activeTab === "skill" && window.api?.skills?.delete) {
        const skillsMetadata = await window.api.skills.list()
        const existingSkill = skillsMetadata.find((skill) => skill.name === itemName)
        if (existingSkill) {
          await window.api.skills.delete(existingSkill.path)
        }
        await loadInstalledSkills()
      } else if (activeTab === "mcp" && window.api?.mcp?.delete) {
        const mcpsMetadata = await window.api.mcp.list()
        const existingMcp = mcpsMetadata.find((mcp) => mcp.name === itemName)
        if (existingMcp) {
          await window.api.mcp.delete(existingMcp.id)
        }
        await loadInstalledMcps()
      } else if (activeTab === "plugin" && window.api?.plugins?.delete) {
        const pluginsMetadata = await window.api.plugins.list()
        const existingPlugin = pluginsMetadata.find((plugin) => plugin.name === itemName)
        if (existingPlugin) {
          await window.api.plugins.delete(existingPlugin.path)
        }
        await loadInstalledPlugins()
      }
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
      const response = await marketApi.downloadItem(itemName, activeTab, downloadToLocal, item.featured === "精品")
      if (response.success) {
        console.log(`Downloaded ${item.name}`)

        // Show different success messages based on download type
        if (downloadToLocal) {
          // For local downloads, show a different message
          setDownloadSuccess({ open: true, itemName: `${item.name} (已保存到本地)` })
        } else {
          // For application installs, show the original message
          setDownloadSuccess({ open: true, itemName: item.name })

          // 重新加载对应类型的已安装列表 (only for app installs, not local downloads)
          if (activeTab === "skill") {
            await loadInstalledSkills()
          } else if (activeTab === "mcp") {
            await loadInstalledMcps()
          } else if (activeTab === "plugin") {
            await loadInstalledPlugins()
          }
        }
      } else {
        console.error("Download failed:", response.error)
        setError(response.error || "下载失败")
      }
    } catch (error) {
      console.error("Failed to download item:", error)
      setError(error instanceof Error ? error.message : "下载失败")
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
    setUploadSuccess({ open: true, type: activeTab })
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
    guidance?: string,
    chineseName?: string,
    userId?: string
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
        guidance,
        chineseName,
        userId
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
    guidance?: string,
    chineseName?: string,
    userId?: string
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
        guidance,
        chineseName,
        userId
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
    setUploadSuccess({ open: true, type: activeTab })
    setUpdateDialog({ open: false, item: null })
    // Reload the current tab data
    triggerReload()
  }

  const renderDetailFilePanel = () => {
    if (!selectedItem) return null
    if (detailLoading) {
      return <div className="text-sm text-muted-foreground py-6">文件详情加载中...</div>
    }

    if (activeTab === "skill") {
      if (selectedItem.featured === "精品") {
        return (
          <div className="rounded-xl border border-[#f5d9c4] bg-[#fdf3e7] p-6 text-sm text-[#8b623d]">
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#f5f4ed]">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#e8e6dc] bg-[#faf9f5]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-xl bg-[#fdf3e7] border border-[#f5d9c4] flex items-center justify-center">
              <ShoppingBag className="size-4 text-[#c4956a]" />
            </div>
            <div>
              <h2 className="font-medium text-[15px] leading-tight text-[#141413]">
                {detailMode === "detail" && selectedItem
                  ? selectedItem.chinese_name || selectedItem.name
                  : "公共市场"}
              </h2>
              {detailMode === "list" && (
                <p className="text-[11px] text-[#87867f] leading-tight mt-0.5">
                  发现并安装社区共享的工具资源
                </p>
              )}
            </div>
          </div>
          {detailMode === "list" ? (
            <Button
              size="sm"
              className="h-8 px-3 gap-1.5 text-xs bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 shadow-[#c4956a_0px_0px_0px_0px,#c4956a_0px_0px_0px_1px] rounded-lg cursor-pointer"
              onClick={handleUploadClick}
            >
              <Plus className="size-3.5" />
              {activeTab === "skill" ? "上传技能" : activeTab === "mcp" ? "上传连接器" : "上传插件"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={backToList}
              className="h-8 px-3 gap-1.5 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg cursor-pointer"
            >
              <ArrowLeft className="size-3.5" />
              返回列表
            </Button>
          )}
        </div>
        {detailMode === "list" && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#87867f]" />
              <Input
                placeholder="搜索技能、连接器、插件…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm bg-white border-[#e8e6dc] text-[#141413] placeholder:text-[#b0aea5] rounded-xl focus-visible:ring-[#3898ec] focus-visible:border-[#3898ec]"
              />
            </div>
          </div>
        )}
      </div>

      {detailMode === "detail" && selectedItem ? (
        <ScrollArea className="flex-1">
          <div className="p-5 h-full">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start xl:h-full">
              <div className="space-y-3 xl:order-1 order-2">
                {renderDetailFilePanel()}
              </div>

              <div className="xl:order-2 order-1 space-y-3 xl:sticky xl:top-4 w-full h-full overflow-y-auto pr-1">
                {/* Info card */}
                <div className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 space-y-3 shadow-[rgba(0,0,0,0.04)_0px_4px_16px]">
                  <div className="space-y-1.5">
                    {selectedItem.chinese_name ? (
                      <h3 className="text-base font-medium leading-snug text-[#141413]">
                        {selectedItem.chinese_name}
                        <span className="ml-2 text-[#87867f] font-normal text-sm">
                          ({selectedItem.name})
                        </span>
                      </h3>
                    ) : (
                      <h3 className="text-base font-medium leading-snug text-[#141413]">
                        {selectedItem.name}
                      </h3>
                    )}
                    {selectedItem.description && (
                      <p className="text-sm text-[#87867f] leading-relaxed">
                        {selectedItem.description}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {selectedItem.category && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                        <Tag className="size-3" />
                        {selectedItem.category}
                      </span>
                    )}
                    {selectedItem.version && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                        <GitBranch className="size-3" />v{selectedItem.version}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                      <Calendar className="size-3" />
                      {new Date(selectedItem.created_at).toLocaleDateString("zh-CN")}
                    </span>
                    {selectedItem.installed && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#edf7f0] border border-[#c4e8d1] text-[#2e7d4f] px-2.5 py-1">
                        <CheckCircle className="size-3" />
                        已安装
                      </span>
                    )}
                    {selectedItem.featured === "精品" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf3e7] border border-[#f5d9c4] text-[#c4956a] px-2.5 py-1">
                        <Star className="size-3 fill-[#c4956a]" />
                        精品
                      </span>
                    )}
                    { selectedItem.user_id ? (selectedItem.user_id.split('/')?.length ===3 ? <span
                      className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                        <User className="size-3" />
                      {selectedItem.user_id}
                      </span> : (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                        <User className="size-3" />
                        {(selectedUploaderProfile?.sapId || selectedItem.user_id)}/
                        {selectedUploaderProfile?.userName || "未知用户"}/
                        {selectedUploaderProfile?.orgName || "未知部门"}
                      </span>
                    )) : null}
                    {activeTab === "skill" && selectedSkillCallCount !== null && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#eef3fb] border border-[#d7e2f5] text-[#365d97] px-2.5 py-1">
                        <BarChart3 className="size-3" />
                        调用次数 {selectedSkillCallCount}
                      </span>
                    )}
                    {activeTab === "skill" && selectedSkillUserCount !== null && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#eef3fb] border border-[#d7e2f5] text-[#365d97] px-2.5 py-1">
                        <User className="size-3" />
                        使用用户数 {selectedSkillUserCount}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {selectedItem.installed ? (
                      selectedItem.featured === "精品" ? (
                        <span className="col-span-2 text-xs bg-[#fdf3e7] border border-[#f5d9c4] text-[#c4956a] px-3 py-2 rounded-lg inline-flex items-center gap-1.5">
                          <Zap className="size-3" />
                          自动保持最新
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg cursor-pointer"
                          onClick={() => handleUpdateInstall(selectedItem)}
                          disabled={updatingItems.has(getItemKey(selectedItem))}
                        >
                          <Zap className="size-3" />
                          更新安装
                        </Button>
                      )
                    ) : (
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-xs bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 shadow-[#c4956a_0px_0px_0px_0px,#c4956a_0px_0px_0px_1px] rounded-lg cursor-pointer"
                        onClick={() => handleDownload(selectedItem, false)}
                        disabled={downloadingItems.has(getItemKey(selectedItem))}
                      >
                        <Zap className="size-3" />
                        安装
                      </Button>
                    )}
                    {selectedItem.installed && selectedItem.featured !== "精品" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] rounded-lg cursor-pointer"
                        onClick={() => handleUninstall(selectedItem)}
                      >
                        <Trash2 className="size-3" />
                        卸载
                      </Button>
                    )}
                    {(selectedItem.canDelete ||
                      (selectedItem.ip &&
                        localStorage.getItem("localIp") &&
                        selectedItem.ip === localStorage.getItem("localIp"))) && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg cursor-pointer"
                          onClick={() => handleUpdate(selectedItem)}
                        >
                          <Edit className="size-3" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] rounded-lg cursor-pointer"
                          onClick={() => handleDelete(selectedItem)}
                        >
                          <Trash2 className="size-3" />
                          删除
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {activeTab === "skill" && canViewSkillUserDetail && (
                  <div className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 space-y-3 shadow-[rgba(0,0,0,0.03)_0px_2px_10px]">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[13px] font-medium text-[#141413]">使用用户明细</h4>
                      <span className="text-[11px] text-[#87867f]">
                        调用次数 {selectedSkillCallCount ?? 0} / 使用用户数 {selectedSkillUserCount ?? 0}
                      </span>
                    </div>
                    {skillUsageLoading ? (
                      <div className="flex items-center justify-center py-5 text-xs text-[#87867f]">
                        <div className="size-4 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin mr-2" />
                        加载中…
                      </div>
                    ) : (
                      <div className="max-h-[260px] overflow-auto border border-[#f0eee6] rounded-xl">
                        <table className="w-full text-[12px]">
                          <thead className="bg-[#f5f4ed]">
                            <tr className="text-[#87867f]">
                              <th className="text-left py-2 px-2 font-medium">sapId</th>
                              <th className="text-left py-2 px-2 font-medium">userName</th>
                              <th className="text-left py-2 px-2 font-medium">orgName</th>
                              <th className="text-right py-2 px-2 font-medium">调用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(selectedSkillUsage?.users ?? []).map((user) => (
                              <tr key={user.sapId} className="border-t border-[#f0eee6] text-[#5e5d59]">
                                <td className="py-1.5 px-2 font-mono">{user.sapId}</td>
                                <td className="py-1.5 px-2">{user.userName || user.sapId}</td>
                                <td className="py-1.5 px-2">{user.orgName || "—"}</td>
                                <td className="py-1.5 px-2 text-right">{user.count}</td>
                              </tr>
                            ))}
                            {(selectedSkillUsage?.users?.length ?? 0) === 0 && (
                              <tr>
                                <td colSpan={4} className="py-6 text-center text-[#87867f]">
                                  暂无调用用户数据
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {selectedItem.guidance && (
                  <div className="rounded-xl border border-[#f5d9c4] bg-[#fdf3e7] p-4 text-sm shadow-[rgba(0,0,0,0.03)_0px_2px_8px]">
                    <div className="flex items-center gap-2 mb-2 text-[11px] uppercase tracking-[0.08em] text-[#c4956a] font-medium">
                      <Lightbulb className="size-3.5 shrink-0" />
                      <span>使用指引</span>
                    </div>
                    <p className="text-[#5e5d59] whitespace-pre-wrap leading-relaxed break-all text-[13px]">
                      {selectedItem.guidance}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as MarketItemType)}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <div className="px-5 pt-3 pb-0 bg-[#faf9f5] border-b border-[#e8e6dc]">
            <TabsList className="grid w-full grid-cols-3 bg-[#f5f4ed] border border-[#e8e6dc] rounded-xl h-9 p-0.5">
              <TabsTrigger
                value="skill"
                className="text-xs rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#141413] data-[state=active]:shadow-[rgba(0,0,0,0.06)_0px_1px_4px] text-[#87867f] data-[state=active]:font-medium transition-all"
              >
                <Sparkles className="size-3 mr-1.5" />
                Skills
              </TabsTrigger>
              <TabsTrigger
                value="mcp"
                className="text-xs rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#141413] data-[state=active]:shadow-[rgba(0,0,0,0.06)_0px_1px_4px] text-[#87867f] data-[state=active]:font-medium transition-all"
              >
                <Plug className="size-3 mr-1.5" />
                MCPs
              </TabsTrigger>
              <TabsTrigger
                value="plugin"
                className="text-xs rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#141413] data-[state=active]:shadow-[rgba(0,0,0,0.06)_0px_1px_4px] text-[#87867f] data-[state=active]:font-medium transition-all"
              >
                <Puzzle className="size-3 mr-1.5" />
                Plugins
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-hidden">
            <TabsContent value={activeTab} className="mt-0 h-full">
              <ScrollArea className="h-full">
                <div className="p-4 space-y-3">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center py-16 text-[#87867f]">
                      <div className="size-6 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin mb-3" />
                      <span className="text-sm">加载中…</span>
                    </div>
                  ) : error ? (
                    <div className="flex flex-col items-center justify-center py-16">
                      <div className="size-10 rounded-2xl bg-[#fdf2f2] border border-[#fad4d4] flex items-center justify-center mb-3">
                        <span className="text-base">❌</span>
                      </div>
                      <p className="text-sm text-[#b53333] mb-3 text-center">{error}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-4 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg"
                        onClick={() => {
                          setError(null)
                          triggerReload()
                        }}
                      >
                        重试
                      </Button>
                    </div>
                  ) : filteredData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-[#87867f]">
                      <div className="size-10 rounded-2xl bg-[#f5f4ed] border border-[#e8e6dc] flex items-center justify-center mb-3">
                        <ShoppingBag className="size-5 text-[#b0aea5]" />
                      </div>
                      <p className="text-sm">
                        {searchQuery ? "未找到匹配的项目" : "暂无可用项目"}
                      </p>
                    </div>
                  ) : (
                    activeTab === "skill" ? (
                      <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
                        <aside className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-3 xl:sticky xl:top-4">
                          <div className="flex items-center justify-between mb-2 px-1">
                            <h3 className="text-xs font-medium text-[#5e5d59]">分类</h3>
                            {categoryFilter && (
                              <button
                                type="button"
                                onClick={() => setCategoryFilter(null)}
                                className="text-xs text-[#b85a3a] hover:text-[#9f472d] transition-colors cursor-pointer"
                              >
                                清除
                              </button>
                            )}
                          </div>
                          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
                            {skillCategoryStats.length === 0 ? (
                              <p className="text-xs text-[#87867f] px-2 py-1.5">暂无分类</p>
                            ) : (
                              skillCategoryStats.map((category) => {
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
                                        ? "bg-[#fdf3e7] border border-[#f5d9c4] text-[#8b623d]"
                                        : "border border-transparent text-[#5e5d59] hover:bg-[#f5f4ed]"
                                    }`}
                                  >
                                    <span className="text-[13px] leading-tight pr-2 break-all">
                                      {category.name}
                                    </span>
                                    <span
                                      className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${
                                        isActive
                                          ? "bg-[#f5d9c4] text-[#8b623d]"
                                          : "bg-[#f0eee6] text-[#87867f]"
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

                        <div className="space-y-3 min-w-0">
                          <div className="flex items-center justify-between text-xs text-[#87867f] px-1">
                            <span>
                              {categoryFilter ? `当前分类：${categoryFilter}` : "全部 Skills"}
                            </span>
                            <div className="flex items-center gap-2">
                              <div className={'inline-block w-10'}>排序</div>
                              <Select
                                value={skillSortMode}
                                onValueChange={(value) => setSkillSortMode(value as SkillSortMode)}
                              >
                                <SelectTrigger className="h-7 min-w-[132px] rounded-lg border-[#e8e6dc] bg-white px-2 text-[11px] text-[#5e5d59]">
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
                              <div  className={'inline-block w-30'}>{filteredData.length} 个结果</div>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
                            {sortedSkillData.map((item) => (
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
                                skillCallCount={getSkillMetricByName(skillUsageSummary, item.name)?.calls ?? 0}
                                skillUserCount={getSkillMetricByName(skillUsageSummary, item.name)?.users ?? 0}
                                uploaderProfile={item.user_id ? uploaderProfiles[item.user_id] ?? null : null}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      filteredData.map((item) => (
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
                          skillCallCount={null}
                          skillUserCount={null}
                          uploaderProfile={null}
                        />
                      ))
                    )
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
        <DialogContent className="bg-[#faf9f5] border-[#e8e6dc]">
          <DialogHeader>
            <DialogTitle className="text-[#141413]">确认删除</DialogTitle>
            <DialogDescription className="text-[#5e5d59]">
              您确定要删除 &quot;{deleteDialog.item?.name}&quot; 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-[#e8e6dc] bg-[#f5f4ed] text-[#5e5d59] hover:bg-[#e8e6dc] rounded-lg"
              onClick={() => setDeleteDialog({ open: false, item: null })}
            >
              取消
            </Button>
            <Button
              className="bg-[#b53333] hover:bg-[#9e2c2c] text-white border-0 rounded-lg"
              onClick={confirmDelete}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={downloadSuccess.open}
        onOpenChange={(open) => setDownloadSuccess({ open, itemName: "" })}
      >
        <DialogContent className="bg-[#faf9f5] border-[#e8e6dc]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#141413]">
              <CheckCircle className="size-5 text-[#2e7d4f]" />
              安装成功
            </DialogTitle>
            <DialogDescription className="text-[#5e5d59]">
              &quot;{downloadSuccess.itemName}&quot; 已成功添加到您的
              {activeTab === "skill" ? "技能" : activeTab === "mcp" ? "MCP连接器" : "插件"}中。
              {activeTab === "skill" && " 您可以在技能面板中找到它。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className="bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 rounded-lg"
              onClick={() => setDownloadSuccess({ open: false, itemName: "" })}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Use UniversalUploadDialog for all types */}
      <UniversalUploadDialog
        open={uploadDialog}
        onOpenChange={setUploadDialog}
        onSuccess={handleUploadSuccess}
        resourceType={activeTab}
        onUpload={handleUniversalUpload}
      />

      <Dialog
        open={uploadSuccess.open}
        onOpenChange={(open) => setUploadSuccess({ open, type: "skill" })}
      >
        <DialogContent className="bg-[#faf9f5] border-[#e8e6dc]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#141413]">
              <CheckCircle className="size-5 text-[#2e7d4f]" />
              上传成功
            </DialogTitle>
            <DialogDescription className="text-[#5e5d59]">
              您的
              {uploadSuccess.type === "skill"
                ? "技能"
                : uploadSuccess.type === "mcp"
                  ? "MCP连接器"
                  : "插件"}
              已成功上传到Market！
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className="bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 rounded-lg"
              onClick={() => setUploadSuccess({ open: false, type: "skill" })}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              guidance: updateDialog.item.guidance,
              chinese_name: updateDialog.item.chinese_name,
              user_id: updateDialog.item.user_id
            }
            : undefined
        }
      />
    </div>
  )
}
