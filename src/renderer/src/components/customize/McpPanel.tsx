import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { notifyMarketPublished, notifyMcpInstallationChanged } from "@/lib/market-change-events"
import { ArrowLeft, Plug, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { McpConnectorConfig } from "@/types"
import { AddMcpConnectorDialog } from "./AddMcpConnectorDialog"
import { MCPConnectorDetail } from "./MCPConnectorDetail"
import { marketApi, type MarketItem } from "../../api/market"
import { MarketPublishDialog, type MarketPublishTarget } from "./MarketPanel/MarketPublishDialog"
import { readUploadedItemNamesFromStorage } from "./MarketPanel/marketPublishStorage"
import { toast } from "sonner"

const HIDDEN_MCP_CONNECTOR_NAMES = new Set(["in-app-browser"])

function isHiddenMcpConnector(connector: McpConnectorConfig): boolean {
  return HIDDEN_MCP_CONNECTOR_NAMES.has(connector.name.trim().toLowerCase())
}

function makeSafeJsonFileName(rawName: string): string {
  const sanitized = rawName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return `${sanitized || "mcp"}.json`
}

function buildMcpMarketConfig(connector: McpConnectorConfig): Record<string, unknown> {
  const serverConfig =
    connector.kind === "stdio" || connector.command
      ? {
          name: connector.name,
          type: "stdio",
          transport: "stdio",
          command: connector.command,
          args: connector.args ?? [],
          ...(connector.env && Object.keys(connector.env).length > 0 ? { env: connector.env } : {})
        }
      : {
          name: connector.name,
          type: connector.advanced?.transport ?? "streamable-http",
          url: connector.url,
          ...(connector.advanced?.transport ? { transport: connector.advanced.transport } : {}),
          ...(connector.advanced?.headers ? { headers: connector.advanced.headers } : {}),
          ...(connector.advanced ? { advanced: connector.advanced } : {})
        }

  return {
    mcpServers: {
      [connector.name]: serverConfig
    }
  }
}

export function McpPanel(): React.JSX.Element {
  const setShowCustomizeView = useAppStore((s) => s.setShowCustomizeView)
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedMcpConnector =
    mcpConnectors.find((connector) => connector.id === selectedId) ?? null
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const loadRevision = useRef(0)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [addMcpDialogOpen, setAddMcpDialogOpen] = useState(false)
  const [editMcpConnector, setEditMcpConnector] = useState<McpConnectorConfig | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishTarget, setPublishTarget] = useState<MarketPublishTarget | null>(null)
  const [publishMode, setPublishMode] = useState<"upload" | "update">("upload")
  const [marketMcpMap, setMarketMcpMap] = useState<Record<string, MarketItem>>({})
  const [uploadedMcpNames] = useState<Set<string>>(() => readUploadedItemNamesFromStorage("mcp"))
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  const reloadConnectors = useCallback(async (preferredConnectorName?: string) => {
    if (!mounted.current) return
    const revision = ++loadRevision.current
    setLoading(true)
    setLoadError(false)
    try {
      const updated = await window.api.mcp.list()
      if (revision !== loadRevision.current) return
      setMcpConnectors(updated)
      setSelectedId((previous) => {
        const visible = updated.filter((connector) => !isHiddenMcpConnector(connector))
        const preferred = preferredConnectorName
          ? visible.find((connector) => connector.name === preferredConnectorName)
          : undefined
        return (
          preferred?.id ??
          (visible.some((connector) => connector.id === previous) ? previous : null)
        )
      })
    } catch {
      if (revision === loadRevision.current) setLoadError(true)
    } finally {
      if (revision === loadRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const revision = loadRevision
    void reloadConnectors()
    return () => {
      mounted.current = false
      revision.current++
      clearTimeout(debounceTimer.current)
    }
  }, [reloadConnectors])

  const loadMarketMcps = useCallback(async () => {
    try {
      const res = await marketApi.getMcps()
      if (!res.success || !res.data) return
      const next: Record<string, MarketItem> = {}
      for (const item of res.data) {
        const key = item.name.trim().toLowerCase()
        if (key) next[key] = item
      }
      setMarketMcpMap(next)
    } catch (e) {
      console.warn("[McpPanel] Failed to load market MCPs:", e)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMarketMcps()
    }, 0)
    return () => clearTimeout(timer)
  }, [loadMarketMcps])

  const visibleMcpConnectors = useMemo(
    () => mcpConnectors.filter((connector) => !isHiddenMcpConnector(connector)),
    [mcpConnectors]
  )

  const filteredMcpConnectors = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return visibleMcpConnectors
    return visibleMcpConnectors.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.url ?? "").toLowerCase().includes(q) ||
        (c.command ?? "").toLowerCase().includes(q)
    )
  }, [visibleMcpConnectors, debouncedQuery])

  const saveConnector = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (savingRef.current) return
      savingRef.current = true
      setSaving(true)
      try {
        await operation()
        notifyMcpInstallationChanged()
      } catch {
        // Storage may have succeeded before capability publication failed. Read
        // back the owner rather than presenting a speculative rollback as fact.
        toast.error("未能确认连接器设置已生效，请重试。")
      } finally {
        await reloadConnectors()
        savingRef.current = false
        if (mounted.current) setSaving(false)
      }
    },
    [reloadConnectors]
  )

  const handleMcpToggleEnabled = useCallback(
    (id: string, enabled: boolean) => saveConnector(() => window.api.mcp.setEnabled(id, enabled)),
    [saveConnector]
  )

  const handleMcpToggleLazyLoad = useCallback(
    (id: string, lazyLoad: boolean) =>
      saveConnector(() => window.api.mcp.setLazyLoad(id, lazyLoad)),
    [saveConnector]
  )

  const handleMcpDelete = useCallback(
    (connector: McpConnectorConfig) => saveConnector(() => window.api.mcp.delete(connector.id)),
    [saveConnector]
  )

  const handleMcpAddSuccess = useCallback(
    async (preferredConnectorName?: string) => {
      notifyMcpInstallationChanged()
      await reloadConnectors(preferredConnectorName)
    },
    [reloadConnectors]
  )

  const openPublishDialog = useCallback(
    (connector: McpConnectorConfig) => {
      const key = connector.name.trim().toLowerCase()
      setPublishMode(uploadedMcpNames.has(key) ? "update" : "upload")
      setPublishTarget({
        type: "mcp",
        name: connector.name,
        description: marketMcpMap[key]?.description || connector.url || connector.command || "",
        category: marketMcpMap[key]?.category,
        chineseName: marketMcpMap[key]?.chinese_name,
        guidance: marketMcpMap[key]?.guidance,
        extraJson: marketMcpMap[key]?.extra_json
      })
      setPublishDialogOpen(true)
    },
    [marketMcpMap, uploadedMcpNames]
  )

  const buildMcpMarketFile = useCallback(
    async (target: MarketPublishTarget) => {
      const connector = mcpConnectors.find((item) => item.name === target.name)
      if (!connector) return { success: false, error: "MCP 连接器不存在" }
      const json = JSON.stringify(buildMcpMarketConfig(connector), null, 2)
      return {
        success: true,
        file: new File([json], makeSafeJsonFileName(connector.name), {
          type: "application/json"
        })
      }
    },
    [mcpConnectors]
  )

  return (
    <>
      <section className="@container/mcp flex min-h-0 min-w-0 flex-1" aria-label="连接应用设置">
        <div
          className={cn(
            "w-[280px] shrink-0 border-r border-border flex flex-col @max-[680px]/mcp:w-full",
            selectedMcpConnector && "@max-[680px]/mcp:hidden"
          )}
        >
          <div className="p-3 border-b border-border space-y-2">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">MCP 连接器</h2>
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
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
                        clearTimeout(debounceTimer.current)
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
                  aria-label="添加连接器"
                  disabled={saving || loading || loadError}
                  onClick={() => {
                    setEditMcpConnector(null)
                    setAddMcpDialogOpen(true)
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-2">
              {loadError ? (
                <div role="alert" className="space-y-2 px-1 py-2 text-xs text-muted-foreground">
                  <p>读取连接器失败，请重试。</p>
                  <Button variant="outline" size="sm" onClick={() => void reloadConnectors()}>
                    重试
                  </Button>
                </div>
              ) : loading ? (
                <p role="status" className="px-1 py-2 text-xs text-muted-foreground">
                  正在读取连接器…
                </p>
              ) : filteredMcpConnectors.length === 0 ? (
                <p className="text-xs text-muted-foreground px-1 py-2">
                  {visibleMcpConnectors.length === 0
                    ? "暂无连接器，点击 + 添加"
                    : "没有匹配的连接器"}
                </p>
              ) : (
                filteredMcpConnectors.map((connector) => (
                  <button
                    key={connector.id}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                      selectedMcpConnector?.id === connector.id
                        ? "bg-muted/70"
                        : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedId(connector.id)}
                  >
                    <Plug
                      className={cn(
                        "size-3.5 shrink-0",
                        connector.enabled ? "text-primary" : "text-muted-foreground"
                      )}
                    />
                    <span
                      className={cn(
                        "text-sm truncate flex-1",
                        !connector.enabled && "text-muted-foreground"
                      )}
                    >
                      {connector.name}
                    </span>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            selectedMcpConnector ? "flex" : "hidden @min-[680px]/mcp:flex"
          )}
        >
          {selectedMcpConnector && (
            <div className="shrink-0 px-3 pt-2 @min-[680px]/mcp:hidden">
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground"
                onClick={() => setSelectedId(null)}
              >
                <ArrowLeft className="size-4" />
                所有连接器
              </Button>
            </div>
          )}
          <MCPConnectorDetail
            connector={selectedMcpConnector}
            actionsDisabled={saving || loading || loadError}
            onToggleEnabled={handleMcpToggleEnabled}
            onToggleLazyLoad={handleMcpToggleLazyLoad}
            onDelete={handleMcpDelete}
            onEdit={(c) => {
              setEditMcpConnector(c)
              setAddMcpDialogOpen(true)
            }}
            onPublish={
              selectedMcpConnector ? () => openPublishDialog(selectedMcpConnector) : undefined
            }
            publishLabel={
              selectedMcpConnector &&
              uploadedMcpNames.has(selectedMcpConnector.name.trim().toLowerCase())
                ? "更新到市场"
                : "发布到市场"
            }
          />
        </div>
      </section>
      <AddMcpConnectorDialog
        open={addMcpDialogOpen}
        onOpenChange={(open) => {
          setAddMcpDialogOpen(open)
          if (!open) setEditMcpConnector(null)
        }}
        onSuccess={handleMcpAddSuccess}
        editConnector={editMcpConnector}
      />
      <MarketPublishDialog
        open={publishDialogOpen}
        mode={publishMode}
        target={publishTarget}
        marketInfo={
          publishTarget ? marketMcpMap[publishTarget.name.trim().toLowerCase()] : undefined
        }
        buildFile={buildMcpMarketFile}
        onOpenChange={(open) => {
          setPublishDialogOpen(open)
          if (!open) setPublishTarget(null)
        }}
        onSuccess={({ name, mode }) => {
          notifyMarketPublished("mcp")
          toast.success(
            mode === "update"
              ? `MCP 连接器「${name}」更新发布成功，已跳转到应用市场。`
              : `MCP 连接器「${name}」发布成功，已跳转到应用市场。`
          )
          useAppStore.setState({
            marketInitialTab: "mcp",
            marketInitialSkillSearchQuery: name.trim(),
            marketInitialSkillDetailName: null
          })
          setShowCustomizeView(true, "market")
        }}
      />
    </>
  )
}
