import { ChevronDown, ChevronRight, FolderOpen, Loader2, RefreshCw } from "lucide-react"
import type { HarnessKnowledgePreviewResult } from "../../../../shared/harness-board-types"
import type { KnowledgeBaseListResult } from "../../../../shared/knowledge-base-types"
import { Button } from "@/components/ui/button"
import { KnowledgePreviewPanel } from "./KnowledgePreviewPanel"

const STATUS_LABELS = {
  not_downloaded: "未下载",
  success: "已下载",
  failed: "更新失败",
  blocked: "暂停更新"
} as const

export function KnowledgeBaseSyncPanel({
  result,
  loading,
  syncingIds,
  expandedIds,
  previews,
  loadingPreviewIds,
  selectedPreviewPaths,
  onRefreshAll,
  onSync,
  onTogglePreview,
  onRefreshPreview,
  onSelectPreviewPath,
  onOpenPath
}: {
  result: KnowledgeBaseListResult | null
  loading: boolean
  syncingIds: Set<string>
  expandedIds: Set<string>
  previews: Record<string, HarnessKnowledgePreviewResult>
  loadingPreviewIds: Set<string>
  selectedPreviewPaths: Record<string, string | null>
  onRefreshAll: () => void | Promise<void>
  onSync: (idKey: string) => void | Promise<void>
  onTogglePreview: (idKey: string) => void
  onRefreshPreview: (idKey: string) => void | Promise<void>
  onSelectPreviewPath: (idKey: string, path: string | null) => void
  onOpenPath: (path: string) => void
}): React.JSX.Element {
  const items = result?.knowledgeBases ?? []
  return (
    <section className="rounded-md border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">公共系统约束</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {result?.ready === false
              ? result.queryError
                ? "配置获取失败"
                : "云端配置尚未就绪"
              : `${items.length} 个知识库`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || result?.refreshing}
          onClick={onRefreshAll}
        >
          {loading || result?.refreshing ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 size-4" />
          )}
          检查全部更新
        </Button>
      </div>
      <div className="space-y-3 p-4">
        {result?.queryError && <p className="text-xs text-status-critical">{result.queryError}</p>}
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            {loading
              ? "正在加载知识库配置…"
              : result?.queryError
                ? "配置获取失败，请重试。"
                : result?.ready
                  ? "暂无可用知识库。"
                  : "云端配置尚未就绪。"}
          </div>
        ) : (
          items.map((item) => {
            const syncing = syncingIds.has(item.idKey) || result?.syncingIds.includes(item.idKey)
            const expanded = expandedIds.has(item.idKey)
            const historical = item.visibility !== "visible"
            return (
              <div
                key={item.idKey}
                className="rounded-md border border-border bg-muted/20 px-4 py-3"
              >
                <div className="flex min-w-0 items-center justify-between gap-4">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={expanded}
                    onClick={() => onTogglePreview(item.idKey)}
                  >
                    <div className="truncate text-sm font-semibold text-foreground">
                      {item.name}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.gitRef}
                      {historical ? " · 当前不可见" : ""}
                    </div>
                    {item.workspaces.map((workspace) => (
                      <div key={workspace.role} className="mt-1 text-xs text-muted-foreground">
                        {workspace.role === "read" ? "读取内容" : "沉淀工作区"}：
                        {workspace.syncing
                          ? "同步中"
                          : workspace.inUse
                            ? "沉淀会话运行中，暂停更新"
                            : !workspace.localValid && workspace.status === "success"
                              ? "目录不可用"
                              : STATUS_LABELS[workspace.status]}
                        {workspace.lastError && (
                          <span className="text-status-critical"> · {workspace.lastError}</span>
                        )}
                      </div>
                    ))}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.localValid && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={item.localPath}
                        onClick={() => onOpenPath(item.localPath)}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onTogglePreview(item.idKey)}
                    >
                      {expanded ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      disabled={historical || syncing || result?.refreshing}
                      onClick={() => onSync(item.idKey)}
                    >
                      {syncing ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 size-4" />
                      )}
                      拉取更新
                    </Button>
                  </div>
                </div>
                {expanded && (
                  <KnowledgePreviewPanel
                    preview={previews[item.idKey] ?? null}
                    loading={loadingPreviewIds.has(item.idKey)}
                    selectedPath={selectedPreviewPaths[item.idKey] ?? null}
                    onSelectPath={(path) => onSelectPreviewPath(item.idKey, path)}
                    onRefresh={() => onRefreshPreview(item.idKey)}
                  />
                )}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
