import { useEffect, useState } from "react"
import { ArrowLeft, Code2, FileText, Loader2, PenTool, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  leanstarRequirementsApi,
  type RequirementDetail,
  type RequirementDocumentContent
} from "@/api/leanstar-requirements"
import { Button } from "@/components/ui/button"
import type { RequirementRecord } from "./requirement-data"

export function RequirementSpaceDetailView({
  requirement,
  onBack
}: {
  requirement: RequirementRecord
  onBack: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<RequirementDetail | null>(null)
  const [document, setDocument] = useState<RequirementDocumentContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    const code = requirement.sourceName.trim()
    void Promise.all([
      leanstarRequirementsApi.getRequirementDetail(code),
      leanstarRequirementsApi.getRequirementDocumentContent(code)
    ])
      .then(([nextDetail, nextDocument]) => {
        if (cancelled) return
        setDetail(nextDetail)
        setDocument(nextDocument)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f7f8fa] dark:bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
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
        <div className="min-w-0">
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
              setReloadToken((value) => value + 1)
            }}
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            重新加载
          </Button>
        </div>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(380px,0.92fr)]">
          <section className="flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
              <FileText className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">需求文件预览</h3>
              <span className="ml-auto text-[11px] text-muted-foreground">只读</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {content ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  暂无可预览的需求文件内容
                </div>
              )}
            </div>
          </section>

          <section className="flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
              <PenTool className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">原型预览</h3>
            </div>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <PenTool className="size-6" />
              </div>
              <h4 className="mt-4 text-sm font-semibold">暂无原型</h4>
              <p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                你可以先设计原型，也可以跳过原型设计直接进入开发。
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button type="button">
                  <PenTool className="mr-1.5 size-4" />
                  去设计原型
                </Button>
                <Button type="button" variant="outline">
                  <Code2 className="mr-1.5 size-4" />
                  去开发
                </Button>
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  )
}
