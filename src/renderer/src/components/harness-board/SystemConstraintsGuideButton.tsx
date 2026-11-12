import { toast } from "sonner"
import { Button } from "@/components/ui/button"

export function SystemConstraintsGuideButton({
  disabled
}: {
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto shrink-0 px-0 py-0 text-xs"
      disabled={disabled}
      onClick={() => {
        void window.electron.openExternal("https://doc.cmbchina.com/f/v?id=_4bbPdp").catch(() => {
          toast.error("无法打开系统约束使用指引，请稍后重试")
        })
      }}
    >
      系统约束使用指引
    </Button>
  )
}
