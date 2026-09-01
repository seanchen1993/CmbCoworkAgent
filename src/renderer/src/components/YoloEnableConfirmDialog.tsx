import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

interface YoloEnableConfirmDialogProps {
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function YoloEnableConfirmDialog({
  open,
  pending,
  onOpenChange,
  onConfirm
}: YoloEnableConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent aria-busy={pending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">开启全局 YOLO 模式？</DialogTitle>
          <DialogDescription>这是应用级设置，切换后立即影响后续操作。</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm leading-6 text-status-warning-foreground">
          开启后，后续符合条件的操作可能被自动批准，包括 Git push；关闭后会立即恢复审批。请确认你理解此风险。
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            确认开启
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
