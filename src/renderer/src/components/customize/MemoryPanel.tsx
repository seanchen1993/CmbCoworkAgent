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
  Archive
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

type MemoryType = "user" | "feedback" | "project" | "reference"

interface MemoryFile {
  name: string
  size: number
  modifiedAt: string
  type: MemoryType | null
  displayName: string | null
  description: string | null
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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

interface FileButtonProps {
  file: MemoryFile
  selected: boolean
  onSelect: (f: MemoryFile) => void
  iconOverride: React.ReactNode
  primaryLabel: string
  secondaryLabel: string
}

function FileButton({
  file,
  selected,
  onSelect,
  iconOverride,
  primaryLabel,
  secondaryLabel
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

export function MemoryPanel(): React.JSX.Element {
  const [files, setFiles] = useState<MemoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [enabled, setEnabled] = useState(true)
  const mountedRef = useRef(true)
  const grouped = useMemo(() => groupFiles(files), [files])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadData = useCallback(async () => {
    try {
      const [fileList, memStats] = await Promise.all([
        window.api.memory.listFiles(),
        window.api.memory.getStats()
      ])
      if (!mountedRef.current) return
      setFiles(fileList)
      setStats(memStats)
      setEnabled(memStats.enabled)
      setSelectedFile((prev) => {
        if (!prev) return null
        return fileList.find((f) => f.name === prev.name) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

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
      .readFile(selectedFile.name)
      .then((content) => {
        if (mountedRef.current) setFileContent(content)
      })
      .catch(console.error)
    // Re-read when name OR modifiedAt changes — this catches background
    // rewrites by the summarizer (which fires memory:changed → loadData →
    // setSelectedFile with the fresh metadata).
  }, [selectedFile?.name, selectedFile?.modifiedAt])

  const handleToggleEnabled = useCallback(async () => {
    try {
      const next = !enabled
      await window.api.memory.setEnabled(next)
      if (mountedRef.current) setEnabled(next)
    } catch (e) {
      console.error(e)
    }
  }, [enabled])

  const handleDelete = useCallback(
    async (file: MemoryFile) => {
      if (file.name === "MEMORY.md") return
      if (!confirm(`确定要删除记忆文件「${file.name}」吗？此操作不可撤销。`)) return
      try {
        await window.api.memory.deleteFile(file.name)
        if (selectedFile?.name === file.name) setSelectedFile(null)
        await loadData()
      } catch (e) {
        console.error(e)
      }
    },
    [selectedFile, loadData]
  )

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Memory</h2>
            <button
              className={cn(
                "text-xs px-2 py-0.5 rounded-full border transition-colors",
                enabled
                  ? "bg-green-500/10 border-green-500/30 text-green-500"
                  : "bg-muted border-border text-muted-foreground"
              )}
              onClick={handleToggleEnabled}
            >
              {enabled ? "已启用" : "已禁用"}
            </button>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span>记忆系统会自动总结对话并在后续会话中回忆</span>
          </div>
          {stats && (
            <div className="flex items-center gap-3 px-2 text-[10px] text-muted-foreground">
              <span>{stats.fileCount} 个文件</span>
              <span>{formatSize(stats.totalSize)}</span>
              <span>索引 {formatSize(stats.indexSize)}</span>
            </div>
          )}
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-3">
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Brain className="size-8 opacity-40 mb-2" />
                <p className="text-xs">暂无记忆文件</p>
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
                记忆系统让 AI 拥有长期记忆能力。每次对话结束后，AI
                会自动总结关键信息并保存为记忆文件，在后续对话中自动回忆相关内容，从而提供更连贯、更个性化的服务。
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">记忆如何工作？</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  每次对话结束时，AI
                  会自动提取对话中的关键信息——比如你的偏好、项目背景、决策的「为什么」——并按
                  <span className="font-medium text-foreground/60">类型分类</span>
                  保存为单独的事实文件（user / feedback / project / reference）。下次对话时，AI
                  会自动检索相关记忆，并参考 MEMORY.md 索引。
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
                    <span className="font-medium text-foreground/60">MEMORY.md</span>{" "}
                    是 LLM 维护的索引，每次对话都会注入到系统提示词
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">3.</span>
                    你可以手动删除不准确或不再需要的记忆条目
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">4.</span>
                    通过顶部开关可随时启用或禁用记忆功能
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">隐私与控制</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  所有记忆数据完全存储在本地，不会上传到任何服务器。你对记忆拥有完全控制权，可以随时查看、编辑或删除任何记忆内容，也可以一键关闭整个记忆功能。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
