import { useEffect, useState } from "react"
import {
  ArrowLeft,
  FileText,
  Loader2,
  LockKeyhole,
  PenTool,
  RefreshCw,
  Trash2,
  UserPlus
} from "lucide-react"
import { toast } from "sonner"
import {
  leanstarRequirementsApi,
  type RichComponent,
  type RequirementDetail,
  type RequirementDocumentContent
} from "@/api/leanstar-requirements"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { findRequirementDesignEntry } from "@/lib/requirement-design-entry"
import type { RequirementRecord } from "./requirement-data"
import { RequirementDevelopmentActions } from "./RequirementDevelopmentActions"
import { shouldHideRequirementDevelopment } from "./requirement-persona"
import {
  cacheRichComponent,
  getCachedRichComponent,
  richComponentCacheKey
} from "@/lib/requirement-rich-component-cache"
import { REQUIREMENT_ACTION_HINTS, RequirementActionButton } from "./RequirementActionButton"
import { RequirementSpaceStatusTag } from "./RequirementSpaceStatusTag"

function isPermissionDeniedError(reason: unknown): boolean {
  if ((reason as { code?: unknown })?.code === "LRDFA02") return true
  const message = reason instanceof Error ? reason.message : String(reason ?? "")
  return message.includes("无权限") || message.includes("操作无权限")
}

function normalizeLeanstarMarkdown(value: string): string {
  const lines = value.split("\n")
  return lines
    .map((line, index) => {
      if (!/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) return line
      const previous = lines[index - 1]?.trim() || ""
      if (previous.startsWith("|") && previous.endsWith("|")) return line
      const cells = Math.max(1, (line.match(/\|/g)?.length ?? 2) - 1)
      return `| ${Array.from({ length: cells }, () => "").join(" | ")} |\n${line}`
    })
    .join("\n")
}

function renderRichComponent(
  markdown: string,
  component: RichComponent,
  url: string,
  description?: string
): string {
  const escapedId = component.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const resource = component.resourceName || "附件"
  const isImage =
    (component.type || "").toUpperCase().includes("IMAGE") || /图片|image/i.test(resource)
  const rendered = isImage ? `![${resource}](${url})` : `[下载 ${resource}](${url})`
  const withDescription = description
    ? `${rendered}\n\n> **${resource}描述：** ${description.replace(/\n/g, " ")}`
    : rendered
  return markdown.replace(
    new RegExp(`!\\[[^\\]]*\\]\\((?:pic)?${escapedId}\\)`, "g"),
    withDescription
  )
}

function renderRichComponentError(
  markdown: string,
  component: RichComponent,
  message: string
): string {
  const escapedId = component.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return markdown.replace(
    new RegExp(`!\\[[^\\]]*\\]\\((?:pic)?${escapedId}\\)`, "g"),
    `> 无法获取到本资源（${component.resourceName || "附件"}）的数据，因为：${message}`
  )
}

export function RequirementSpaceDetailView({
  requirement,
  onDesignRequirement,
  onResetDesign,
  onStartDevelopment,
  onContinueDevelopment,
  onResetDevelopment,
  onBack
}: {
  requirement: RequirementRecord
  onDesignRequirement: (requirement: RequirementRecord, content?: string) => Promise<void>
  onResetDesign: () => void | Promise<void>
  onStartDevelopment: () => void | Promise<void>
  onContinueDevelopment: (threadId: string) => void | Promise<void>
  onResetDevelopment: () => void | Promise<void>
  onBack: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<RequirementDetail | null>(null)
  const [document, setDocument] = useState<RequirementDocumentContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [renderedContent, setRenderedContent] = useState("")
  const [prototypeHtml, setPrototypeHtml] = useState("")
  const [designResetOpen, setDesignResetOpen] = useState(false)
  const [designResetting, setDesignResetting] = useState(false)
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
        if (documentResult.status === "fulfilled") {
          setDocument(documentResult.value)
          setRenderedContent(
            normalizeLeanstarMarkdown(documentResult.value?.documentTextContent?.trim() || "")
          )
        }
        const unexpectedError = [detailResult, documentResult].find(
          (result) => result.status === "rejected" && !isPermissionDeniedError(result.reason)
        )
        if (unexpectedError?.status === "rejected") throw unexpectedError.reason
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "加载需求详情失败")
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [requirement, reloadToken])

  useEffect(() => {
    const components = document?.richComponents ?? []
    if (!components.length || permissionDenied) return
    let cancelled = false
    const code = document?.code?.trim() || requirement.sourceName.trim()
    void (async () => {
      let descriptions = new Map<string, string>()
      try {
        descriptions = await leanstarRequirementsApi.getMultimodalComponentDescriptions(components)
      } catch {
        // Binary resources remain useful even when multimodal descriptions are unavailable.
      }
      let next = normalizeLeanstarMarkdown(document?.documentTextContent?.trim() || "")
      for (const component of components) {
        if (cancelled) return
        const key = richComponentCacheKey(code, component)
        const cached = getCachedRichComponent(key)
        try {
          const url =
            cached?.url ||
            URL.createObjectURL(
              await leanstarRequirementsApi.downloadRichComponent(component, code)
            )
          const description = cached?.description || descriptions.get(component.id)
          if (!cached) cacheRichComponent(key, { url, description })
          next = renderRichComponent(next, component, url, description)
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "未知错误"
          next = renderRichComponentError(next, component, message)
          if (!cancelled) setRenderedContent(next)
          return
        }
        if (!cancelled) setRenderedContent(next)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [document, permissionDenied, requirement.sourceName])

  const title = document?.title?.trim() || detail?.title?.trim() || requirement.title
  const content =
    renderedContent || normalizeLeanstarMarkdown(document?.documentTextContent?.trim() || "")
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
          {requirement.status ? <RequirementSpaceStatusTag status={requirement.status} /> : null}
          <p className="text-[11px] text-muted-foreground">
            需求空间3.0 · {requirement.sourceName}
          </p>
          {requirement.owner ? (
            <p className="text-[11px] text-muted-foreground">
              需求用户：{requirement.owner.name} / {requirement.owner.id}
            </p>
          ) : null}
        </div>
        {!shouldHideRequirementDevelopment() ? (
          <div className="ml-auto">
            <RequirementDevelopmentActions
              requirement={requirement}
              onStartDevelopment={onStartDevelopment}
              onContinueDevelopment={onContinueDevelopment}
              onResetDevelopment={onResetDevelopment}
              disabledReason={
                permissionDenied ? "暂无该需求文件的查看权限，无法带入项目模式开发。" : undefined
              }
            />
          </div>
        ) : null}
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
                        需求空间平台目前仅支持查看
                        <strong className="px-1 font-semibold text-foreground">“实施中”</strong>
                        状态的需求信息。其他状态暂时无法预览，请参考下方临时解决方案。
                      </p>
                    </div>
                    <div className="px-6 py-5">
                      <div className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3.5 text-left">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <UserPlus className="size-4" />
                        </span>
                        <div className="min-w-0 text-sm leading-6 text-muted-foreground">
                          <p className="font-medium text-foreground">临时解决方案</p>
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4 w-full"
                        disabled={refreshing}
                        onClick={() => {
                          setRefreshing(true)
                          setError(null)
                          setReloadToken((value) => value + 1)
                        }}
                      >
                        {refreshing ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1.5 size-3.5" />
                        )}
                        {refreshing ? "正在刷新" : "刷新需求信息"}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : content ? (
                <MarkdownPreview
                  content={content}
                  showHeader={false}
                  showModeToggle={false}
                  whiteBackground
                  allowBlobUrls
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
                {designBinding?.htmlId ? (
                  <RequirementActionButton
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    hint={REQUIREMENT_ACTION_HINTS.resetDesign}
                    onClick={() => setDesignResetOpen(true)}
                  >
                    <Trash2 className="size-3" />
                    重置原型
                  </RequirementActionButton>
                ) : null}
                <RequirementActionButton
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  hint={
                    permissionDenied
                      ? "暂无该需求文件的查看权限，无法开始或继续设计。"
                      : designBinding?.htmlId
                        ? REQUIREMENT_ACTION_HINTS.continueDesign
                        : REQUIREMENT_ACTION_HINTS.startDesign
                  }
                  onClick={() => void onDesignRequirement(requirement, content)}
                  disabled={permissionDenied}
                >
                  <PenTool className="mr-1.5 size-3.5" />
                  {designBinding?.htmlId ? "继续设计" : "去设计"}
                </RequirementActionButton>
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
                  {shouldHideRequirementDevelopment()
                    ? "你可以基于当前需求创建并持续完善原型设计。"
                    : "原型设计并非开发的必需步骤。你可以直接点击页面上方的“去开发”，前往项目模式开始开发；也可以先完善原型，再进入开发。"}
                </p>
              </div>
            )}
          </section>
        </main>
      )}
      <Dialog
        open={designResetOpen}
        onOpenChange={(open) => {
          if (!designResetting) setDesignResetOpen(open)
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>确认重置原型设计？</DialogTitle>
            <DialogDescription className="pt-2 leading-6">
              重置后仅解除当前需求与设计会话的关联。设计会话及其历史记录仍会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={designResetting}
              onClick={() => setDesignResetOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={designResetting}
              onClick={() => {
                setDesignResetting(true)
                void Promise.resolve(onResetDesign())
                  .then(() => {
                    setPrototypeHtml("")
                    setReloadToken((value) => value + 1)
                    setDesignResetOpen(false)
                    toast.success("原型设计已重置")
                  })
                  .catch((error) => {
                    toast.error(error instanceof Error ? error.message : "重置原型设计失败")
                  })
                  .finally(() => setDesignResetting(false))
              }}
            >
              {designResetting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
