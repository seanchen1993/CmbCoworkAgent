import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Plus,
  Power,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { SkillMetadata } from "@/types"

type FilePreviewKind = "text" | "html" | "image" | "pdf"
type FileTreeNode = {
  id: string
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
}

function UploadSkillDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess } = props
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."))
      if (ext !== ".md" && ext !== ".zip") {
        setError("仅支持 .md 或 .zip 文件")
        return
      }
      if (typeof window.api?.skills?.upload !== "function") {
        setError("上传功能不可用，请重启应用后重试")
        return
      }
      setError(null)
      setUploading(true)
      try {
        const buffer = await file.arrayBuffer()
        const res = await window.api.skills.upload(buffer, file.name)
        if (res.success) {
          onSuccess()
          onOpenChange(false)
        } else {
          setError(res.error || "上传失败")
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error")
      } finally {
        setUploading(false)
      }
    },
    [onOpenChange, onSuccess]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback(() => setDragOver(false), [])

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFile(file)
      e.target.value = ""
    },
    [handleFile]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传技能</DialogTitle>
          <DialogDescription>
            .md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含 SKILL.md
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "mt-4 border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-muted-foreground/50",
            uploading && "pointer-events-none opacity-60"
          )}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => document.getElementById("upload-skill-input")?.click()}
        >
          <input
            id="upload-skill-input"
            type="file"
            accept=".md,.zip"
            className="hidden"
            onChange={onInputChange}
            disabled={uploading}
          />
          {uploading ? (
            <p className="text-sm text-muted-foreground">上传中...</p>
          ) : (
            <>
              <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">拖拽文件到此处，或点击选择</p>
            </>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

function getSkillDir(skillPath: string): string {
  const normalized = skillPath.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx >= 0 ? normalized.slice(0, idx) : normalized
}

function getRelativeFileName(skillPath: string, filePath: string): string {
  const skillDir = getSkillDir(skillPath).replace(/\\/g, "/")
  const normalizedFile = filePath.replace(/\\/g, "/")
  if (normalizedFile.startsWith(`${skillDir}/`)) {
    return normalizedFile.slice(skillDir.length + 1)
  }
  return normalizedFile
}

function createDirNode(id: string, name: string, path: string): FileTreeNode {
  return { id, name, path, isDir: true, children: [] }
}

function createFileNode(id: string, name: string, path: string): FileTreeNode {
  return { id, name, path, isDir: false, children: [] }
}

function sortTreeNodes(nodes: FileTreeNode[], isRoot: boolean): FileTreeNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (isRoot) {
      if (!a.isDir && a.name.toUpperCase() === "SKILL.MD") return -1
      if (!b.isDir && b.name.toUpperCase() === "SKILL.MD") return 1
      if (a.isDir && a.name.toLowerCase() === "templates") return -1
      if (b.isDir && b.name.toLowerCase() === "templates") return 1
    }
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const node of sorted) {
    if (node.isDir && node.children.length > 0) {
      node.children = sortTreeNodes(node.children, false)
    }
  }
  return sorted
}

function buildFileTree(skillPath: string, files: string[]): FileTreeNode[] {
  const root: FileTreeNode = createDirNode("root", "root", "")

  for (const filePath of files) {
    const relative = getRelativeFileName(skillPath, filePath)
    const segments = relative.split("/").filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const isLast = i === segments.length - 1
      const nodeId = `${current.id}/${segment}`
      let child = current.children.find((c) => c.name === segment)

      if (!child) {
        child = isLast
          ? createFileNode(nodeId, segment, filePath)
          : createDirNode(nodeId, segment, `${current.path}/${segment}`.replace(/^\/+/, "/"))
        current.children.push(child)
      }
      current = child
    }
  }

  return sortTreeNodes(root.children, true)
}

function defaultSkillFile(files: string[]): string | null {
  if (files.length === 0) return null
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f))
  return skillMd ?? files[0]
}

const SKILL_HOOK_TREE_EXAMPLE = `~/.cmbcoworkagent/skills/<skill-name>/
  SKILL.md
  hooks.json
  hooks/
    pre-write-check.py`

const SKILL_HOOK_JSON_EXAMPLE = `[
  {
    "event": "PreToolUse",
    "matcher": "write_file|edit_file",
    "type": "command",
    "command": "python C:/absolute/path/to/pre_write_guard.py",
    "timeout": 10000,
    "onBlock": {
      "systemMessage": "请先按技能要求整改，再重试",
      "requiredSkill": "<skill-name>"
    }
  }
]`

function SkillGuideSection(props: {
  title: string
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, summary, children } = props
  return (
    <details className="rounded-lg border border-border/60 bg-background">
      <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
          <span className="shrink-0 rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
            点击展开
          </span>
        </div>
      </summary>
      <div className="border-t border-border/50 p-4">{children}</div>
    </details>
  )
}

function SkillGuideSubSection(props: {
  title: string
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, summary, children } = props
  return (
    <details className="rounded-md border border-border/40 bg-muted/20">
      <summary className="cursor-pointer list-none px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
      </summary>
      <div className="border-t border-border/40 px-3 py-3">{children}</div>
    </details>
  )
}

function SkillsGuide(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-muted p-3">
            <Sparkles className="size-6 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold">技能介绍</h3>
            <p className="text-sm text-muted-foreground">
              技能是可复用的 AI
              提示词模板；如果某个技能需要配套拦截、校验或整改引导，也可以在技能目录里直接附带 Skill
              Hook。
            </p>
          </div>
        </div>

        <SkillGuideSection
          title="技能基础"
          summary="技能目录结构、上传方式，以及启用 / 禁用的基本行为。"
        >
          <div className="space-y-3">
            <SkillGuideSubSection
              title="技能目录长什么样"
              summary="每个技能本质上是一个目录，核心文件是 SKILL.md。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  技能的核心是
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  ，用来定义任务目标、执行步骤、输出要求等。
                </p>
                <p>
                  应用里会区分内置技能和自定义技能；内置技能不可删除，自定义技能可以上传、禁用和删除。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="如何添加和使用"
              summary="支持上传 .md 或 .zip，上传后可直接在右侧预览。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  点击左上角
                  <code className="mx-1 font-mono text-foreground/85">+</code>
                  可上传技能。
                </p>
                <p>上传后可以在左侧展开目录、右侧预览文件内容，也可以随时切换技能启用状态。</p>
                <p>禁用技能后，该技能本体和它附带的 Skill Hook 会一起失效。</p>
              </div>
            </SkillGuideSubSection>
          </div>
        </SkillGuideSection>

        <SkillGuideSection
          title="Skill Hook 配置说明"
          summary="把 hooks.json 放进技能目录后，技能启用时会自动加载对应 Hook。"
        >
          <div className="space-y-3">
            <SkillGuideSubSection
              title="Skill Hook 是什么"
              summary="适合把某个技能专属的拦截、校验和整改引导跟技能本体一起分发。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Skill Hook 会进入统一 Hook
                  执行链，但它的来源绑定在技能上：启用技能时加载，停用技能时同步移除。
                </p>
                <p>
                  常见用途包括写入前校验、完成前补充检查、阻断后自动附带
                  <code className="mx-1 font-mono text-foreground/85">requiredSkill</code>
                  整改指引。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="目录与加载规则"
              summary="在技能目录下新建 hooks.json；脚本本体建议放到 hooks/ 子目录。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5 text-foreground">
                  {SKILL_HOOK_TREE_EXAMPLE}
                </pre>
                <p>
                  只要目录里存在
                  <code className="mx-1 font-mono text-foreground/85">hooks.json</code>
                  ，启用技能时就会自动加载。
                </p>
                <p>
                  当前 Hook 命令实际按工作区
                  <code className="mx-1 font-mono text-foreground/85">cwd</code>
                  执行；如果脚本放在技能目录里，推荐在
                  <code className="mx-1 font-mono text-foreground/85">command</code>
                  里写绝对路径，避免随工作区变化找不到脚本。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="最小配置示例"
              summary="下面是一个最小的 skill-level PreToolUse command hook。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                  <code>{SKILL_HOOK_JSON_EXAMPLE}</code>
                </pre>
                <p>
                  如果要用自然语言策略 Hook，可以把
                  <code className="mx-1 font-mono text-foreground/85">type</code>
                  改成
                  <code className="mx-1 font-mono text-foreground/85">prompt</code>
                  ，再提供
                  <code className="mx-1 font-mono text-foreground/85">prompt</code>
                  字段。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="调试与验证"
              summary="看 Hook 执行记录、stderr 日志，以及去哪看完整事件协议。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  命令 Hook 的调试日志建议写到 stderr；如果 stdout 输出 JSON，会被当成 Hook
                  返回值解析。
                </p>
                <p>
                  技能 Hook 生效后，可以在聊天区的“Hook 执行记录”里看执行结果，也可以到“自定义 &gt;
                  钩子”查看统一的来源和配置详情。
                </p>
                <p>
                  完整的事件输入 / 输出协议、tool_input 字段和各类返回字段说明，请到“自定义 &gt;
                  钩子”右侧查看。
                </p>
              </div>
            </SkillGuideSubSection>
          </div>
        </SkillGuideSection>
      </div>
    </div>
  )
}

export function SkillsPanel(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [expandedDirNodes, setExpandedDirNodes] = useState<Set<string>>(new Set())
  const [skillFilesMap, setSkillFilesMap] = useState<Record<string, string[]>>({})
  const [selectedSkill, setSelectedSkill] = useState<SkillMetadata | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null)
  const [selectedFilePreviewKind, setSelectedFilePreviewKind] = useState<FilePreviewKind>("text")
  const [selectedBinaryBase64, setSelectedBinaryBase64] = useState<string | null>(null)
  const [selectedBinaryMimeType, setSelectedBinaryMimeType] = useState<string | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  useEffect(() => {
    return () => clearTimeout(debounceTimer.current)
  }, [])

  useEffect(() => {
    window.api.skills.list().then(setSkills).catch(console.error)
  }, [])

  useEffect(() => {
    window.api.skills
      .getDisabled()
      .then((list) => setDisabledSkills(new Set(list)))
      .catch(console.error)
  }, [])

  const skillFilesMapRef = useRef(skillFilesMap)
  skillFilesMapRef.current = skillFilesMap

  const expandedSkillsRef = useRef(expandedSkills)
  expandedSkillsRef.current = expandedSkills

  const loadFileContent = useCallback(async (skill: SkillMetadata, filePath: string) => {
    setSelectedSkill(skill)
    setSelectedFilePath(filePath)
    setSelectedFileContent(null)
    setSelectedBinaryBase64(null)
    setSelectedBinaryMimeType(null)

    const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
    const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)
    const isPdf = ext === "pdf"
    const isHtml = ext === "html" || ext === "htm"
    const knownTextExts = new Set([
      "md",
      "txt",
      "html",
      "htm",
      "css",
      "scss",
      "less",
      "js",
      "ts",
      "jsx",
      "tsx",
      "json",
      "yaml",
      "yml",
      "xml",
      "csv",
      "svg",
      "sh",
      "bash",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "c",
      "h",
      "cpp",
      "hpp",
      "sql",
      "graphql",
      "toml",
      "ini",
      "env",
      "log"
    ])
    const isKnownText = knownTextExts.has(ext)

    if (isImage || isPdf) {
      setSelectedFilePreviewKind(isImage ? "image" : "pdf")
      const binaryRes = await window.api.skills.readBinary(filePath)
      if (binaryRes.success && typeof binaryRes.content === "string") {
        setSelectedBinaryBase64(binaryRes.content)
        setSelectedBinaryMimeType(binaryRes.mimeType || (isImage ? "image/png" : "application/pdf"))
      } else {
        setSelectedFilePreviewKind("text")
        setSelectedFileContent(`Error: ${binaryRes.error || "Failed to read binary file"}`)
      }
      return
    }

    if (!isKnownText) {
      setSelectedFilePreviewKind("text")
      setSelectedFileContent(`此文件类型 (.${ext || "未知"}) 暂不支持预览，请使用其他工具打开。`)
      return
    }

    setSelectedFilePreviewKind(isHtml ? "html" : "text")
    const textRes = await window.api.skills.read(filePath)
    if (textRes.success && typeof textRes.content === "string") {
      setSelectedFileContent(textRes.content)
    } else {
      setSelectedFileContent(`Error: ${textRes.error || "Failed to read file"}`)
    }
  }, [])

  const ensureSkillFiles = useCallback(async (skill: SkillMetadata): Promise<string[]> => {
    const cachedFiles = skillFilesMapRef.current[skill.name]
    if (cachedFiles && cachedFiles.length > 0) return cachedFiles
    const res = await window.api.skills.listFiles(skill.path)
    const fallbackFiles = [skill.path]
    if (!res.success || !res.files || res.files.length === 0) {
      setSkillFilesMap((prev) => ({ ...prev, [skill.name]: fallbackFiles }))
      return fallbackFiles
    }
    const files = res.files
    setSkillFilesMap((prev) => ({ ...prev, [skill.name]: files }))
    return files
  }, [])

  const onToggleSkill = useCallback(
    async (skill: SkillMetadata) => {
      const wasExpanded = expandedSkillsRef.current.has(skill.name)
      const next = new Set<string>()
      if (!wasExpanded) next.add(skill.name)
      setExpandedSkills(next)

      if (!wasExpanded) {
        const files = await ensureSkillFiles(skill)
        const firstFile = defaultSkillFile(files)
        if (firstFile) {
          await loadFileContent(skill, firstFile)
        } else {
          setSelectedSkill(skill)
          setSelectedFilePath(null)
          setSelectedFileContent("该技能目录下没有可读取文件。")
        }
      }
    },
    [ensureSkillFiles, loadFileContent]
  )

  const onSelectFile = useCallback(
    async (skill: SkillMetadata, filePath: string) => {
      await loadFileContent(skill, filePath)
    },
    [loadFileContent]
  )

  const toggleDirNode = useCallback((nodeId: string) => {
    setExpandedDirNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const toggleSkillEnabled = useCallback((skillName: string) => {
    setDisabledSkills((prev) => {
      const next = new Set(prev)
      if (next.has(skillName)) next.delete(skillName)
      else next.add(skillName)
      window.api.skills.setDisabled([...next]).catch(console.error)
      return next
    })
  }, [])

  const handleDeleteSkill = useCallback(async (skill: SkillMetadata) => {
    if (!window.api?.skills?.delete) return
    if (!confirm(`确定要删除技能「${skill.name}」吗？`)) return
    const res = await window.api.skills.delete(skill.path)
    if (res.success) {
      setSelectedSkill(null)
      setSelectedFilePath(null)
      setSelectedFileContent(null)
      setSkillFilesMap((prev) => {
        const next = { ...prev }
        delete next[skill.name]
        return next
      })
      setDisabledSkills((prev) => {
        const next = new Set(prev)
        next.delete(skill.name)
        window.api.skills.setDisabled([...next]).catch(console.error)
        return next
      })
      window.api.skills.list().then(setSkills).catch(console.error)
    } else {
      alert(res.error || "删除失败")
    }
  }, [])

  const builtinSkills = useMemo(() => skills.filter((s) => s.source === "project"), [skills])
  const customSkills = useMemo(() => skills.filter((s) => s.source === "user"), [skills])

  const filterSkillsBySearch = useCallback(
    (list: SkillMetadata[]) => {
      const q = debouncedQuery.trim().toLowerCase()
      if (!q) return list
      return list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q) ?? false)
      )
    },
    [debouncedQuery]
  )

  const filteredBuiltin = useMemo(
    () => filterSkillsBySearch(builtinSkills),
    [builtinSkills, filterSkillsBySearch]
  )
  const filteredCustom = useMemo(
    () => filterSkillsBySearch(customSkills),
    [customSkills, filterSkillsBySearch]
  )

  return (
    <div className="contents">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Skills</h2>
            <div className="flex items-center gap-1">
              <div className="relative flex-1 min-w-[120px] max-w-[160px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="搜索"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="h-7 pl-7 pr-6 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                    onClick={() => {
                      setSearchQuery("")
                      setDebouncedQuery("")
                    }}
                    aria-label="清���"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => setUploadDialogOpen(true)}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-3">
            <SkillSection
              title="内置技能"
              skills={filteredBuiltin}
              expandedSkills={expandedSkills}
              skillFilesMap={skillFilesMap}
              selectedSkill={selectedSkill}
              selectedFilePath={selectedFilePath}
              expandedDirNodes={expandedDirNodes}
              disabledSkills={disabledSkills}
              onToggleSkill={onToggleSkill}
              onToggleDirNode={toggleDirNode}
              onSelectFile={onSelectFile}
            />
            {customSkills.length > 0 && (
              <SkillSection
                title="我安装的技能"
                skills={filteredCustom}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                selectedFilePath={selectedFilePath}
                expandedDirNodes={expandedDirNodes}
                disabledSkills={disabledSkills}
                onToggleSkill={onToggleSkill}
                onToggleDirNode={toggleDirNode}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        </ScrollArea>
      </div>

      <SkillDetail
        skill={selectedSkill}
        selectedFilePath={selectedFilePath}
        content={selectedFileContent}
        previewKind={selectedFilePreviewKind}
        binaryBase64={selectedBinaryBase64}
        binaryMimeType={selectedBinaryMimeType}
        isDisabled={selectedSkill ? disabledSkills.has(selectedSkill.name) : false}
        onToggleEnabled={() => {
          if (selectedSkill) toggleSkillEnabled(selectedSkill.name)
        }}
        onShowGuide={() => {
          setSelectedSkill(null)
          setSelectedFilePath(null)
          setSelectedFileContent(null)
          setSelectedBinaryBase64(null)
          setSelectedBinaryMimeType(null)
        }}
        onDelete={
          selectedSkill?.source === "user" ? () => handleDeleteSkill(selectedSkill) : undefined
        }
      />

      <UploadSkillDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onSuccess={() => {
          setSkillFilesMap({})
          window.api.skills.list().then(setSkills).catch(console.error)
        }}
      />
    </div>
  )
}

function SkillSection(props: {
  title: string
  skills: SkillMetadata[]
  expandedSkills: Set<string>
  skillFilesMap: Record<string, string[]>
  selectedSkill: SkillMetadata | null
  selectedFilePath: string | null
  expandedDirNodes: Set<string>
  disabledSkills: Set<string>
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    title,
    skills,
    expandedSkills,
    skillFilesMap,
    selectedSkill,
    selectedFilePath,
    expandedDirNodes,
    disabledSkills,
    onToggleSkill,
    onToggleDirNode,
    onSelectFile
  } = props
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div>
      <button
        className="flex items-center justify-between w-full px-1 mb-1 group cursor-pointer"
        onClick={() => setCollapsed((v) => !v)}
      >
        <div className="flex items-center gap-1">
          {collapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
            {title}
          </span>
        </div>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5">
          {skills.length}
        </Badge>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {skills.length === 0 ? (
            <p className="text-xs text-muted-foreground px-1 py-2">没有匹配的技能</p>
          ) : (
            skills.map((skill) => {
              const expanded = expandedSkills.has(skill.name)
              const files = skillFilesMap[skill.name] || []
              const selected = selectedSkill?.name === skill.name
              const disabled = disabledSkills.has(skill.name)

              return (
                <SkillItem
                  key={skill.name}
                  skill={skill}
                  expanded={expanded}
                  selected={selected}
                  disabled={disabled}
                  files={files}
                  selectedFilePath={selectedFilePath}
                  expandedDirNodes={expandedDirNodes}
                  onToggleSkill={onToggleSkill}
                  onToggleDirNode={onToggleDirNode}
                  onSelectFile={onSelectFile}
                />
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

function SkillItem(props: {
  skill: SkillMetadata
  expanded: boolean
  selected: boolean
  disabled: boolean
  files: string[]
  selectedFilePath: string | null
  expandedDirNodes: Set<string>
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    skill,
    expanded,
    selected,
    disabled,
    files,
    selectedFilePath,
    expandedDirNodes,
    onToggleSkill,
    onToggleDirNode,
    onSelectFile
  } = props

  const treeNodes = useMemo(
    () => (expanded && files.length > 0 ? buildFileTree(skill.path, files) : []),
    [expanded, files, skill.path]
  )

  return (
    <div className="rounded-md border border-border/70 overflow-hidden">
      <button
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors",
          selected ? "bg-muted/70" : "hover:bg-muted/50"
        )}
        onClick={() => onToggleSkill(skill)}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <Folder className="size-3.5 text-muted-foreground shrink-0" />
        <span
          className={cn(
            "text-sm truncate flex-1",
            disabled && "text-muted-foreground line-through"
          )}
        >
          {skill.name}
        </span>
        <Sparkles
          className={cn(
            "size-3 shrink-0",
            disabled ? "text-muted-foreground/40" : "text-amber-500"
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/60 bg-muted/20">
          {treeNodes.length > 0 ? (
            <SkillFileTree
              nodes={treeNodes}
              level={0}
              skill={skill}
              selectedFilePath={selectedFilePath}
              expandedDirNodes={expandedDirNodes}
              onToggleDirNode={onToggleDirNode}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div className="pl-7 pr-2 py-1.5 text-xs text-muted-foreground">没有文件</div>
          )}
        </div>
      )}
    </div>
  )
}

function SkillFileTree(props: {
  nodes: FileTreeNode[]
  level: number
  skill: SkillMetadata
  selectedFilePath: string | null
  expandedDirNodes: Set<string>
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const { nodes, level, skill, selectedFilePath, expandedDirNodes, onToggleDirNode, onSelectFile } =
    props

  return (
    <div>
      {nodes.map((node) => {
        if (node.isDir) {
          const isExpanded = expandedDirNodes.has(node.id)
          return (
            <div key={node.id}>
              <button
                className="w-full flex items-center gap-2 pr-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40"
                style={{ paddingLeft: `${28 + level * 16}px` }}
                onClick={() => onToggleDirNode(node.id)}
              >
                {isExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{node.name}</span>
              </button>
              {isExpanded && (
                <SkillFileTree
                  nodes={node.children}
                  level={level + 1}
                  skill={skill}
                  selectedFilePath={selectedFilePath}
                  expandedDirNodes={expandedDirNodes}
                  onToggleDirNode={onToggleDirNode}
                  onSelectFile={onSelectFile}
                />
              )}
            </div>
          )
        }

        const activeFile = selectedFilePath === node.path
        return (
          <button
            key={node.id}
            className={cn(
              "w-full flex items-center gap-2 pr-2 py-1.5 text-left text-xs transition-colors",
              activeFile ? "bg-muted" : "hover:bg-muted/50"
            )}
            style={{ paddingLeft: `${28 + level * 16}px` }}
            onClick={() => onSelectFile(skill, node.path)}
          >
            <FileText className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}</span>
          </button>
        )
      })}
    </div>
  )
}

export function SkillDetail(props: {
  skill: SkillMetadata | null
  selectedFilePath: string | null
  content: string | null
  previewKind: FilePreviewKind
  binaryBase64: string | null
  binaryMimeType: string | null
  isDisabled: boolean
  onToggleEnabled: () => void
  onShowGuide?: () => void
  onDelete?: () => void
  hideActions?: boolean
}): React.JSX.Element {
  const {
    skill,
    selectedFilePath,
    content,
    previewKind,
    binaryBase64,
    binaryMimeType,
    isDisabled,
    onToggleEnabled,
    onShowGuide,
    onDelete,
    hideActions = false
  } = props

  if (!skill) {
    return <SkillsGuide />
  }

  const description = skill.description || "暂无描述"
  const isMarkdown = !!selectedFilePath && /\.md$/i.test(selectedFilePath)
  const hasFrontmatter = isMarkdown && !!content && content.startsWith("---")
  const frontmatterEnd = hasFrontmatter ? content.indexOf("---", 3) : -1
  const previewContent =
    hasFrontmatter && frontmatterEnd > 0
      ? content.slice(content.indexOf("\n", frontmatterEnd) + 1).trim()
      : content
  const binaryDataUrl =
    binaryBase64 && binaryMimeType ? `data:${binaryMimeType};base64,${binaryBase64}` : null
  const isLoading = !!selectedFilePath && content === null && binaryBase64 === null

  return (
    <div
      className="flex-1 flex flex-col min-w-0 overflow-hidden select-none"
      onCopy={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "c") {
          e.preventDefault()
        }
      }}
    >
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold truncate">{skill.name}</h2>
          {/*<p className="text-xs text-muted-foreground mt-0.5 truncate">*/}
          {/*  {selectedFilePath ? selectedFilePath.replace(/\\/g, "/") : "未选择文件"}*/}
          {/*</p>*/}
        </div>
        {!hideActions && (
          <div className="flex items-center gap-1.5 shrink-0">
            {onShowGuide && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onShowGuide}>
                配置说明
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={onDelete}
              >
                <Trash2 className="size-3" />
                删除
              </Button>
            )}
            <Button
              variant={isDisabled ? "outline" : "default"}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={onToggleEnabled}
            >
              <Power className="size-3" />
              {isDisabled ? "已禁用" : "已启用"}
            </Button>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-b border-border">
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {description}
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : previewKind === "image" && binaryDataUrl ? (
            <div className="h-full w-full flex items-start justify-center">
              <img
                src={binaryDataUrl}
                alt={selectedFilePath ?? "image preview"}
                className="max-w-full h-auto rounded-md border border-border"
              />
            </div>
          ) : previewKind === "pdf" && binaryDataUrl ? (
            <div className="h-[80vh] min-h-[500px]">
              <iframe
                title={selectedFilePath ?? "pdf preview"}
                src={binaryDataUrl}
                className="h-full w-full rounded-md border border-border bg-white"
              />
            </div>
          ) : previewKind === "html" ? (
            <div className="h-[80vh] min-h-[500px] rounded-md border border-border overflow-hidden bg-white">
              <iframe
                title={selectedFilePath ?? "html preview"}
                srcDoc={content ?? ""}
                className="h-full w-full"
                sandbox=""
              />
            </div>
          ) : !isMarkdown ? (
            <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed text-muted-foreground bg-muted/30 rounded-md p-3">
              {content}
            </pre>
          ) : (
            <div className="streaming-markdown text-sm leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewContent ?? ""}</ReactMarkdown>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
