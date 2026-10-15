import { useMemo, useState, type ReactNode } from "react"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  Users
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useKnowledgeDetails } from "./use-knowledge-details"
import { KnowledgeReadReaders } from "./KnowledgeReadReaders"
import { KnowledgeReadTimeHeader, KnowledgeReadTimeValue } from "./KnowledgeReadTime"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  KnowledgeActiveDetails,
  KnowledgeActiveFile,
  KnowledgeReadDetails,
  KnowledgeReadFile
} from "../../../../shared/dashboard-knowledge-overview"

const loadUpdates = (rooms: string[]) =>
  window.api.dashboard.knowledgeActiveDetails({ upperOrgLv1: rooms })
const loadReads = (rooms: string[]) =>
  window.api.dashboard.knowledgeReadDetails({ upperOrgLv1: rooms })

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path
const text = (value: string): string => value || "—"

function DetailList<T>({
  title,
  icon,
  items,
  loading,
  error,
  note,
  placeholder,
  searchText,
  renderItem,
  itemKey,
  onRetry
}: {
  title: string
  icon: ReactNode
  items: T[]
  loading: boolean
  error: string | null
  note?: string
  placeholder: string
  searchText: (item: T) => string
  renderItem: (item: T) => ReactNode
  itemKey?: (item: T) => string
  onRetry: () => void
}): React.JSX.Element {
  const [keyword, setKeyword] = useState("")
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return query
      ? items.filter((item) => searchText(item).toLocaleLowerCase().includes(query))
      : items
  }, [items, keyword, searchText])
  const pageSize = 20
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  return (
    <section className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-lg border border-border lg:min-h-0">
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-3 text-sm font-medium">
        {icon}
        <h3>{title}</h3>
        {!loading && !error && (
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {items.length.toLocaleString("zh-CN")} 条
          </span>
        )}
      </div>
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`搜索${title}`}
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              setPage(1)
            }}
            placeholder={placeholder}
            className="h-8 pl-8 text-xs"
          />
        </div>
        {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      </div>
      {loading ? (
        <div className="flex min-h-40 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载中
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 px-4 text-xs"
        >
          <p className="text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex min-h-40 flex-1 items-center justify-center text-xs text-muted-foreground">
          {keyword.trim() ? "没有匹配的知识沉淀" : "近30天暂无明细"}
        </div>
      ) : (
        <ul
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain"
          aria-label={title}
        >
          {visible.map((item, index) => (
            <li key={itemKey ? itemKey(item) : index} className="space-y-1.5 px-4 py-3 text-xs">
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          {keyword.trim() ? `匹配 ${filtered.length} 条 · ` : ""}每页 {pageSize} 条
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-label={`${title}上一页`}
            disabled={loading || !!error || currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="min-w-12 text-center tabular-nums">
            {currentPage} / {pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-label={`${title}下一页`}
            disabled={loading || !!error || currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  )
}

const updateSearchText = (row: KnowledgeActiveFile): string =>
  [
    row.fileName,
    row.filePath,
    row.subProduct,
    row.deployUnit,
    row.lastCommitUser,
    row.roomName
  ].join(" ")
const readSearchText = (row: KnowledgeReadFile): string =>
  [row.filePath, row.pluginName, row.pluginId].join(" ")
const unavailableNotes = {
  multipleRooms: "多选室时不展示更新明细",
  unclassified: "未归属没有室编号，无法查询更新明细",
  roomNotMapped: "当前部门未配置室编号，无法查询更新明细",
  noAccess: "仅可查看本室的更新明细"
}

function UpdateRow({ row }: { row: KnowledgeActiveFile }): React.JSX.Element {
  return (
    <>
      <div className="break-all font-medium">{row.fileName || fileName(row.filePath)}</div>
      <div className="break-all font-mono text-[11px] text-muted-foreground">{row.filePath}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>系统：{text(row.subProduct)}</span>
        <span>部署单元：{text(row.deployUnit)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>更新人：{text(row.lastCommitUser)}</span>
        <span>{text(row.lastCommitDate)}</span>
      </div>
      <div className="break-words text-[11px] text-muted-foreground">
        部门：{text(row.roomName)}
      </div>
    </>
  )
}

const readFileKey = (row: KnowledgeReadFile): string =>
  JSON.stringify([row.pluginId, row.pluginName, row.filePath])

function ReadRow({
  row,
  rooms,
  expanded,
  onToggle
}: {
  row: KnowledgeReadFile
  rooms: string[]
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="break-all font-medium">{fileName(row.filePath)}</div>
      <div className="break-all font-mono text-[11px] text-muted-foreground">{row.filePath}</div>
      <div className="break-all text-[11px] text-muted-foreground">
        插件：{row.pluginName || row.pluginId}
      </div>
      {row.pluginName && row.pluginId && (
        <div className="break-all text-[10px] text-muted-foreground">插件 ID：{row.pluginId}</div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
        <KnowledgeReadTimeHeader />
        <KnowledgeReadTimeValue value={row.lastReadAt} />
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "查看"}${fileName(row.filePath)}的读取人`}
        onClick={onToggle}
      >
        <Users className="size-3.5" />
        {expanded ? "收起读取人" : "查看读取人"}
      </button>
      {expanded && <KnowledgeReadReaders file={row} rooms={rooms} />}
    </>
  )
}

export function KnowledgeActiveDetailsDialog({
  open,
  onOpenChange,
  rooms
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rooms: string[]
}): React.JSX.Element {
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const updates = useKnowledgeDetails<KnowledgeActiveDetails>(
    open,
    rooms,
    "dashboard:knowledgeActiveDetails",
    loadUpdates
  )
  const reads = useKnowledgeDetails<KnowledgeReadDetails>(
    open,
    rooms,
    "dashboard:knowledgeReadDetails",
    loadReads
  )
  const updateError =
    updates.error ??
    (updates.data?.unavailableReason ? unavailableNotes[updates.data.unavailableReason] : null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] w-[calc(100%-2rem)] max-w-[1280px] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 text-left">
          <DialogTitle className="text-base">活跃知识沉淀明细</DialogTitle>
          <DialogDescription className="pr-6 text-xs">
            近30天 · {rooms.length ? rooms.join("、") : "当前可查看部门"}
            。更新与读取分别统计，同一份知识可同时出现在两侧。
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-2 lg:overflow-hidden">
          <DetailList
            title="更新明细"
            icon={<RefreshCw className="size-4 text-emerald-500" />}
            items={updates.data?.items ?? []}
            loading={updates.loading}
            error={updateError}
            placeholder="搜索文件、系统、更新人或部门"
            searchText={updateSearchText}
            renderItem={(row) => <UpdateRow row={row} />}
            onRetry={updates.retry}
          />
          <DetailList
            title="读取明细"
            icon={<BookOpen className="size-4 text-blue-500" />}
            items={reads.data?.items ?? []}
            loading={reads.loading}
            error={reads.error}
            note={
              reads.data?.complete === false
                ? "部分历史记录缺少文件信息，仅展示已确认的读取明细。"
                : "按插件和文件路径去重。"
            }
            placeholder="搜索文件路径或插件"
            searchText={readSearchText}
            itemKey={readFileKey}
            renderItem={(row) => (
              <ReadRow
                row={row}
                rooms={rooms}
                expanded={expandedFile === readFileKey(row)}
                onToggle={() =>
                  setExpandedFile(expandedFile === readFileKey(row) ? null : readFileKey(row))
                }
              />
            )}
            onRetry={reads.retry}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
