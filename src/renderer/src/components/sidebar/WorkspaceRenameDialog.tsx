import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export interface WorkspaceRenameTarget {
  path: string | null
  name: string
  defaultName: string
  hasCustomName: boolean
}

interface WorkspaceRenameDialogProps {
  open: boolean
  workspace: WorkspaceRenameTarget | null
  onOpenChange: (open: boolean) => void
  onSubmit: (workspacePath: string, nextName: string | null) => void
}

export function WorkspaceRenameDialog({
  open,
  workspace,
  onOpenChange,
  onSubmit
}: WorkspaceRenameDialogProps): React.JSX.Element {
  const [value, setValue] = useState("")

  useEffect(() => {
    if (open && workspace) {
      setValue(workspace.name)
      return
    }

    setValue("")
  }, [open, workspace])

  function closeDialog(): void {
    onOpenChange(false)
  }

  function submitName(nextName: string | null): void {
    if (!workspace?.path) {
      closeDialog()
      return
    }

    onSubmit(workspace.path, nextName)
    closeDialog()
  }

  function handleSave(): void {
    const nextName = value.trim()
    submitName(!nextName || nextName === workspace?.defaultName ? null : nextName)
  }

  function handleReset(): void {
    submitName(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改工作区名称</DialogTitle>
          <DialogDescription>仅影响侧边栏展示，不会修改实际目录名。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">工作区路径</div>
            <div className="break-all rounded-sm border border-border/70 bg-muted/40 px-3 py-2 text-xs text-foreground">
              {workspace?.path}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">显示名称</div>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleSave()
                }
              }}
              placeholder={workspace?.defaultName || "输入工作区名称"}
              autoFocus
            />
            <div className="text-xs text-muted-foreground">留空将恢复默认名称。</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            取消
          </Button>
          <Button variant="outline" onClick={handleReset} disabled={!workspace?.hasCustomName}>
            恢复默认
          </Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
