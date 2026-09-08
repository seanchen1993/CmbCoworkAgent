import { Button } from "@/components/ui/button"
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
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function ThreadGroupDeleteDialog({
  open,
  title,
  description,
  confirming = false,
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
