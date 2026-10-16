import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  STAGE_BUCKET_LABELS,
  STAGE_BUCKET_ORDER,
  type StageBucket
} from "../../../../shared/harness-stage-bucket"
import {
  projectCodeAgentLabel,
  projectCodeClassificationReason,
  type ProjectCodeTraceCursor,
  type ProjectCodeTraceItem,
  type ProjectCodeTracePage,
  type ProjectCodeTraceSummary
} from "../../../../shared/project-code-trace"
import { LocalLinesPanel } from "./CommitAdoptionTraceDialog"
import { TraceExplorer } from "./TraceHistoryDialog"
import { unwrapThreadTracesResponse } from "./thread-traces-response"
import type { DashboardLocalGenAdoptionLines, DashboardTraceDetail } from "./use-dashboard"

export interface ProjectCodeTraceTarget {
  projectId: string
  name: string
  bucket: StageBucket
}
const count = (n: number) => n.toLocaleString("zh-CN")
const time = (value: string | null) =>
  value ? (Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString("zh-CN")) : "—"
const linkClass =
  "text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"

function CodeConversationDialog({
  threadId,
  traceId,
  projectId,
  onClose
}: {
  threadId: string
  traceId: string | null
  projectId: string
  onClose: () => void
}) {
  const [traces, setTraces] = useState<DashboardTraceDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    async (id: string) =>
      unwrapThreadTracesResponse(
        await window.api.dashboard.threadTraces(id, { scope: "project", projectId })
      ),
    [projectId]
  )
  useEffect(() => {
    let cancelled = false
    void load(threadId)
      .then((data) => {
        if (!cancelled) setTraces(data)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, threadId])
  const selected = traceId ? traces.find((trace) => trace.traceId === traceId) : undefined
  const loadThread = useCallback(
    async (id: string) => (id === threadId ? traces : load(id)),
    [load, threadId, traces]
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex h-[82vh] max-w-[1100px] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>产码会话溯源</DialogTitle>
          <DialogDescription className="break-all">
            {threadId}
            {traceId ? ` · Trace ${traceId}` : ""}
          </DialogDescription>
        </DialogHeader>
        <TraceExplorer
          traces={selected ? [selected] : traces}
          loading={loading}
          error={error}
          defaultViewMode={traceId ? "trace" : "thread"}
          showCodeStats={false}
          loadThreadTraces={loadThread}
          title="关联会话"
          subtitle="查看生成代码时的对话与工具调用"
          emptyText="没有可还原的会话记录"
          className="min-h-0 flex-1"
        />
      </DialogContent>
    </Dialog>
  )
}

function CodeTraceRow({
  item,
  onViewThread
}: {
  item: ProjectCodeTraceItem
  onViewThread: (threadId: string, traceId: string | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [local, setLocal] = useState<DashboardLocalGenAdoptionLines | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localRequested, setLocalRequested] = useState(false)
  const loadLocal = async () => {
    if (!item.commitSha || !item.genEventId || localLoading) return
    setLocalRequested(true)
    setLocalLoading(true)
    setLocalError(null)
    try {
      const res = await window.api.adoption.commitLines(item.commitSha, [item.genEventId])
      if (!res.success) throw new Error(res.error ?? "本机逐行代码读取失败")
      setLocal(res.data?.[0] ?? null)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalLoading(false)
    }
  }
  return (
    <>
      <tr className="border-b align-top hover:bg-muted/20">
        <td className="px-3 py-3">
          <button
            type="button"
            className="flex max-w-[200px] items-center gap-1 text-left"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            <span
              className="truncate font-mono"
              title={item.file ?? "产码记录缺失，无法获取文件名"}
            >
              {item.file ?? "未记录文件名"}
            </span>
          </button>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {item.language ?? "—"} · {item.tool ?? "未记录工具"}
          </div>
        </td>
        <td className="px-3 py-3 text-right font-medium tabular-nums">
          {count(item.adoptedLines)}
        </td>
        <td className="px-3 py-3">
          <div>{item.nodeName ?? "未记录阶段"}</div>
          <div className="mt-1 text-muted-foreground">{item.nodeStatus ?? "未记录状态"}</div>
        </td>
        <td className="max-w-[190px] px-3 py-3">
          <div className="break-words">
            {item.usedSkills.length ? item.usedSkills.join("、") : "未使用SKILL"}
          </div>
        </td>
        <td className="max-w-[210px] px-3 py-3 text-muted-foreground">
          {projectCodeClassificationReason(item.nodeStatus, item.usedSkills.length > 0)}
        </td>
        <td className="px-3 py-3">
          <div>{projectCodeAgentLabel(item.agentKind)}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {item.agentLabel ?? item.userName ?? "—"}
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
          {time(item.generatedAt)}
        </td>
        <td className="space-y-1 whitespace-nowrap px-3 py-3">
          <button
            type="button"
            disabled={!item.threadId}
            className={linkClass}
            title="查看实际生成这段代码的 Agent 会话"
            onClick={() => item.threadId && onViewThread(item.threadId, item.traceId)}
          >
            产码会话
          </button>
          {item.rootThreadId && item.rootThreadId !== item.threadId ? (
            <div>
              <button
                type="button"
                className={linkClass}
                title="查看主 Agent 分派任务的会话"
                onClick={() => onViewThread(item.rootThreadId!, null)}
              >
                主 Agent 会话
              </button>
            </div>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b bg-muted/10">
          <td colSpan={8} className="space-y-3 px-5 py-3">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
              <span>
                生成 {count(item.generatedLines)} 行 → 有效 {count(item.effectiveLines)} 行 → 采纳{" "}
                {count(item.adoptedLines)} 行
              </span>
              <span>特性：{item.featureSlug ?? "未记录"}</span>
              <span>
                项目插件：
                {[item.pluginName, item.pluginVersion].filter(Boolean).join(" · ") || "未记录"}
              </span>
              <span>模型：{item.model ?? "未记录"}</span>
              <span>上报人：{item.userName ?? "未记录"}</span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 break-all text-[11px] text-muted-foreground">
              <span>
                提交：{item.commitSha ?? "未记录"} · {item.pushed ? "已 Push" : "未确认 Push"}
              </span>
              <span>
                仓库 / 分支：
                {[item.repository, item.branch].filter(Boolean).join(" / ") || "未记录"}
              </span>
              <span>测量时间：{time(item.measuredAt)}</span>
              <span>Trace：{item.traceId ?? "未记录"}</span>
              <span>生成记录：{item.genEventId ?? "未记录"}</span>
            </div>
            {!item.generationAvailable ? (
              <p className="text-[11px] text-muted-foreground">
                未找到关联的产码记录；采纳行数与分类仍按采纳事件中保存的信息展示。
              </p>
            ) : null}
            {item.attributionMismatch ? (
              <div className="space-y-1 text-[11px] text-amber-600">
                <p>产码与采纳记录中的归因信息不一致；此处按采纳记录展示，与项目列表保持一致。</p>
                {item.generationAttribution ? (
                  <p>
                    产码记录原始归因：{item.generationAttribution.nodeName ?? "未记录阶段"} ·{" "}
                    {item.generationAttribution.nodeStatus ?? "未记录状态"}；Skill：
                    {item.generationAttribution.usedSkills.join("、") || "未记录"}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="text-[11px] text-muted-foreground">
              Skill 表示代码记录的技能归因，可能继承自主 Agent；不等同于该子 Agent 自行读取过技能。
            </div>
            {item.commitSha && item.genEventId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadLocal()}
                disabled={localLoading}
                className="text-xs"
              >
                查看本机逐行代码
              </Button>
            ) : null}
            {localRequested ? (
              <LocalLinesPanel loading={localLoading} error={localError} data={local} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function CodeTracePages({
  target,
  bucket,
  upperOrgLv1
}: {
  target: ProjectCodeTraceTarget
  bucket: StageBucket
  upperOrgLv1?: string | string[] | null
}) {
  const [page, setPage] = useState(0)
  const [cursors, setCursors] = useState<Array<ProjectCodeTraceCursor | null>>([null])
  const [result, setResult] = useState<{ page: number; data: ProjectCodeTracePage } | null>(null)
  const [summary, setSummary] = useState<ProjectCodeTraceSummary | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [conversation, setConversation] = useState<{
    threadId: string
    traceId: string | null
  } | null>(null)
  const cache = useRef(new Map<number, ProjectCodeTracePage>())
  const cursor = cursors[page]
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        let data = cache.current.get(page)
        if (!data) {
          const res = await window.api.dashboard.projectCodeTrace({
            projectId: target.projectId,
            bucket,
            upperOrgLv1,
            cursor,
            pageSize: 20
          })
          if (!res.success || !res.data) throw new Error(res.error ?? "代码溯源查询失败")
          data = res.data
          if (cancelled) return
          cache.current.set(page, data)
          // Keep the first-page snapshot/summary plus five recently visited pages.
          if (cache.current.size > 6) {
            const oldest = [...cache.current.keys()].find((key) => key !== 0 && key !== page)
            if (oldest !== undefined) cache.current.delete(oldest)
          }
        }
        if (!cancelled) {
          setResult({ page, data })
          if (data.summary) setSummary(data.summary)
          if (data.total !== undefined) setTotal(data.total)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [target.projectId, bucket, upperOrgLv1, page, cursor, retry])
  const data = result?.page === page ? result.data : null
  const lines = summary
    ? bucket === "plugin_constrained"
      ? summary.harnessLines
      : bucket === "vibecoding"
        ? summary.vibeLines
        : summary.unattributedLines
    : null
  const denominator = summary ? summary.harnessLines + summary.vibeLines : 0
  const share =
    bucket !== "unattributed" && lines !== null && denominator > 0
      ? `${((lines / denominator) * 100).toFixed(1)}%`
      : "—"
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b bg-muted/10 px-5 py-3 text-xs">
        <span>
          采纳 <b>{lines === null ? "—" : count(lines)}</b> 行
        </span>
        <span>
          占比 <b>{share}</b>
        </span>
        <span className="text-muted-foreground">
          Harness {summary ? count(summary.harnessLines) : "—"} 行 · VibeCoding{" "}
          {summary ? count(summary.vibeLines) : "—"} 行 · 未归因{" "}
          {summary ? count(summary.unattributedLines) : "—"} 行
        </span>
        <span
          className="ml-auto cursor-help text-muted-foreground"
          title="与项目列表同为累计采纳行数，不受顶部日期筛选影响。占比分母为 Harness 与 VibeCoding 采纳行数之和；未归因不计入分母。"
        >
          <Info className="inline size-3.5" /> 统计说明
        </span>
      </div>
      {error ? (
        <div className="p-6 text-sm text-destructive">
          {error}
          <Button
            variant="outline"
            size="sm"
            className="ml-3"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试
          </Button>
        </div>
      ) : loading || !data ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1150px] text-left text-xs">
            <thead className="sticky top-0 z-10 border-b bg-background text-[11px] text-muted-foreground">
              <tr>
                {[
                  "文件 / 工具",
                  "采纳行数 ↓",
                  "生成时阶段 / 状态",
                  "Skill 归因",
                  "分类原因",
                  "产码 Agent",
                  "生成时间",
                  "溯源"
                ].map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <CodeTraceRow
                  key={item.eventId}
                  item={item}
                  onViewThread={(threadId, traceId) => setConversation({ threadId, traceId })}
                />
              ))}
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-14 text-center text-muted-foreground">
                    该分类暂无已采纳代码记录
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground">
        <span>共 {count(total)} 条采纳记录 · 每页 20 条</span>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0 || loading}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页
          </Button>
          <span>第 {page + 1} 页</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.nextCursor || loading || Boolean(error)}
            onClick={() => {
              if (data?.nextCursor) {
                setCursors((old) => [...old.slice(0, page + 1), data.nextCursor])
                setPage(page + 1)
              }
            }}
          >
            下一页
          </Button>
        </div>
      </div>
      {conversation ? (
        <CodeConversationDialog
          key={`${conversation.threadId}:${conversation.traceId}`}
          {...conversation}
          projectId={target.projectId}
          onClose={() => setConversation(null)}
        />
      ) : null}
    </>
  )
}

export function ProjectCodeTraceDialog({
  target,
  upperOrgLv1,
  onClose
}: {
  target: ProjectCodeTraceTarget
  upperOrgLv1?: string | string[] | null
  onClose: () => void
}) {
  const [bucket, setBucket] = useState(target.bucket)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex h-[82vh] max-w-[1380px] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>代码溯源 · {target.name}</DialogTitle>
          <DialogDescription>已采纳代码的技能归因、生成时阶段及关联会话</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 border-b px-5 py-3">
          {STAGE_BUCKET_ORDER.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={bucket === key ? "default" : "outline"}
              onClick={() => setBucket(key)}
            >
              {STAGE_BUCKET_LABELS[key]}
            </Button>
          ))}
        </div>
        <CodeTracePages
          key={`${bucket}:${JSON.stringify(upperOrgLv1)}`}
          target={target}
          bucket={bucket}
          upperOrgLv1={upperOrgLv1}
        />
      </DialogContent>
    </Dialog>
  )
}
