import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plug, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { McpConnectorConfig } from "@/types"
import { AddMcpConnectorDialog } from "./AddMcpConnectorDialog"
import { MCPConnectorDetail } from "./MCPConnectorDetail"
import { marketApi, type MarketItem } from "../../api/market"
import {
  MarketPublishDialog,
  type MarketPublishTarget
} from "./MarketPanel/MarketPublishDialog"
import { readUploadedItemNamesFromStorage } from "./MarketPanel/marketPublishStorage"
import { toast } from "sonner"

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
  const [selectedMcpConnector, setSelectedMcpConnector] = useState<McpConnectorConfig | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [addMcpDialogOpen, setAddMcpDialogOpen] = useState(false)
  const [editMcpConnector, setEditMcpConnector] = useState<McpConnectorConfig | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishTarget, setPublishTarget] = useState<MarketPublishTarget | null>(null)
  const [publishMode, setPublishMode] = useState<"upload" | "update">("upload")
  const [marketMcpMap, setMarketMcpMap] = useState<Record<string, MarketItem>>({})
  const [uploadedMcpNames, setUploadedMcpNames] = useState<Set<string>>(() =>
    readUploadedItemNamesFromStorage("mcp")
  )
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  useEffect(() => {
    window.api.mcp.list().then(setMcpConnectors).catch(console.error)
  }, [])

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

  const filteredMcpConnectors = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return mcpConnectors
    return mcpConnectors.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.url ?? "").toLowerCase().includes(q) ||
        (c.command ?? "").toLowerCase().includes(q)
    )
  }, [mcpConnectors, debouncedQuery])

  const handleMcpToggleEnabled = useCallback((id: string, enabled: boolean) => {
    window.api.mcp.setEnabled(id, enabled).catch(console.error)
    setMcpConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)))
    setSelectedMcpConnector((prev) => (prev?.id === id ? { ...prev, enabled } : prev))
  }, [])

  const handleMcpToggleLazyLoad = useCallback((id: string, lazyLoad: boolean) => {
    // Use functional update to avoid stale closure over mcpConnectors
    setMcpConnectors((prevConnectors) => {
      const connector = prevConnectors.find((c) => c.id === id)
      if (!connector) return prevConnectors

      window.api.mcp.update({ ...connector, lazyLoad }).catch(console.error)

      setSelectedMcpConnector((prev) => (prev?.id === id ? { ...prev, lazyLoad } : prev))
      return prevConnectors.map((c) => (c.id === id ? { ...c, lazyLoad } : c))
    })
  }, [])

  const handleMcpDelete = useCallback(async (connector: McpConnectorConfig) => {
    try {
      await window.api.mcp.delete(connector.id)
      setSelectedMcpConnector((prev) => (prev?.id === connector.id ? null : prev))
      const updated = await window.api.mcp.list()
      setMcpConnectors(updated)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const handleMcpAddSuccess = useCallback(async () => {
    try {
      const updated = await window.api.mcp.list()
      setMcpConnectors(updated)
      setSelectedMcpConnector((prev) => {
        if (!prev) return null
        return updated.find((c) => c.id === prev.id) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

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
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">MCP 连接器</h2>
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
            {filteredMcpConnectors.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">
                {mcpConnectors.length === 0 ? "暂无连接器，点击 + 添加" : "没有匹配的连接器"}
              </p>
            ) : (
              filteredMcpConnectors.map((connector) => (
                <button
                  key={connector.id}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedMcpConnector?.id === connector.id ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedMcpConnector(connector)}
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
      <MCPConnectorDetail
        connector={selectedMcpConnector}
        onToggleEnabled={handleMcpToggleEnabled}
        onToggleLazyLoad={handleMcpToggleLazyLoad}
        onDelete={handleMcpDelete}
        onEdit={(c) => {
          setEditMcpConnector(c)
          setAddMcpDialogOpen(true)
        }}
        onPublish={selectedMcpConnector ? () => openPublishDialog(selectedMcpConnector) : undefined}
        publishLabel={
          selectedMcpConnector &&
          uploadedMcpNames.has(selectedMcpConnector.name.trim().toLowerCase())
            ? "更新到市场"
            : "发布到市场"
        }
      />
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
          setUploadedMcpNames(readUploadedItemNamesFromStorage("mcp"))
          void loadMarketMcps()
          toast.success(
            mode === "update"
              ? `MCP 连接器「${name}」更新发布成功，已跳转到应用市场。`
              : `MCP 连接器「${name}」发布成功，已跳转到应用市场。`
          )
          setShowCustomizeView(true, "market")
        }}
      />
    </>
  )
}
