import { useEffect, useState } from "react"
import { FolderOpen, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

export function RequirementWorkDirPicker({
  workDir,
  onWorkDirChange,
  disabled = false
}: {
  workDir: string | null
  onWorkDirChange: (workDir: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)

  const selectWorkDir = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.requirements.selectWorkDir()
      if (!result.success) throw new Error(result.error || "选择需求工作目录失败")
      if (result.workDir) onWorkDirChange(result.workDir)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择需求工作目录失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4 dark:bg-muted/20">
      <div className="mb-2 flex items-center gap-2">
        <FolderOpen className="size-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">总需求工作目录</span>
        <span className="text-sm text-muted-foreground">
          多个需求可共用同一个根目录，无需分别设置
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
          {workDir || "尚未选择需求工作目录"}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || disabled}
          onClick={() => void selectWorkDir()}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FolderOpen className="size-3.5" />
          )}
          {loading ? "选择中..." : workDir ? "更换目录" : "选择目录"}
        </Button>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
        系统会在目录下为当前需求创建独立子文件夹，并将需求文件存放在其中。
      </p>
    </div>
  )
}

export function RequirementWorkDirDialog({
  open,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (workDir: string) => void | Promise<void>
}): React.JSX.Element {
  const [workDir, setWorkDir] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.requirements
      .getWorkDir()
      .then((value) => {
        if (!cancelled) setWorkDir(value)
      })
      .catch(() => {
        if (!cancelled) setWorkDir(null)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(next) => !confirming && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>选择需求工作目录</DialogTitle>
          <DialogDescription>
            首次进入项目模式前，请选择一个目录用于保存需求开发文件。
            <strong className="font-semibold text-foreground">
              只需设置一次，后续需求将默认复用该目录，不再重复提示。
            </strong>
          </DialogDescription>
        </DialogHeader>
        <RequirementWorkDirPicker
          workDir={workDir}
          onWorkDirChange={setWorkDir}
          disabled={confirming}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={confirming}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!workDir || confirming}
            onClick={() => {
              if (!workDir) return
              setConfirming(true)
              void Promise.resolve(onConfirm(workDir)).finally(() => setConfirming(false))
            }}
          >
            {confirming ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {confirming ? "正在准备" : "确认并去开发"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
