import { useEffect, useState } from "react"
import {
  ArrowLeft,
  FileText,
  Loader2,
  LockKeyhole,
  PenTool,
  RefreshCw,
  UserPlus
} from "lucide-react"
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
import { RequirementDevelopmentActions } from "./RequirementDevelopmentActions"

function isPermissionDeniedError(reason: unknown): boolean {
  if ((reason as { code?: unknown })?.code === "LRDFA02") return true
  const message = reason instanceof Error ? reason.message : String(reason ?? "")
  return message.includes("无权限") || message.includes("操作无权限")
}

export function RequirementSpaceDetailView({
  requirement,
  onDesignRequirement,
  onStartDevelopment,
  onContinueDevelopment,
  onResetDevelopment,
  onBack
}: {
  requirement: RequirementRecord
  onDesignRequirement: (requirement: RequirementRecord, content?: string) => Promise<void>
  onStartDevelopment: () => void | Promise<void>
  onContinueDevelopment: (threadId: string) => void | Promise<void>
  onResetDevelopment: () => void | Promise<void>
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
        <div className="ml-auto">
          <RequirementDevelopmentActions
            requirement={requirement}
            onStartDevelopment={onStartDevelopment}
            onContinueDevelopment={onContinueDevelopment}
            onResetDevelopment={onResetDevelopment}
          />
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
                <div className="flex h-full items-center justify-center bg-muted/20 px-6 py-10">
                  <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border/80 bg-background shadow-sm">
                    <div className="flex flex-col items-center border-b border-border/60 px-6 py-6 text-center">
                      <span className="flex size-11 items-center justify-center rounded-full bg-status-warning/10 text-status-warning ring-1 ring-status-warning/20">
                        <LockKeyhole className="size-5" />
                      </span>
                      <h4 className="mt-3 text-base font-semibold text-foreground">
                        暂时无法预览该需求文件
                      </h4>
                      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                        需求空间平台目前暂不支持
                        <strong className="px-0.5 font-semibold text-foreground">无权限成员</strong>
                        查看此内容，我们已向平台反馈并推动后续支持。
                      </p>
                    </div>
                    <div className="px-6 py-5">
                      <div className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3.5 text-left">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <UserPlus className="size-4" />
                        </span>
                        <div className="min-w-0 text-sm leading-6 text-muted-foreground">
                          <p className="font-medium text-foreground">如何获得查看权限</p>
                          <p className="mt-1">
                            请联系需求负责人
                            {ownerName ? (
                              <strong className="mx-1 font-semibold text-primary">
                                {ownerName}
                              </strong>
                            ) : null}
                            ，请其将你添加为该需求的
                            <strong className="px-0.5 font-semibold text-foreground">参与人</strong>
                            。获得权限后，即可返回此处查看需求文件。
                          </p>
                        </div>
                      </div>
                    </div>
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
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void onDesignRequirement(requirement, content)}
                >
                  <PenTool className="mr-1.5 size-3.5" />
                  {designBinding?.htmlFile ? "继续设计" : "去设计"}
                </Button>
              </div>
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
                  可直接在当前页面进入开发，也可按需先补充原型设计。
                </p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  )
}
