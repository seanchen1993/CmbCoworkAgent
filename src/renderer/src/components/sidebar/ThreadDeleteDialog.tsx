import type { MouseEventHandler } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

export function ThreadDeleteDialog({
  open,
  title,
  description,
  confirming = false,
  onCancel,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  confirming?: boolean
  onCancel: () => void
  onConfirm: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !confirming && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" disabled={confirming} onClick={onConfirm}>
            {confirming ? "删除中…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
