import { useEffect, useState } from "react"
import { Info, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
      if (mapping.repositoryPaths.some((entry) => entry.localRepoPath === localRepoPath)) return
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
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            代码仓库路径（{mapping.repositoryPaths.length}）
          </span>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          disabled={disabled || mapping.repositoryPaths.length >= 10}
          onClick={() => void pick()}
        >
          <Plus className="size-4" />
          添加
        </Button>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {mapping.repositoryPaths.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            暂无路径
          </p>
        ) : (
          mapping.repositoryPaths.map((entry) => (
            <div
              key={entry.pathId}
              className="grid grid-cols-[minmax(0,5fr)_minmax(0,5fr)_2rem] items-center gap-3"
            >
              <button
                type="button"
                title={entry.localRepoPath}
                aria-label={`更换代码仓库路径：${entry.localRepoPath}`}
                disabled={disabled}
                className="h-9 min-w-0 rounded-sm border border-input bg-background px-3 text-left text-sm transition-colors hover:border-foreground/30 focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void pick(entry.pathId)}
              >
                <span className="block truncate">{entry.localRepoPath}</span>
              </button>
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
          ))
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
