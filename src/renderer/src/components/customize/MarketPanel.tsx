import { useEffect, useRef, useState } from "react"
import {
  Search,
  ShoppingBag,
  Sparkles,
  Plug,
  Puzzle,
  Trash2,
  CheckCircle,
  Plus,
  HardDrive,
  Zap,
  Tag,
  Star,
  GitBranch,
  User,
  Edit,
  Calendar,
  FileText,
  Lightbulb
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UniversalUploadDialog } from "./UniversalUploadDialog"
import { marketApi, MarketApiResponse, MarketItem, MarketItemType } from "../../api/market"
import { getMarketMockResponse } from "./MarketMockData"

// Local storage helper functions for tracking user uploads
const UPLOADED_ITEMS_KEY = "marketplace_uploaded_items"
const USE_MARKET_MOCK_ON_ERROR =
  String(import.meta.env.VITE_MARKET_MOCK_ON_ERROR || "false").toLowerCase() === "true"

interface UploadedItemRecord {
  name: string
  type: MarketItemType
  uploadedAt: string
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
  onDelete: (item: MarketItem) => void
  onUpdate: (item: MarketItem) => void
  onDownload: (item: MarketItem, downloadToLocal?: boolean) => void
  onUpdateInstall: (item: MarketItem) => void
  onUninstall: (item: MarketItem) => void // 新增卸载回调
  isDownloading?: boolean
  isInstalled?: boolean // 新增已安装状态
  isUpdating?: boolean // 新增更新中状态
}

function MarketItemCard({
  item,
  onDelete,
  onUpdate,
  onDownload,
  onUpdateInstall,
  onUninstall,
  isDownloading = false,
  isInstalled = false,
  isUpdating = false
}: MarketItemCardProps) {
  const handleInstallDownload = () => {
    onDownload(item, false) // Install to application
  }

  const handleLocalDownload = () => {
    onDownload(item, true) // Download to local file system
  }

  const handleUpdateInstall = () => {
    onUpdateInstall(item) // 更新安装
  }

  const handleUninstall = () => {
    onUninstall(item)
  }

  const ip = localStorage.getItem("localIp")
  const isFeatured = item.featured === "精品"

  return (
    <div className="p-4 rounded-lg border border-gray-300 hover:shadow-lg transition-colors">
      {/* Header: name + badges + actions */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0 mb-4">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <h3 className="font-semibold text-sm">{item.name}</h3>
            {item.chinese_name && (
              <span className="text-xs text-muted-foreground">（{item.chinese_name}）</span>
            )}
            {isInstalled && (
              <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
                <CheckCircle className="size-3" />
                已安装
              </span>
            )}
          </div>
          {item.category && (
            <div className="flex items-center gap-1 mt-1">
              <Tag className="size-3 text-primary shrink-0" />
              <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {item.category}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          {isDownloading || isUpdating ? (
            <div className="size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              {isInstalled ? (
                isFeatured ? (
                  <span className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-700 px-2 py-1 rounded-full flex items-center gap-1">
                    <Zap className="size-3" />
                    自动保持最新
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 gap-1 bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 cursor-pointer"
                    onClick={handleUpdateInstall}
                  >
                    <Zap className="size-3" />
                    更新安装
                  </Button>
                )
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 gap-1 cursor-pointer"
                  onClick={handleInstallDownload}
                >
                  <Zap className="size-3" />
                  安装
                </Button>
              )}
              {isInstalled && !isFeatured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-auto px-2 gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 cursor-pointer"
                  onClick={handleUninstall}
                  title="卸载"
                >
                  <Trash2 className="size-3 mr-1" />
                  卸载
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-auto px-2 gap-1 cursor-pointer"
                onClick={handleLocalDownload}
              >
                <HardDrive className="size-3 mr-1" />
                下载
              </Button>
            </>
          )}
          {(item.canDelete || (item.ip && ip && item.ip === ip)) && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-auto px-2 gap-1 cursor-pointer"
                onClick={() => onUpdate(item)}
                title="更新"
              >
                <Edit className="size-3 mr-1" />
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-auto px-2 gap-1 cursor-pointer"
                onClick={() => onDelete(item)}
                title="删除"
              >
                <Trash2 className="size-3 mr-1" />
                删除
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground mb-2 leading-relaxed">{item.description}</p>

      {/* Guidance — supports line breaks and whitespace formatting */}
      {item.guidance && (
        <div className="text-xs text-muted-foreground border-l-2 border-border pl-2 mb-3">
          <div className="flex items-start gap-1.5">
            <Lightbulb className="size-3 mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap leading-relaxed">{item.guidance}</span>
          </div>
        </div>
      )}

      {/* Featured auto-update notice */}
      {isFeatured && isInstalled && (
        <div className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md px-3 py-1.5 mb-2 flex items-center gap-1.5">
          <Star className="size-3 shrink-0 text-yellow-500" />
          精品技能无需手动更新，系统将自动安装最新版本
        </div>
      )}

      {/* Metadata row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-t border-border pt-2 mt-1">
        {item.filename && (
          <div className="flex items-center gap-1" title="文件名">
            <FileText className="size-3 shrink-0" />
            <span>{item.filename}</span>
          </div>
        )}
        <div className="flex items-center gap-1" title="创建时间">
          <Calendar className="size-3 shrink-0" />
          <span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span>
        </div>
        {item.version && (
          <div className="flex items-center gap-1" title="版本">
            <GitBranch className="size-3 shrink-0" />
            <span>v{item.version}</span>
          </div>
        )}
        {item.featured && (
          <div className="flex items-center gap-1" title="推荐标签">
            <Star
              className={`size-3 shrink-0 ${isFeatured ? "text-yellow-500" : "text-muted-foreground"}`}
            />
            <span className={isFeatured ? "text-yellow-600 font-medium" : ""}>{item.featured}</span>
          </div>
        )}
        {item.user_id && (
          <div className="flex items-center gap-1" title="上传用户">
            <User className="size-3 shrink-0" />
            <span>用户 {item.user_id}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function MarketPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<MarketItemType>("skill")
  const [searchQuery, setSearchQuery] = useState("")
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
  const installedSkillsRef = useRef<string[]>([])
  const installedMcpsRef = useRef<string[]>([])
  const installedPluginsRef = useRef<string[]>([])

  const triggerReload = () => {
    setReloadToken((prev) => prev + 1)
  }

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
  }, [])

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
      const response = await marketApi.downloadItem(itemName, activeTab, false)

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
        case "skill":
          return marketApi.getSkills()
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

  const filteredData = getCurrentData().filter(
    (item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

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
      const response = await marketApi.downloadItem(itemName, activeTab, downloadToLocal)
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="size-5" />
            <h2 className="font-semibold">公共市场</h2>
          </div>
          <Button size="sm" onClick={handleUploadClick} className="flex items-center gap-2">
            <Plus className="size-4" />
            {activeTab === "skill" ? "上传技能" : activeTab === "mcp" ? "上传连接器" : "上传插件"}
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索公共市场里的工具"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as MarketItemType)}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-4 pt-3">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="skill" className="text-xs">
              <Sparkles className="size-3 mr-1" />
              Skills
            </TabsTrigger>
            <TabsTrigger value="mcp" className="text-xs">
              <Plug className="size-3 mr-1" />
              MCPs
            </TabsTrigger>
            <TabsTrigger value="plugin" className="text-xs">
              <Puzzle className="size-3 mr-1" />
              Plugins
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 overflow-hidden">
          <TabsContent value={activeTab} className="mt-0 h-full">
            <ScrollArea className="h-full">
              <div className="p-4 space-y-10">
                {loading ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">加载中...</div>
                ) : error ? (
                  <div className="text-center py-8">
                    <div className="text-red-500 text-sm mb-2">❌ {error}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null)
                        // Trigger reload explicitly
                        triggerReload()
                      }}
                    >
                      重试
                    </Button>
                  </div>
                ) : filteredData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {searchQuery ? "未找到匹配的项目" : "暂无可用项目"}
                  </div>
                ) : (
                  filteredData.map((item) => (
                    <MarketItemCard
                      key={item.id}
                      item={item}
                      onDelete={handleDelete}
                      onUpdate={handleUpdate}
                      onDownload={handleDownload}
                      onUpdateInstall={handleUpdateInstall} // 修正：使用正确的handleUpdateInstall函数
                      onUninstall={handleUninstall} // 传递卸载回调
                      isDownloading={downloadingItems.has(item.id || item.name)}
                      isInstalled={item.installed} // 传递已安装状态
                      isUpdating={updatingItems.has(item.id || item.name)} // 修正：使用updatingItems而不是downloadingItems
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </div>
      </Tabs>

      <Dialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open, item: null })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              您确定要删除 &quot;{deleteDialog.item?.name}&quot; 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog({ open: false, item: null })}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={downloadSuccess.open}
        onOpenChange={(open) => setDownloadSuccess({ open, itemName: "" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="size-5 text-green-500" />
              下载成功
            </DialogTitle>
            <DialogDescription>
              &quot;{downloadSuccess.itemName}&quot; 已成功下载并添加到您的
              {activeTab === "skill" ? "技能" : activeTab === "mcp" ? "MCP连接器" : "插件"}中。
              {activeTab === "skill" && " 您可以在技能面板中找到它。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDownloadSuccess({ open: false, itemName: "" })}>确定</Button>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="size-5 text-green-500" />
              上传成功
            </DialogTitle>
            <DialogDescription>
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
            <Button onClick={() => setUploadSuccess({ open: false, type: "skill" })}>确认</Button>
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
