import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  FolderOpen,
  Plug,
  Plus,
  Power,
  Puzzle,
  Search,
  Sparkles,
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

type PluginHookMetadata = Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]
const PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL =
  import.meta.env.VITE_PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL?.trim()

interface PluginDetail {
  skills: string[]
  mcpServers: string[]
  hookCount: number
  hooks: PluginHookMetadata[]
  manifest: PluginManifest | null
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
  onSuccess: () => void
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
          onSuccess()
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
        onSuccess()
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
  const [plugins, setPlugins] = useState<PluginMetadata[]>([])
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMetadata | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<PluginMetadata | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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

  // After install/update, refresh the selected plugin's detail if it was affected
  const handleInstallSuccess = useCallback(() => {
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
            window.api.plugins
              .getDetail(updated.id)
              .then(setDetail)
              .catch(() => {
                setDetail({ skills: [], mcpServers: [], hookCount: 0, hooks: [], manifest: null })
              })
          }
        }
      })
      .catch(console.error)
  }, [bumpPluginVersion, selectedPlugin])

  useEffect(() => {
    refreshPlugins()
  }, [refreshPlugins])

  const loadDetail = useCallback(async (plugin: PluginMetadata) => {
    setSelectedPlugin(plugin)
    setDetail(null)
    try {
      const d = await window.api.plugins.getDetail(plugin.id)
      setDetail(d)
    } catch {
      setDetail({ skills: [], mcpServers: [], hookCount: 0, hooks: [], manifest: null })
    }
  }, [])

  const handleSelectPlugin = useCallback(
    (plugin: PluginMetadata) => {
      if (selectedPlugin?.id === plugin.id) return
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
              filteredPlugins.map((plugin) => (
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
              ))
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
    </>
  )
}

export function PluginDetailPanel(props: {
  plugin: PluginMetadata | null
  detail: PluginDetail | null
  onToggleEnabled: (plugin: PluginMetadata) => void
  onToggleHookEnabled?: (plugin: PluginMetadata, hook: PluginHookMetadata) => void
  onDelete: (plugin: PluginMetadata) => void
  hideActions?: boolean
}): React.JSX.Element {
  const {
    plugin,
    detail,
    onToggleEnabled,
    onToggleHookEnabled,
    onDelete,
    hideActions = false
  } = props

  if (!plugin) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
        <div className="max-w-md space-y-6">
          <div className="text-center space-y-3">
            <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
              <Puzzle className="size-7 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground/80">Plugins 插件</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              插件是打包好的功能扩展包，一个插件可以同时包含 Skills、MCP 服务器和 Hooks。
              相比单独添加技能或 MCP，插件提供了更便捷的「一键安装、整体管理」的体验。
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">插件包含什么？</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                一个插件可以包含以下组件的任意组合：
                <span className="font-medium text-foreground/60">Skills</span>（位于{" "}
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">skills/</span>{" "}
                目录）、<span className="font-medium text-foreground/60">MCP 服务器</span>（通过{" "}
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">.mcp.json</span>{" "}
                配置），以及 <span className="font-medium text-foreground/60">Hooks</span>（默认读取{" "}
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                  hooks/hooks.json
                </span>
                ）。 安装后，包含的技能、MCP 和 Hooks 都可以在插件详情页查看和管理。
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">如何安装？</p>
              <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">1.</span>点击{" "}
                  <span className="font-medium text-foreground/60">+</span> 按钮，上传{" "}
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">.zip</span>{" "}
                  压缩包，或选择本地文件夹直接安装
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">2.</span>也可以前往{" "}
                  <span className="font-medium text-foreground/60">Market</span>{" "}
                  浏览社区发布的插件，一键下载安装
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">3.</span>
                  安装后可查看插件的版本、作者、许可证、包含的组件等详情
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">4.</span>
                  通过开关随时启用或禁用，也可以完全卸载不需要的插件
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">插件 vs 单独添加</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                如果你只需要一个技能，直接在 Skills
                页面上传即可。如果你只需要连接一个远程工具服务，在 MCPs
                页面添加即可。但当你需要「一组关联的技能 + MCP 配置 + Hook
                规则」打包分发时，插件是更好的选择——安装一次，全部就位。
              </p>
            </div>
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

          {detail && detail.hooks.length > 0 && (
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
          {detail && detail.skills.length > 0 && (
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
          {detail && detail.mcpServers.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">MCP Servers</h3>
              <div className="space-y-1">
                {detail.mcpServers.map((server) => (
                  <div
                    key={server}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs"
                  >
                    <Plug className="size-3 text-blue-500 shrink-0" />
                    <span className="truncate">{server}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading state */}
          {!detail && <p className="text-xs text-muted-foreground">加载中...</p>}

          {/* Plugin path */}
          <div className="pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground/60 break-all">
              {plugin.path.replace(/\\/g, "/")}
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
