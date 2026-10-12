import { botApi } from "@/lib/bot-api"
import { useState } from "react"
import { GitBranch, GitMerge, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import type {
  BotWorktreeCleanup,
  BotWorktreeDetail,
  BotWorktreeMerge
} from "../../../../shared/bot-worktree"

type Action = "merge" | "discard" | "cleanup"
type Pending = { action: Action; request: BotWorktreeMerge | BotWorktreeCleanup }

export function BotWorktreePanel({
  address,
  settled
}: {
  address: BotRunAddress
  settled: boolean
}) {
  const [detail, setDetail] = useState<BotWorktreeDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Action | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const read = async () => {
    setBusy(true)
    setError(null)
    setConfirming(null)
    try {
      const next = await botApi.worktreeDetail(address)
      setDetail(next)
      // A fresh read is serialized with the Git worker's operation lock. It
      // resolves an unknown response before a new confirmation can be offered.
      setPending(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "工作区读取失败")
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    const action = pending?.action ?? confirming
    if (!action || !detail?.worktree.headCommit) return
    const request = pending?.request ?? {
      ...address,
      nonce: crypto.randomUUID(),
      expectedHeadCommit: detail.worktree.headCommit,
      ...(action !== "merge" ? { operation: action } : {})
    }
    setPending({ action, request })
    setBusy(true)
    setError(null)
    try {
      const worktree =
        action === "merge"
          ? await botApi.worktreeMerge(request)
          : await botApi.worktreeCleanup({ ...request, operation: action })
      setDetail({
        worktree,
        summary: worktree.status === "merged" ? "变更已合并到源分支。" : "工作区已丢弃。",
        patch: "",
        patchTruncated: false
      })
      setPending(null)
      setConfirming(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作结果未确认，请重试原请求")
    } finally {
      setBusy(false)
    }
  }
  const worktree = detail?.worktree
  const canMerge =
    settled &&
    worktree &&
    ["ready", "recoverable"].includes(worktree.status) &&
    !worktree.dirty &&
    worktree.headCommit &&
    worktree.headCommit !== worktree.baseCommit &&
    !detail.patchTruncated
  const canDiscard =
    settled && worktree?.headCommit && ["ready", "recoverable"].includes(worktree.status)
  const canCleanup =
    settled &&
    worktree?.headCommit &&
    worktree.cleanupPending &&
    ["merged", "discarded"].includes(worktree.status)
  const action = pending?.action ?? confirming
  return (
    <section className="space-y-3 rounded-xl border bg-muted/20 p-3" aria-label="独立代码工作区">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <GitBranch size={15} />
          独立代码工作区
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void read()}>
          {busy ? (
            "正在处理…"
          ) : detail ? (
            <>
              <RefreshCw size={13} />
              刷新变更
            </>
          ) : (
            "查看变更"
          )}
        </Button>
      </div>
      {detail && worktree && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div>
              源分支 <span className="font-medium text-foreground">{worktree.sourceBranch}</span>
            </div>
            {worktree.headCommit && (
              <div>
                提交 {worktree.headCommit.slice(0, 12)}
                {worktree.dirty ? " · 有未提交修改" : ""}
              </div>
            )}
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">工作区信息</summary>
            <div className="mt-2 space-y-1 break-all select-text">
              <div>{worktree.branch}</div>
              <div>{worktree.directory}</div>
              {!["merged", "discarded"].includes(worktree.status) && (
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words">
                  {detail.summary}
                </pre>
              )}
            </div>
          </details>
          {["merged", "discarded"].includes(worktree.status) && (
            <p className="text-xs">{detail.summary}</p>
          )}
          {detail.patch && (
            <div className="max-h-64 overflow-auto rounded-lg border bg-background">
              <DiffDisplay diff={detail.patch} />
            </div>
          )}
          {detail.patchTruncated && (
            <p className="text-xs text-muted-foreground">
              部分文件无法完整预览，请展开工作区信息并在本地检查。
            </p>
          )}
          {worktree.dirty && !["merged", "discarded"].includes(worktree.status) && (
            <p className="text-xs text-muted-foreground">
              工作区修改已保留。提交或处理完未提交修改后，可合并到源分支。
            </p>
          )}
          {worktree.cleanupPending && (
            <p className="text-xs text-muted-foreground">
              临时目录尚未清理，可重试清理以释放空间。
            </p>
          )}
          {worktree.error && (
            <p role="status" className="break-words text-xs text-muted-foreground">
              {worktree.error}
            </p>
          )}
          {(canMerge || canDiscard || canCleanup || pending) && (
            <div className="space-y-2">
              {confirming || pending ? (
                <>
                  <p className="text-xs">
                    {action === "merge"
                      ? `确认将提交 ${(pending?.request.expectedHeadCommit ?? worktree.headCommit)!.slice(0, 12)} 合并到 ${worktree.sourceBranch}？`
                      : "删除此任务的独立目录和分支，包括未提交及忽略的文件。此操作不可撤销，源项目不会被删除。"}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={action === "merge" ? "default" : "destructive"}
                      disabled={busy}
                      onClick={() => void apply()}
                    >
                      {action === "merge" ? <GitMerge size={14} /> : <Trash2 size={14} />}
                      {pending ? "重试原请求" : action === "merge" ? "确认合并" : "确认删除工作区"}
                    </Button>
                    {!pending && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        取消
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {canMerge && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirming("merge")}
                    >
                      <GitMerge size={14} />
                      合并到源分支
                    </Button>
                  )}
                  {(canDiscard || canCleanup) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirming(canCleanup ? "cleanup" : "discard")}
                    >
                      <Trash2 size={14} />
                      {canCleanup ? "重试清理" : "丢弃工作区"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
