import { ChevronDown, ChevronRight, FolderOpen, Info, Loader2, RefreshCw } from "lucide-react"
import type { HarnessKnowledgePreviewResult } from "../../../../shared/harness-board-types"
import type {
  KnowledgeBaseListItem,
  KnowledgeBaseListResult
} from "../../../../shared/knowledge-base-types"
import { Button } from "@/components/ui/button"
import { Badge, badgeVariants, type BadgeProps } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { KnowledgePreviewPanel } from "./KnowledgePreviewPanel"

function knowledgeStatus(
  item: KnowledgeBaseListItem,
  syncing: boolean
): { label: string; variant: BadgeProps["variant"] } {
  const workspaces = item.workspaces
  if (syncing || workspaces.some((workspace) => workspace.syncing))
    return { label: "同步中", variant: "info" }
  const hasDownloaded = workspaces.some(
    (workspace) => workspace.status === "success" && workspace.localValid
  )
  if (workspaces.some((workspace) => workspace.status === "failed")) {
    return { label: hasDownloaded ? "部分更新失败" : "更新失败", variant: "critical" }
  }
  if (workspaces.some((workspace) => workspace.status === "blocked" || workspace.inUse))
    return { label: "暂停更新", variant: "warning" }
  if (workspaces.every((workspace) => workspace.status === "success" && workspace.localValid))
    return { label: "已下载", variant: "nominal" }
  if (workspaces.some((workspace) => workspace.status === "success" && !workspace.localValid))
    return { label: "目录不可用", variant: "critical" }
  return { label: hasDownloaded ? "部分下载" : "未下载", variant: "outline" }
}

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
  onSelectPreviewPath: (idKey: string, path: string | null) => void
  onOpenPath: (path: string) => void
}): React.JSX.Element {
  const items = result?.knowledgeBases ?? []
  return (
    <section className="rounded-md border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-foreground">公共系统约束</h2>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="知识库自动更新与可见范围说明"
                  className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="z-[70] max-w-72">
                知识库将定时自动拉取，可见的知识库由你所在的组织管理。
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
            const syncing =
              syncingIds.has(item.idKey) || result?.syncingIds.includes(item.idKey) === true
            const expanded = expandedIds.has(item.idKey)
            const historical = item.visibility !== "visible"
            const status = knowledgeStatus(item, syncing)
            const owner = [item.ownerName, item.ownerId].filter((value) => value.trim()).join("/")
            const commonError =
              item.workspaces[0]?.lastError &&
              item.workspaces.every(
                (workspace) => workspace.lastError === item.workspaces[0].lastError
              )
                ? item.workspaces[0].lastError
                : null
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
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span
                        className="min-w-0 truncate text-sm font-semibold text-foreground"
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      <Badge
                        variant="outline"
                        className="max-w-32 shrink-0 font-normal normal-case tracking-normal text-muted-foreground"
                        title={item.gitRef}
                      >
                        <span className="truncate">{item.gitRef}</span>
                      </Badge>
                      <Badge
                        variant={status.variant}
                        className="shrink-0 font-normal normal-case tracking-normal"
                      >
                        {status.label}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="shrink-0 font-normal normal-case tracking-normal text-muted-foreground"
                        title="最近成功更新时间（GMT+8）"
                      >
                        {item.lastSuccessfulSyncAt ?? "暂无成功更新"}
                      </Badge>
                      {owner && (
                        <Badge
                          variant="outline"
                          className="max-w-48 shrink-0 font-normal normal-case tracking-normal text-muted-foreground"
                          title={`维护人：${owner}`}
                        >
                          <span className="truncate">维护人：{owner}</span>
                        </Badge>
                      )}
                      {historical && (
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className={badgeVariants({
                                  variant: "outline",
                                  className:
                                    "shrink-0 font-normal normal-case tracking-normal text-muted-foreground"
                                })}
                              >
                                已不再可用
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="z-[70] max-w-72">
                              该知识库对您所在组织不再可用
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                    {!commonError &&
                      item.workspaces
                        .filter((workspace) => workspace.lastError)
                        .map((workspace) => (
                          <div
                            key={workspace.role}
                            className="mt-1 break-words text-xs text-status-critical"
                          >
                            {workspace.role === "read" ? "读取内容" : "沉淀工作区"}：
                            {workspace.lastError}
                          </div>
                        ))}
                    {commonError && (
                      <div className="mt-1 break-words text-xs text-status-critical">
                        {commonError}
                      </div>
                    )}
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
