import { Eye, FileText } from "lucide-react"
import type { ReactNode } from "react"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import type { RequirementPrdManifest } from "./requirement-data"

export function RequirementPrdSummaryCard({
  prd,
  fallbackName,
  onOpenFile,
  children
}: {
  prd: RequirementPrdManifest["prd"]
  fallbackName: string
  onOpenFile?: () => void
  children?: ReactNode
}): React.JSX.Element {
  const canOpenFile = Boolean(prd.file && onOpenFile)

  return (
    <section className="rounded-xl border border-border/80 bg-white p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-base font-semibold leading-6 text-foreground">
              {prd.name || fallbackName}
            </h3>
            {prd.file ? (
              <IconPopoverButton
                aria-label={canOpenFile ? "查看 PRD 总览详情" : "暂无关联 PRD 文件"}
                icon={<Eye className="size-3.5" />}
                disabled={!canOpenFile}
                popoverContent={canOpenFile ? "在右侧面板预览文件" : "暂无关联 PRD 文件"}
                onClick={onOpenFile}
              />
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">
        {prd.description || "暂无 PRD 描述"}
      </p>
      {prd.file ? (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <FileText className="size-3.5 shrink-0" />
          <span>文档文件</span>
          <strong className="truncate font-medium text-foreground">{prd.file}</strong>
        </div>
      ) : null}
      {children}
    </section>
  )
}
