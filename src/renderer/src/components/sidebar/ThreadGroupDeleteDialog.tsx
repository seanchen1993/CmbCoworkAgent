import { Button } from "@/components/ui/button"
import type { ThreadGroupDeletionProgress } from "@/lib/thread-group-deletion"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

interface ThreadGroupDeleteDialogProps {
  open: boolean
  title: string
  description: string
  confirming?: boolean
  progress?: ThreadGroupDeletionProgress | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function ThreadGroupDeleteDialog({
  open,
  title,
  description,
  confirming = false,
  progress,
  onOpenChange,
  onConfirm
}: ThreadGroupDeleteDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {confirming && progress
            ? `已处理 ${progress.completed}/${progress.total}，已删除 ${progress.deleted}，已跳过 ${progress.skipped}`
            : "运行中或删除失败的会话将保留，其余会话继续删除。"}
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={confirming} onClick={onConfirm}>
            {confirming ? "删除中..." : "删除全部"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
