import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Brain,
  FileText,
  Info,
  Trash2,
  User,
  MessageSquare,
  Folder,
  BookOpen,
  Archive,
  Sparkles,
  Loader2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

type MemoryType = "user" | "feedback" | "project" | "reference"
type MemoryScope = "global" | "project"
type ProjectScopeStatus = "checking" | "available" | "unavailable"

interface MemoryPanelProps {
  workspacePath?: string | null
}

interface MemoryFile {
  name: string
  size: number
  modifiedAt: string
  type: MemoryType | null
  displayName: string | null
  description: string | null
  recallCount: number
}

interface DreamStateInfo {
  lastRunAt: number
  sessionsSinceLastRun: number
}

const TYPE_META: Record<
  MemoryType,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  user: { label: "User", icon: User, color: "text-blue-500" },
  feedback: { label: "Feedback", icon: MessageSquare, color: "text-amber-500" },
  project: { label: "Project", icon: Folder, color: "text-emerald-500" },
  reference: { label: "Reference", icon: BookOpen, color: "text-purple-500" }
}

interface MemoryStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
  dreamEnabled: boolean
  dreamState: DreamStateInfo
  scope: MemoryScope
  memoryDir: string
  projectId?: string
  gitRoot?: string
}

function formatDreamAge(lastRunAt: number): string {
  if (!lastRunAt) return "从未整合"
  const days = Math.floor((Date.now() - lastRunAt) / 86400000)
  if (days === 0) return "今天"
  if (days === 1) return "昨天"
  return `${days} 天前`
}

function RecallBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span
      className={cn(
        "ml-auto shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium",
        count >= 10
          ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
          : "bg-muted text-muted-foreground"
      )}
    >
      {count}×
    </span>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function lastPathSegment(path: string | null | undefined): string {
  if (!path) return ""
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).pop() || trimmed
}

interface FileButtonProps {
  file: MemoryFile
  selected: boolean
  onSelect: (f: MemoryFile) => void
  iconOverride: React.ReactNode
  primaryLabel: string
  secondaryLabel: string
  showRecall?: boolean
}

function FileButton({
  file,
  selected,
  onSelect,
  iconOverride,
  primaryLabel,
  secondaryLabel,
  showRecall
}: FileButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
        selected ? "bg-muted/70" : "hover:bg-muted/50"
      )}
      onClick={() => onSelect(file)}
    >
      {iconOverride}
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block">{primaryLabel}</span>
        <span className="text-[10px] text-muted-foreground truncate block">{secondaryLabel}</span>
      </div>
      {showRecall && <RecallBadge count={file.recallCount} />}
    </button>
  )
}

interface GroupedFiles {
  byType: Record<MemoryType, MemoryFile[]>
  index: MemoryFile | null
  legacy: MemoryFile[]
}

function groupFiles(files: MemoryFile[]): GroupedFiles {
  const byType: Record<MemoryType, MemoryFile[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: []
  }
  let index: MemoryFile | null = null
  const legacy: MemoryFile[] = []
  for (const f of files) {
    if (f.name === "MEMORY.md") {
      index = f
      continue
    }
    if (f.type) {
      byType[f.type].push(f)
    } else {
      legacy.push(f)
    }
  }
  return { byType, index, legacy }
}

interface DreamResult {
  archived: number
  merged: number
  created: number
  skipped: number
}

interface MemoryProject {
  projectId: string
  displayName: string
  memoryDir: string
  gitRoot?: string
  fileCount: number
  totalSize: number
  indexSize: number
  isCurrent: boolean
}

export function MemoryPanel({ workspacePath }: MemoryPanelProps): React.JSX.Element {
  const [files, setFiles] = useState<MemoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [dreamEnabled, setDreamEnabled] = useState(false)
  const [dreamRunning, setDreamRunning] = useState(false)
  const [dreamResult, setDreamResult] = useState<DreamResult | null>(null)
  const [activeScope, setActiveScope] = useState<MemoryScope>("global")
  const [projectScopeStatus, setProjectScopeStatus] = useState<ProjectScopeStatus>("unavailable")
  const [projects, setProjects] = useState<MemoryProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const grouped = useMemo(() => groupFiles(files), [files])
  const hasProjectScope = projects.length > 0
  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )
  const projectFactCount = files.filter((file) => file.name !== "MEMORY.md").length
  const projectTitle =
    selectedProject?.displayName || workspacePath
      ? (selectedProject?.displayName ?? lastPathSegment(workspacePath))
      : "未关联工作区"
  const scopeRequest = useMemo(
    () => ({
      scope: activeScope,
      workspacePath: workspacePath ?? null,
      projectId: activeScope === "project" ? selectedProjectId : null
    }),
    [activeScope, selectedProjectId, workspacePath]
  )

  useEffect(() => {
    if (activeScope === "project" && !hasProjectScope) {
      setActiveScope("global")
    }
  }, [activeScope, hasProjectScope])

  useEffect(() => {
    let cancelled = false
    setProjectScopeStatus("checking")
    window.api.memory
      .listProjects({ workspacePath: workspacePath ?? null })
      .then((projectList) => {
        if (cancelled || !mountedRef.current) return
        setProjects(projectList)
        setSelectedProjectId((prev) => {
          if (prev && projectList.some((project) => project.projectId === prev)) return prev
          return (
            projectList.find((project) => project.isCurrent)?.projectId ??
            projectList[0]?.projectId ??
            null
          )
        })
        setProjectScopeStatus(projectList.length > 0 ? "available" : "unavailable")
        if (workspacePath?.trim() && projectList.some((project) => project.isCurrent)) {
          setActiveScope((scope) => (scope === "global" ? "project" : scope))
        }
      })
      .catch((e) => {
        console.error(e)
        if (!cancelled && mountedRef.current) {
          setProjects([])
          setSelectedProjectId(null)
          setProjectScopeStatus("unavailable")
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadData = useCallback(async () => {
    try {
      const [fileList, memStats] = await Promise.all([
        window.api.memory.listFiles(scopeRequest),
        window.api.memory.getStats(scopeRequest)
      ])
      if (!mountedRef.current) return
      setFiles(fileList)
      setStats(memStats)
      setEnabled(memStats.enabled)
      setDreamEnabled(memStats.dreamEnabled)
      setSelectedFile((prev) => {
        if (!prev) return null
        return fileList.find((f) => f.name === prev.name) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [scopeRequest])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    return window.api.memory.onChanged(() => {
      loadData()
    })
  }, [loadData])

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      return
    }
    window.api.memory
      .readFile(selectedFile.name, scopeRequest)
      .then((content) => {
        if (mountedRef.current) setFileContent(content)
      })
      .catch(console.error)
    // Re-read when name OR modifiedAt changes — this catches background
    // rewrites by the summarizer (which fires memory:changed → loadData →
    // setSelectedFile with the fresh metadata).
  }, [scopeRequest, selectedFile?.name, selectedFile?.modifiedAt])

  useEffect(() => {
    setSelectedFile(null)
    setFileContent("")
    setDreamResult(null)
  }, [activeScope, selectedProjectId, workspacePath])

  const handleToggleEnabled = useCallback(async () => {
    try {
      const next = !enabled
      await window.api.memory.setEnabled(next)
      if (mountedRef.current) {
        setEnabled(next)
        if (!next) setDreamEnabled(false)
        setStats((prev) =>
          prev ? { ...prev, enabled: next, dreamEnabled: next ? prev.dreamEnabled : false } : prev
        )
      }
    } catch (e) {
      console.error(e)
    }
  }, [enabled])

  const handleToggleDreamEnabled = useCallback(async () => {
    if (!enabled) return
    try {
      const next = !dreamEnabled
      await window.api.memory.setDreamEnabled(next)
      if (mountedRef.current) {
        setDreamEnabled(next)
        setStats((prev) => (prev ? { ...prev, dreamEnabled: next } : prev))
      }
    } catch (e) {
      console.error(e)
    }
  }, [enabled, dreamEnabled])

  const handleDream = useCallback(async () => {
    if (dreamRunning || !enabled || !dreamEnabled) return
    setDreamRunning(true)
    setDreamResult(null)
    try {
      const result = await window.api.memory.consolidate(scopeRequest)
      if (mountedRef.current) {
        setDreamResult(result)
        await loadData()
      }
    } catch (e) {
      console.error(e)
    } finally {
      if (mountedRef.current) setDreamRunning(false)
    }
  }, [dreamRunning, enabled, dreamEnabled, loadData, scopeRequest])

  const handleDelete = useCallback(
    async (file: MemoryFile) => {
      if (file.name === "MEMORY.md") return
      if (!confirm(`确定要删除记忆文件「${file.name}」吗？此操作不可撤销。`)) return
      try {
        await window.api.memory.deleteFile(file.name, scopeRequest)
        if (selectedFile?.name === file.name) setSelectedFile(null)
        await loadData()
      } catch (e) {
        console.error(e)
      }
    },
    [selectedFile, loadData, scopeRequest]
  )

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <h2 className="text-base font-bold">Memory</h2>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1">
            <button
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                activeScope === "global"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setActiveScope("global")}
            >
              全局
            </button>
            <button
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                activeScope === "project"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                !hasProjectScope && "cursor-not-allowed opacity-50"
              )}
              onClick={() => {
                if (hasProjectScope) setActiveScope("project")
              }}
              disabled={!hasProjectScope}
              title={
                hasProjectScope
                  ? (selectedProject?.gitRoot ?? selectedProject?.memoryDir ?? undefined)
                  : projectScopeStatus === "checking"
                    ? "正在检测项目记忆"
                    : "没有可用的项目记忆"
              }
            >
              当前项目
            </button>
          </div>
          {activeScope === "project" && hasProjectScope && (
            <select
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              value={selectedProjectId ?? ""}
              onChange={(event) => setSelectedProjectId(event.target.value || null)}
              title="选择要查看和管理的项目记忆"
            >
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.isCurrent ? "当前项目 · " : ""}
                  {project.displayName} · {project.projectId}
                </option>
              ))}
            </select>
          )}
          <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
            {activeScope === "project" ? (
              <>
                <div className="flex items-center gap-1.5">
                  <Folder className="size-3 shrink-0" />
                  <span className="min-w-0 truncate font-medium text-foreground/70">
                    当前项目：{projectTitle}
                  </span>
                  {selectedProject?.projectId && (
                    <span className="shrink-0 text-muted-foreground/70">
                      #{selectedProject.projectId}
                    </span>
                  )}
                </div>
                <div className="mt-1 space-y-0.5 pl-4">
                  {workspacePath ? (
                    <div className="truncate" title={workspacePath}>
                      工作区：{workspacePath}
                    </div>
                  ) : (
                    <div>当前会话未关联工作区</div>
                  )}
                  {projectScopeStatus === "checking" ? (
                    <div>正在识别 Git 项目</div>
                  ) : hasProjectScope && selectedProject ? (
                    <>
                      {selectedProject.gitRoot ? (
                        <div className="truncate" title={selectedProject.gitRoot}>
                          Git root：{selectedProject.gitRoot}
                        </div>
                      ) : (
                        <div>Git root：未知（旧项目记忆）</div>
                      )}
                      <div className="truncate" title={selectedProject.memoryDir}>
                        记忆目录：{selectedProject.memoryDir}
                      </div>
                    </>
                  ) : workspacePath ? (
                    <div>未识别到可用项目记忆</div>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <Brain className="size-3 shrink-0" />
                  <span className="min-w-0 truncate font-medium text-foreground/70">全局记忆</span>
                </div>
                <div className="mt-1 space-y-0.5 pl-4">
                  <div>跨项目共享的用户事实、偏好与反馈</div>
                  {stats?.memoryDir && (
                    <div className="truncate" title={stats.memoryDir}>
                      记忆目录：{stats.memoryDir}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className={cn(
                "shrink-0 text-xs px-2 py-0.5 rounded-full border transition-colors",
                enabled
                  ? "bg-green-500/10 border-green-500/30 text-green-500"
                  : "bg-muted border-border text-muted-foreground"
              )}
              onClick={handleToggleEnabled}
            >
              记忆子系统 {enabled ? "已启用" : "已禁用"}
            </button>
            <button
              className={cn(
                "shrink-0 text-xs px-2 py-0.5 rounded-full border transition-colors",
                enabled && dreamEnabled
                  ? "bg-purple-500/10 border-purple-500/30 text-purple-500"
                  : "bg-muted border-border text-muted-foreground",
                !enabled && "cursor-not-allowed"
              )}
              onClick={handleToggleDreamEnabled}
              disabled={!enabled}
              title={enabled ? "控制自动 Dream 整合与手动 Dream 按钮" : "开启记忆后才能启用 Dream"}
            >
              Dream {enabled && dreamEnabled ? "已启用" : "已禁用"}
            </button>
            <button
              className={cn(
                "ml-auto flex items-center gap-1 shrink-0 text-xs px-2 py-0.5 rounded-full border transition-colors",
                dreamRunning || !enabled || !dreamEnabled
                  ? "bg-muted border-border text-muted-foreground cursor-not-allowed"
                  : "bg-purple-500/10 border-purple-500/30 text-purple-500 hover:bg-purple-500/20"
              )}
              onClick={handleDream}
              disabled={dreamRunning || !enabled || !dreamEnabled}
              title="对记忆进行 Dream 整合：合并重复条目、提炼模式、归档过期内容"
            >
              {dreamRunning ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {dreamRunning ? "整合中…" : "Dream"}
            </button>
          </div>

          {dreamResult && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-purple-500/5 border border-purple-500/20 text-[11px] text-purple-600 dark:text-purple-400">
              <Sparkles className="size-3 shrink-0" />
              <span>
                整合完成：
                {dreamResult.merged > 0 && `合并 ${dreamResult.merged} 条 · `}
                {dreamResult.created > 0 && `新增 ${dreamResult.created} 条 · `}
                {dreamResult.archived > 0 && `归档 ${dreamResult.archived} 条 · `}
                {dreamResult.skipped > 0 && `跳过 ${dreamResult.skipped} 条`}
                {dreamResult.merged === 0 && dreamResult.created === 0 && dreamResult.archived === 0
                  ? "无需整合"
                  : ""}
              </span>
            </div>
          )}

          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span>
              {enabled
                ? "记忆库可用；具体会话需在输入框旁单独开启"
                : "记忆子系统已关闭，所有会话都不会总结、检索或注入记忆"}
            </span>
          </div>
          {stats && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10px] text-muted-foreground">
              <span>{stats.scope === "project" ? "项目记忆" : "全局记忆"}</span>
              <span>{stats.fileCount} 个文件</span>
              <span>{formatSize(stats.totalSize)}</span>
              <span>索引 {formatSize(stats.indexSize)}</span>
              {stats.projectId && <span>项目 {stats.projectId}</span>}
              <span className="ml-auto min-w-0">
                Dream {stats.dreamEnabled ? "开启" : "关闭"} · 整合:{" "}
                {formatDreamAge(stats.dreamState.lastRunAt)}
                {stats.dreamState.sessionsSinceLastRun > 0 &&
                  ` · ${stats.dreamState.sessionsSinceLastRun} 次对话`}
              </span>
            </div>
          )}
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-3">
            {activeScope === "project" && hasProjectScope && projectFactCount === 0 && (
              <div className="rounded-md border border-blue-500/25 bg-blue-500/5 p-2.5 text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">
                当前项目已识别，但还没有项目事实文件。旧版记忆会保留在全局记忆里；项目记忆会在后续会话结束总结后写入这里。
              </div>
            )}
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Brain className="size-8 opacity-40 mb-2" />
                <p className="text-xs">
                  {activeScope === "project" ? "当前项目暂无记忆文件" : "暂无记忆文件"}
                </p>
              </div>
            ) : (
              <>
                {grouped.index && (
                  <FileButton
                    file={grouped.index}
                    selected={selectedFile?.name === grouped.index.name}
                    onSelect={setSelectedFile}
                    iconOverride={<FileText className="size-3.5 shrink-0 text-primary" />}
                    primaryLabel="MEMORY.md"
                    secondaryLabel="索引文件 · 注入到每次对话"
                  />
                )}

                {grouped.legacy.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                    检测到 {grouped.legacy.length} 个旧版按日期归档的记忆文件。新版改为按
                    <span className="font-medium">类型 + 单事实文件</span>
                    管理。旧文件仍可被搜索到，但不会出现在 MEMORY.md 索引里。
                  </div>
                )}

                {(["user", "feedback", "project", "reference"] as const).map((type) => {
                  const items = grouped.byType[type]
                  if (items.length === 0) return null
                  const meta = TYPE_META[type]
                  const Icon = meta.icon
                  return (
                    <div key={type} className="space-y-1">
                      <div className="flex items-center gap-1.5 px-2 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <Icon className={cn("size-3", meta.color)} />
                        <span>{meta.label}</span>
                        <span className="text-muted-foreground/60">· {items.length}</span>
                      </div>
                      {items.map((file) => (
                        <FileButton
                          key={file.name}
                          file={file}
                          selected={selectedFile?.name === file.name}
                          onSelect={setSelectedFile}
                          iconOverride={<Icon className={cn("size-3.5 shrink-0", meta.color)} />}
                          primaryLabel={file.displayName ?? file.name}
                          secondaryLabel={
                            file.description ??
                            `${formatSize(file.size)} · ${formatDate(file.modifiedAt)}`
                          }
                          showRecall
                        />
                      ))}
                    </div>
                  )
                })}

                {grouped.legacy.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 px-2 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <Archive className="size-3 text-muted-foreground/70" />
                      <span>历史记录</span>
                      <span className="text-muted-foreground/60">· {grouped.legacy.length}</span>
                    </div>
                    {grouped.legacy.map((file) => (
                      <FileButton
                        key={file.name}
                        file={file}
                        selected={selectedFile?.name === file.name}
                        onSelect={setSelectedFile}
                        iconOverride={
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        }
                        primaryLabel={file.name}
                        secondaryLabel={`${formatSize(file.size)} · ${formatDate(file.modifiedAt)}`}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedFile ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{selectedFile.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatSize(selectedFile.size)} · 修改于 {formatDate(selectedFile.modifiedAt)}
              </p>
            </div>
            {selectedFile.name !== "MEMORY.md" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(selectedFile)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <ScrollArea className="flex-1">
            <pre className="p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed text-foreground/90">
              {fileContent || "(空文件)"}
            </pre>
          </ScrollArea>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
          <div className="max-w-md space-y-6">
            <div className="text-center space-y-3">
              <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
                <Brain className="size-7 text-muted-foreground/60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground/80">Memory 记忆</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                记忆系统让 AI
                拥有长期记忆能力。现在新会话默认不使用记忆；你可以在输入框旁为当前会话单独开启。
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">记忆如何工作？</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  当前会话开启记忆后，对话成功结束时 AI
                  会提取对话中的关键信息——比如你的偏好、项目背景、决策的「为什么」——并按
                  <span className="font-medium text-foreground/60">类型分类</span>
                  保存为单独的事实文件（user / feedback / project /
                  reference）。后续已开启记忆的会话会检索相关内容，并参考 MEMORY.md 索引。
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">管理你的记忆</p>
                <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">1.</span>
                    从左侧按类型浏览记忆，点击查看完整内容
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">2.</span>
                    <span className="font-medium text-foreground/60">MEMORY.md</span> 是 LLM
                    维护的索引，仅在会话开启记忆时注入到系统提示词
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">3.</span>
                    你可以手动删除不准确或不再需要的记忆条目
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">4.</span>
                    通过顶部开关可控制全局记忆子系统；通过输入框旁入口控制当前会话
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">隐私与控制</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  所有记忆数据完全存储在本地，不会上传到任何服务器。你对记忆拥有完全控制权，可以随时查看、编辑或删除任何记忆内容，也可以一键关闭全局记忆子系统。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
