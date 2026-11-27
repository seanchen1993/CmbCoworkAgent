import { useEffect, useState } from "react"
import { GitBranch, RefreshCw } from "lucide-react"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import { Button } from "@/components/ui/button"
import { isBinaryFile } from "@/lib/file-types"
import type { GitPanelRepository } from "../../../../shared/git-panel-repository"
import { WORKSPACE_WATCH_DEBOUNCE_MS } from "../../../../shared/workspace-files-changed"
import { isSameGitWorkspacePath } from "../../../../shared/workspace-path"

type DiffList = Awaited<ReturnType<typeof window.api.workspace.getGitPanelDiffs>>

export function AuthorizedGitPanel({
  threadId,
  repository,
  picker,
  onRefresh
}: {
  threadId: string
  repository: GitPanelRepository
  picker: React.ReactNode
  onRefresh: () => void
}): React.JSX.Element {
  const [revision, setRevision] = useState(0)
  const [response, setResponse] = useState<{
    revision: number
    branch: string | null
    list?: DiffList
    error?: string
  }>()
  const [file, setFile] = useState<string | null>(null)
  const path = repository.path
  const branch = repository.branch
  const currentResponse =
    response?.revision === revision && response.branch === branch ? response : undefined
  const list = currentResponse?.list
  const error = currentResponse?.error

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let refreshBranch = false
    const unsubscribe = window.api.workspace.onFilesChanged((event) => {
      if (
        !event.threadIds.includes(threadId) ||
        !isSameGitWorkspacePath(event.literalWorkspacePath ?? event.workspacePath, path)
      )
        return
      refreshBranch ||= event.changeType === "meta"
      clearTimeout(timer)
      timer = setTimeout(() => {
        setRevision((value) => value + 1)
        if (refreshBranch) onRefresh()
        refreshBranch = false
      }, WORKSPACE_WATCH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [threadId, path, onRefresh])

  useEffect(() => {
    let current = true
    window.api.workspace
      .getGitPanelDiffs(threadId, {
        worktreePath: path,
        panelRepository: true,
        includeDiffs: false,
        includeChangedFiles: false,
        statusUntrackedMode: "normal"
      })
      .then((result) => {
        if (!current) return
        if (!result.success) throw new Error(result.error || "读取文件变更失败")
        setResponse({ revision, branch, list: result })
        setFile((selected) =>
          result.files.some((entry) => entry.path === selected) ? selected : null
        )
      })
      .catch((cause: unknown) => {
        if (current)
          setResponse({
            revision,
            branch,
            error: cause instanceof Error ? cause.message : String(cause)
          })
      })
    return () => {
      current = false
    }
  }, [threadId, path, branch, revision])

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border bg-background-elevated">
      <header className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          {picker}
          <Button
            size="sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setRevision((value) => value + 1)
              onRefresh()
            }}
          >
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">本任务授权</span>
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate" title={repository.branch ?? undefined}>
            分支 {repository.branch || "未知分支"}
          </span>
        </div>
      </header>
      {error ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          {error}
        </p>
      ) : !list ? (
        <p role="status" className="p-3 text-xs">
          正在读取文件变更…
        </p>
      ) : !list.files.length ? (
        <p className="p-3 text-sm">当前仓库没有待查看的文件改动</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[50%] shrink-0 overflow-y-auto border-b p-2">
            <div className="px-2 py-1 text-xs text-muted-foreground">
              变更文件 · {list.changedFilesTotal ?? list.files.length}
              {Boolean(list.omittedFileCount) && `（仅显示前 ${list.files.length} 个）`}
            </div>
            {list.files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                aria-label={`查看 ${entry.path} 的 diff`}
                aria-pressed={file === entry.path}
                title={entry.path}
                onClick={() => setFile(entry.path)}
                className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-muted/50 aria-pressed:bg-muted"
              >
                {entry.path}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {file ? (
              <AuthorizedFileDiff
                key={file}
                threadId={threadId}
                repositoryPath={path}
                file={file}
              />
            ) : (
              <p className="p-2 text-xs text-muted-foreground">选择文件查看改动</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function AuthorizedFileDiff({
  threadId,
  repositoryPath,
  file
}: {
  threadId: string
  repositoryPath: string
  file: string
}): React.JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState("")
  const binary = isBinaryFile(file.split("/").pop() || file)
  useEffect(() => {
    if (binary) return
    let current = true
    window.api.workspace
      .getGitPanelFileDiff(threadId, file, {
        worktreePath: repositoryPath,
        panelRepository: true
      })
      .then((result) => {
        if (!current) return
        if (!result.success || !result.file) throw new Error(result.error || "读取文件 diff 失败")
        setDiff(result.file.diff)
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      current = false
    }
  }, [threadId, repositoryPath, file, binary])
  if (binary) return <p className="p-2 text-xs">暂不支持 Diff 预览</p>
  if (error)
    return (
      <p role="alert" className="p-2 text-xs text-destructive">
        {error}
      </p>
    )
  if (diff === null)
    return (
      <p role="status" className="p-2 text-xs">
        正在读取文件 diff…
      </p>
    )
  return diff ? (
    <DiffDisplay diff={diff} filePath={file} />
  ) : (
    <p className="p-2 text-xs">无文本差异</p>
  )
}
