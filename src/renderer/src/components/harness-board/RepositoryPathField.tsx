import { useEffect, useState } from "react"
import { ChevronDown, Info, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { HarnessDeployUnitConfig } from "../../../../shared/harness-board-types"

export function RepositoryBranchHint({
  path,
  compact = false
}: {
  path: string
  compact?: boolean
}): React.JSX.Element | null {
  const [result, setResult] = useState<{ path: string; text: string } | null>(null)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void window.api.git
      .currentBranch(path)
      .then((info) => {
        if (!cancelled)
          setResult({
            path,
            text: info.error
              ? "分支读取失败"
              : info.isMultiRepo
                ? "该目录包含子仓库，请选择具体工程查看分支"
                : !info.isGitRepo
                  ? "非 Git 目录"
                  : info.branch === "HEAD" || !info.branch
                    ? "游离 HEAD"
                    : `分支：${info.branch}`
          })
      })
      .catch(() => {
        if (!cancelled) setResult({ path, text: "分支读取失败" })
      })
    return () => {
      cancelled = true
    }
  }, [path])
  if (!path) return null
  if (compact) {
    const text = result?.path === path ? result.text.replace(/^分支：/, "") : "读取中…"
    return (
      <Input
        readOnly
        value={text}
        className="h-9 min-w-0 cursor-default truncate border-border/50 bg-muted/50 text-sm text-muted-foreground shadow-none focus-visible:ring-0"
        aria-label={`Git 分支`}
      />
    )
  }
  const text = result?.path === path ? result.text.replace(/^分支：/, "") : "读取分支…"
  return (
    <span className="block min-w-0 truncate text-xs text-muted-foreground" title={text}>
      {text}
    </span>
  )
}

export function RepositoryPathsField({
  mapping,
  onChange,
  disabled
}: {
  mapping: HarnessDeployUnitConfig
  onChange: (mapping: HarnessDeployUnitConfig) => void
  disabled?: boolean
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const pick = async (pathId?: string): Promise<void> => {
    try {
      const localRepoPath = await window.api.workspace.select()
      if (!localRepoPath) return
      setError(null)
      onChange({
        ...mapping,
        repositoryPaths: pathId
          ? mapping.repositoryPaths.map((entry) =>
              entry.pathId === pathId ? { ...entry, localRepoPath } : entry
            )
          : [...mapping.repositoryPaths, { pathId: crypto.randomUUID(), localRepoPath }]
      })
    } catch {
      setError("选择目录失败，请重试")
    }
  }
  const firstPath = mapping.repositoryPaths[0]
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,5fr)_4.5rem] gap-3 text-xs font-medium text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <span>代码仓库路径</span>
          <span className="tabular-nums">已配置：{mapping.repositoryPaths.length}个</span>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="本地代码工程路径提示"
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="z-[70] max-w-72">
                支持添加同一代码仓库的多个文件夹路径，用于不同特性的并行开发
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
        <span>Git 分支</span>
      </div>
      <Popover>
        <PopoverAnchor asChild>
          <div className="grid min-w-0 grid-cols-[minmax(0,5fr)_minmax(0,5fr)_4.5rem] items-center gap-3">
            <div className="relative min-w-0">
              <Input
                readOnly
                value={firstPath?.localRepoPath ?? ""}
                placeholder="添加工程目录"
                title={firstPath?.localRepoPath}
                aria-label="选择代码仓库路径"
                disabled={disabled}
                onClick={() => void pick(firstPath?.pathId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    void pick(firstPath?.pathId)
                  }
                }}
                className="h-9 min-w-0 cursor-pointer truncate bg-background pr-10 placeholder:text-muted-foreground/45"
              />
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label="展开代码仓库路径"
                  title={`展开全部 ${mapping.repositoryPaths.length} 个路径`}
                  className="group absolute right-0.5 top-0.5 size-8 text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </PopoverTrigger>
            </div>
            {firstPath ? (
              <RepositoryBranchHint path={firstPath.localRepoPath} compact />
            ) : (
              <Input
                readOnly
                value=""
                aria-label="Git 分支"
                className="h-9 cursor-default border-border/50 bg-muted/50 text-muted-foreground shadow-none focus-visible:ring-0"
              />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={-36}
          avoidCollisions={false}
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-sm border-input bg-background p-0 text-foreground"
          aria-label="工程目录管理"
        >
          <div className="shrink-0 border-b border-border p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              disabled={disabled}
              onClick={() => void pick()}
            >
              <Plus className="size-4" />
              添加同一代码仓库的副本
            </Button>
          </div>
          <div className="min-h-0 max-h-72 space-y-2 overflow-y-auto p-2">
            {firstPath ? (
              <>
                {mapping.repositoryPaths.map((entry) => (
                  <div
                    key={entry.pathId}
                    className="grid grid-cols-[minmax(0,5fr)_minmax(0,5fr)_4.5rem] items-center gap-3"
                  >
                    <Input
                      readOnly
                      value={entry.localRepoPath}
                      title={entry.localRepoPath}
                      aria-label="选择代码仓库路径"
                      disabled={disabled}
                      className="h-9 min-w-0 cursor-pointer truncate bg-background text-sm"
                      onClick={() => void pick(entry.pathId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          void pick(entry.pathId)
                        }
                      }}
                    />
                    <RepositoryBranchHint path={entry.localRepoPath} compact />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      title="移除工程目录"
                      aria-label={`移除工程目录：${entry.localRepoPath}`}
                      disabled={disabled}
                      onClick={() =>
                        onChange({
                          ...mapping,
                          repositoryPaths: mapping.repositoryPaths.filter(
                            (item) => item.pathId !== entry.pathId
                          )
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </>
            ) : (
              <p className="py-2 text-center text-xs text-muted-foreground">暂无工程目录</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
