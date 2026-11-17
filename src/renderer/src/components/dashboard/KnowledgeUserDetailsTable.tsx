import { useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { KnowledgeUserDetail } from "../../../../shared/dashboard-knowledge-overview"
import type { DashboardKnowledgeCommitRateUnavailableReason } from "../../../../shared/dashboard-knowledge-commit-rate"
import { useKnowledgeDetails } from "./use-knowledge-details"

const COLUMNS: { key: keyof KnowledgeUserDetail; label: string; numeric?: boolean }[] = [
  { key: "userName", label: "用户" },
  { key: "roomName", label: "所属室" },
  { key: "totalNum", label: "知识沉淀总数", numeric: true },
  { key: "abandonedNum", label: "废弃知识沉淀数", numeric: true },
  { key: "recentNum", label: "近一个月知识沉淀数", numeric: true },
  { key: "updateActiveNum", label: "更新活跃知识沉淀数", numeric: true },
  { key: "readActiveNum", label: "阅读活跃知识沉淀数", numeric: true }
]
const SCOPE_NOTES: Record<DashboardKnowledgeCommitRateUnavailableReason, string> = {
  multipleRooms: "当前范围暂不支持多选室",
  unclassified: "未归属没有室编号，无法查询用户明细",
  roomNotMapped: "所选室未配置室编号，无法查询用户明细",
  noAccess: "仅可查看本室的用户明细"
}
const loadDetails = (rooms: string[]) =>
  window.api.dashboard.knowledgeUserDetails({ upperOrgLv1: rooms })
const PAGE_SIZE = 10
const compareText = (a: string, b: string): number => a.localeCompare(b, "zh-CN", { numeric: true })

export function KnowledgeUserDetailsTable({
  rooms,
  refreshKey
}: {
  rooms: string[]
  refreshKey: number
}): React.JSX.Element {
  const { data, loading, error, retry } = useKnowledgeDetails(
    true,
    rooms,
    "dashboard:knowledgeUserDetails",
    loadDetails,
    refreshKey
  )
  const [keyword, setKeyword] = useState("")
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: keyof KnowledgeUserDetail; direction: "asc" | "desc" }>({
    key: "totalNum",
    direction: "desc"
  })
  const rows = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return (data?.items ?? [])
      .filter(
        (row) => !query || `${row.userName} ${row.roomName}`.toLocaleLowerCase().includes(query)
      )
      .sort((a, b) => {
        const left = a[sort.key]
        const right = b[sort.key]
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : compareText(String(left), String(right))
        return (
          (sort.direction === "asc" ? 1 : -1) * comparison ||
          compareText(a.userName, b.userName) ||
          compareText(a.roomName, b.roomName)
        )
      })
  }, [data, keyword, sort])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages)
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const scopeNote = data?.unavailableReason ? SCOPE_NOTES[data.unavailableReason] : null
  const exportExcel = async (): Promise<void> => {
    if (exporting || loading || error || scopeNote || !rows.length) return
    setExporting(true)
    setExportError(null)
    try {
      const result = await window.api.dashboard.exportExcel(
        [
          {
            name: "用户知识沉淀明细",
            header: COLUMNS.map((column) => column.label),
            rows: rows.map((row) => COLUMNS.map((column) => row[column.key]))
          }
        ],
        { fileName: "用户知识沉淀明细" }
      )
      if (!result.success && !result.canceled) throw new Error(result.error || "导出用户明细失败")
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="knowledge-user-details-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="knowledge-user-details-title" className="text-sm font-semibold">
          用户知识沉淀明细列表
        </h3>
        {import.meta.env.DEV && <span className="text-[11px] text-amber-600">开发示例数据</span>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索用户知识沉淀明细"
              placeholder="搜索用户或所属室"
              className="h-8 pl-8 text-xs"
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            {!loading && !error && !scopeNote && (
              <span className="text-[11px] text-muted-foreground" aria-live="polite">
                {keyword.trim() ? `匹配 ${rows.length.toLocaleString("zh-CN")} 条 · ` : ""}共{" "}
                {data?.items.length.toLocaleString("zh-CN") ?? 0} 条
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={exporting || loading || !!error || !!scopeNote || !rows.length}
              title={`导出当前筛选下的全部 ${rows.length.toLocaleString("zh-CN")} 条记录`}
              onClick={() => void exportExcel()}
            >
              {exporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              导出 Excel
            </Button>
          </div>
        </div>
        {exportError && (
          <p role="alert" className="px-4 py-2 text-xs text-destructive">
            {exportError}
          </p>
        )}
        {loading ? (
          <div
            role="status"
            className="flex h-40 items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            加载中
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 text-xs"
          >
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              重试
            </Button>
          </div>
        ) : scopeNote ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {scopeNote}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" aria-label="用户知识沉淀明细">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    {COLUMNS.map((column) => {
                      const active = sort.key === column.key
                      const Icon = active
                        ? sort.direction === "asc"
                          ? ArrowUp
                          : ArrowDown
                        : ArrowUpDown
                      return (
                        <th
                          key={column.key}
                          className={`whitespace-nowrap px-4 py-3 font-medium ${column.numeric ? "text-right" : "text-left"}`}
                          aria-sort={
                            active
                              ? sort.direction === "asc"
                                ? "ascending"
                                : "descending"
                              : "none"
                          }
                        >
                          <button
                            type="button"
                            className={`inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "text-foreground" : ""}`}
                            aria-label={`按${column.label}排序${active ? `，当前${sort.direction === "asc" ? "升序" : "降序"}` : ""}`}
                            onClick={() => {
                              setSort({
                                key: column.key,
                                direction: active
                                  ? sort.direction === "asc"
                                    ? "desc"
                                    : "asc"
                                  : column.numeric
                                    ? "desc"
                                    : "asc"
                              })
                              setPage(1)
                            }}
                          >
                            {column.label}
                            <Icon className={`size-3 shrink-0 ${active ? "" : "opacity-50"}`} />
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.map((row, index) => (
                    <tr key={index} className="transition-colors hover:bg-muted/20">
                      {COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className={`px-4 py-3 ${column.numeric ? "text-right tabular-nums" : "text-left"}`}
                        >
                          {column.numeric ? (
                            row[column.key].toLocaleString("zh-CN")
                          ) : (
                            <span
                              className={`block max-w-64 truncate ${column.key === "userName" ? "font-medium" : "text-muted-foreground"}`}
                              title={String(row[column.key])}
                            >
                              {row[column.key] || "未记录"}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td
                        colSpan={COLUMNS.length}
                        className="h-40 text-center text-muted-foreground"
                      >
                        {keyword.trim() ? "没有匹配的用户明细" : "暂无用户知识沉淀明细"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {rows.length > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                <span>每页 {PAGE_SIZE} 条</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    aria-label="用户明细上一页"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <span className="min-w-12 text-center tabular-nums">
                    {currentPage} / {pages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    aria-label="用户明细下一页"
                    disabled={currentPage >= pages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
