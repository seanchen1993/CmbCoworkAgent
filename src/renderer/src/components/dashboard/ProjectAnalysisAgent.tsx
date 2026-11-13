import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Bot, Copy, Send, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProjectAgentRunProgress } from "./ProjectAgentRunProgress"
import { useProjectAgentRun } from "./use-project-agent-run"
import { ProjectAnalysisScope } from "./ProjectAnalysisScope"
import type { DashboardTimeControl } from "./TimeControlBar"
import type { RunAnalysisMembership } from "../../../../shared/project-run-analysis"
import { useProjectAnalysisReport } from "./ProjectAnalysisReport"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  ProjectAnalysisAgentInput,
  ProjectAnalysisAgentResult,
  ProjectAnalysisMessage,
  ProjectAnalysisTarget
} from "../../../../shared/project-analysis-agent"

type Message = ProjectAnalysisMessage & { id: number; result?: ProjectAnalysisAgentResult }
const FAMILY = "dashboard:projectModeAnalysisAgent"
const SUGGESTIONS = [
  "诊断当前范围内的异常项目，列出触发条件、涉及特性和核实建议",
  "分析代码采纳率，指出需要进一步核实的问题",
  "比较 Harness 与 VibeCoding 的代码产出",
  "分析未使用 Skill 的对话及工具调用情况"
]

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

function evidenceId(messageId: number, id: string): string {
  return `analysis-evidence-${messageId}-${id}`
}

// Transform text nodes only, keeping code blocks and existing links intact.
function evidenceLinks(message: Message) {
  const ids = new Set(message.result?.evidence.map(({ id }) => id))
  return () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference") return
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child)
          return [child]
        }
        return child.value.split(/(\[E\d+\])/g).map((value): MarkdownNode => {
          const id = /^\[(E\d+)\]$/.exec(value)?.[1]
          return id && ids.has(id)
            ? {
                type: "link",
                url: `#${evidenceId(message.id, id)}`,
                children: [{ type: "text", value }]
              }
            : { type: "text", value }
        })
      })
    }
    visit(tree)
  }
}

const MARKDOWN_COMPONENTS: Components = {
  table({ children }) {
    return (
      <div
        className="streaming-markdown-table-wrap"
        tabIndex={0}
        aria-label="分析对比表，可横向滚动"
      >
        <table>{children}</table>
      </div>
    )
  },
  pre({ children }) {
    return <pre className="max-w-full overflow-x-auto rounded bg-muted/50 p-3">{children}</pre>
  },
  a({ href, children }) {
    const citation = href?.startsWith("#analysis-evidence-")
    return (
      <a
        href={href}
        {...(!citation ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={
          citation
            ? (event) => {
                event.preventDefault()
                const target = document.getElementById(href!.slice(1))
                const details = target?.closest("details")
                if (details) details.open = true
                target?.scrollIntoView({ block: "nearest" })
                target?.focus({ preventScroll: true })
              }
            : undefined
        }
      >
        {children}
      </a>
    )
  }
}

function AnalysisMarkdown({ message }: { message: Message }) {
  const citations = useMemo(() => evidenceLinks(message), [message])
  return (
    <div className="streaming-markdown min-w-0 !text-[13px] !leading-6">
      <ReactMarkdown remarkPlugins={[remarkGfm, citations]} components={MARKDOWN_COMPONENTS}>
        {message.content}
      </ReactMarkdown>
    </div>
  )
}

export function ProjectAnalysisAgent({
  open,
  context,
  scopeLabel,
  scopeSummary,
  scopeDetails,
  analysisUnavailable,
  onClose,
  timeControl,
  onMembershipChange,
  onInspect
}: {
  open: boolean
  context: Omit<ProjectAnalysisAgentInput, "question" | "messages">
  scopeLabel: string
  scopeSummary: string
  scopeDetails: string[]
  analysisUnavailable?: string
  onClose: () => void
  timeControl: Omit<DashboardTimeControl, "range">
  onMembershipChange: (value: RunAnalysisMembership) => void
  onInspect: (target: ProjectAnalysisTarget) => void
}): React.JSX.Element {
  const runProgress = useProjectAgentRun()
  const { end: endRun, clear: clearRun } = runProgress
  const followBottom = useRef(true)
  const [newContentBelow, setNewContentBelow] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [mode, setMode] = useState<"analysis" | "report">("analysis")
  const selectedRooms = Array.isArray(context.options.upperOrgLv1)
    ? context.options.upperOrgLv1
    : context.options.upperOrgLv1
      ? [context.options.upperOrgLv1]
      : []
  const reportContent = useProjectAnalysisReport({
    active: open && mode === "report",
    selectedRooms
  })
  const sequence = useRef(0)
  const busy = useRef(false)
  const lastRequest = useRef<ProjectAnalysisAgentInput | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const messageId = useRef(0)
  useEffect(() => {
    if (open && followBottom.current) bottom.current?.scrollIntoView({ block: "nearest" })
    else if (open && loading) setNewContentBelow(true)
  }, [messages, loading, open, runProgress.state.text])
  useEffect(
    () => () => {
      sequence.current++
      if (busy.current) void window.api.dashboard.cancelRequests([FAMILY]).catch(() => undefined)
    },
    []
  )
  const cancel = useCallback(() => {
    sequence.current++
    busy.current = false
    setLoading(false)
    endRun("cancelled")
    setNotice("分析已停止，可以重新提问")
    void window.api.dashboard.cancelRequests([FAMILY]).catch(() => undefined)
  }, [endRun])
  const contextKey = JSON.stringify(context)
  const previousContext = useRef(contextKey)
  useEffect(() => {
    if (previousContext.current === contextKey) return
    previousContext.current = contextKey
    if (busy.current) cancel()
    sequence.current++
    lastRequest.current = null
    setMessages([])
    setError("")
    setNotice("分析范围已更新，已开始新对话")
    clearRun()
    followBottom.current = true
    setNewContentBelow(false)
  }, [contextKey, cancel, clearRun])
  const run = async (request: ProjectAnalysisAgentInput) => {
    if (busy.current) return
    busy.current = true
    const ticket = ++sequence.current
    setLoading(true)
    runProgress.begin()
    followBottom.current = true
    setNewContentBelow(false)
    setError("")
    setNotice("")
    lastRequest.current = request
    try {
      const response = await window.api.dashboard.projectModeAnalysisAgent(request, (event) => {
        if (ticket === sequence.current) runProgress.receive(event)
      })
      if (ticket !== sequence.current) return
      if (response.cancelled) {
        endRun("cancelled")
        setNotice("分析已停止")
        return
      }
      if (!response.success || !response.data) throw new Error(response.error ?? "分析失败，请重试")
      const result = response.data
      endRun("completed")
      setMessages((items) => [
        ...items,
        { id: ++messageId.current, role: "assistant", content: result.content, result }
      ])
    } catch (e) {
      if (ticket === sequence.current) {
        endRun("failed")
        setError(e instanceof Error ? e.message : "分析失败，请重试")
      }
    } finally {
      if (ticket === sequence.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }
  const submit = (question: string) => {
    const normalized = question.trim()
    if (!normalized || normalized.length > 6000 || busy.current || analysisUnavailable) return
    const request = {
      ...context,
      question: normalized,
      messages: messages
        .slice(-8)
        .map(({ role, content }) => ({ role, content: content.slice(0, 8000) }))
    }
    setMessages((items) => [
      ...items,
      { id: ++messageId.current, role: "user", content: normalized }
    ])
    setInput("")
    void run(request)
  }
  const copy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setNotice("分析内容已复制")
    } catch {
      setNotice("复制失败，请检查剪贴板权限")
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) {
          if (busy.current) cancel()
          onClose()
        }
      }}
    >
      <DialogContent
        className={`flex max-h-[90vh] w-[min(960px,95vw)] !max-w-[960px] flex-col gap-3 overflow-hidden transition-none ${mode === "report" ? "h-[min(850px,90vh)]" : ""}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4" />
            项目分析 Agent
          </DialogTitle>
          <DialogDescription>
            {mode === "report"
              ? "室级综合报告 · 所选自然周或月的全量项目活动"
              : `${scopeLabel} · ${scopeSummary} · 累计指标`}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            if (busy.current) cancel()
            setMode(value as "analysis" | "report")
          }}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <TabsList className="shrink-0 self-start" aria-label="项目 Agent 工作模式">
            <TabsTrigger value="analysis">项目分析</TabsTrigger>
            <TabsTrigger value="report">综合报告</TabsTrigger>
          </TabsList>
          <TabsContent
            value="analysis"
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
          >
            {analysisUnavailable && (
              <p
                role="status"
                className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
              >
                {analysisUnavailable}，可切换到综合报告生成全室报告。
              </p>
            )}
            <ProjectAnalysisScope
              range={context.range}
              membership={context.options.membership ?? "active"}
              busy={loading}
              timeControl={timeControl}
              onMembershipChange={onMembershipChange}
            />
            <details className="shrink-0 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <span>{scopeDetails[0]}</span> · 查看本次分析范围与筛选
              </summary>
              <ul className="mt-2 space-y-1">
                {scopeDetails.slice(1).map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              <p className="mt-2">
                日期用于选择名单，指标为累计值。关闭后保留当前对话；更换分析对象或筛选后开始新对话。
              </p>
            </details>
            {!messages.length && (
              <div className="flex shrink-0 flex-wrap gap-2">
                {SUGGESTIONS.map((question) => (
                  <Button
                    key={question}
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal text-left text-xs"
                    disabled={loading || Boolean(analysisUnavailable)}
                    onClick={() => submit(question)}
                  >
                    {question}
                  </Button>
                ))}
              </div>
            )}
            <div
              className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain pr-1"
              role="log"
              onScroll={(event) => {
                const node = event.currentTarget
                followBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
                if (followBottom.current) setNewContentBelow(false)
              }}
              aria-label="项目分析对话"
              aria-live="polite"
            >
              {!messages.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  选择一个分析方向，或输入你关心的问题。回答会附上数据依据。
                </p>
              )}
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`rounded-lg border p-3 ${message.role === "user" ? "ml-8 bg-primary/5" : "mr-2 bg-card"}`}
                >
                  <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{message.role === "user" ? "你" : "项目分析 Agent"}</span>
                    {message.result && (
                      <button
                        aria-label="复制分析结果"
                        className="inline-flex size-7 items-center justify-center rounded hover:bg-muted"
                        onClick={() => void copy(message.content)}
                      >
                        <Copy className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {message.role === "user" ? (
                    <div className="whitespace-pre-wrap text-sm">{message.content}</div>
                  ) : (
                    <AnalysisMarkdown message={message} />
                  )}
                  {message.result && (
                    <>
                      <div className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
                        {message.result.exampleData && (
                          <span className="mr-2 text-amber-600">开发示例数据</span>
                        )}
                        {message.result.projectCount} 个项目 · {message.result.featureCount} 个特性
                        · 数据截至 {new Date(message.result.dataAsOf).toLocaleString("zh-CN")} ·{" "}
                        {message.result.modelName}
                      </div>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-primary">
                          数据依据（{message.result.evidence.length}）
                        </summary>
                        <div className="mt-2 space-y-2">
                          {message.result.evidence.map((e) => (
                            <div
                              key={e.id}
                              id={evidenceId(message.id, e.id)}
                              tabIndex={-1}
                              className="rounded bg-muted/40 p-2 focus:outline-primary"
                            >
                              <div className="font-medium">
                                [{e.id}] {e.label}
                              </div>
                              <div className="mt-1 text-muted-foreground">{e.summary}</div>
                              {e.target && e.target.featureSlug !== undefined && (
                                <button
                                  className="mt-1 text-primary hover:underline"
                                  onClick={() => onInspect(e.target!)}
                                >
                                  查看特性诊断
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    </>
                  )}
                </article>
              ))}
              {runProgress.state.text && (
                <article
                  aria-label="正在生成的分析"
                  className="mr-2 min-w-0 rounded-lg border bg-card p-3"
                >
                  <div className="mb-2 text-xs text-muted-foreground">
                    {loading ? "项目分析 Agent · 正在生成" : "本次分析未完成 · 以下为已接收内容"}
                  </div>
                  <AnalysisMarkdown
                    message={{ id: -1, role: "assistant", content: runProgress.state.text }}
                  />
                </article>
              )}
              <div ref={bottom} />
            </div>
            {newContentBelow && loading && (
              <button
                className="shrink-0 self-center text-xs text-primary hover:underline"
                onClick={() => {
                  followBottom.current = true
                  setNewContentBelow(false)
                  bottom.current?.scrollIntoView({ block: "end" })
                }}
              >
                有新内容，回到底部
              </button>
            )}
            <div className="shrink-0">
              <ProjectAgentRunProgress state={runProgress.state} />
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 rounded border border-destructive/30 p-2 text-xs text-destructive"
              >
                <span>{error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || Boolean(analysisUnavailable)}
                  onClick={() => {
                    if (lastRequest.current) void run(lastRequest.current)
                  }}
                >
                  重试分析
                </Button>
              </div>
            )}
            {notice && (
              <div role="status" className="text-xs text-muted-foreground">
                {notice}
              </div>
            )}
            <form
              className="flex shrink-0 items-end gap-2 border-t pt-3"
              onSubmit={(event) => {
                event.preventDefault()
                submit(input)
              }}
            >
              <textarea
                aria-label="项目分析问题"
                maxLength={6000}
                rows={3}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="例如：当前筛选中，哪些特性的代码采纳率需要关注？"
                className="min-w-0 flex-1 resize-none rounded border bg-background p-2 text-sm"
              />
              {loading ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={(event) => {
                    event.preventDefault()
                    cancel()
                  }}
                >
                  <Square className="mr-1 size-3" />
                  停止分析
                </Button>
              ) : (
                <Button type="submit" disabled={!input.trim() || Boolean(analysisUnavailable)}>
                  <Send className="mr-1 size-3" />
                  发送
                </Button>
              )}
            </form>
          </TabsContent>
          <TabsContent value="report" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {reportContent}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
