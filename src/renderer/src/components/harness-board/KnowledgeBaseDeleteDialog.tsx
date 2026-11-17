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

export function KnowledgeBaseDeleteDialog({
  name,
  busy,
  blocked,
  onClose,
  onConfirm
}: {
  name: string | null
  busy: boolean
  blocked: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除公共系统约束</DialogTitle>
          <DialogDescription>
            将删除[{name}]。公共系统约束沉淀产生的未提交的改动将会一并删除。
            如果该公共系统约束对您仍然可见，一段时间后将自动重新下载。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="destructive" disabled={busy || blocked} onClick={onConfirm}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            {busy ? "正在删除…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
