import { useState } from "react"
import { ArrowLeft, Loader2, Save, WandSparkles } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ActiveRequirementDesignEntry } from "./use-requirement-design-entry"
import { returnToRequirementConversation } from "@/lib/requirement-design-entry"

export function RequirementDesignContextBar({
  entry,
  html,
  htmlId,
  artifactPath,
  artifactMetadata,
  disabledReason,
  onArtifactPathChange,
  onEntryChange,
  showToast
}: {
  entry: ActiveRequirementDesignEntry
  html: string
  htmlId: string
  artifactPath?: string | null
  artifactMetadata?: Record<string, unknown> | null
  disabledReason?: string
  onArtifactPathChange: (filePath: string) => void
  onEntryChange: (entry: ActiveRequirementDesignEntry) => void
  showToast: (message: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const requirementName = entry.requirementName?.trim() || "未命名需求"
  const functionName = entry.functionName?.trim() || "未命名功能"
  const effectiveDisabledReason = saving ? "正在同步设计，请稍候" : disabledReason

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      if (!html.trim()) throw new Error("请先生成设计内容")
      if (!htmlId) throw new Error("设计会话尚未就绪")

      const artifactId = `${htmlId}_design-main`
      let result = artifactPath
        ? await window.api.design.saveArtifactFile(
            artifactPath,
            html,
            entry.workspacePath,
            artifactMetadata ?? undefined
          )
        : await window.api.design.saveArtifact(
            artifactId,
            html,
            entry.workspacePath,
            artifactMetadata ?? undefined
          )
      if (!result.success && artifactPath) {
        result = await window.api.design.saveArtifact(
          artifactId,
          html,
          entry.workspacePath,
          artifactMetadata ?? undefined
        )
      }
      const htmlFile = result.filePath?.trim()
      if (!result.success || !htmlFile) throw new Error(result.error || "保存设计文件失败")

      await window.api.design.storeHtml(artifactId, html)
      onArtifactPathChange(htmlFile)
      const synced = await window.api.requirements.updateFunctionHtml({
        reqId: entry.requirementId,
        workspacePath: entry.workspacePath,
        requirementFilePath: entry.requirementFilePath,
        htmlFile,
        htmlId
      })
      if (!synced.success) throw new Error(synced.error || "同步需求 Manifest 失败")
      onEntryChange({ ...entry, htmlId, htmlFile, bindingReady: true })
      showToast("设计已保存并同步到需求 Manifest")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存需求设计失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-4 border-y border-status-info/30 bg-status-info/10 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-info px-2 py-0.5 text-[11px] font-semibold text-white">
        <WandSparkles className="size-3 animate-pulse" aria-hidden="true" />
        需求原型设计中
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-4 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">
          需求名称
          <strong className="ml-1.5 font-semibold text-foreground">{requirementName}</strong>
        </span>
        <span className="h-4 w-px shrink-0 bg-status-info/30" />
        <span className="min-w-0 truncate text-muted-foreground">
          功能名称
          <strong className="ml-1.5 font-semibold text-foreground">{functionName}</strong>
        </span>
      </div>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={effectiveDisabledReason ? 0 : -1}
              className={effectiveDisabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"}
            >
              <button
                type="button"
                disabled={Boolean(effectiveDisabledReason)}
                onClick={() => void save()}
                className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-status-info px-3 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-55"
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3" />
                )}
                {saving ? "同步中..." : "同步到需求里"}
              </button>
            </span>
          </TooltipTrigger>
          {effectiveDisabledReason ? (
            <TooltipContent side="bottom">{effectiveDisabledReason}</TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
      <button
        type="button"
        onClick={() => returnToRequirementConversation(entry.requirementId)}
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-status-info/40 bg-background/80 px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-status-info/15"
      >
        <ArrowLeft className="size-3" />
        返回需求
      </button>
    </div>
  )
}
