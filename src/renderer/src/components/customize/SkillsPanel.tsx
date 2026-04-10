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
    onDelete,
    hideActions = false
  } = props

  if (!skill) {
    return (
      <div
        className="flex-1 flex items-center justify-center overflow-y-auto p-8 select-none"
        onCopy={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "c") {
            e.preventDefault()
          }
        }}
      >
        <div className="max-w-md space-y-6">
          <div className="text-center space-y-3">
            <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
              <Sparkles className="size-7 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground/80">Skills 技能</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              技能是可复用的 AI 提示词模板，让 AI
              按照预设的指令和步骤完成特定任务。应用内置了一些常用技能，你也可以上传自定义技能来扩展
              AI 的工作流。
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">技能的结构</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                每个技能是一个文件夹，核心是{" "}
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">SKILL.md</span>{" "}
                文件，用来定义 AI 的行为指令——任务目标、执行步骤、输出格式等。技能分为
                <span className="font-medium text-foreground/60">内置技能</span>（随应用提供）和
                <span className="font-medium text-foreground/60">自定义技能</span>
                （用户上传），内置技能不可删除，自定义技能可随时管理。
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">如何添加和使用？</p>
              <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">1.</span>
                  <span>
                    点击 <span className="font-medium text-foreground/60">+</span> 按钮，支持上传
                    .md 或 .zip 格式的技能文件
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">2.</span>
                  <span>上传后可在右侧预览文件内容，支持渲染和源码切换</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-foreground/40 shrink-0">3.</span>
                  <span>通过开关可随时启用或禁用某个技能</span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">适用场景</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                代码审查、文档生成、Bug 分析、数据处理、翻译润色……任何你需要 AI
                反复执行的任务，都可以封装成技能来提升效率。你还可以从 Market 中下载大家分享的技能。
              </p>
            </div>
          </div>
        </div>
      </div>
    )
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
