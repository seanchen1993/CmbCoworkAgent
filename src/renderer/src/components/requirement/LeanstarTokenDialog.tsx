import { ExternalLink, Loader2 } from "lucide-react"
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
import { Input } from "@/components/ui/input"

export function LeanstarTokenDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  saving,
  onConfirm,
  description = "填写 Token 后会保存到本地需求配置。",
  confirmLabel = "确定"
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onValueChange: (value: string) => void
  saving: boolean
  onConfirm: () => void | Promise<void>
  description?: string
  confirmLabel?: string
}): React.JSX.Element {
  const openTokenPage = (): void => {
    const url = import.meta.env.VITE_LEANSTAR_PERSONAL_TOKEN_URL?.trim() || ""
    if (!url) {
      toast.error("未配置精益之星 Token 获取链接")
      return
    }
    void window.electron.openExternal(url).catch(() => toast.error("打开 Token 获取页面失败"))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>精益之星身份令牌-Token</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={value}
            disabled={saving}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="请输入 Token"
            autoFocus
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              void onConfirm()
            }}
          />
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            onClick={openTokenPage}
          >
            打开链接获取 Token
            <ExternalLink className="size-3" />
          </button>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="button" onClick={() => void onConfirm()} disabled={saving || !value.trim()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
