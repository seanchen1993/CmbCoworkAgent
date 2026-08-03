import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CheckCircle2, ExternalLink, FileText, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type {
  HarnessAgentmdLoadStatusItem,
  HarnessAgentmdLoadStatusState
} from "@/lib/thread-context"

export function getSystemConstraintsLoadCounts(
  state: HarnessAgentmdLoadStatusState | null | undefined
): { loaded: number; total: number } {
  const items = state?.items ?? []
  return {
    loaded: items.filter((item) => item.loaded).length,
    total: items.length
  }
}

export function hasNoLoadedSystemConstraints(
  state: HarnessAgentmdLoadStatusState | null | undefined
): boolean {
  const { loaded, total } = getSystemConstraintsLoadCounts(state)
  return total > 0 && loaded === 0
}

export function getSystemConstraintsOverviewTitle(
  state: HarnessAgentmdLoadStatusState | null | undefined
): string {
  if (hasNoLoadedSystemConstraints(state)) {
    return state?.loader === "cmbdevclaw"
      ? "CMBDevClaw 未加载全部系统约束"
      : "插件未加载全部系统约束"
  }
  return state?.loader === "cmbdevclaw" ? "CMBDevClaw 已加载系统约束" : "插件已加载系统约束"
}

export function SystemConstraintsPreviewPopover({
  preview,
  children,
  align = "start",
  side = "left",
  sideOffset = 10
}: {
  preview: string | null | undefined
  children: React.ReactElement
  align?: "center" | "end" | "start"
  side?: "bottom" | "left" | "right" | "top"
  sideOffset?: number
}): React.JSX.Element {
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const promptPreview = preview?.trim()
  const showPreview = useCallback(() => {
    if (previewHideTimerRef.current) {
      clearTimeout(previewHideTimerRef.current)
      previewHideTimerRef.current = null
    }
    if (promptPreview) setPreviewOpen(true)
  }, [promptPreview])
  const hidePreview = useCallback(() => {
    if (previewHideTimerRef.current) clearTimeout(previewHideTimerRef.current)
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null
      setPreviewOpen(false)
    }, 120)
  }, [])

  useEffect(
    () => () => {
      if (previewHideTimerRef.current) clearTimeout(previewHideTimerRef.current)
    },
    []
  )

  if (!promptPreview) return children

  return (
    <Popover open={previewOpen} onOpenChange={setPreviewOpen}>
      <PopoverAnchor asChild>
        <span
          className="inline-flex min-w-0"
          onPointerEnter={showPreview}
          onPointerLeave={hidePreview}
          onFocus={showPreview}
          onBlur={hidePreview}
        >
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="max-h-[70vh] w-[min(680px,calc(100vw-2rem))] overflow-auto p-3 text-left"
        onPointerEnter={showPreview}
        onPointerLeave={hidePreview}
      >
        <div className="mb-2 flex items-center gap-1.5 border-b border-border/60 pb-2 text-[11px] font-medium text-foreground/80">
          <FileText className="size-3.5" />
          <span>系统约束预览</span>
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {promptPreview}
        </pre>
      </PopoverContent>
    </Popover>
  )
}

function systemConstraintStatusClass(item: HarnessAgentmdLoadStatusItem): string {
  if (!item.loaded) {
    return "border-red-300/60 bg-red-50/70 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
  }
  if (item.source === "remote") {
    return "border-blue-300/60 bg-blue-50/70 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300"
  }
  if (item.source === "local") {
    return "border-emerald-300/60 bg-emerald-50/70 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
  }
  return "border-border/70 bg-muted/40 text-muted-foreground"
}

function systemConstraintLabel(item: HarnessAgentmdLoadStatusItem): string {
  const sourceLabel =
    item.source === "remote"
      ? "公共系统约束"
      : item.source === "local"
        ? "本地系统约束"
        : item.source || "系统约束"
  return item.loaded ? sourceLabel : `${sourceLabel}未加载`
}

async function openSystemConstraintPath(targetPath: string): Promise<void> {
  const normalizedTargetPath = targetPath.trim()
  if (!normalizedTargetPath) return
  try {
    const platform = await window.electron.ipcRenderer.invoke("get-platform")
    const normalizedPath =
      platform === "win32" ? normalizedTargetPath.replace(/\//g, "\\") : normalizedTargetPath
    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
    if (result && typeof result === "object" && "success" in result && !result.success) {
      const error =
        "error" in result && typeof result.error === "string" ? result.error : "无法打开路径"
      toast.error(error)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "无法打开路径")
  }
}

export function SystemConstraintsPanel({
  state
}: {
  state: HarnessAgentmdLoadStatusState | null | undefined
}): React.JSX.Element {
  const groupedItems = useMemo(() => {
    const groups = new Map<string, HarnessAgentmdLoadStatusItem[]>()
    for (const item of state?.items ?? []) {
      const group = groups.get(item.deployUnitId) ?? []
      group.push(item)
      groups.set(item.deployUnitId, group)
    }
    return Array.from(groups.entries())
  }, [state?.items])
  const { total } = getSystemConstraintsLoadCounts(state)
  const promptPreview = state?.promptPreview?.trim()
  const title = getSystemConstraintsOverviewTitle(state)
  const isLoadFailure = hasNoLoadedSystemConstraints(state)
  const handleOpenPath = useCallback((path: string): void => {
    void openSystemConstraintPath(path)
  }, [])

  if (!state || (total === 0 && !promptPreview)) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
        <FileText className="mb-2 size-8 opacity-50" />
        <span className="mt-1 text-xs">会话发起后显示系统约束加载详情</span>
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3 text-xs">
      {promptPreview ? (
        <SystemConstraintsPreviewPopover preview={promptPreview}>
          <div
            className={cn(
              "cursor-help border-l-2 px-3 py-2",
              isLoadFailure
                ? "border-amber-500/80 bg-amber-500/[0.08] dark:bg-amber-500/10"
                : "border-emerald-500/70 bg-emerald-500/[0.06] dark:bg-emerald-500/10"
            )}
            tabIndex={0}
          >
            <span
              className={cn(
                "inline-flex max-w-full truncate font-medium decoration-dotted underline-offset-2 hover:underline",
                isLoadFailure ? "text-amber-700 dark:text-amber-300" : "text-foreground"
              )}
            >
              {title}
            </span>
          </div>
        </SystemConstraintsPreviewPopover>
      ) : (
        <div
          className={cn(
            "border-l-2 px-3 py-2",
            isLoadFailure
              ? "border-amber-500/80 bg-amber-500/[0.08] dark:bg-amber-500/10"
              : "border-emerald-500/70 bg-emerald-500/[0.06] dark:bg-emerald-500/10"
          )}
        >
          <div
            className={cn(
              "truncate font-medium",
              isLoadFailure ? "text-amber-700 dark:text-amber-300" : "text-foreground"
            )}
          >
            {title}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {groupedItems.length === 0 && (
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-muted-foreground">
            本次会话没有 AGENTS.md 加载明细
          </div>
        )}
        {groupedItems.map(([deployUnitId, items]) => (
          <div key={deployUnitId} className="rounded-lg border border-border/70 bg-background/80">
            <div className="border-b border-border/60 px-3 py-2 font-mono text-[11px] font-semibold text-foreground/80">
              {deployUnitId}
            </div>
            <div className="space-y-2 p-2.5">
              {items.map((item, index) => (
                <button
                  key={`${deployUnitId}-${item.source}-${item.path}-${index}`}
                  type="button"
                  className={cn(
                    "group flex w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-background disabled:cursor-default disabled:opacity-75",
                    systemConstraintStatusClass(item)
                  )}
                  title={item.loaded && item.path ? `点击打开：${item.path}` : undefined}
                  disabled={!item.loaded || !item.path}
                  onClick={() => handleOpenPath(item.path)}
                >
                  {item.loaded ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{systemConstraintLabel(item)}</span>
                    {item.loaded && item.path ? (
                      <span className="mt-1 block truncate font-mono text-[10px] opacity-80">
                        {item.path}
                      </span>
                    ) : item.message ? (
                      <span className="mt-1 block text-[10px] opacity-85">{item.message}</span>
                    ) : (
                      <span className="mt-1 block text-[10px] opacity-75">无详情</span>
                    )}
                  </span>
                  {item.loaded && item.path && (
                    <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
