import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  KnowledgeFileReaders,
  KnowledgeReadFileRef
} from "../../../../shared/dashboard-knowledge-overview"
import { useKnowledgeDetails } from "./use-knowledge-details"
import { KnowledgeReadTimeHeader, KnowledgeReadTimeValue } from "./KnowledgeReadTime"

export function KnowledgeReadReaders({
  file,
  rooms
}: {
  file: KnowledgeReadFileRef
  rooms: string[]
}): React.JSX.Element {
  const request = useCallback(
    (scope: string[]) =>
      window.api.dashboard.knowledgeReadReaders(
        { filePath: file.filePath, pluginId: file.pluginId, pluginName: file.pluginName },
        { upperOrgLv1: scope }
      ),
    [file.filePath, file.pluginId, file.pluginName]
  )
  const { data, error, loading, retry } = useKnowledgeDetails<KnowledgeFileReaders>(
    true,
    rooms,
    "dashboard:knowledgeReadReaders",
    request
  )
  const [keyword, setKeyword] = useState("")
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return (data?.items ?? []).filter(
      (row) =>
        !query ||
        [row.userName, row.sapId, row.ystId, ...row.departments]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)
    )
  }, [data, keyword])
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10))
  const currentPage = Math.min(page, pageCount)
  const named = data?.items.filter((row) => row.nameOnly).length ?? 0
  const identified = (data?.items.length ?? 0) - named
  if (loading)
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/30 p-3 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        读取人加载中
      </div>
    )
  if (error)
    return (
      <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-[11px]">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={retry}>
          重试读取人
        </Button>
      </div>
    )
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/20 p-3"
      role="region"
      aria-label="文件读取人"
    >
      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
        <span className="font-medium">
          读取人：{identified} 人{named > 0 ? ` · 仅姓名 ${named} 条` : ""}
        </span>
        <span className="text-muted-foreground">近30天</span>
      </div>
      <p className="text-[10px] text-muted-foreground">读取人为发起 Agent 使用这份知识的用户。</p>
      {data?.hasUnknownReaders && (
        <p className="text-[10px] text-muted-foreground">
          部分记录无法确认读取人，未计入已识别人数。
        </p>
      )}
      {named > 0 && (
        <p className="text-[10px] text-muted-foreground">
          仅有姓名的旧记录单独列出，无法准确区分同名用户。
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="搜索读取人"
          placeholder="搜索姓名、工号或部门"
          className="h-7 pl-7 text-[11px]"
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value)
            setPage(1)
          }}
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full table-fixed text-left text-[11px]">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              <th className="w-1/5 py-2 pr-2 font-normal">读取人</th>
              <th className="w-1/5 py-2 pr-2 font-normal">工号</th>
              <th className="w-[30%] py-2 pr-2 font-normal">部门</th>
              <th className="py-2 font-normal">
                <KnowledgeReadTimeHeader />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice((currentPage - 1) * 10, currentPage * 10).map((row) => (
              <tr key={row.key} className="border-t border-border align-top">
                <td className="break-all py-2 pr-2">
                  {row.userName || "未记录姓名"}
                  {row.nameOnly && (
                    <span className="ml-1 text-[10px] text-muted-foreground">仅姓名</span>
                  )}
                </td>
                <td className="break-all py-2 pr-2">
                  <div>{row.sapId || row.ystId || "—"}</div>
                  {row.sapId && row.ystId && row.sapId !== row.ystId && (
                    <div className="text-[10px] text-muted-foreground">一事通：{row.ystId}</div>
                  )}
                </td>
                <td className="break-words py-2 pr-2">
                  {row.departments.length
                    ? row.departments.map((dept) => <div key={dept}>{dept}</div>)
                    : "未记录部门"}
                </td>
                <td className="py-2 text-muted-foreground">
                  <KnowledgeReadTimeValue value={row.lastReadAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="py-4 text-center text-muted-foreground">
            {keyword.trim() ? "没有匹配的读取人" : "暂无可识别的读取人信息"}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{keyword.trim() ? `匹配 ${filtered.length} 条 · ` : ""}每页10条</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label="读取人上一页"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft className="size-3" />
          </Button>
          <span>
            {currentPage} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label="读取人下一页"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
