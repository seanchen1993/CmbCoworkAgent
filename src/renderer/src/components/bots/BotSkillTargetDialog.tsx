import { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { botErrorMessage } from "@/lib/bot-error-message"
import type { QueuedMessage } from "@/types"
import type { HarnessBoardCatalogPageResult, HarnessProjectListItem } from "../../../../shared/harness-board-types"
import type { useBotWorks } from "./use-bot-works"

type SelectedProject = Pick<HarnessProjectListItem, "projectId" | "name">

function BotSkillProjectPicker({ selected, select }: {
  selected: SelectedProject | null
  select(project: SelectedProject): void
}) {
  const [query, setQuery] = useState("")
  const [cursors, setCursors] = useState<number[]>([])
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{
    query: string
    cursor: number | undefined
    retry: number
    page?: HarnessBoardCatalogPageResult
    error?: string
  } | null>(null)
  const cursor = cursors.at(-1)
  const current = result?.query === query && result.cursor === cursor && result.retry === retry ? result : null

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const page = await window.api.harnessBoard.catalogPage({
          includeRegistry: false, projectLimit: 20, projectCursor: cursor, query: query.trim() || undefined
        })
        if (active) setResult({ query, cursor, retry, page })
      } catch (cause) {
        if (active) setResult({ query, cursor, retry, error: botErrorMessage(cause, "暂时无法读取项目。") })
      }
    }
    const timer = setTimeout(() => void load(), query ? 200 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [query, cursor, retry])

  const projects = current?.page?.projects.filter(project => project.lifecycle.status === "active") ?? []
  const nextCursor = current?.page?.projectNextCursor
  return (
    <div className="grid gap-2">
      {selected && <span className="truncate text-xs" title={selected.name}>已选项目 · {selected.name}</span>}
      <input type="search" aria-label="搜索已登记项目" placeholder="搜索已登记项目…" maxLength={160}
        value={query} onChange={(event) => { setQuery(event.target.value); setCursors([]) }}
        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault() }} />
      {current?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {current.error} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>重试</button>
        </p>
      ) : !current ? <p role="status" className="text-xs text-muted-foreground">正在读取项目…</p> : (
        <>
          <div className="grid max-h-36 gap-1 overflow-auto">
            {projects.map(project => (
              <Button type="button" key={project.projectId}
                variant={selected?.projectId === project.projectId ? "secondary" : "outline"}
                aria-pressed={selected?.projectId === project.projectId}
                className="min-w-0 justify-start" title={project.workspacePath}
                onClick={() => select({ projectId: project.projectId, name: project.name })}>
                <span className="truncate">{project.name}</span>
                <span className="truncate text-xs text-muted-foreground">{project.projectDir || project.projectCode}</span>
              </Button>
            ))}
            {!projects.length && <span className="text-xs text-muted-foreground">本页没有可用项目</span>}
          </div>
          {(cursors.length > 0 || nextCursor != null) && (
            <div className="flex justify-end gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={!cursors.length}
                onClick={() => setCursors(value => value.slice(0, -1))}>上一页</Button>
              <Button type="button" variant="ghost" size="sm" disabled={nextCursor == null}
                onClick={() => { if (nextCursor != null) setCursors(value => [...value, nextCursor]) }}>下一页</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function BotSkillTargetDialog({
  skill,
  directory,
  error,
  retry,
  close,
  choose
}: {
  skill: string
  directory: ReturnType<typeof useBotWorks>
  error?: string
  retry?: QueuedMessage["botSkillTarget"]
  close(): void
  choose(target: NonNullable<QueuedMessage["botSkillTarget"]>): void
}) {
  const origin = useRef(typeof document !== "undefined" && typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null)
  const originThread = useRef(origin.current?.closest<HTMLElement>("[data-chat-thread-id]") ?? null)
  const failedCreate = retry?.kind === "create" ? retry : undefined
  const failedPath = failedCreate && "path" in failedCreate ? failedCreate.path : ""
  const [creating, setCreating] = useState(Boolean(failedCreate))
  const [title, setTitle] = useState(failedCreate?.title ?? "")
  const [path, setPath] = useState(failedPath)
  const [location, setLocation] = useState(failedCreate && "projectId" in failedCreate
    ? "project" : failedPath ? "directory" : "default")
  const [project, setProject] = useState<SelectedProject | null>(null)
  const canCreate = Boolean(title.trim() && (location !== "project" || project) &&
    (location !== "directory" || path.trim()))
  const works = [...new Map([...directory.priority, ...directory.items].map(work => [work.id, work])).values()]
    .filter(work => !work.source && work.state !== "completed" &&
      !work.deletionPending && (!work.conversation || work.conversation.state === "bound"))
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" onCloseAutoFocus={event => {
        const trigger = origin.current
        // Initial send can disable its button after the draft enters the queue.
        // Keep the fallback in that same original conversation, never another task.
        const target = trigger?.isConnected && !trigger.matches(":disabled") && !trigger.closest("[inert]")
          ? trigger : originThread.current?.isConnected
            ? originThread.current.querySelector<HTMLElement>("[data-bot-composer] textarea:not(:disabled), [data-bot-composer] [contenteditable='true']")
            : null
        if (target) {
          event.preventDefault()
          target.focus({ preventScroll: true })
        }
      }}>
        <DialogTitle>选择技能交办位置</DialogTitle>
        <DialogDescription>「{skill}」将在你选中的会话执行。关闭此窗口可保留草稿。</DialogDescription>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => choose({ kind: "main" })}>在主对话发送</Button>
          <Button variant="outline" onClick={() => setCreating(!creating)}>新建任务</Button>
        </div>
        {creating ? (
          <form className="bot-work-create" onSubmit={(event) => {
            event.preventDefault()
            if (!canCreate) return
            const target = { kind: "create" as const, title: title.trim() }
            if (location === "project" && project) choose({ ...target, projectId: project.projectId })
            else choose({ ...target, path: location === "directory" ? path.trim() : "" })
          }}>
            <label>任务名称<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label>工作位置
              <select className="rounded-lg border bg-background px-2 py-2 text-sm" value={location}
                onChange={(event) => setLocation(event.target.value)}>
                <option value="default">Bot 默认目录</option>
                <option value="project">已登记项目</option>
                <option value="directory">手填目录</option>
              </select>
            </label>
            {location === "project" && <BotSkillProjectPicker selected={project} select={setProject} />}
            {location === "directory" && (
              <label>工作目录<input required maxLength={4096} value={path} onChange={(event) => setPath(event.target.value)} /></label>
            )}
            <Button disabled={!canCreate} type="submit">交办并发送</Button>
          </form>
        ) : (
          <>
            <input className="bot-work-search" aria-label="搜索任务" placeholder="搜索已有任务…" value={directory.query}
              onChange={(event) => directory.setQuery(event.target.value)} />
            {directory.error && <p role="alert">{directory.error}</p>}
            <div className="grid max-h-56 gap-1 overflow-auto">
              {works.map(work => (
                <Button key={work.id} variant="outline" className="justify-start"
                  onClick={() => choose({ kind: "work", workId: work.id })}>
                  <span className="truncate">{work.title}</span>
                </Button>
              ))}
              {directory.cursor && <Button variant="ghost" disabled={directory.loading} onClick={() => void directory.more()}>显示更多任务</Button>}
              {!directory.loading && !works.length && <span className="text-sm text-muted-foreground">没有可交办的现有任务</span>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
