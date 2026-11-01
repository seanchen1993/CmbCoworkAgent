import { useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, ExternalLink, FileText, Loader2, Pencil, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { assembleBoundedTextPreview } from "@/lib/text-preview-pages"
import type { WorkspaceFilePreviewReadResult } from "../../../../shared/workspace-file-preview"
import type { RequirementPrdManifest, RequirementRecord } from "./requirement-data"

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const PREVIEW_MAX_PAGES = 64

async function readWorkspaceTextFile(
  threadId: string,
  filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  const requestToken = globalThis.crypto.randomUUID()
  const lane = `requirement-function-workspace:${threadId}:${requestToken}`
  const readPage = (offset: number): Promise<WorkspaceFilePreviewReadResult> =>
    window.api.workspace.readFilePreview({
      source: { threadId, filePath },
      offset,
      lane,
      requestToken
    })
  const first = await readPage(0)
  if (!first.success) return { success: false, error: first.error }
  const assembled = await assembleBoundedTextPreview(
    first,
    async (offset) => {
      const page = await readPage(offset)
      return page.success ? page : null
    },
    { maxBytes: PREVIEW_MAX_BYTES, maxPages: PREVIEW_MAX_PAGES }
  )
  return { success: true, content: assembled.content }
}

export function RequirementFunctionWorkspace({
  requirement,
  functionInfo,
  filePath,
  threadId,
  prototypeGenerated,
  hasPrototypeDesignSession,
  prototypeSkipped,
  prototypePreview,
  conversationLoading,
  reloadToken,
  onBack,
  onRequestPrototypeDesign
}: {
  requirement: RequirementRecord
  functionInfo: RequirementPrdManifest["functions"][number]
  filePath: string
  threadId: string | null
  prototypeGenerated: boolean
  hasPrototypeDesignSession: boolean
  prototypeSkipped: boolean
  prototypePreview?: ReactNode
  conversationLoading: boolean
  reloadToken: number
  onBack: () => void
  onRequestPrototypeDesign: () => void
}): React.JSX.Element {
  const [content, setContent] = useState("")
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setEditing(false)
    void (async () => {
      if (!threadId) {
        if (!cancelled) {
          setError("当前需求尚未关联任务，无法读取 PRD 文件")
          setLoading(false)
        }
        return
      }
      const result = await readWorkspaceTextFile(threadId, filePath)
      if (cancelled) return
      if (!result.success) setError(result.error || "PRD 文件加载失败")
      else {
        setContent(result.content ?? "")
        setDraft(result.content ?? "")
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [filePath, reloadToken, threadId])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.api.requirements.savePrdFile({
        reqId: requirement.id,
        filePath,
        content: draft
      })
      if (!result.success) throw new Error(result.error || "保存失败")
      setContent(draft)
      setEditing(false)
      toast.success("PRD 已保存")
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "保存 PRD 失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#fbfcfe] p-4">
      <div className="mb-1.5 flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          返回功能清单
        </Button>
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {functionInfo.fr}：{functionInfo.name || "未命名功能"} · 预览
        </h2>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {prototypeGenerated ? "原型设计阶段" : "规范 PRD 阶段"}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200 hover:border-primary/70">
          <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-slate-100/80 px-3.5">
            <span className="text-xs font-semibold text-foreground/75">MD 预览</span>
            <span
              className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground/80"
              title={filePath}
            >
              {filePath.replace(/^\/+/, "")}
            </span>
            {editing ? (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={saving}
                  onClick={() => {
                    setDraft(content)
                    setEditing(false)
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={saving || draft === content}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  保存
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary"
                disabled={loading || Boolean(error)}
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3" />
                可编辑
              </Button>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在读取 PRD
              </div>
            ) : error ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
                {error}
              </div>
            ) : editing ? (
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`编辑 ${functionInfo.name} PRD`}
                className="h-full min-h-[360px] w-full resize-none border-0 bg-white p-5 font-mono text-sm leading-6 text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-primary/20"
                spellCheck={false}
                autoFocus
              />
            ) : (
              <MarkdownPreview
                content={content}
                path={filePath}
                showHeader={false}
                showModeToggle={false}
                whiteBackground
                className="min-h-full"
              />
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200 hover:border-primary/70">
          <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/80 bg-slate-100/80 px-3.5">
            <span className="text-xs font-semibold text-foreground/75">原型预览</span>
            {prototypeGenerated ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary"
                        disabled={conversationLoading}
                        onClick={onRequestPrototypeDesign}
                      >
                        <ExternalLink className="size-3" />
                        继续完善设计
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-64">
                    已关联设计会话，点击可跳转并继续完善原型
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </header>
          <div className="relative min-h-0 flex-1 bg-slate-50/70">
            {prototypeGenerated && prototypePreview ? (
              prototypePreview
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                {prototypeSkipped ? (
                  <span className="mb-4 inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800">
                    当前状态：无需设计
                  </span>
                ) : null}
                <div
                  className={`mb-3 flex size-12 items-center justify-center rounded-xl border bg-white ${
                    prototypeSkipped
                      ? "border-amber-300 text-amber-700 shadow-sm"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  <FileText className="size-5" />
                </div>
                <p className="text-base font-semibold text-foreground">
                  {prototypeSkipped
                    ? "已选择无需设计，尚未生成原型"
                    : hasPrototypeDesignSession
                      ? "尚未生成可预览原型"
                      : "尚未开始原型设计"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {prototypeSkipped
                    ? "如需补充原型，可随时点击下方按钮重新进入原型设计。"
                    : hasPrototypeDesignSession
                      ? "设计会话已创建，当前尚未生成原型 HTML，可返回会话继续沟通和设计。"
                      : "尚未创建设计会话，点击下方按钮开始设计原型。"}
                </p>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="mt-5 inline-flex">
                        <Button
                          type="button"
                          size="sm"
                          disabled={conversationLoading}
                          onClick={onRequestPrototypeDesign}
                        >
                          {prototypeSkipped || !hasPrototypeDesignSession ? "去设计" : "继续设计"}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-72">
                      {prototypeSkipped || !hasPrototypeDesignSession
                        ? "尚未关联设计会话，点击可创建设计会话并开始原型设计"
                        : "已创建设计会话，暂未生成可预览的原型 HTML，点击可跳转到会话继续设计"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
