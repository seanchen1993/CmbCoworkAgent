import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  FileEdit,
  FolderOpen,
  Plug,
  Plus,
  Power,
  Puzzle,
  Search,
  Sparkles,
  Store,
  Trash2,
  Upload,
  Webhook,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { PluginMetadata, PluginManifest } from "@/types"
import { marketApi, type MarketItem } from "../../api/market"
import {
  MarketPublishDialog,
  type MarketPublishFileBuildContext,
  type MarketPublishTarget
} from "./MarketPanel/MarketPublishDialog"
import { PluginFileEditorDialog } from "./PluginFileEditorDialog"
import { readUploadedItemNamesFromStorage } from "./MarketPanel/marketPublishStorage"
import { toast } from "sonner"

type PluginHookMetadata = Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]
type PluginMcpServerDetail = Awaited<ReturnType<typeof window.api.plugins.getDetail>>["mcpServerDetails"][number]
const PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL =
  import.meta.env.VITE_PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL?.trim()
const LOCAL_UPLOADED_PLUGIN_NAMES_KEY = "plugins_panel_uploaded_plugin_names"

interface PluginDetail {
  skills: string[]
  mcpServers: string[]
  mcpServerDetails: PluginMcpServerDetail[]
  hookCount: number
  hooks: PluginHookMetadata[]
  manifest: PluginManifest | null
}

interface PluginConsoleInfo {
  name: string
  chineseName: string
  market: boolean
  uploadUser: string
  skills: string[]
  mcps: string[]
  hooks: string[]
}

function getEmptyPluginDetail(): PluginDetail {
  return { skills: [], mcpServers: [], mcpServerDetails: [], hookCount: 0, hooks: [], manifest: null }
}

function normalizePluginNameKey(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
}

function resolvePluginMarketInfo(
  plugin: PluginMetadata,
  marketPluginMap: Record<string, MarketItem>
): MarketItem | undefined {
  return marketPluginMap[normalizePluginNameKey(plugin.name)]
}

function buildPluginConsoleInfo(
  plugin: PluginMetadata,
  detail: PluginDetail | null,
  marketInfo: MarketItem | undefined
): PluginConsoleInfo {
  return {
    name: plugin.name,
    chineseName: marketInfo?.chinese_name?.trim() || "",
    market: Boolean(marketInfo),
    uploadUser: marketInfo?.user_id?.trim() || marketInfo?.managerName?.trim() || "",
    skills: detail?.skills ?? [],
    mcps: detail?.mcpServers ?? [],
    hooks: detail?.hooks.map((hook) => hook.id) ?? []
  }
}

function parseSkillsFromMarketExtraJson(extraJson?: string): string[] {
  if (!extraJson?.trim()) return []
  try {
    const parsed = JSON.parse(extraJson) as { skills?: unknown }
    if (!Array.isArray(parsed?.skills)) return []
    return Array.from(
      new Set(
        parsed.skills
          .filter((skill): skill is string => typeof skill === "string")
          .map((skill) => skill.trim())
          .filter(Boolean)
      )
    )
  } catch {
    return []
  }
}

function buildPluginSkillsExtraJson(skills: string[]): string | undefined {
  const normalized = Array.from(
    new Set(
      skills
        .map((skill) => skill.trim())
        .filter(Boolean)
    )
  )
  if (normalized.length === 0) return undefined
  return JSON.stringify({ skills: normalized })
}

function readLocalUploadedPluginNamesFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LOCAL_UPLOADED_PLUGIN_NAMES_KEY)
    const parsed: string[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map(normalizePluginNameKey).filter(Boolean))
  } catch (error) {
    console.warn("[PluginsPanel] Failed to read local uploaded plugin names:", error)
    return new Set()
  }
}

function markLocalUploadedPluginNameInStorage(pluginName: string): void {
  try {
    const key = normalizePluginNameKey(pluginName)
    if (!key) return
    const next = readLocalUploadedPluginNamesFromStorage()
    next.add(key)
    localStorage.setItem(LOCAL_UPLOADED_PLUGIN_NAMES_KEY, JSON.stringify([...next]))
  } catch (error) {
    console.warn("[PluginsPanel] Failed to mark local uploaded plugin name:", error)
  }
}

function removeLocalUploadedPluginNameFromStorage(pluginName: string): void {
  try {
    const key = normalizePluginNameKey(pluginName)
    if (!key) return
    const next = [...readLocalUploadedPluginNamesFromStorage()].filter((item) => item !== key)
    localStorage.setItem(LOCAL_UPLOADED_PLUGIN_NAMES_KEY, JSON.stringify(next))
  } catch (error) {
    console.warn("[PluginsPanel] Failed to remove local uploaded plugin name:", error)
  }
}

function ConfirmDeleteDialog(props: {
  open: boolean
  pluginName: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { open, pluginName, onConfirm, onCancel } = props
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>确认卸载</DialogTitle>
          <DialogDescription>确定要卸载插件「{pluginName}」吗？此操作不可撤销。</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            卸载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ErrorDialog(props: {
  open: boolean
  message: string
  onClose: () => void
}): React.JSX.Element {
  const { open, message, onClose } = props
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>操作失败</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadPluginDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (pluginName?: string) => void
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess } = props
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleZipFile = useCallback(
    async (file: File) => {
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."))
      if (ext !== ".zip") {
        setError("仅支持 .zip 文件")
        return
      }
      setError(null)
      setUploading(true)
      try {
        const buffer = await file.arrayBuffer()
        const res = await window.api.plugins.install(buffer, file.name)
        if (res.success) {
          onSuccess(res.pluginName)
          onOpenChange(false)
        } else {
          setError(res.error || "安装失败")
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error")
      } finally {
        setUploading(false)
      }
    },
    [onOpenChange, onSuccess]
  )

  const handleSelectDir = useCallback(async () => {
    setError(null)
    setUploading(true)
    try {
      const res = await window.api.plugins.installFromDir()
      if (res.success) {
        onSuccess(res.pluginName)
        onOpenChange(false)
      } else if (res.error !== "已取消") {
        setError(res.error || "安装失败")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setUploading(false)
    }
  }, [onOpenChange, onSuccess])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleZipFile(file)
    },
    [handleZipFile]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback(() => setDragOver(false), [])

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleZipFile(file)
      e.target.value = ""
    },
    [handleZipFile]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>安装 Plugin</DialogTitle>
          <DialogDescription>
            上传 .zip 文件或选择本地 Plugin 文件夹。Plugin 可包含 skills/、.mcp.json，或
            hooks/hooks.json。
          </DialogDescription>
        </DialogHeader>
        {PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            <span>需要创建插件？可以先下载插件模板文件，按模板结构修改后再上传。</span>
            <a
              href={PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex items-center gap-1 font-medium text-blue-700 underline-offset-2 hover:underline"
            >
              下载插件模板
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
        <div className="mt-4 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          当前本地上传 Plugin 仅支持英文插件名。请确保 .zip 文件名、插件根目录名以及{" "}
          <span className="font-mono">plugin.json</span> /{" "}
          <span className="font-mono">.codex-plugin/plugin.json</span> 中的{" "}
          <span className="font-mono">name</span>{" "}
          使用英文、数字、短横线或下划线；中文名可能导致安装失败。
        </div>
        <div
          className={cn(
            "mt-4 border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-muted-foreground/50",
            uploading && "pointer-events-none opacity-60"
          )}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => document.getElementById("upload-plugin-input")?.click()}
        >
          <input
            id="upload-plugin-input"
            type="file"
            accept=".zip"
            className="hidden"
            onChange={onInputChange}
            disabled={uploading}
          />
          {uploading ? (
            <p className="text-sm text-muted-foreground">安装中...</p>
          ) : (
            <>
              <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">拖拽 .zip 文件到此处，或点击选择</p>
            </>
          )}
        </div>
        <div className="mt-2 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleSelectDir}
            disabled={uploading}
          >
            <FolderOpen className="size-4" />
            选择文件夹
          </Button>
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

export function PluginsPanel(): React.JSX.Element {
  const bumpPluginVersion = useAppStore((s) => s.bumpPluginVersion)
  const setShowCustomizeView = useAppStore((s) => s.setShowCustomizeView)
  const [plugins, setPlugins] = useState<PluginMetadata[]>([])
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMetadata | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishTarget, setPublishTarget] = useState<MarketPublishTarget | null>(null)
  const [publishMode, setPublishMode] = useState<"upload" | "update">("upload")
  const [marketPluginMap, setMarketPluginMap] = useState<Record<string, MarketItem>>({})
  // marketPluginsLoaded becomes true once the load attempt finishes, regardless
  // of outcome. marketPluginsLoadFailed tells the legacy fallback to default to
  // "not market" so offline users still see their local plugins' internals.
  const [marketPluginsLoaded, setMarketPluginsLoaded] = useState(false)
  const [marketPluginsLoadFailed, setMarketPluginsLoadFailed] = useState(false)
  const [uploadedPluginNames, setUploadedPluginNames] = useState<Set<string>>(() =>
    readUploadedItemNamesFromStorage("plugin")
  )
  const [localUploadedPluginNames, setLocalUploadedPluginNames] = useState<Set<string>>(() =>
    readLocalUploadedPluginNamesFromStorage()
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loggedPluginSelectionRef = useRef<string | null>(null)
  const originMigrationDoneRef = useRef(false)
  const originMigrationInFlightRef = useRef(false)
  const [deleteTarget, setDeleteTarget] = useState<PluginMetadata | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [fileEditorOpen, setFileEditorOpen] = useState(false)

  // 市场下载的 Plugin 不再隐藏 Skill/Hook/MCP 详情，统一展示组件详情。
  // 历史上这里会对 origin === "market" 的插件隐藏详情；现按需求恒为可见。
  // 保留入参以兼容调用点签名（恒返回 false）。
  const shouldHidePluginDetails = useCallback((plugin: PluginMetadata | null): boolean => {
    void plugin
    return false
  }, [])

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => clearTimeout(debounceTimer.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  const refreshPlugins = useCallback(() => {
    window.api.plugins.list().then(setPlugins).catch(console.error)
  }, [])

  const loadMarketPlugins = useCallback(async () => {
    try {
      const res = await marketApi.getPlugins()
      if (!res.success || !res.data) {
        setMarketPluginsLoaded(true)
        setMarketPluginsLoadFailed(true)
        return
      }
      const next: Record<string, MarketItem> = {}
      for (const item of res.data) {
        const key = item.name.trim().toLowerCase()
        if (key) next[key] = item
      }
      setMarketPluginMap(next)
      setMarketPluginsLoaded(true)
      setMarketPluginsLoadFailed(false)
    } catch (e) {
      console.warn("[PluginsPanel] Failed to load market plugins:", e)
      setMarketPluginsLoaded(true)
      setMarketPluginsLoadFailed(true)
    }
  }, [])

  // After install/update, refresh the selected plugin's detail if it was affected
  const handleInstallSuccess = useCallback(
    (pluginName?: string) => {
      if (pluginName) {
        markLocalUploadedPluginNameInStorage(pluginName)
        setLocalUploadedPluginNames(readLocalUploadedPluginNamesFromStorage())
      }
      window.api.plugins
        .list()
        .then((list) => {
          setPlugins(list)
          bumpPluginVersion()
          if (selectedPlugin) {
            const updated = list.find(
              (p) => p.id === selectedPlugin.id || p.name === selectedPlugin.name
            )
            if (updated) {
              setSelectedPlugin(updated)
              if (shouldHidePluginDetails(updated)) {
                setDetail(null)
              } else {
                window.api.plugins
                  .getDetail(updated.id)
                  .then(setDetail)
                  .catch(() => {
                    setDetail(getEmptyPluginDetail())
                  })
              }
            }
          }
        })
        .catch(console.error)
    },
    [bumpPluginVersion, selectedPlugin, shouldHidePluginDetails]
  )

  const shouldHideSelectedPluginDetails = shouldHidePluginDetails(selectedPlugin)

  useEffect(() => {
    if (fileEditorOpen && (!selectedPlugin || shouldHideSelectedPluginDetails)) {
      setFileEditorOpen(false)
    }
  }, [fileEditorOpen, selectedPlugin, shouldHideSelectedPluginDetails])

  useEffect(() => {
    refreshPlugins()
  }, [refreshPlugins])

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMarketPlugins()
    }, 0)
    return () => clearTimeout(timer)
  }, [loadMarketPlugins])

  useEffect(() => {
    if (originMigrationDoneRef.current || originMigrationInFlightRef.current) return
    if (!marketPluginsLoaded || marketPluginsLoadFailed) return
    if (plugins.length === 0) return

    const candidates = plugins.filter(
      (plugin) => plugin.origin !== "market" && plugin.origin !== "local"
    )
    if (candidates.length === 0) return

    const updates: Array<{ id: string; origin: "market" | "local" }> = []
    for (const plugin of candidates) {
      const key = normalizePluginNameKey(plugin.name)
      if (!key) continue
      const nextOrigin =
        uploadedPluginNames.has(key) || localUploadedPluginNames.has(key) || !marketPluginMap[key]
          ? "local"
          : "market"
      updates.push({ id: plugin.id, origin: nextOrigin })
    }
    if (updates.length === 0) return

    originMigrationInFlightRef.current = true
    void (async () => {
      try {
        const result = await window.api.plugins.setOriginsBatch(updates)
        if (result?.success) {
          originMigrationDoneRef.current = true
          refreshPlugins()
        }
      } catch (error) {
        console.warn("[PluginsPanel] Failed to backfill plugin origin:", error)
      } finally {
        originMigrationInFlightRef.current = false
      }
    })()
  }, [
    localUploadedPluginNames,
    marketPluginMap,
    marketPluginsLoadFailed,
    marketPluginsLoaded,
    plugins,
    refreshPlugins,
    uploadedPluginNames
  ])

  const loadDetail = useCallback(
    async (plugin: PluginMetadata) => {
      setSelectedPlugin(plugin)
      setDetail(null)
      if (shouldHidePluginDetails(plugin)) {
        return
      }
      try {
        const d = await window.api.plugins.getDetail(plugin.id)
        setDetail(d)
      } catch {
        setDetail(getEmptyPluginDetail())
      }
    },
    [shouldHidePluginDetails]
  )

  useEffect(() => {
    if (!marketPluginsLoaded || !selectedPlugin || detail || shouldHideSelectedPluginDetails) return
    void loadDetail(selectedPlugin)
  }, [detail, loadDetail, marketPluginsLoaded, selectedPlugin, shouldHideSelectedPluginDetails])

  useEffect(() => {
    if (!marketPluginsLoaded || !selectedPlugin) return
    const shouldHideUiDetail = shouldHidePluginDetails(selectedPlugin)
    if (!shouldHideUiDetail && !detail) return
    if (loggedPluginSelectionRef.current === selectedPlugin.id) return

    let cancelled = false
    const plugin = selectedPlugin
    const marketInfo = resolvePluginMarketInfo(plugin, marketPluginMap)

    const logPluginInfo = async (): Promise<void> => {
      let consoleDetail = detail
      if (shouldHideUiDetail) {
        try {
          consoleDetail = await window.api.plugins.getDetail(plugin.id)
        } catch (error) {
          console.warn("[PluginsPanel] Failed to load plugin detail for console:", error)
          consoleDetail = getEmptyPluginDetail()
        }
      }
      if (cancelled || loggedPluginSelectionRef.current === plugin.id) return
      console.log(buildPluginConsoleInfo(plugin, consoleDetail, marketInfo))
      loggedPluginSelectionRef.current = plugin.id
    }

    void logPluginInfo()

    return () => {
      cancelled = true
    }
  }, [detail, marketPluginMap, marketPluginsLoaded, selectedPlugin, shouldHidePluginDetails])

  const handleSelectPlugin = useCallback(
    (plugin: PluginMetadata) => {
      if (selectedPlugin?.id === plugin.id) return
      loggedPluginSelectionRef.current = null
      loadDetail(plugin)
    },
    [selectedPlugin, loadDetail]
  )

  const handleToggleEnabled = useCallback(
    async (plugin: PluginMetadata) => {
      try {
        const newEnabled = !plugin.enabled
        await window.api.plugins.setEnabled(plugin.id, newEnabled)
        refreshPlugins()
        bumpPluginVersion()
        if (selectedPlugin?.id === plugin.id) {
          setSelectedPlugin((prev) => (prev ? { ...prev, enabled: newEnabled } : prev))
        }
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "启用/禁用插件失败")
      }
    },
    [bumpPluginVersion, selectedPlugin, refreshPlugins]
  )

  const handleToggleHookEnabled = useCallback(
    async (plugin: PluginMetadata, hook: PluginHookMetadata) => {
      try {
        const result = await window.api.plugins.setHookEnabled(plugin.id, hook.id, !hook.enabled)
        if (!result.success) {
          setErrorMsg(result.error || "启用/禁用插件 Hook 失败")
          return
        }
        bumpPluginVersion()
        await loadDetail(plugin)
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "启用/禁用插件 Hook 失败")
      }
    },
    [bumpPluginVersion, loadDetail]
  )

  const handleDeleteRequest = useCallback((plugin: PluginMetadata) => {
    setDeleteTarget(plugin)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    const plugin = deleteTarget
    setDeleteTarget(null)
    try {
      const res = await window.api.plugins.delete(plugin.id)
      if (res.success) {
        removeLocalUploadedPluginNameFromStorage(plugin.name)
        setLocalUploadedPluginNames(readLocalUploadedPluginNamesFromStorage())
        if (selectedPlugin?.id === plugin.id) {
          setSelectedPlugin(null)
          setDetail(null)
        }
        refreshPlugins()
        bumpPluginVersion()
      } else {
        setErrorMsg(res.error || "卸载失败")
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "卸载插件失败")
    }
  }, [bumpPluginVersion, deleteTarget, selectedPlugin, refreshPlugins])

  const openPublishDialog = useCallback(
    (plugin: PluginMetadata) => {
      const key = plugin.name.trim().toLowerCase()
      const hasMarketRecord = Boolean(marketPluginMap[key])
      const localSkills =
        selectedPlugin?.id === plugin.id && detail ? detail.skills : []
      const fallbackSkills = parseSkillsFromMarketExtraJson(marketPluginMap[key]?.extra_json)
      const extraJson = buildPluginSkillsExtraJson(localSkills.length > 0 ? localSkills : fallbackSkills)
      setPublishMode(uploadedPluginNames.has(key) && hasMarketRecord ? "update" : "upload")
      setPublishTarget({
        type: "plugin",
        name: plugin.name,
        description: plugin.description,
        category: marketPluginMap[key]?.category,
        chineseName: marketPluginMap[key]?.chinese_name,
        guidance: marketPluginMap[key]?.guidance,
        extraJson
      })
      setPublishDialogOpen(true)
    },
    [detail, marketPluginMap, selectedPlugin, uploadedPluginNames]
  )

  const buildPluginMarketFile = useCallback(
    async (target: MarketPublishTarget, context: MarketPublishFileBuildContext) => {
      const plugin = plugins.find((item) => item.name === target.name)
      if (!plugin) return { success: false, error: "Plugin 不存在" }
      const exported = await window.api.plugins.exportForMarket(plugin.id, {
        version: context.version
      })
      if (!exported.success || !exported.buffer) {
        return { success: false, error: exported.error || "导出 Plugin 失败" }
      }
      const fileName = exported.fileName || `${plugin.name}.zip`
      return {
        success: true,
        file: new File([exported.buffer], fileName, { type: "application/zip" })
      }
    },
    [plugins]
  )

  const filteredPlugins = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    )
  }, [plugins, debouncedQuery])

  return (
    <>
      {/* Left panel - plugin list */}
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Plugins</h2>
            <div className="flex items-center gap-1">
              <div className="relative flex-1 min-w-[120px] max-w-[160px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="搜索"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="h-7 pl-7 pr-6 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                    onClick={() => {
                      setSearchQuery("")
                      setDebouncedQuery("")
                    }}
                    aria-label="清除"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => setUploadDialogOpen(true)}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {filteredPlugins.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-xs">
                {plugins.length === 0 ? (
                  <div className="space-y-2">
                    <Puzzle className="size-8 mx-auto opacity-40" />
                    <p>暂无安装的插件</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => setUploadDialogOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      安装 Plugin
                    </Button>
                  </div>
                ) : (
                  <p>没有匹配的插件</p>
                )}
              </div>
            ) : (
              filteredPlugins.map((plugin) => {
                const isMarketPlugin = Boolean(resolvePluginMarketInfo(plugin, marketPluginMap))
                return (
                  <button
                    key={plugin.id}
                    className={cn(
                      "w-full text-left rounded-md border border-border/70 p-2.5 transition-colors",
                      selectedPlugin?.id === plugin.id
                        ? "bg-muted/70 border-border"
                        : "hover:bg-muted/50"
                    )}
                    onClick={() => handleSelectPlugin(plugin)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Puzzle
                          className={cn(
                            "size-4 shrink-0",
                            plugin.enabled ? "text-primary" : "text-muted-foreground/40"
                          )}
                        />
                        <span
                          className={cn(
                            "text-sm font-medium truncate",
                            !plugin.enabled && "text-muted-foreground"
                          )}
                        >
                          {plugin.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {isMarketPlugin && (
                          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                            市场
                          </Badge>
                        )}
                        {plugin.version && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                            v{plugin.version}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {plugin.description && (
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words">
                        {plugin.description}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      {plugin.skillCount > 0 && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Sparkles className="size-3" />
                          {plugin.skillCount} skills
                        </span>
                      )}
                      {plugin.mcpServerCount > 0 && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Plug className="size-3" />
                          {plugin.mcpServerCount} MCPs
                        </span>
                      )}
                      {(plugin.hookCount ?? 0) > 0 && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Webhook className="size-3" />
                          {plugin.hookCount ?? 0} Hooks
                        </span>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel - plugin detail */}
      <PluginDetailPanel
        plugin={selectedPlugin}
        detail={detail}
        onToggleEnabled={handleToggleEnabled}
        onToggleHookEnabled={handleToggleHookEnabled}
        onDelete={handleDeleteRequest}
        onPublish={
          selectedPlugin && !shouldHideSelectedPluginDetails
            ? () => openPublishDialog(selectedPlugin)
            : undefined
        }
        publishLabel={
          selectedPlugin &&
          uploadedPluginNames.has(selectedPlugin.name.trim().toLowerCase()) &&
          marketPluginMap[selectedPlugin.name.trim().toLowerCase()]
            ? "更新到市场"
            : "发布到市场"
        }
        isMarketPlugin={
          selectedPlugin ? Boolean(resolvePluginMarketInfo(selectedPlugin, marketPluginMap)) : false
        }
        hideComponentDetails={shouldHideSelectedPluginDetails}
        onEditFiles={
          selectedPlugin && !shouldHideSelectedPluginDetails
            ? () => setFileEditorOpen(true)
            : undefined
        }
      />

      <PluginFileEditorDialog
        plugin={selectedPlugin}
        open={fileEditorOpen}
        onOpenChange={setFileEditorOpen}
      />

      <UploadPluginDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onSuccess={handleInstallSuccess}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        pluginName={deleteTarget?.name ?? ""}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <ErrorDialog
        open={errorMsg !== null}
        message={errorMsg ?? ""}
        onClose={() => setErrorMsg(null)}
      />

      <MarketPublishDialog
        open={publishDialogOpen}
        mode={publishMode}
        target={publishTarget}
        marketInfo={
          publishTarget ? marketPluginMap[publishTarget.name.trim().toLowerCase()] : undefined
        }
        buildFile={buildPluginMarketFile}
        onOpenChange={(open) => {
          setPublishDialogOpen(open)
          if (!open) setPublishTarget(null)
        }}
        onSuccess={({ name, mode }) => {
          setUploadedPluginNames(readUploadedItemNamesFromStorage("plugin"))
          void loadMarketPlugins()
          toast.success(
            mode === "update"
              ? `Plugin「${name}」更新发布成功，已跳转到应用市场。`
              : `Plugin「${name}」发布成功，已跳转到应用市场。`
          )
          setShowCustomizeView(true, "market")
        }}
      />
    </>
  )
}

export function PluginDetailPanel(props: {
  plugin: PluginMetadata | null
  detail: PluginDetail | null
  onToggleEnabled: (plugin: PluginMetadata) => void
  onToggleHookEnabled?: (plugin: PluginMetadata, hook: PluginHookMetadata) => void
  onDelete: (plugin: PluginMetadata) => void
  onPublish?: (plugin: PluginMetadata) => void
  publishLabel?: string
  hideActions?: boolean
  hideComponentDetails?: boolean
  isMarketPlugin?: boolean
  onEditFiles?: (plugin: PluginMetadata) => void
}): React.JSX.Element {
  const {
    plugin,
    detail,
    onToggleEnabled,
    onToggleHookEnabled,
    onDelete,
    onPublish,
    publishLabel = "发布到市场",
    hideActions = false,
    hideComponentDetails = false,
    isMarketPlugin = false,
    onEditFiles
  } = props

  if (!plugin) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="space-y-3">
            <div className="size-12 rounded-lg bg-muted/60 flex items-center justify-center">
              <Puzzle className="size-6 text-muted-foreground/70" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground/85">Plugins 插件</h3>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                插件是一个可分发的功能包，可以把技能、MCP 服务、Hooks 和静态资源放在一起安装、启用、禁用和卸载。
                适合把一套完整工作流交给团队复用，而不是让每个人分别添加技能、连接器和 Hook 规则。
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <p className="text-sm font-medium text-foreground/75">推荐目录结构</p>
            <pre className="rounded-md border bg-background p-3 text-xs overflow-x-auto text-muted-foreground">
{`my-plugin/
  plugin.json                 // 插件元信息，也可放在 .codex-plugin/plugin.json
  .mcp.json                   // 插件 MCP 配置，可选
  skills/
    my-skill/SKILL.md         // 插件技能，可选
  hooks/hooks.json            // 插件 Hook 配置，可选
  assets/                     // 图片、脚本、模板等资源，可选`}
            </pre>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground/75">
                <Sparkles className="size-4 text-amber-500" />
                Skills
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                放在 <span className="font-mono">skills/</span> 目录。启用插件后，技能会出现在可用技能列表中；读取或选择插件技能时，会激活该插件的运行作用域。
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground/75">
                <Plug className="size-4 text-blue-500" />
                MCP Servers
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                放在根目录 <span className="font-mono">.mcp.json</span>。remote MCP 默认携带当前用户身份 Header；插件 MCP 默认不会抢全局 MCP 的裸短别名。
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground/75">
                <Webhook className="size-4 text-violet-500" />
                Hooks
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                默认读取 <span className="font-mono">hooks/hooks.json</span>。插件 Hook 只会在插件或插件技能进入作用域后参与执行，避免污染普通工具调用。
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <p className="text-sm font-medium text-foreground/75">.mcp.json 字段说明</p>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <p><span className="font-mono text-foreground/70">url</span>：remote MCP 地址，支持 http/https。</p>
              <p><span className="font-mono text-foreground/70">command / args / env</span>：stdio MCP 启动命令、参数和环境变量。</p>
              <p><span className="font-mono text-foreground/70">transport</span>：remote 传输方式，支持 <span className="font-mono">sse</span> 或 <span className="font-mono">streamable-http</span>。</p>
              <p><span className="font-mono text-foreground/70">headers</span>：插件自定义请求 Header。</p>
              <p><span className="font-mono text-foreground/70">injectUserHeaders</span>：remote MCP 默认 <span className="font-mono">true</span>，会注入 <span className="font-mono">yst_id_token</span>、<span className="font-mono">sap_id</span>、<span className="font-mono">name</span>；设为 <span className="font-mono">false</span> 可关闭。</p>
              <p><span className="font-mono text-foreground/70">priority</span>：插件 MCP 基础优先级，范围 <span className="font-mono">0..100</span>，默认 <span className="font-mono">50</span>；全局 MCP 默认 <span className="font-mono">100</span>。</p>
              <p><span className="font-mono text-foreground/70">scope</span>：默认 <span className="font-mono">plugin-active</span>，未激活时按 lazy 工具处理；也可设 <span className="font-mono">plugin-installed</span> 常驻。</p>
              <p><span className="font-mono text-foreground/70">fallback</span>：允许插件 MCP 连接失败时回退到全局同名 MCP。必须显式设置 <span className="font-mono">safeToRetry: true</span>，只适合查询类或幂等工具。</p>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <p className="text-sm font-medium text-foreground/75">.mcp.json 示例</p>
            <pre className="max-h-[260px] overflow-auto rounded-md border bg-background p-3 text-xs text-muted-foreground">
{`{
  "search-service": {
    "url": "https://example.com/mcp",
    "transport": "streamable-http",
    "headers": {
      "X-App": "my-plugin"
    },
    "injectUserHeaders": true,
    "priority": 50,
    "scope": "plugin-active",
    "fallback": {
      "enabled": true,
      "to": "global",
      "match": "toolNameAndSchema",
      "safeToRetry": true
    }
  },
  "local-helper": {
    "command": "node",
    "args": ["./mcp-server.js"],
    "env": {
      "NODE_ENV": "production"
    }
  }
}`}
            </pre>
          </div>

          <div className="rounded-lg border border-amber-300/50 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 leading-relaxed">
            启用插件前请确认来源可信。remote MCP 默认会携带当前用户身份访问远程服务；fallback 会把同一组参数发送给全局同名 MCP，因此只应给可重试、幂等、无写入副作用的工具开启。
          </div>
        </div>
      </div>
    )
  }

  const manifest = detail?.manifest
  const author = manifest?.author
    ? typeof manifest.author === "string"
      ? manifest.author
      : manifest.author.name || ""
    : plugin.author
  const hookCount = detail?.hookCount ?? plugin.hookCount ?? detail?.hooks.length ?? 0
  const canManageHooks = !hideActions && typeof onToggleHookEnabled === "function"
  const eventLabel: Partial<Record<PluginHookMetadata["event"], string>> = {
    PreToolUse: "调用前",
    PostToolUse: "调用后",
    PostToolUseFailure: "调用失败",
    Stop: "停止",
    StopFailure: "停止失败",
    Notification: "通知",
    UserPromptSubmit: "提交",
    SessionStart: "会话始",
    SessionEnd: "会话终",
    SubagentStart: "子开始",
    SubagentStop: "子停止",
    PreCompact: "压缩前",
    PostCompact: "压缩后",
    PermissionRequest: "权限申请",
    PermissionDenied: "权限拒绝",
    Setup: "初始化",
    CwdChanged: "目录变更",
    FileChanged: "文件变更"
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold truncate">{plugin.name}</h2>
            {isMarketPlugin && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 shrink-0">
                市场
              </Badge>
            )}
            {plugin.version && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                v{plugin.version}
              </Badge>
            )}
          </div>
          {author && <p className="text-xs text-muted-foreground mt-0.5">{author}</p>}
        </div>
        {!hideActions && (
          <div className="flex items-center gap-1.5 shrink-0">
            {onEditFiles && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => onEditFiles(plugin)}
              >
                <FileEdit className="size-3" />
                编辑文件
              </Button>
            )}
            {onPublish && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => onPublish(plugin)}
              >
                <Store className="size-3" />
                {publishLabel}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(plugin)}
            >
              <Trash2 className="size-3" />
              卸载
            </Button>
            <Button
              variant={plugin.enabled ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => onToggleEnabled(plugin)}
            >
              <Power className="size-3" />
              {plugin.enabled ? "已启用" : "已禁用"}
            </Button>
          </div>
        )}
      </div>

      {/* Description */}
      {plugin.description && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
            {plugin.description}
          </p>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Manifest info */}
          {manifest && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">插件信息</h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {manifest.version && (
                  <div>
                    <span className="text-muted-foreground">版本: </span>
                    <span>{manifest.version}</span>
                  </div>
                )}
                {manifest.license && (
                  <div>
                    <span className="text-muted-foreground">许可证: </span>
                    <span>{manifest.license}</span>
                  </div>
                )}
                {manifest.keywords && manifest.keywords.length > 0 && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">关键词: </span>
                    <span>{manifest.keywords.join(", ")}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Components summary */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">组件摘要</h3>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 text-amber-500" />
                <span>{plugin.skillCount} 个 Skills</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Plug className="size-3.5 text-blue-500" />
                <span>{plugin.mcpServerCount} 个 MCP Servers</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Webhook className="size-3.5 text-violet-500" />
                <span>{hookCount} 个 Hooks</span>
              </div>
            </div>
          </div>

          {hideComponentDetails && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground leading-relaxed">
              从市场安装的 Plugin 仅展示组件数量，具体 Hooks、Skills、MCP 配置详情已隐藏。
            </div>
          )}

          {!hideComponentDetails && detail && detail.hooks.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">Hooks</h3>
                <span className="text-[11px] text-muted-foreground">
                  配置文件：{detail.hooks[0]?.hookPath ?? "hooks/hooks.json"}
                </span>
              </div>
              {!plugin.enabled && (
                <div className="rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  插件当前已禁用，下面这些 Hook 不会参与执行；你仍然可以提前调整它们的启停状态。
                </div>
              )}
              <div className="space-y-2">
                {detail.hooks.map((hook) => {
                  const isPrompt = hook.type === "prompt"
                  const summary = isPrompt ? (hook.prompt ?? "") : (hook.command ?? "")
                  return (
                    <div
                      key={hook.id}
                      className={cn(
                        "rounded-md border border-border/60 bg-muted/20 px-3 py-2 space-y-2",
                        !hook.enabled && "opacity-60"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-muted text-muted-foreground">
                          {eventLabel[hook.event] ?? hook.event}
                        </span>
                        {isPrompt && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-violet-500/15 text-violet-600 dark:text-violet-400">
                            策略
                          </span>
                        )}
                        {hook.matcher && hook.matcher !== "*" && (
                          <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                            {hook.matcher}
                          </span>
                        )}
                        {canManageHooks ? (
                          <button
                            className="ml-auto shrink-0"
                            onClick={() => onToggleHookEnabled?.(plugin, hook)}
                            title={hook.enabled ? "点击禁用" : "点击启用"}
                          >
                            <Power
                              className={cn(
                                "size-3.5",
                                hook.enabled ? "text-status-nominal" : "text-muted-foreground"
                              )}
                            />
                          </button>
                        ) : (
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {hook.enabled ? "已启用" : "已禁用"}
                          </span>
                        )}
                      </div>
                      <p
                        className={cn(
                          "text-xs text-muted-foreground break-all",
                          isPrompt ? "italic" : "font-mono"
                        )}
                      >
                        {summary}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Skills list */}
          {!hideComponentDetails && detail && detail.skills.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Skills</h3>
              <div className="space-y-1">
                {detail.skills.map((skill) => (
                  <div
                    key={skill}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs"
                  >
                    <Sparkles className="size-3 text-amber-500 shrink-0" />
                    <span className="truncate">{skill === "." ? "(根目录 Skill)" : skill}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MCP Servers list */}
          {!hideComponentDetails && detail && detail.mcpServers.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">MCP Servers</h3>
                <span className="text-[11px] text-muted-foreground">
                  默认携带当前用户身份，激活后显示并参与调用
                </span>
              </div>
              <div className="rounded-lg border border-blue-300/40 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300 leading-relaxed">
                插件 MCP 支持在 <span className="font-mono">.mcp.json</span> 中配置{" "}
                <span className="font-mono">injectUserHeaders</span>、{" "}
                <span className="font-mono">priority</span>、{" "}
                <span className="font-mono">scope</span> 和{" "}
                <span className="font-mono">fallback</span>。默认 remote MCP 会带上{" "}
                <span className="font-mono">yst_id_token</span>、{" "}
                <span className="font-mono">sap_id</span>、{" "}
                <span className="font-mono">name</span>；若不需要，可设{" "}
                <span className="font-mono">injectUserHeaders: false</span>。Fallback 只会在同时声明{" "}
                <span className="font-mono">safeToRetry: true</span> 时启用。
              </div>
              <div className="space-y-2">
                {(detail.mcpServerDetails.length > 0
                  ? detail.mcpServerDetails
                  : detail.mcpServers.map((name) => ({
                      name,
                      kind: "remote" as const,
                      injectUserHeaders: true,
                      priority: 50,
                      scope: "plugin-active" as const,
                      fallbackEnabled: false,
                      fallbackSafeToRetry: false
                    }))
                ).map((server) => (
                  <div
                    key={server.name}
                    className="rounded-md bg-muted/30 px-3 py-2 text-xs space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Plug className="size-3 text-blue-500 shrink-0" />
                      <span className="truncate font-medium">{server.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {server.kind}
                      </span>
                      {server.transport && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {server.transport}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span>用户 Header：{server.injectUserHeaders ? "默认注入" : "不注入"}</span>
                      <span>优先级：{server.priority}（插件最高 100）</span>
                      <span>作用域：{server.scope === "plugin-active" ? "插件激活优先" : "安装后常驻"}</span>
                      <span>
                        Fallback：
                        {server.fallbackEnabled
                          ? `到 ${server.fallbackTo ?? "global"}`
                          : server.fallbackSafeToRetry
                            ? "关闭"
                            : "关闭或未声明 safeToRetry"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading state */}
          {!hideComponentDetails && !detail && <p className="text-xs text-muted-foreground">加载中...</p>}

          {/* Plugin path */}
          {!hideComponentDetails && (
            <div className="pt-2 border-t border-border">
              <p className="text-[10px] text-muted-foreground/60 break-all">
                {plugin.path.replace(/\\/g, "/")}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
