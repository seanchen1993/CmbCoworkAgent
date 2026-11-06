import { useEffect, useState } from "react"
import { ArrowLeft, Code2, FileText, Loader2, PenTool, RefreshCw } from "lucide-react"
import {
  leanstarRequirementsApi,
  type RequirementDetail,
  type RequirementDocumentContent
} from "@/api/leanstar-requirements"
import { Button } from "@/components/ui/button"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { findRequirementDesignEntry } from "@/lib/requirement-design-entry"
import type { RequirementRecord } from "./requirement-data"

function isPermissionDeniedError(reason: unknown): boolean {
  if ((reason as { code?: unknown })?.code === "LRDFA02") return true
  const message = reason instanceof Error ? reason.message : String(reason ?? "")
  return message.includes("无权限") || message.includes("操作无权限")
}

export function RequirementSpaceDetailView({
  requirement,
  onDesignRequirement,
  onBack
}: {
  requirement: RequirementRecord
  onDesignRequirement: (requirement: RequirementRecord, content?: string) => Promise<void>
  onBack: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<RequirementDetail | null>(null)
  const [document, setDocument] = useState<RequirementDocumentContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [prototypeHtml, setPrototypeHtml] = useState("")
  const designBinding = findRequirementDesignEntry(requirement.id)

  useEffect(() => {
    let cancelled = false
    const htmlFile = designBinding?.htmlFile?.trim()
    if (!htmlFile) return
    void window.api.file.readText(htmlFile).then((result) => {
      if (!cancelled) setPrototypeHtml(result.success ? result.content || "" : "")
    })
    return () => {
      cancelled = true
    }
  }, [designBinding?.htmlFile, reloadToken])

  useEffect(() => {
    let cancelled = false
    const code = requirement.sourceName.trim()
    void Promise.allSettled([
      leanstarRequirementsApi.getRequirementDetail(code),
      leanstarRequirementsApi.getRequirementDocumentContent(code)
    ])
      .then(([detailResult, documentResult]) => {
        if (cancelled) return
        const denied = [detailResult, documentResult].some(
          (result) => result.status === "rejected" && isPermissionDeniedError(result.reason)
        )
        setPermissionDenied(denied)
        if (detailResult.status === "fulfilled") setDetail(detailResult.value)
        if (documentResult.status === "fulfilled") setDocument(documentResult.value)
        const unexpectedError = [detailResult, documentResult].find(
          (result) => result.status === "rejected" && !isPermissionDeniedError(result.reason)
        )
        if (unexpectedError?.status === "rejected") throw unexpectedError.reason
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "加载需求详情失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [requirement, reloadToken])

  const title = document?.title?.trim() || detail?.title?.trim() || requirement.title
  const content = document?.documentTextContent?.trim() || ""
  const ownerName = requirement.owner?.name.trim()

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f7f8fa] dark:bg-background">
      <header className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onBack}
          aria-label="返回需求列表"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex gap-2 items-center">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-[11px] text-muted-foreground">
            需求空间3.0 · {requirement.sourceName}
          </p>
        </div>
      </header>

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" />
          正在加载需求详情
        </div>
      ) : error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true)
              setError(null)
              setPermissionDenied(false)
              setReloadToken((value) => value + 1)
            }}
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            重新加载
          </Button>
        </div>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-2 lg:grid-cols-[minmax(0,1.08fr)_minmax(380px,0.92fr)]">
          <section className="flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background ">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-4">
              <FileText className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">需求文件预览</h3>
              <span className="ml-auto text-[11px] text-muted-foreground">只读</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {permissionDenied ? (
                <div className="flex h-full items-center justify-center px-8 text-center">
                  <div className="max-w-lg text-sm leading-7 text-muted-foreground">
                    <p className="font-medium text-foreground">暂时无法预览该需求文件</p>
                    <p className="mt-2">
                      需求空间平台目前暂不支持无权限成员查看此内容，我们已向平台反馈并推动后续支持。
                    </p>
                    <p className="mt-2">
                      现阶段可联系需求负责人
                      {ownerName ? `“${ownerName}”` : ""}，请其将你添加为该需求的参与人，
                      获得权限后即可查看需求文件。
                    </p>
                  </div>
                </div>
              ) : content ? (
                <MarkdownPreview
                  content={content}
                  showHeader={false}
                  showModeToggle={false}
                  whiteBackground
                  className="min-h-full"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  暂无可预览的需求文件内容
                </div>
              )}
            </div>
          </section>

          <section className="flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background ">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-4 ">
              <PenTool className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">原型预览</h3>
              {designBinding?.htmlId ? (
                <Button
                  type="button"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={() => void onDesignRequirement(requirement, content)}
                >
                  继续设计
                </Button>
              ) : null}
            </div>
            {prototypeHtml && designBinding?.htmlFile ? (
              <HtmlThumbnailPreview
                html={prototypeHtml}
                title={`原型预览 ${designBinding.htmlFile}`}
                browserUrl={designBinding.htmlFile}
                browserWorkspacePath={designBinding.workspacePath}
                fit="fill"
                className="min-h-0 flex-1"
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <PenTool className="size-6" />
                </div>
                <h4 className="mt-4 text-sm font-semibold">暂无原型</h4>
                <p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                  你可以先设计原型，也可以跳过原型设计直接进入开发。
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    onClick={() => void onDesignRequirement(requirement, content)}
                  >
                    <PenTool className="mr-1.5 size-4" />
                    {designBinding?.htmlId ? "继续设计" : "去设计原型"}
                  </Button>
                  <Button type="button" variant="outline">
                    <Code2 className="mr-1.5 size-4" />
                    去开发
                  </Button>
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  )
}
