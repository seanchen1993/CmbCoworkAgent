import { Eye, FileText, FolderOpen } from "lucide-react"
import type { ReactNode } from "react"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import type { RequirementPrdManifest } from "./requirement-data"

export function RequirementPrdSummaryCard({
  prd,
  fallbackName,
  onOpenFile,
  onRevealFile,
  children
}: {
  prd: RequirementPrdManifest["prd"]
  fallbackName: string
  onOpenFile?: () => void
  onRevealFile?: () => void
  children?: ReactNode
}): React.JSX.Element {
  const canOpenFile = Boolean(prd.file && onOpenFile)
  const canRevealFile = Boolean(prd.file && onRevealFile)

  return (
    <section className="rounded-xl border border-border/80 bg-white p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-base font-semibold leading-6 text-foreground">
              {prd.name || fallbackName}
            </h3>
            {prd.file ? (
              <div className="flex items-center gap-0.5">
                <IconPopoverButton
                  aria-label={canOpenFile ? "查看 PRD 总览详情" : "暂无关联 PRD 文件"}
                  icon={<Eye className="size-3.5" />}
                  disabled={!canOpenFile}
                  popoverContent={canOpenFile ? "在右侧面板预览文件" : "暂无关联 PRD 文件"}
                  onClick={onOpenFile}
                />
                <IconPopoverButton
                  aria-label={canRevealFile ? "打开 PRD 文件所在文件夹" : "暂无关联 PRD 文件"}
                  icon={<FolderOpen className="size-3.5" />}
                  disabled={!canRevealFile}
                  popoverContent={canRevealFile ? "打开文件所在文件夹" : "暂无关联 PRD 文件"}
                  onClick={onRevealFile}
                />
              </div>
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
