import { useEffect, useState } from "react"
import { GitCommitHorizontal, Loader2, FolderPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { TaskCardPicker } from "./TaskCardPicker"
import type {
  TaskCommitBinding,
  TaskCommitBindingEditor
} from "../../../../shared/task-commit-binding"

export function TaskCommitBindingControl({ threadId }: { threadId: string }): React.JSX.Element {
  const [binding, setBinding] = useState<TaskCommitBinding | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<TaskCommitBindingEditor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    window.api.taskCommitBinding
      .read(threadId)
      .then((value) => {
        if (active) setBinding(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [threadId])

  async function load() {
    setOpen(true)
    setBusy(true)
    setError("")
    setDraft(null)
    try {
      const next = await window.api.taskCommitBinding.open(threadId)
      setDraft(next)
      if (next.warning) setError(next.warning)
      if (!next.active) setBinding(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function change(action: "choose" | "save" | "revoke") {
    if (!draft || busy) return
    setBusy(true)
    setError("")
    try {
      if (action === "choose") {
        const paths = await window.api.taskCommitBinding.choose(draft.token)
        setDraft({
          ...draft,
          repositories: [...new Set([...draft.repositories, ...paths])],
          selected: [...new Set([...draft.selected, ...paths])]
        })
      } else {
        if (action === "save") {
          setBinding(
            await window.api.taskCommitBinding.save(draft.token, draft.cardNumber, draft.selected)
          )
        } else {
          await window.api.taskCommitBinding.revoke(draft.token)
          setBinding(null)
        }
        setOpen(false)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-xs"
        onClick={() => void load()}
        title={
          binding
            ? [binding.cardNumber || "提交时选择任务卡", ...binding.repositoryPaths].join("\n")
            : "设置本任务的提交卡号和仓库"
        }
      >
        <GitCommitHorizontal className="size-3.5" />
        {binding ? binding.cardNumber || "提交时选卡" : "任务提交设置"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent ref={setContainer} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>本任务的 Git 提交</DialogTitle>
            <DialogDescription>
              {draft?.cardNumber.trim()
                ? "本任务中，Agent 明确提交所选仓库中的具体文件时，将使用预选任务卡。需要审阅的改动会提示确认，其余可直接提交。"
                : "Agent 在所选仓库提交时，会请你选择任务卡并确认本次提交。"}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">预选任务卡（可选）</span>
                  {draft.cardNumber && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={busy}
                      onClick={() => setDraft({ ...draft, cardNumber: "" })}
                    >
                      清除预选任务卡
                    </Button>
                  )}
                </div>
                <TaskCardPicker
                  autoSelect={false}
                  value={draft.cardNumber}
                  disabled={busy}
                  onValueChange={(cardNumber) => setDraft({ ...draft, cardNumber })}
                  placeholder="选择或输入任务卡号"
                  portalContainer={container}
                />
              </div>
              <fieldset disabled={busy} className="space-y-2">
                <legend className="text-sm font-medium">可提交的仓库</legend>
                <div className="max-h-52 space-y-1 overflow-y-auto">
                  {draft.repositories.map((root) => (
                    <label key={root} className="flex items-start gap-2 rounded px-1 py-1 text-xs">
                      <input
                        type="checkbox"
                        checked={draft.selected.includes(root)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            selected: e.target.checked
                              ? [...draft.selected, root]
                              : draft.selected.filter((item) => item !== root)
                          })
                        }
                      />
                      <span className="break-all">{root}</span>
                    </label>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void change("choose")}
                >
                  <FolderPlus className="size-4" />
                  选择本地仓库
                </Button>
              </fieldset>
            </div>
          )}
          {busy && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在读取或保存提交设置
            </div>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {draft?.active && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void change("revoke")}
              >
                撤销授权
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || !draft?.selected.length}
              onClick={() => void change("save")}
            >
              确认本任务授权
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
