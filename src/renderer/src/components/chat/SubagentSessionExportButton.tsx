import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { SubagentExportTarget } from "../../../../shared/subagent-session-export"

export function SubagentSessionExportButton({
  target
}: {
  target: SubagentExportTarget
}): React.JSX.Element {
  const [exporting, setExporting] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2"
      disabled={exporting}
      title="导出仍在内存中的完整会话和最近一次 API 请求；重启或缓存淘汰后不可用"
      onClick={async () => {
        setExporting(true)
        try {
          const result = await window.api.threads.exportSubagentSession(target)
          if (result.success) toast.success("会话已导出")
          else if (!result.canceled) toast.error(result.error || "导出失败")
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "导出失败")
        } finally {
          setExporting(false)
        }
      }}
    >
      <Download className="size-3.5" />
      {exporting ? "导出中" : "导出"}
    </Button>
  )
}
