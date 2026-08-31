import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  FileText,
  Folder,
  GitBranch,
  Info,
  Loader2,
  Plus,
  Power,
  Radio,
  Search,
  Sparkles,
  Store,
  Trash2,
  Upload,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { SkillMetadata } from "@/types"
import { useAppStore } from "@/lib/store"
import { getSkillMetadataId, isSkillDisabled, normalizeSkillId } from "@/lib/skill-ids"
import {
  invalidateSkillCatalog,
  readSkillCatalogCache,
  revalidateSkillCatalog,
  subscribeSkillCatalogInvalidation
} from "@/lib/app-catalog-cache"
import { SkillDisabledMutationCoordinator } from "@/lib/skill-disabled-mutation-coordinator"
import { SKILL_PLUGIN_CATALOG_RENDER_BATCH } from "@/lib/skill-plugin-catalog"
import { marketApi, type MarketItem } from "../../api/market"
import { DEFAULT_SCENE_CATEGORY } from "../../lib/skill-data-service"
import { SkillFileEditor } from "./SkillFileEditor"
import { UniversalUploadDialog } from "./MarketPanel/UniversalUploadDialog"
import { toast } from "sonner"
import { marketInstalledVersionStorage } from "./MarketPanel/MarketUpdateBadge"
import { marketInstalledSourceStorage } from "./MarketPanel/market-installed-source-storage"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

type FilePreviewKind = "text" | "html" | "image" | "pdf"
type SkillCatalogLoadState = "loading" | "ready" | "error"
const recoveredEmptySkillCatalogKeys = new Set<string>()
type FileTreeNode = {
  id: string
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
}
type SkillTreeNode = {
  key: string
  label: string
  skill?: SkillMetadata
  children: SkillTreeNode[]
}

type SkillMarketInfo = Pick<
  MarketItem,
  | "name"
  | "chinese_name"
  | "category"
  | "description"
  | "featured"
  | "guidance"
  | "user_id"
  | "version"
>
type SaveSkillFileResult = { success: boolean; error?: string }
type PublishMode = "upload" | "update"
type PublishSuccessPayload = { skillName: string; mode: PublishMode }
type UploadedItemRecord = {
  name: string
  type: "skill" | "mcp" | "plugin"
  uploadedAt?: string
}
type LocalUploadedSkillPathRecord = {
  path: string
  uploadedAt?: string
}
type EditedSkillPathRecord = {
  path: string
  editedAt?: string
}

const KNOWN_TEXT_EXTS = new Set([
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
const UPLOADED_ITEMS_KEY = "marketplace_uploaded_items"
const LOCAL_UPLOADED_SKILL_PATHS_KEY = "skills_panel_uploaded_skill_paths"
const EDITED_SKILL_PATHS_KEY = "skills_panel_edited_skill_paths"
const DEFAULT_SKILL_VERSION = "v1.0.0"

/**
 * 统一路径 Key，保证在 Windows/Linux 下本地标记可稳定命中：
 * - 分隔符统一为 `/`
 * - 比较统一转小写（Windows 大小写不敏感场景更稳妥）
 */
function normalizeSkillPathKey(skillPath: string): string {
  return String(skillPath || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase()
}

/**
 * 统一目录名 Key，用于把 upload 返回的目录名与 skills.list() 结果做匹配。
 */
function normalizeDirNameKey(dirName: string): string {
  return (
    String(dirName || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.trim()
      .toLowerCase() || ""
  )
}

/**
 * 从本地缓存读取“我发布过的 skill 名称集合”。
 * 这里不依赖服务端字段，沿用 Market 面板的本地标记逻辑，避免破坏现有数据口径。
 */
function readUploadedSkillNamesFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(UPLOADED_ITEMS_KEY)
    const parsed: UploadedItemRecord[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()

    const names = new Set<string>()
    for (const item of parsed) {
      if (!item || item.type !== "skill") continue
      const normalized = normalizeSkillName(item.name)
      if (normalized) names.add(normalized)
    }
    return names
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to read uploaded items from localStorage:", storageError)
    return new Set()
  }
}

/**
 * 统一写入“我发布过”的本地标记：
 * - 同名记录先去重再写入，避免历史重复项导致判断抖动；
 * - 时间戳保留，后续可用于按最近发布排序等扩展。
 */
function markUploadedSkillInStorage(skillName: string): void {
  try {
    const raw = localStorage.getItem(UPLOADED_ITEMS_KEY)
    const parsed: UploadedItemRecord[] = raw ? JSON.parse(raw) : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => !(item?.name === skillName && item?.type === "skill"))
    next.push({ name: skillName, type: "skill", uploadedAt: new Date().toISOString() })
    localStorage.setItem(UPLOADED_ITEMS_KEY, JSON.stringify(next))
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to mark uploaded skill in localStorage:", storageError)
  }
}

function readOrgInstalledSkillNamesFromStorage(): Set<string> {
  const names = new Set<string>()

  for (const name of marketInstalledSourceStorage.getNames("orgSkill")) {
    const normalized = normalizeSkillName(name)
    if (normalized) names.add(normalized)
  }

  const versionRecords = marketInstalledVersionStorage.getRecords().orgSkill || {}
  for (const name of Object.keys(versionRecords)) {
    const normalized = normalizeSkillName(name)
    if (normalized) names.add(normalized)
  }

  return names
}

/**
 * 读取“通过 SkillsPanel 上传过”的技能路径集合。
 * 该集合用于判定：这是“我自己上传”的技能，而不是从市场安装来的技能。
 */
function readLocalUploadedSkillPathSetFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LOCAL_UPLOADED_SKILL_PATHS_KEY)
    const parsed: LocalUploadedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()

    const paths = new Set<string>()
    for (const item of parsed) {
      if (!item?.path) continue
      paths.add(normalizeSkillPathKey(item.path))
    }
    return paths
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to read local uploaded skill paths:", storageError)
    return new Set()
  }
}

/**
 * 记录“该技能是从 SkillsPanel 上传”的来源标记。
 */
function markLocalUploadedSkillPathInStorage(skillPath: string): void {
  try {
    const keyPath = normalizeSkillPathKey(skillPath)
    if (!keyPath) return
    const raw = localStorage.getItem(LOCAL_UPLOADED_SKILL_PATHS_KEY)
    const parsed: LocalUploadedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => normalizeSkillPathKey(item?.path || "") !== keyPath)
    next.push({ path: skillPath, uploadedAt: new Date().toISOString() })
    localStorage.setItem(LOCAL_UPLOADED_SKILL_PATHS_KEY, JSON.stringify(next))
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to mark local uploaded skill path:", storageError)
  }
}

/**
 * 删除技能时同步移除本地上传来源标记，防止脏数据累积。
 */
function removeLocalUploadedSkillPathFromStorage(skillPath: string): void {
  try {
    const keyPath = normalizeSkillPathKey(skillPath)
    const raw = localStorage.getItem(LOCAL_UPLOADED_SKILL_PATHS_KEY)
    const parsed: LocalUploadedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => normalizeSkillPathKey(item?.path || "") !== keyPath)
    localStorage.setItem(LOCAL_UPLOADED_SKILL_PATHS_KEY, JSON.stringify(next))
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to remove local uploaded skill path:", storageError)
  }
}

/**
 * 读取“已编辑技能”的路径集合，用于在 UI 中展示“已编辑”标识。
 */
function readEditedSkillPathSetFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(EDITED_SKILL_PATHS_KEY)
    const parsed: EditedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    const paths = new Set<string>()
    for (const item of parsed) {
      if (!item?.path) continue
      paths.add(normalizeSkillPathKey(item.path))
    }
    return paths
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to read edited skill paths:", storageError)
    return new Set()
  }
}

/**
 * 保存“已编辑技能”标记。
 */
function markEditedSkillPathInStorage(skillPath: string): void {
  try {
    const keyPath = normalizeSkillPathKey(skillPath)
    if (!keyPath) return
    const raw = localStorage.getItem(EDITED_SKILL_PATHS_KEY)
    const parsed: EditedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => normalizeSkillPathKey(item?.path || "") !== keyPath)
    next.push({ path: skillPath, editedAt: new Date().toISOString() })
    localStorage.setItem(EDITED_SKILL_PATHS_KEY, JSON.stringify(next))
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to mark edited skill path:", storageError)
  }
}

/**
 * 删除技能时清理“已编辑技能”标记。
 */
function removeEditedSkillPathFromStorage(skillPath: string): void {
  try {
    const keyPath = normalizeSkillPathKey(skillPath)
    const raw = localStorage.getItem(EDITED_SKILL_PATHS_KEY)
    const parsed: EditedSkillPathRecord[] = raw ? JSON.parse(raw) : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => normalizeSkillPathKey(item?.path || "") !== keyPath)
    localStorage.setItem(EDITED_SKILL_PATHS_KEY, JSON.stringify(next))
  } catch (storageError) {
    console.warn("[SkillsPanel] Failed to remove edited skill path:", storageError)
  }
}

function normalizeSkillName(value?: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
}

function getSkillChineseName(
  skill: SkillMetadata,
  marketInfo: SkillMarketInfo | undefined
): string {
  const marketChinese = marketInfo?.chinese_name?.trim()
  if (marketChinese) return marketChinese
  const metadataChinese = skill.metadata?.chinese_name?.trim()
  return metadataChinese || ""
}

function getSkillCategory(skill: SkillMetadata, marketInfo: SkillMarketInfo | undefined): string {
  const marketCategory = marketInfo?.category?.trim()
  if (marketCategory) return marketCategory
  const metadataCategory = skill.metadata?.category?.trim()
  return metadataCategory || ""
}

function isFeaturedSkill(marketInfo: SkillMarketInfo | undefined): boolean {
  return marketInfo?.featured === "精品"
}

function splitMarkdownFrontmatter(
  filePath: string | null,
  content: string | null
): { protectedPrefix: string; editableContent: string; hasFrontmatter: boolean } {
  const isMarkdown = !!filePath && /\.md$/i.test(filePath)
  if (!isMarkdown || typeof content !== "string") {
    return { protectedPrefix: "", editableContent: content ?? "", hasFrontmatter: false }
  }

  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { protectedPrefix: "", editableContent: content, hasFrontmatter: false }

  return {
    protectedPrefix: match[0],
    editableContent: content.slice(match[0].length),
    hasFrontmatter: true
  }
}

function mergeMarkdownFrontmatter(protectedPrefix: string, editableContent: string): string {
  if (!protectedPrefix) return editableContent
  if (!editableContent || protectedPrefix.endsWith("\n") || protectedPrefix.endsWith("\r\n")) {
    return `${protectedPrefix}${editableContent}`
  }
  return `${protectedPrefix}\n${editableContent}`
}

function buildNestedNameConflictConfirmMessage(
  conflicts: Array<{ name: string; relativePath: string }>
): string {
  const preview =
    conflicts.length <= 5
      ? conflicts.map((item) => `${item.name}（${item.relativePath}）`).join("、")
      : `${conflicts
          .slice(0, 5)
          .map((item) => `${item.name}（${item.relativePath}）`)
          .join("、")} 等`
  return `导入会引入 ${conflicts.length} 个与现有 skill 同名的子技能：${preview}，是否继续？\n\n继续后面板中可能出现同名技能，可通过目录层级区分。`
}

function UploadSkillDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (uploadedSkillDirName?: string) => void
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
        let res = await window.api.skills.upload(buffer, file.name)
        if (!res.success && res.nestedNameConflicts?.length) {
          const shouldContinue = window.confirm(
            buildNestedNameConflictConfirmMessage(res.nestedNameConflicts)
          )
          if (!shouldContinue) {
            setError("已取消导入")
            return
          }
          res = await window.api.skills.upload(buffer, file.name, {
            allowNestedNameDuplicates: true
          })
        }
        if (res.success) {
          onSuccess(res.skillName)
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
            .md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含
            SKILL.md，可包含嵌套子技能
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

function PublishSkillDialog(props: {
  open: boolean
  skill: SkillMetadata | null
  mode: PublishMode
  marketInfo?: SkillMarketInfo
  onOpenChange: (open: boolean) => void
  onSuccess: (payload: PublishSuccessPayload) => void
}): React.JSX.Element {
  const { open, skill, mode, marketInfo, onOpenChange, onSuccess } = props
  if (!skill) return <></>

  const buildMarketFile = async (): Promise<{ success: boolean; file?: File; error?: string }> => {
    try {
      const includeNestedSkills = await resolveNestedSkillExportChoice(skill)
      const exported = await window.api.skills.exportForMarket(skill.path, { includeNestedSkills })
      if (!exported.success || !exported.buffer) {
        return { success: false, error: exported.error || "导出技能失败" }
      }

      const fileName = exported.fileName || `${skill.name}.zip`
      return {
        success: true,
        file: new File([exported.buffer], fileName, { type: "application/zip" })
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "导出技能失败" }
    }
  }

  return (
    <UniversalUploadDialog
      open={open}
      onOpenChange={onOpenChange}
      onSuccess={() => {
        markUploadedSkillInStorage(skill.name)
        onSuccess({ skillName: skill.name, mode })
      }}
      resourceType="skill"
      isUpdate={mode === "update"}
      existingItem={{
        name: skill.name,
        description: skill.description || marketInfo?.description || "",
        category: getSkillCategory(skill, marketInfo) || DEFAULT_SCENE_CATEGORY,
        version: skill.version || marketInfo?.version || undefined,
        guidance: skill.metadata?.guidance || marketInfo?.guidance || "",
        chinese_name: getSkillChineseName(skill, marketInfo),
        user_id: marketInfo?.user_id
      }}
      generatedFile={{
        label: "将自动打包当前技能目录为 zip 并上传",
        build: buildMarketFile
      }}
      lockName
      titleOverride={mode === "update" ? "更新市场技能" : "发布到公共市场"}
      descriptionOverride="会自动打包当前技能目录为 zip 并提交到 Market。若包含嵌套子技能，发布前会询问是否一并上传。"
      submitLabel={mode === "update" ? "更新发布" : "一键发布"}
      submittingLabel={mode === "update" ? "更新中..." : "发布中..."}
      onUpload={(file, name, description, category, version, guidance, chineseName, userId) => {
        if (mode === "update") {
          return marketApi.updateItem(
            file,
            "skill",
            name,
            description,
            category,
            version,
            guidance || undefined,
            chineseName || undefined,
            userId || undefined
          )
        }
        if (!file) return Promise.resolve({ success: false, error: "导出技能失败" })
        return marketApi.uploadFile(
          file,
          "skill",
          name,
          description,
          category,
          version,
          guidance || undefined,
          chineseName || undefined,
          userId || undefined
        )
      }}
    />
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

function getNestedChildSkillRoots(skillPath: string, files: string[]): string[] {
  const roots = new Set<string>()
  for (const filePath of files) {
    const relative = getRelativeFileName(skillPath, filePath).replace(/\\/g, "/")
    if (!/(^|\/)SKILL\.md$/i.test(relative)) continue
    if (relative.toUpperCase() === "SKILL.MD") continue
    const root = relative.replace(/\/SKILL\.md$/i, "")
    if (root) roots.add(root)
  }
  return [...roots].sort((a, b) => a.localeCompare(b))
}

async function resolveNestedSkillExportChoice(skill: SkillMetadata): Promise<boolean> {
  const res = await window.api.skills.listFiles(skill.path)
  if (!res.success) {
    throw new Error(res.error || "检测子技能失败")
  }
  const nestedSkillRoots = getNestedChildSkillRoots(skill.path, res.files || [])
  if (nestedSkillRoots.length === 0) return true

  const preview =
    nestedSkillRoots.length <= 5
      ? nestedSkillRoots.join("、")
      : `${nestedSkillRoots.slice(0, 5).join("、")} 等`
  return window.confirm(
    `这个 skill 下包含 ${nestedSkillRoots.length} 个子技能（${preview}），是否一并上传？\n\n点击“确定”一并上传，点击“取消”仅上传当前 skill。`
  )
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
  /**
   * 性能优化：
   * 旧实现每层目录都用 `children.find` 线性查找，文件较多时会退化到 O(n^2)。
   * 这里用 WeakMap 缓存“目录节点 -> 子节点索引”，将查找降为近似 O(1)。
   */
  const childIndexCache = new WeakMap<FileTreeNode, Map<string, FileTreeNode>>()

  const getChildIndex = (node: FileTreeNode): Map<string, FileTreeNode> => {
    let index = childIndexCache.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [child.name, child]))
      childIndexCache.set(node, index)
    }
    return index
  }

  for (const filePath of files) {
    const relative = getRelativeFileName(skillPath, filePath)
    const segments = relative.split("/").filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const isLast = i === segments.length - 1
      const nodeId = `${current.id}/${segment}`
      const childIndex = getChildIndex(current)
      let child = childIndex.get(segment)

      if (!child) {
        child = isLast
          ? createFileNode(nodeId, segment, filePath)
          : createDirNode(nodeId, segment, `${current.path}/${segment}`.replace(/^\/+/, "/"))
        current.children.push(child)
        childIndex.set(segment, child)
      }
      current = child
    }
  }

  return sortTreeNodes(root.children, true)
}

function getSkillTreePath(skill: SkillMetadata): string {
  const id = skill.id?.startsWith("plugin:") ? skill.id.split("/").slice(1).join("/") : skill.id
  return String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
}

function buildSkillTree(skills: SkillMetadata[]): SkillTreeNode[] {
  const root: SkillTreeNode = { key: "root", label: "root", children: [] }
  const indexByNode = new WeakMap<SkillTreeNode, Map<string, SkillTreeNode>>()

  const getIndex = (node: SkillTreeNode): Map<string, SkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [normalizeSkillId(child.label), child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (const skill of skills) {
    const segments = getSkillTreePath(skill).split("/").filter(Boolean)
    const fallbackSegments = segments.length > 0 ? segments : [skill.name]
    let current = root

    for (const segment of fallbackSegments) {
      const key = `${current.key}/${normalizeSkillId(segment)}`
      const childIndex = getIndex(current)
      let child = childIndex.get(normalizeSkillId(segment))
      if (!child) {
        child = { key, label: segment, children: [] }
        current.children.push(child)
        childIndex.set(normalizeSkillId(segment), child)
      }
      current = child
    }

    current.skill = skill
  }

  const sortNodes = (nodes: SkillTreeNode[]): SkillTreeNode[] =>
    [...nodes]
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
      .map((node) => ({ ...node, children: sortNodes(node.children) }))

  return sortNodes(root.children)
}

function countSkillTreeSkills(node: SkillTreeNode): number {
  return (
    (node.skill ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countSkillTreeSkills(child), 0)
  )
}

function splitSkillsByEnabled(
  skills: SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>
): { enabled: SkillMetadata[]; disabled: SkillMetadata[] } {
  const enabled: SkillMetadata[] = []
  const disabled: SkillMetadata[] = []

  for (const skill of skills) {
    if (isSkillDisabled(skill, disabledSkillIds)) {
      disabled.push(skill)
    } else {
      enabled.push(skill)
    }
  }

  return { enabled, disabled }
}

function defaultSkillFile(files: string[]): string | null {
  if (files.length === 0) return null
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f))
  return skillMd ?? files[0]
}

const SKILL_HOOK_TREE_EXAMPLE = `~/.cmbcoworkagent/skills/<skill-name>/
  SKILL.md
  hooks/
    hooks.json
    pre-write-check.py`

const SKILL_NESTED_TREE_EXAMPLE = `~/.cmbcoworkagent/skills/office/
  SKILL.md
  hooks/
    hooks.json
  pdf/
    SKILL.md
    hooks/
      hooks.json
  sheets/
    SKILL.md`

const SKILL_HOOK_JSON_EXAMPLE = `[
  {
    "event": "PreToolUse",
    "matcher": "write_file|edit_file",
    "type": "command",
    "command": "python hooks/pre_write_guard.py",
    "timeout": 10000,
    "persistAfterInterrupt": true,
    "onBlock": {
      "systemMessage": "请先按技能要求整改，再重试",
      "requiredSkill": "<skill-name>"
    }
  },
  {
    "event": "PostSkillUse",
    "matcher": "<skill-name>",
    "type": "command",
    "command": "python hooks/post_skill_audit.py",
    "forcedOutcome": "always-halt",
    "forcedReason": "技能使用结果命中策略，直接终止本轮"
  }
]`

// Claude Code 嵌套格式：按事件名分组，每组多个 matcher，每个 matcher 又可挂多个 hook。
// timeout 单位是秒（运行时自动 ×1000 转毫秒）。
const SKILL_HOOK_CC_EXAMPLE = `{
  "PreToolUse": [
    {
      "matcher": "write_file|edit_file",
      "hooks": [
        {
          "type": "command",
          "command": "python hooks/pre_write_guard.py",
          "timeout": 10,
          "persistAfterInterrupt": true
        }
      ]
    }
  ],
  "PostSkillUse": [
    {
      "matcher": "<skill-name>",
      "hooks": [
        {
          "type": "command",
          "command": "python hooks/post_skill_audit.py",
          "forcedOutcome": "always-halt",
          "forcedReason": "技能使用结果命中策略，直接终止本轮"
        }
      ]
    }
  ]
}`

const SKILL_HOOK_FRONTMATTER_EXAMPLE = `---
name: secret-policy
description: 处理敏感信息前必须使用。用户提到密钥、凭据、脱敏、审计或 secret 时使用。
hooks:
  PreToolUse:
    - matcher: write_file|edit_file
      hooks:
        - id: pre-write-check
          type: command
          command: python hooks/pre-write-check.py
          timeout: 10
          timeoutMs: 12000
          once: true
          persistAfterInterrupt: true
          onBlock:
            reason: 高风险写入，请先按技能流程处理
            requiredSkill: secret-policy
  PostSkillUse:
    - hooks:
        - id: post-skill-audit
          type: command
          command: python hooks/post-skill-audit.py
          forcedOutcome: always-revise
          forcedReason: 技能使用后需要补充审计结论
---

# Secret Policy

按敏感信息处理流程完成任务。`

const SKILL_HOOK_ENV_EXAMPLE = `const workspace = process.env.WORKSPACE_PATH
const skillRoot = process.env.SKILL_ROOT
const hookRoot = process.env.HOOK_SOURCE_ROOT
const toolArgs = process.env.TOOL_ARGS
  ? JSON.parse(process.env.TOOL_ARGS)
  : null`

const SKILL_HOOK_WINDOWS_ARG_EXAMPLE = `"command": "python hooks/check.py \\"%WORKSPACE_PATH%\\""`

const SKILL_HOOK_STDIN_EXAMPLE = `{
  "hook_event_name": "PreToolUse",
  "cwd": "~/.cmbcoworkagent/skills/<skill-name>",
  "tool_name": "write_file",
  "tool_input": { "path": "src/demo.ts" },
  "skill_name": "<skill-name>",
  "hook_source_type": "skill",
  "hook_source_root": "~/.cmbcoworkagent/skills/<skill-name>",
  "skill_root": "~/.cmbcoworkagent/skills/<skill-name>"
}`

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
          summary="技能目录结构、嵌套子技能、上传方式，以及启用 / 禁用的基本行为。"
        >
          <div className="space-y-3">
            <SkillGuideSubSection
              title="技能目录长什么样"
              summary="每个技能本质上是一个目录，核心文件是 SKILL.md；目录下也可以继续放子技能。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  技能的核心是
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  ，用来定义任务目标、执行步骤、输出要求等。
                </p>
                <p>
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  顶部可以带 YAML frontmatter；技能模块会从这里读取
                  <code className="mx-1 font-mono text-foreground/85">name</code>、
                  <code className="mx-1 font-mono text-foreground/85">description</code>
                  等元信息，也会加载
                  <code className="mx-1 font-mono text-foreground/85">hooks</code>
                  字段里的配套 Skill Hook。frontmatter
                  后面的正文仍是技能说明，会按正常技能内容读取。
                </p>
                <p>
                  如果某个 Skill Hook 需要在技能触发后于当前线程持续生效，可以在该 Hook 上加
                  <code className="mx-1 font-mono text-foreground/85">
                    persistAfterInterrupt: true
                  </code>
                  ；这个字段只对技能 / 插件 Hook 有意义，并且按 Hook 自己的身份持久化到线程。
                </p>
                <p>
                  一个技能目录下如果还有子目录包含
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  ，会被识别为独立的子技能；系统按目录路径区分父子技能和同名技能。
                </p>
                <p>
                  技能说明中提到的相对脚本、资源和模板路径，会按当前
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  所在目录解析；这只用于技能脚本定位，不会改变工作区 Hook 的
                  <code className="mx-1 font-mono text-foreground/85">WORKSPACE_PATH</code>。
                </p>
                <p>
                  应用里会区分内置技能和自定义技能；内置技能不可删除，自定义技能可以上传、禁用、编辑和删除。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="嵌套子技能"
              summary="适合把一个主题下的多个细分能力打包在同一个父目录里。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5 text-foreground">
                  {SKILL_NESTED_TREE_EXAMPLE}
                </pre>
                <p>
                  例如
                  <code className="mx-1 font-mono text-foreground/85">office</code>
                  可以作为父技能，下面的
                  <code className="mx-1 font-mono text-foreground/85">office/pdf</code>和
                  <code className="mx-1 font-mono text-foreground/85">office/sheets</code>
                  会作为独立子技能展示和匹配。
                </p>
                <p>
                  子技能可以拥有自己的
                  <code className="mx-1 font-mono text-foreground/85">hooks/hooks.json</code>
                  ；触发子技能时只激活它自己目录下的 Skill Hook，不会串到同名的其他技能。
                </p>
                <p>
                  父技能和子技能都支持
                  <code className="mx-1 font-mono text-foreground/85">persistAfterInterrupt</code>
                  ，是否在当前线程后续轮次继续命中由各自 Hook 自己决定。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="如何添加和使用"
              summary="支持上传 .md 或 .zip；zip 可以带父目录和嵌套子技能。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  点击左上角
                  <code className="mx-1 font-mono text-foreground/85">+</code>
                  可上传技能。
                </p>
                <p>
                  导入 zip 时会选择最外层的
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  作为主技能；如果包含子技能且子技能名称与已有技能重复，会先提示确认。
                </p>
                <p>上传后可以在左侧展开目录、右侧预览文件内容，也可以随时切换技能启用状态。</p>
                <p>
                  如果普通技能与插件自带技能同名，斜杠列表会同时展示两个入口并标明来源；选中后按对应
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  绝对路径执行，插件自带技能仍由插件管理。
                </p>
                <p>禁用技能后，该技能本体和它附带的 Skill Hook 会一起失效。</p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="发布到市场"
              summary="发布时会保留技能原始相对路径信息，并处理嵌套子技能。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  发布前如果检测到子技能，会询问是否一起上传；选择只上传当前技能时，子技能目录不会进入导出包。
                </p>
                <p>
                  导出包会附带市场元数据，记录当前技能和子技能的相对路径；重新导入时这些元数据只用于识别，不会写入用户技能目录。
                </p>
              </div>
            </SkillGuideSubSection>
          </div>
        </SkillGuideSection>

        <SkillGuideSection
          title="Skill Hook 配置说明"
          summary="把 hooks/hooks.json 放进技能目录，或写进 SKILL.md frontmatter，技能启用时会自动加载对应 Hook。"
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
              summary="推荐在技能目录下新建 hooks/hooks.json；父技能和子技能都可以有自己的 Hook。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5 text-foreground">
                  {SKILL_HOOK_TREE_EXAMPLE}
                </pre>
                <p>
                  只要目录里存在
                  <code className="mx-1 font-mono text-foreground/85">hooks/hooks.json</code>
                  ，启用对应技能时就会自动加载；根目录
                  <code className="mx-1 font-mono text-foreground/85">hooks.json</code>
                  仍兼容旧包；也可以直接写在
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  顶部 YAML frontmatter 的
                  <code className="mx-1 font-mono text-foreground/85">hooks</code>
                  字段里。嵌套子技能的 Hook 放在子技能自己的目录或子技能自己的
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  里。
                </p>
                <p>
                  Skill Hook 命令默认按技能所在目录作为
                  <code className="mx-1 font-mono text-foreground/85">cwd</code>
                  执行；脚本放在技能目录时，可以在
                  <code className="mx-1 font-mono text-foreground/85">command</code>
                  里直接写相对路径，也可以继续用
                  <code className="mx-1 font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>或
                  <code className="mx-1 font-mono text-foreground/85">SKILL_ROOT</code>
                  环境变量定位。
                </p>
                <p>
                  Hook 写在
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md frontmatter</code>
                  里时，配置来源会显示为
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  ；命令默认执行目录仍是该技能目录，和
                  <code className="mx-1 font-mono text-foreground/85">hooks/hooks.json</code>
                  保持一致。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="触发与作用域规则"
              summary="斜杠命令、技能卡片和模型自动读取技能都会激活该技能的 Hook。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  通过斜杠命令选择技能、在技能卡片里选择技能，或模型自动读取某个
                  <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                  ，都会视为该技能被激活。
                  <code className="mx-1 font-mono text-foreground/85">PreSkillUse</code>和
                  <code className="mx-1 font-mono text-foreground/85">PostSkillUse</code>
                  会围绕这次激活触发；前者在使用前，后者在本轮结束阶段。
                </p>
                <p>
                  技能激活后，本轮运行里它自己的
                  <code className="mx-1 font-mono text-foreground/85">PreToolUse</code>、
                  <code className="mx-1 font-mono text-foreground/85">PostToolUse</code>等工具 Hook
                  会继续生效；同一个技能同一轮只会做一次激活记录，避免重复读取时反复触发激活 Hook。
                </p>
                <p>
                  父技能和子技能互相独立：只选子技能时只触发子技能目录下的 Hook，不会自动触发父技能
                  Hook；只选父技能时也不会自动触发子技能 Hook。
                </p>
                <p>禁用某个技能后，该技能本体和它目录下的 Skill Hook 会一起失效。</p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="最小配置示例"
              summary="支持 SKILL.md frontmatter、扁平数组和 Claude Code 嵌套格式；运行时自动识别。"
            >
              <div className="space-y-3 text-sm text-muted-foreground">
                <p className="font-medium text-foreground/85">
                  SKILL.md frontmatter（技能说明和配套 Hook 放在同一个文件）
                </p>
                <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                  <code>{SKILL_HOOK_FRONTMATTER_EXAMPLE}</code>
                </pre>
                <p>
                  frontmatter 使用 YAML，字段无需加引号；内部
                  <code className="mx-1 font-mono text-foreground/85">hooks</code>
                  结构与 Claude Code hooks settings 一致，并支持
                  <code className="mx-1 font-mono text-foreground/85">once</code>、
                  <code className="mx-1 font-mono text-foreground/85">persistAfterInterrupt</code>、
                  <code className="mx-1 font-mono text-foreground/85">timeoutMs</code>、
                  <code className="mx-1 font-mono text-foreground/85">forcedOutcome</code>、
                  <code className="mx-1 font-mono text-foreground/85">forcedReason</code>、
                  <code className="mx-1 font-mono text-foreground/85">onBlock</code>和
                  <code className="mx-1 font-mono text-foreground/85">modelId</code>。
                </p>
                <p>
                  对<code className="mx-1 font-mono text-foreground/85">PreSkillUse</code>/
                  <code className="mx-1 font-mono text-foreground/85">PostSkillUse</code>
                  ，如果 frontmatter 里的
                  <code className="mx-1 font-mono text-foreground/85">matcher</code>
                  省略，默认匹配当前技能名；只选中子技能时，只会激活子技能自己的 Hook。
                </p>
                <p className="font-medium text-foreground/85">扁平数组（推荐）</p>
                <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                  <code>{SKILL_HOOK_JSON_EXAMPLE}</code>
                </pre>
                <p className="font-medium text-foreground/85">
                  Claude Code 嵌套格式（兼容 CC 写法）
                </p>
                <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                  <code>{SKILL_HOOK_CC_EXAMPLE}</code>
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
                <p>
                  <code className="mx-1 font-mono text-foreground/85">forcedOutcome</code>
                  取值：
                  <code className="mx-1 font-mono text-foreground/85">&quot;always-revise&quot;</code>
                  （强制走修订）/
                  <code className="mx-1 font-mono text-foreground/85">&quot;always-halt&quot;</code>
                  （强制终止本轮）；不写则跟随 hook stdout 输出。可选
                  <code className="mx-1 font-mono text-foreground/85">forcedReason</code>
                  作为静态原因。
                </p>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="命令能拿到哪些上下文"
              summary="工作区、技能目录、事件、工具参数会通过环境变量和 stdin JSON 传给 command hook。"
            >
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  Skill Hook 的命令默认在技能目录执行，
                  <code className="mx-1 font-mono text-foreground/85">cwd</code>
                  不是当前项目工作区。Skill Hook 里
                  <code className="mx-1 font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>与
                  <code className="mx-1 font-mono text-foreground/85">SKILL_ROOT</code>
                  通常相同；要访问用户当前工作区，请优先读取
                  <code className="mx-1 font-mono text-foreground/85">WORKSPACE_PATH</code>
                  ；兼容 Claude Code 写法时也可以读取
                  <code className="mx-1 font-mono text-foreground/85">CLAUDE_PROJECT_DIR</code>。
                </p>
                <div className="space-y-1">
                  <p className="font-medium text-foreground/85">常用环境变量：</p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      <code className="font-mono text-foreground/85">WORKSPACE_PATH</code> /
                      <code className="ml-1 font-mono text-foreground/85">CLAUDE_PROJECT_DIR</code>
                      ：当前会话的工作区路径。
                    </li>
                    <li>
                      <code className="font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>、
                      <code className="font-mono text-foreground/85">HOOK_SOURCE_TYPE</code>、
                      <code className="font-mono text-foreground/85">HOOK_SOURCE_PATH</code>
                      ：当前这条 Hook 的来源目录、来源类型和配置文件路径；command 的
                      <code className="mx-1 font-mono text-foreground/85">cwd</code>
                      默认就是来源目录。
                    </li>
                    <li>
                      <code className="font-mono text-foreground/85">SKILL_ROOT</code>、
                      <code className="font-mono text-foreground/85">SKILL_PATH</code>、
                      <code className="font-mono text-foreground/85">SKILL_NAME</code>
                      ：事件关联的技能目录、技能文件路径和技能名；它们不决定非 Skill Hook
                      的执行目录。
                    </li>
                    <li>
                      <code className="font-mono text-foreground/85">HOOK_EVENT</code>、
                      <code className="font-mono text-foreground/85">TOOL_NAME</code>、
                      <code className="font-mono text-foreground/85">SESSION_ID</code>、
                      <code className="font-mono text-foreground/85">USER_PROMPT</code>
                      ：事件名、工具名、会话 ID 和用户提示。
                    </li>
                    <li>
                      <code className="font-mono text-foreground/85">TOOL_ARGS</code>、
                      <code className="font-mono text-foreground/85">TOOL_RESULT</code>
                      ：小体积 JSON 辅助字段；内容较大时请从 stdin JSON 读取。
                    </li>
                    <li>
                      <code className="font-mono text-foreground/85">PLUGIN_ID</code>、
                      <code className="font-mono text-foreground/85">PLUGIN_NAME</code>、
                      <code className="font-mono text-foreground/85">PLUGIN_ROOT</code>
                      ：由插件带来的 Hook 会附带插件来源信息。
                    </li>
                  </ul>
                </div>
                <div className="space-y-2">
                  <p>推荐在脚本里读环境变量，而不是把路径写死在 command 里：</p>
                  <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                    <code>{SKILL_HOOK_ENV_EXAMPLE}</code>
                  </pre>
                </div>
                <div className="space-y-2">
                  <p>
                    如果确实要把工作区路径作为命令参数传入，Windows
                    下可以这样写；跨平台脚本仍建议读取环境变量：
                  </p>
                  <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                    <code>{SKILL_HOOK_WINDOWS_ARG_EXAMPLE}</code>
                  </pre>
                </div>
                <div className="space-y-2">
                  <p>
                    command hook 还会从 stdin 收到完整 JSON。这里的
                    <code className="mx-1 font-mono text-foreground/85">cwd</code>
                    表示命令实际执行目录，也就是
                    <code className="mx-1 font-mono text-foreground/85">hook_source_root</code>
                    ；在 Skill Hook 里通常是技能目录，工作区路径仍以
                    <code className="mx-1 font-mono text-foreground/85">WORKSPACE_PATH</code>
                    为准。
                  </p>
                  <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                    <code>{SKILL_HOOK_STDIN_EXAMPLE}</code>
                  </pre>
                  <p>
                    不同事件还会补充
                    <code className="mx-1 font-mono text-foreground/85">prompt</code>、
                    <code className="mx-1 font-mono text-foreground/85">tool_response</code>、
                    <code className="mx-1 font-mono text-foreground/85">
                      skill_trigger_tool_name
                    </code>
                    、<code className="mx-1 font-mono text-foreground/85">subagent</code>和
                    <code className="mx-1 font-mono text-foreground/85">stop_context</code>
                    等字段；完整字段以“自定义 &gt; 钩子”的事件协议说明为准。
                  </p>
                </div>
              </div>
            </SkillGuideSubSection>

            <SkillGuideSubSection
              title="调试与验证"
              summary="看 Hook 执行记录、stderr 日志，以及去哪看完整事件协议。"
            >
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  命令 Hook 的调试日志建议写到 stderr；stdout 必须输出纯 JSON 才会被当成 Hook
                  返回值解析，不要额外包单引号、markdown 或混入调试日志。
                </p>
                <p>
                  常用返回包括
                  <code className="mx-1 font-mono text-foreground/85">
                    decision=&quot;block&quot;
                  </code>
                  、
                  <code className="mx-1 font-mono text-foreground/85">reason</code>、
                  <code className="mx-1 font-mono text-foreground/85">systemMessage</code>、
                  <code className="mx-1 font-mono text-foreground/85">additionalContext</code>和
                  <code className="mx-1 font-mono text-foreground/85">requiredSkill</code>
                  ；命令返回
                  <code className="mx-1 font-mono text-foreground/85">exit=2</code>
                  也会按阻断处理。
                </p>
                <p>
                  所有事件都支持
                  <code className="mx-1 font-mono text-foreground/85">continue=false</code>+
                  <code className="mx-1 font-mono text-foreground/85">stopReason</code>
                  ，优先级高于
                  <code className="mx-1 font-mono text-foreground/85">decision=block</code>
                  ：Stop / PostSkillUse 上是真的终止整轮；Pre / Post
                  工具事件上等同强制阻断该次操作。
                </p>
                <p>
                  如果不想让脚本动态决定，可以在 Hook 配置里直接锁定行为：
                  <code className="mx-1 font-mono text-foreground/85">{`"forcedOutcome": "always-revise"`}</code>
                  / <code className="mx-1 font-mono text-foreground/85">{`"always-halt"`}</code>
                  ，可选搭配
                  <code className="mx-1 font-mono text-foreground/85">forcedReason</code>
                  作为静态原因；hook 的 stdout 输出会被覆盖。
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
  const setShowCustomizeView = useAppStore((state) => state.setShowCustomizeView)
  const setMarketInitialSkillCategory = useAppStore(
    (state) => state.setMarketInitialSkillCategory
  )
  const setMarketInitialSkillSearchQuery = useAppStore(
    (state) => state.setMarketInitialSkillSearchQuery
  )
  const recordSkillUrl = import.meta.env.VITE_JUMP_RECORD_SKILL_URL?.trim() || ""
  const [initialSkillSnapshot] = useState(() => readSkillCatalogCache())
  const [skills, setSkills] = useState<SkillMetadata[]>(
    () => initialSkillSnapshot?.localSkills ?? []
  )
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const [expandedDirNodes, setExpandedDirNodes] = useState<Set<string>>(new Set())
  const [skillFilesMap, setSkillFilesMap] = useState<Record<string, string[]>>({})
  const [marketSkillMap, setMarketSkillMap] = useState<Record<string, SkillMarketInfo>>({})
  const [selectedSkill, setSelectedSkill] = useState<SkillMetadata | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null)
  const [selectedFilePreviewKind, setSelectedFilePreviewKind] = useState<FilePreviewKind>("text")
  const [selectedBinaryBase64, setSelectedBinaryBase64] = useState<string | null>(null)
  const [selectedBinaryMimeType, setSelectedBinaryMimeType] = useState<string | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishSkill, setPublishSkill] = useState<SkillMetadata | null>(null)
  const [publishMode, setPublishMode] = useState<PublishMode>("upload")
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(
    () => initialSkillSnapshot?.disabledSkillIds ?? new Set()
  )
  const disabledSkillsRef = useRef(disabledSkills)
  const disabledSkillMutationCoordinatorRef = useRef(
    new SkillDisabledMutationCoordinator(disabledSkills)
  )
  const disabledSkillMutationChainRef = useRef<Promise<void>>(Promise.resolve())
  const disabledSkillAuthorityRevisionRef = useRef(0)
  const skillMutationMountedRef = useRef(true)
  const [skillCatalogLoadState, setSkillCatalogLoadState] = useState<SkillCatalogLoadState>(
    initialSkillSnapshot ? "ready" : "loading"
  )
  const [skillCatalogLoadError, setSkillCatalogLoadError] = useState<string | null>(null)
  const [uploadedSkillNames, setUploadedSkillNames] = useState<Set<string>>(() =>
    readUploadedSkillNamesFromStorage()
  )
  const [localUploadedSkillPaths, setLocalUploadedSkillPaths] = useState<Set<string>>(() =>
    readLocalUploadedSkillPathSetFromStorage()
  )
  const [orgInstalledSkillNames, setOrgInstalledSkillNames] = useState<Set<string>>(() =>
    readOrgInstalledSkillNamesFromStorage()
  )
  const [editedSkillPaths, setEditedSkillPaths] = useState<Set<string>>(() =>
    readEditedSkillPathSetFromStorage()
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [visibleSkillLimit, setVisibleSkillLimit] = useState(SKILL_PLUGIN_CATALOG_RENDER_BATCH)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const skillRefreshGeneration = useRef(0)

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value)
      setVisibleSkillLimit(SKILL_PLUGIN_CATALOG_RENDER_BATCH)
    }, 200)
  }, [])

  useEffect(() => {
    skillMutationMountedRef.current = true
    return () => {
      skillMutationMountedRef.current = false
      clearTimeout(debounceTimer.current)
    }
  }, [])

  const publishDisabledSkillSnapshot = useCallback((snapshot: Set<string>): void => {
    disabledSkillsRef.current = snapshot
    if (skillMutationMountedRef.current) setDisabledSkills(snapshot)
  }, [])

  const refreshSkills = useCallback(async (invalidate = false): Promise<SkillMetadata[]> => {
    const generation = ++skillRefreshGeneration.current
    const disabledAuthorityRevision = disabledSkillAuthorityRevisionRef.current
    setSkillCatalogLoadState("loading")
    setSkillCatalogLoadError(null)
    if (invalidate) invalidateSkillCatalog()
    try {
      const pluginVersion = useAppStore.getState().pluginVersion
      const cachedBeforeRefresh = readSkillCatalogCache()
      let snapshot = await revalidateSkillCatalog(pluginVersion)
      // Development/HMR or a branch update can change bundled skills without a
      // skills:changed event, leaving an application-lifetime snapshot with no
      // project rows. If this refresh only reused that exact stale snapshot,
      // force one isolated Worker rescan. A legitimately empty fresh result is
      // not scanned twice on every remount.
      if (
        !invalidate &&
        snapshot === cachedBeforeRefresh &&
        !snapshot.localSkills.some((skill) => skill.source === "project") &&
        !recoveredEmptySkillCatalogKeys.has(snapshot.key)
      ) {
        recoveredEmptySkillCatalogKeys.add(snapshot.key)
        invalidateSkillCatalog()
        snapshot = await revalidateSkillCatalog(pluginVersion)
        recoveredEmptySkillCatalogKeys.add(snapshot.key)
      }
      if (generation === skillRefreshGeneration.current) {
        setSkills(snapshot.localSkills)
        if (disabledAuthorityRevision === disabledSkillAuthorityRevisionRef.current) {
          publishDisabledSkillSnapshot(
            disabledSkillMutationCoordinatorRef.current.replaceAuthoritative(
              snapshot.disabledSkillIds
            )
          )
        }
        setSkillCatalogLoadState("ready")
      }
      return snapshot.localSkills
    } catch (error) {
      if (generation === skillRefreshGeneration.current) {
        setSkillCatalogLoadState("error")
        setSkillCatalogLoadError(error instanceof Error ? error.message : "技能目录加载失败")
      }
      throw error
    }
  }, [publishDisabledSkillSnapshot])

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void refreshSkills()
        .then(() => {
          if (active) setVisibleSkillLimit(SKILL_PLUGIN_CATALOG_RENDER_BATCH)
        })
        .catch(console.error)
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
      skillRefreshGeneration.current += 1
    }
  }, [refreshSkills])

  useEffect(() => {
    return subscribeSkillCatalogInvalidation(() => {
      void refreshSkills().catch(console.error)
    })
  }, [refreshSkills])

  const reloadUploadedSkillNames = useCallback(() => {
    setUploadedSkillNames(readUploadedSkillNamesFromStorage())
  }, [])

  const reloadLocalUploadedSkillPaths = useCallback(() => {
    setLocalUploadedSkillPaths(readLocalUploadedSkillPathSetFromStorage())
  }, [])

  const reloadOrgInstalledSkillNames = useCallback(() => {
    setOrgInstalledSkillNames(readOrgInstalledSkillNamesFromStorage())
  }, [])

  const reloadEditedSkillPaths = useCallback(() => {
    setEditedSkillPaths(readEditedSkillPathSetFromStorage())
  }, [])

  const loadMarketSkills = useCallback(async () => {
    try {
      const res = await marketApi.getSkills()
      if (!res.success || !res.data) return
      const next: Record<string, SkillMarketInfo> = {}
      for (const item of res.data) {
        const normalized = normalizeSkillName(item.name)
        if (!normalized) continue
        next[normalized] = {
          name: item.name,
          chinese_name: item.chinese_name,
          category: item.category,
          description: item.description,
          featured: item.featured
        }
      }
      setMarketSkillMap(next)
    } catch (e) {
      console.warn("[SkillsPanel] Failed to load market skills:", e)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMarketSkills()
    }, 0)
    return () => clearTimeout(timer)
  }, [loadMarketSkills])

  const skillFilesMapRef = useRef(skillFilesMap)
  useEffect(() => {
    skillFilesMapRef.current = skillFilesMap
  }, [skillFilesMap])

  const expandedSkillsRef = useRef(expandedSkills)
  useEffect(() => {
    expandedSkillsRef.current = expandedSkills
  }, [expandedSkills])

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
    const isKnownText = KNOWN_TEXT_EXTS.has(ext)

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
    const skillId = getSkillMetadataId(skill)
    const cachedFiles = skillFilesMapRef.current[skillId]
    if (cachedFiles && cachedFiles.length > 0) return cachedFiles
    const res = await window.api.skills.listFiles(skill.path)
    const fallbackFiles = [skill.path]
    if (!res.success || !res.files || res.files.length === 0) {
      setSkillFilesMap((prev) => ({ ...prev, [skillId]: fallbackFiles }))
      return fallbackFiles
    }
    const files = res.files
    setSkillFilesMap((prev) => ({ ...prev, [skillId]: files }))
    return files
  }, [])

  const shouldHideMarketInstalledFeaturedFiles = useCallback(
    (skill: SkillMetadata): boolean => {
      if (skill.source !== "user") return false
      const localMarked = localUploadedSkillPaths.has(normalizeSkillPathKey(skill.path))
      const uploadedByMe = uploadedSkillNames.has(normalizeSkillName(skill.name))
      if (localMarked || uploadedByMe) return false
      return isFeaturedSkill(marketSkillMap[normalizeSkillName(skill.name)])
    },
    [localUploadedSkillPaths, marketSkillMap, uploadedSkillNames]
  )

  const onToggleSkill = useCallback(
    async (skill: SkillMetadata) => {
      const skillId = getSkillMetadataId(skill)
      const wasExpanded = expandedSkillsRef.current.has(skillId)
      const next = new Set<string>()
      if (!wasExpanded) next.add(skillId)
      setExpandedSkills(next)

      if (!wasExpanded) {
        if (shouldHideMarketInstalledFeaturedFiles(skill)) {
          setSelectedSkill(skill)
          setSelectedFilePath(null)
          setSelectedFileContent(null)
          setSelectedBinaryBase64(null)
          setSelectedBinaryMimeType(null)
          return
        }
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
    [ensureSkillFiles, loadFileContent, shouldHideMarketInstalledFeaturedFiles]
  )

  const onSelectFile = useCallback(
    async (skill: SkillMetadata, filePath: string) => {
      if (shouldHideMarketInstalledFeaturedFiles(skill)) {
        setSelectedSkill(skill)
        setSelectedFilePath(null)
        setSelectedFileContent(null)
        setSelectedBinaryBase64(null)
        setSelectedBinaryMimeType(null)
        return
      }
      await loadFileContent(skill, filePath)
    },
    [loadFileContent, shouldHideMarketInstalledFeaturedFiles]
  )

  const toggleDirNode = useCallback((nodeId: string) => {
    setExpandedDirNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const toggleSkillEnabled = useCallback(
    (skill: SkillMetadata) => {
      const skillId = getSkillMetadataId(skill)
      if (!skillId) return
      const disabled = !isSkillDisabled(skill, disabledSkillsRef.current)
      const { version, snapshot } = disabledSkillMutationCoordinatorRef.current.begin(
        skillId,
        disabled
      )
      disabledSkillAuthorityRevisionRef.current += 1
      publishDisabledSkillSnapshot(snapshot)

      disabledSkillMutationChainRef.current = disabledSkillMutationChainRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const authoritative = await window.api.skills.setDisabledState(skillId, disabled)
            disabledSkillAuthorityRevisionRef.current += 1
            publishDisabledSkillSnapshot(
              disabledSkillMutationCoordinatorRef.current.settle(
                skillId,
                version,
                authoritative
              )
            )
          } catch (error) {
            disabledSkillAuthorityRevisionRef.current += 1
            publishDisabledSkillSnapshot(
              disabledSkillMutationCoordinatorRef.current.abandon(skillId, version)
            )
            // Roll back immediately from the renderer's last authoritative
            // snapshot, then revalidate through the isolated catalog Worker.
            // Never recover a Worker failure by scanning SKILL.md on main.
            console.error("[SkillsPanel] Failed to update disabled skill:", error)
            if (skillMutationMountedRef.current) {
              void refreshSkills(true).catch((refreshError) => {
                console.error("[SkillsPanel] Failed to refresh disabled skills:", refreshError)
              })
              toast.error("技能启用状态保存失败，已恢复到保存前状态")
            }
          }
        })
    },
    [publishDisabledSkillSnapshot, refreshSkills]
  )

  const handleDeleteSkill = useCallback(
    async (skill: SkillMetadata) => {
      if (!window.api?.skills?.delete) return
      if (
        !confirm(
          `确定要删除技能「${skill.name}」吗？\n\n特别注意：删除后的技能文件不会进入垃圾箱，会直接从磁盘移除。`
        )
      )
        return
      const res = await window.api.skills.delete(skill.path)
      if (res.success) {
        removeLocalUploadedSkillPathFromStorage(skill.path)
        removeEditedSkillPathFromStorage(skill.path)
        marketInstalledSourceStorage.removeName(skill.name, "orgSkill")
        marketInstalledVersionStorage.removeVersion(skill.name, "orgSkill")
        reloadLocalUploadedSkillPaths()
        reloadOrgInstalledSkillNames()
        reloadEditedSkillPaths()
        setSelectedSkill(null)
        setSelectedFilePath(null)
        setSelectedFileContent(null)
        setSkillFilesMap((prev) => {
          const next = { ...prev }
          delete next[getSkillMetadataId(skill)]
          return next
        })
        void refreshSkills(true).catch(console.error)
      } else {
        alert(res.error || "删除失败")
      }
    },
    [
      refreshSkills,
      reloadEditedSkillPaths,
      reloadLocalUploadedSkillPaths,
      reloadOrgInstalledSkillNames
    ]
  )

  const builtinSkills = useMemo(() => skills.filter((s) => s.source === "project"), [skills])
  const customSkills = useMemo(() => skills.filter((s) => s.source === "user"), [skills])

  const resolveMarketInfo = useCallback(
    (skill: SkillMetadata): SkillMarketInfo | undefined => {
      if (skill.source !== "user") return undefined
      return marketSkillMap[normalizeSkillName(skill.name)]
    },
    [marketSkillMap]
  )

  const isSkillUploadedInPanel = useCallback(
    (skill: SkillMetadata | null | undefined): boolean => {
      if (!skill || skill.source !== "user") return false
      if (orgInstalledSkillNames.has(normalizeSkillName(skill.name))) return false
      const localMarked = localUploadedSkillPaths.has(normalizeSkillPathKey(skill.path))
      if (localMarked) return true
      if (uploadedSkillNames.has(normalizeSkillName(skill.name))) return true
      // 历史兜底：无市场同名记录时，仍按“本地上传”处理。
      return !resolveMarketInfo(skill)
    },
    [localUploadedSkillPaths, orgInstalledSkillNames, resolveMarketInfo, uploadedSkillNames]
  )

  const selectedSkillMarketInfo = useMemo(
    () => (selectedSkill ? resolveMarketInfo(selectedSkill) : undefined),
    [resolveMarketInfo, selectedSkill]
  )
  /**
   * “我自己在 SkillsPanel 上传”的判定：
   * 优先依赖本地路径标记；其次兜底为“用户技能且市场中无同名项”（历史数据兼容）。
   */
  const selectedSkillUploadedInPanel = useMemo(
    () => isSkillUploadedInPanel(selectedSkill),
    [isSkillUploadedInPanel, selectedSkill]
  )
  const selectedSkillUploadedByMe = useMemo(
    () => !!selectedSkill && uploadedSkillNames.has(normalizeSkillName(selectedSkill.name)),
    [selectedSkill, uploadedSkillNames]
  )
  const selectedSkillIsEdited = useMemo(
    () => !!selectedSkill && editedSkillPaths.has(normalizeSkillPathKey(selectedSkill.path)),
    [editedSkillPaths, selectedSkill]
  )
  const selectedSkillHasMarketEntry = useMemo(
    () => !!selectedSkillMarketInfo || selectedSkillUploadedByMe,
    [selectedSkillMarketInfo, selectedSkillUploadedByMe]
  )
  const isMarketInstalledFeaturedSkill = useCallback(
    (skill: SkillMetadata | null | undefined): boolean => {
      if (!skill || skill.source !== "user") return false
      if (isSkillUploadedInPanel(skill)) return false
      return isFeaturedSkill(resolveMarketInfo(skill))
    },
    [isSkillUploadedInPanel, resolveMarketInfo]
  )
  const selectedSkillHideContent = useMemo(
    () => isMarketInstalledFeaturedSkill(selectedSkill),
    [isMarketInstalledFeaturedSkill, selectedSkill]
  )
  const selectedSkillCanEdit = useMemo(
    () => !!selectedSkill && selectedSkillUploadedInPanel,
    [selectedSkill, selectedSkillUploadedInPanel]
  )
  const selectedSkillShowPublishButton = useMemo(
    () => !!selectedSkill && selectedSkill.source !== "project" && selectedSkillUploadedInPanel,
    [selectedSkill, selectedSkillUploadedInPanel]
  )
  const selectedSkillPublishLabel = "同步到市场"
  const selectedSkillDeleteDisabledReason = selectedSkillHideContent
    ? "精品技能是内置技能，不允许删除。你可以点击按钮不启动这个技能。"
    : undefined

  const saveSkillFileContent = useCallback(
    async (filePath: string, nextContent: string): Promise<SaveSkillFileResult> => {
      if (!selectedSkill) return { success: false, error: "未选择技能" }
      if (selectedSkill.source === "project") return { success: false, error: "内置技能不支持编辑" }
      if (!isSkillUploadedInPanel(selectedSkill)) {
        return { success: false, error: "只有我上传的技能支持编辑" }
      }
      if (!selectedFilePath || selectedFilePath !== filePath) {
        return { success: false, error: "当前文件已切换，请重试" }
      }

      const res = await window.api.skills.write(filePath, nextContent)
      if (!res.success) return { success: false, error: res.error || "保存失败" }

      setSelectedFileContent(nextContent)
      markEditedSkillPathInStorage(selectedSkill.path)
      setEditedSkillPaths((prev) => {
        const next = new Set(prev)
        next.add(normalizeSkillPathKey(selectedSkill.path))
        return next
      })
      toast.success("保存成功，可新开会话试一试效果。")

      if (/(^|\/)SKILL\.md$/i.test(filePath)) {
        /**
         * SKILL.md 里可能修改了 frontmatter（名称/描述等）。
         * 保存后主动刷新技能列表，保证左侧列表与右侧详情展示的元信息立即一致。
         */
        setSkillFilesMap({})
        void refreshSkills(true)
          .then((nextSkills) => {
            const nextSelected = nextSkills.find((item) => item.path === filePath) || null
            setSelectedSkill(nextSelected)
            if (nextSelected) {
              setExpandedSkills(new Set([getSkillMetadataId(nextSelected)]))
            }
          })
          .catch(console.error)
      }

      return { success: true }
    },
    [isSkillUploadedInPanel, refreshSkills, selectedFilePath, selectedSkill]
  )

  const filterSkillsBySearch = useCallback(
    (list: SkillMetadata[]) => {
      const q = debouncedQuery.trim().toLowerCase()
      if (!q) return list
      return list.filter((skill) => {
        const marketInfo = resolveMarketInfo(skill)
        const chineseName = getSkillChineseName(skill, marketInfo)
        const category = getSkillCategory(skill, marketInfo)
        return (
          skill.name.toLowerCase().includes(q) ||
          (skill.description?.toLowerCase().includes(q) ?? false) ||
          chineseName.toLowerCase().includes(q) ||
          category.toLowerCase().includes(q)
        )
      })
    },
    [debouncedQuery, resolveMarketInfo]
  )

  const openPublishDialog = useCallback(
    (skill: SkillMetadata) => {
      // 已发布过则“更新发布”，否则“一键发布”。
      const mode: PublishMode = uploadedSkillNames.has(normalizeSkillName(skill.name))
        ? "update"
        : "upload"
      setPublishMode(mode)
      setPublishSkill(skill)
      setPublishDialogOpen(true)
    },
    [uploadedSkillNames]
  )

  const uploadedCustomSkills = useMemo(
    () => customSkills.filter((skill) => isSkillUploadedInPanel(skill)),
    [customSkills, isSkillUploadedInPanel]
  )
  const orgInstalledCustomSkills = useMemo(
    () =>
      customSkills.filter(
        (skill) =>
          !isSkillUploadedInPanel(skill) &&
          orgInstalledSkillNames.has(normalizeSkillName(skill.name))
      ),
    [customSkills, isSkillUploadedInPanel, orgInstalledSkillNames]
  )
  const marketInstalledCustomSkills = useMemo(
    () =>
      customSkills.filter(
        (skill) =>
          !isSkillUploadedInPanel(skill) &&
          !orgInstalledSkillNames.has(normalizeSkillName(skill.name))
      ),
    [customSkills, isSkillUploadedInPanel, orgInstalledSkillNames]
  )

  const filteredBuiltin = useMemo(
    () => filterSkillsBySearch(builtinSkills),
    [builtinSkills, filterSkillsBySearch]
  )
  const filteredUploadedCustom = useMemo(
    () => filterSkillsBySearch(uploadedCustomSkills),
    [filterSkillsBySearch, uploadedCustomSkills]
  )
  const filteredMarketInstalledCustom = useMemo(
    () => filterSkillsBySearch(marketInstalledCustomSkills),
    [filterSkillsBySearch, marketInstalledCustomSkills]
  )
  const filteredOrgInstalledCustom = useMemo(
    () => filterSkillsBySearch(orgInstalledCustomSkills),
    [filterSkillsBySearch, orgInstalledCustomSkills]
  )

  const visibleSkillGroups = useMemo(() => {
    const builtin = filteredBuiltin.slice(0, visibleSkillLimit)
    const uploaded = filteredUploadedCustom.slice(
      0,
      Math.max(0, visibleSkillLimit - builtin.length)
    )
    const market = filteredMarketInstalledCustom.slice(
      0,
      Math.max(0, visibleSkillLimit - builtin.length - uploaded.length)
    )
    const org = filteredOrgInstalledCustom.slice(
      0,
      Math.max(0, visibleSkillLimit - builtin.length - uploaded.length - market.length)
    )
    return {
      builtin,
      uploaded,
      market,
      org
    }
  }, [
    filteredBuiltin,
    filteredMarketInstalledCustom,
    filteredOrgInstalledCustom,
    filteredUploadedCustom,
    visibleSkillLimit
  ])
  const totalFilteredSkills =
    filteredBuiltin.length +
    filteredUploadedCustom.length +
    filteredMarketInstalledCustom.length +
    filteredOrgInstalledCustom.length

  const openMarketWithSkillSearch = useCallback(
    (skillName: string) => {
      const keyword = skillName.trim()
      setMarketInitialSkillCategory(null)
      setMarketInitialSkillSearchQuery(keyword || null)
      // 兜底：当 customizeInitialTab 已经是 market 时，先切到 skills 再切回 market，
      // 保证“更新到市场/发布到市场”后一定触发市场页切换并应用搜索词。
      setShowCustomizeView(true, "skills")
      setTimeout(() => setShowCustomizeView(true, "market"), 0)
    },
    [setMarketInitialSkillCategory, setMarketInitialSkillSearchQuery, setShowCustomizeView]
  )

  const handleOpenRecordSkill = useCallback(() => {
    if (!recordSkillUrl) {
      toast.error("未配置录制技能跳转地址")
      return
    }

    void window.electron.openExternal(recordSkillUrl).catch((error) => {
      console.error("[SkillsPanel] Failed to open record skill url:", error)
      toast.error("打开录制技能页面失败")
    })
  }, [recordSkillUrl])

  return (
    <div className="contents">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="搜索"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-7 w-full pl-7 pr-6 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                onClick={() => {
                  setSearchQuery("")
                  setDebouncedQuery("")
                }}
                aria-label="清空"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer group relative h-7 flex-1 overflow-hidden rounded-md border-emerald-300/55 bg-emerald-500/[0.08] px-2 text-xs font-medium text-emerald-700 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-emerald-400/70 hover:bg-emerald-500/[0.16] hover:shadow-md dark:text-emerald-300"
                onClick={() => setUploadDialogOpen(true)}
                aria-label="上传技能"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-emerald-400/10 to-emerald-400/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                />
                <span className="relative flex size-4 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/25 transition-transform duration-200 group-hover:scale-105">
                  <Plus className="size-2.5" />
                </span>
                <span className="relative">上传技能</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer group relative h-7 flex-1 overflow-hidden rounded-md border-amber-300/55 bg-amber-500/[0.08] px-2 text-xs font-medium text-amber-700 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-amber-400/70 hover:bg-amber-500/[0.16] hover:shadow-md dark:text-amber-300"
                onClick={handleOpenRecordSkill}
                aria-label="录制技能"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-amber-400/10 to-amber-400/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                />
                <span className="relative flex size-4 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-amber-500/25 transition-transform duration-200 group-hover:scale-105">
                  <Radio className="size-2.5" />
                </span>
                <span className="relative">录制技能</span>
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 cursor-pointer group relative h-7 w-full overflow-hidden rounded-md border-primary/40 bg-primary/[0.08] px-2.5 text-xs font-medium text-primary shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-primary/60 hover:bg-primary/[0.18] hover:shadow-md"
              onClick={() => openMarketWithSkillSearch("")}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-primary/15 to-primary/30 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              />
              <span className="relative flex size-4 items-center justify-center rounded-full bg-primary/15 ring-1 ring-primary/25 transition-transform duration-200 group-hover:scale-105">
                <Store className="size-2.5" />
              </span>
              <span className="relative">去应用市场</span>
              <ChevronRight className="relative size-3 text-primary/80 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Button>
            <div className="rounded-md border border-sky-200/70 bg-sky-50/80 px-2.5 py-2 text-[11px] leading-4 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
              <div className="flex items-start gap-1.5">
                <Info className="mt-0.5 size-3 shrink-0" />
                <p>
                  这里管理普通技能。与插件技能同名时，斜杠列表会同时显示并用来源区分；技能说明中的相对脚本路径按
                  <code className="mx-0.5 rounded bg-sky-100 px-1 dark:bg-sky-500/20">
                    SKILL.md
                  </code>
                  所在目录解析。
                </p>
              </div>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-3">
            {skillCatalogLoadState === "loading" && (
              <div
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>{skills.length > 0 ? "正在刷新技能目录…" : "正在加载技能目录…"}</span>
              </div>
            )}
            {skillCatalogLoadState === "error" && (
              <div
                className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                role="alert"
                title={skillCatalogLoadError ?? undefined}
              >
                <AlertCircle className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {skills.length > 0 ? "技能目录刷新失败，当前展示上次结果。" : "技能目录加载失败。"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={() => void refreshSkills(true).catch(console.error)}
                >
                  重试
                </Button>
              </div>
            )}
            {skillCatalogLoadState === "ready" && builtinSkills.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Info className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">当前版本未发现内置技能。</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={() => void refreshSkills(true).catch(console.error)}
                >
                  重新扫描
                </Button>
              </div>
            )}
            {builtinSkills.length > 0 && (
              <SkillSection
                title="内置技能"
                skills={visibleSkillGroups.builtin}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                disabledSkills={disabledSkills}
                onToggleSkill={onToggleSkill}
                onToggleDirNode={toggleDirNode}
                onSelectFile={onSelectFile}
              />
            )}
            {uploadedCustomSkills.length > 0 && (
              <SkillSection
                title="我上传的技能"
                skills={visibleSkillGroups.uploaded}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                disabledSkills={disabledSkills}
                onToggleSkill={onToggleSkill}
                onToggleDirNode={toggleDirNode}
                onSelectFile={onSelectFile}
              />
            )}
            {marketInstalledCustomSkills.length > 0 && (
              <SkillSection
                title="我从应用市场安装的技能"
                skills={visibleSkillGroups.market}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                disabledSkills={disabledSkills}
                onToggleSkill={onToggleSkill}
                onToggleDirNode={toggleDirNode}
                onSelectFile={onSelectFile}
                hideFeaturedMarketFiles
                hideMarketTag
              />
            )}
            {orgInstalledCustomSkills.length > 0 && (
              <SkillSection
                title="我安装的组织级技能"
                skills={visibleSkillGroups.org}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                disabledSkills={disabledSkills}
                onToggleSkill={onToggleSkill}
                onToggleDirNode={toggleDirNode}
                onSelectFile={onSelectFile}
                hideMarketTag
              />
            )}
            {visibleSkillLimit < totalFilteredSkills && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() =>
                  setVisibleSkillLimit((value) => value + SKILL_PLUGIN_CATALOG_RENDER_BATCH)
                }
              >
                加载更多（剩余 {totalFilteredSkills - visibleSkillLimit}）
              </Button>
            )}
          </div>
        </ScrollArea>
      </div>

      <SkillDetail
        skill={selectedSkill}
        marketInfo={selectedSkillMarketInfo}
        selectedFilePath={selectedFilePath}
        content={selectedFileContent}
        previewKind={selectedFilePreviewKind}
        binaryBase64={selectedBinaryBase64}
        binaryMimeType={selectedBinaryMimeType}
        isDisabled={selectedSkill ? isSkillDisabled(selectedSkill, disabledSkills) : false}
        onToggleEnabled={() => {
          if (selectedSkill) toggleSkillEnabled(selectedSkill)
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
        deleteDisabledReason={selectedSkillDeleteDisabledReason}
        onPublish={
          selectedSkill && selectedSkillShowPublishButton
            ? () => openPublishDialog(selectedSkill)
            : undefined
        }
        publishLabel={selectedSkillPublishLabel}
        canEdit={selectedSkillCanEdit}
        hideContentPreview={selectedSkillHideContent}
        onSaveContent={saveSkillFileContent}
        isEdited={selectedSkillIsEdited}
        hasMarketEntry={selectedSkillHasMarketEntry}
      />

      <UploadSkillDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onSuccess={(uploadedSkillDirName) => {
          setSkillFilesMap({})
          void refreshSkills(true)
            .then((nextSkills) => {
              if (!uploadedSkillDirName) return
              /**
               * 上传成功后把“目录名（upload 返回）”映射回技能 path，并写入“本面板上传”的来源标记。
               * 这里用目录名匹配，兼容 frontmatter name 与目录名不完全一致的场景。
               */
              const dirNameKey = normalizeDirNameKey(uploadedSkillDirName)
              const matched = nextSkills.find((item) => {
                const normalizedDir = getSkillDir(item.path).replace(/\\/g, "/")
                const dirName = normalizedDir.split("/").filter(Boolean).pop() || ""
                return normalizeDirNameKey(dirName) === dirNameKey
              })
              if (!matched) return
              markLocalUploadedSkillPathInStorage(matched.path)
              reloadLocalUploadedSkillPaths()
            })
            .catch(console.error)
        }}
      />

      <PublishSkillDialog
        open={publishDialogOpen}
        skill={publishSkill}
        mode={publishMode}
        marketInfo={publishSkill ? resolveMarketInfo(publishSkill) : undefined}
        onOpenChange={(open) => {
          setPublishDialogOpen(open)
          if (!open) setPublishSkill(null)
        }}
        onSuccess={({ skillName, mode }) => {
          reloadUploadedSkillNames()
          void loadMarketSkills()
          void refreshSkills(true).catch(console.error)

          toast.success(
            mode === "update"
              ? `技能「${skillName}」更新发布成功，已跳转到应用市场。`
              : `技能「${skillName}」发布成功，已跳转到应用市场。`
          )
          openMarketWithSkillSearch(skillName)
        }}
      />
    </div>
  )
}

function SkillSection(props: {
  title: string
  skills: SkillMetadata[]
  marketSkillMap: Record<string, SkillMarketInfo>
  uploadedSkillNames: Set<string>
  editedSkillPaths: Set<string>
  expandedSkills: Set<string>
  skillFilesMap: Record<string, string[]>
  selectedSkill: SkillMetadata | null
  expandedDirNodes: Set<string>
  disabledSkills: Set<string>
  hideFeaturedMarketFiles?: boolean
  hideMarketTag?: boolean
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    title,
    skills,
    marketSkillMap,
    uploadedSkillNames,
    editedSkillPaths,
    expandedSkills,
    skillFilesMap,
    selectedSkill,
    expandedDirNodes,
    disabledSkills,
    hideFeaturedMarketFiles = false,
    hideMarketTag = false,
    onToggleSkill,
    onToggleDirNode,
    onSelectFile
  } = props
  const [collapsed, setCollapsed] = useState(false)
  const [disabledCollapsed, setDisabledCollapsed] = useState(true)
  const [expandedSkillTreeNodes, setExpandedSkillTreeNodes] = useState<Set<string>>(new Set())
  const { enabled: enabledSkills, disabled: disabledSectionSkills } = useMemo(
    () => splitSkillsByEnabled(skills, disabledSkills),
    [disabledSkills, skills]
  )
  const sectionStyle = useMemo(() => {
    if (title.includes("内置")) {
      return {
        header: "border-status-info/25 bg-status-info/10 text-status-info hover:bg-status-info/15",
        dot: "bg-status-info",
        count: "border-status-info/25 bg-background-elevated/85 text-status-info"
      }
    }
    if (title.includes("我上传")) {
      return {
        header:
          "border-status-warning/25 bg-status-warning/10 text-status-warning hover:bg-status-warning/15",
        dot: "bg-status-warning",
        count: "border-status-warning/25 bg-background-elevated/85 text-status-warning"
      }
    }
    if (title.includes("应用市场")) {
      return {
        header:
          "border-status-nominal/25 bg-status-nominal/10 text-status-nominal hover:bg-status-nominal/15",
        dot: "bg-status-nominal",
        count: "border-status-nominal/25 bg-background-elevated/85 text-status-nominal"
      }
    }
    if (title.includes("组织级")) {
      return {
        header: "border-primary/25 bg-primary/10 text-primary hover:bg-primary/15",
        dot: "bg-primary",
        count: "border-primary/25 bg-background-elevated/85 text-primary"
      }
    }
    return {
      header: "border-border/70 bg-muted/50 text-foreground hover:bg-muted",
      dot: "bg-muted-foreground",
      count: "border-border/70 bg-background text-muted-foreground"
    }
  }, [title])
  const toggleSkillTreeNode = useCallback((nodeKey: string) => {
    setExpandedSkillTreeNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])

  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-1.5">
      <button
        className={cn(
          "flex items-center justify-between w-full rounded-md border px-2.5 py-1.5 group cursor-pointer transition-colors",
          sectionStyle.header
        )}
        onClick={() => setCollapsed((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {collapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span className={cn("size-1.5 rounded-full shrink-0", sectionStyle.dot)} />
          <span className="text-xs font-semibold tracking-wide truncate">{title}</span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "h-5 min-w-6 justify-center px-1.5 text-[10px] font-semibold tabular-nums",
            sectionStyle.count
          )}
        >
          {skills.length}
        </Badge>
      </button>
      {!collapsed && (
        <div className="space-y-2 pt-2 px-0.5 pb-0.5">
          {skills.length === 0 ? (
            <p className="text-xs text-muted-foreground rounded-md border border-dashed border-border/60 px-2 py-2">
              没有匹配的技能
            </p>
          ) : (
            <>
              <SkillStatusGroup
                title="已启用"
                skills={enabledSkills}
                initiallyCollapsed={false}
                disabledSkills={disabledSkills}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                expandedSkillTreeNodes={expandedSkillTreeNodes}
                hideFeaturedMarketFiles={hideFeaturedMarketFiles}
                hideMarketTag={hideMarketTag}
                onToggleSkill={onToggleSkill}
                onToggleSkillTreeNode={toggleSkillTreeNode}
                onToggleDirNode={onToggleDirNode}
                onSelectFile={onSelectFile}
              />
              <SkillStatusGroup
                title="已禁用"
                skills={disabledSectionSkills}
                collapsed={disabledCollapsed}
                onCollapsedChange={setDisabledCollapsed}
                initiallyCollapsed
                disabledSkills={disabledSkills}
                marketSkillMap={marketSkillMap}
                uploadedSkillNames={uploadedSkillNames}
                editedSkillPaths={editedSkillPaths}
                expandedSkills={expandedSkills}
                skillFilesMap={skillFilesMap}
                selectedSkill={selectedSkill}
                expandedDirNodes={expandedDirNodes}
                expandedSkillTreeNodes={expandedSkillTreeNodes}
                hideFeaturedMarketFiles={hideFeaturedMarketFiles}
                hideMarketTag={hideMarketTag}
                onToggleSkill={onToggleSkill}
                onToggleSkillTreeNode={toggleSkillTreeNode}
                onToggleDirNode={onToggleDirNode}
                onSelectFile={onSelectFile}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SkillStatusGroup(props: {
  title: string
  skills: SkillMetadata[]
  initiallyCollapsed?: boolean
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  marketSkillMap: Record<string, SkillMarketInfo>
  uploadedSkillNames: Set<string>
  editedSkillPaths: Set<string>
  expandedSkills: Set<string>
  skillFilesMap: Record<string, string[]>
  selectedSkill: SkillMetadata | null
  expandedDirNodes: Set<string>
  expandedSkillTreeNodes: Set<string>
  disabledSkills: Set<string>
  hideFeaturedMarketFiles: boolean
  hideMarketTag: boolean
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleSkillTreeNode: (nodeKey: string) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    title,
    skills,
    initiallyCollapsed = false,
    collapsed,
    onCollapsedChange,
    marketSkillMap,
    uploadedSkillNames,
    editedSkillPaths,
    expandedSkills,
    skillFilesMap,
    selectedSkill,
    expandedDirNodes,
    expandedSkillTreeNodes,
    disabledSkills,
    hideFeaturedMarketFiles,
    hideMarketTag,
    onToggleSkill,
    onToggleSkillTreeNode,
    onToggleDirNode,
    onSelectFile
  } = props
  const [localCollapsed, setLocalCollapsed] = useState(initiallyCollapsed)
  const isCollapsed = collapsed ?? localCollapsed
  const skillTree = useMemo(() => buildSkillTree(skills), [skills])
  const isDisabledGroup = title.includes("禁用")

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (onCollapsedChange) onCollapsedChange(next)
      else setLocalCollapsed(next)
    },
    [onCollapsedChange]
  )

  if (skills.length === 0) return <></>

  return (
    <div
      className={cn(
        "rounded-lg border p-1",
        isDisabledGroup
          ? "border-border/60 bg-muted/20"
          : "border-emerald-200/60 bg-emerald-50/30 dark:border-emerald-900/40 dark:bg-emerald-950/10"
      )}
    >
      <button
        className="flex min-h-7 w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-background/70"
        onClick={() => setCollapsed(!isCollapsed)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {isCollapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span
            className={cn(
              "size-1.5 rounded-full",
              isDisabledGroup ? "bg-muted-foreground" : "bg-emerald-500"
            )}
          />
          <span className="font-medium truncate">{title}</span>
        </span>
        <Badge variant="outline" className="h-4 min-w-5 justify-center px-1 text-[10px]">
          {skills.length}
        </Badge>
      </button>
      {!isCollapsed && (
        <div className="space-y-2 pt-1.5">
          <SkillTreeList
            nodes={skillTree}
            level={0}
            marketSkillMap={marketSkillMap}
            uploadedSkillNames={uploadedSkillNames}
            editedSkillPaths={editedSkillPaths}
            expandedSkills={expandedSkills}
            skillFilesMap={skillFilesMap}
            selectedSkill={selectedSkill}
            expandedDirNodes={expandedDirNodes}
            expandedSkillTreeNodes={expandedSkillTreeNodes}
            disabledSkills={disabledSkills}
            hideFeaturedMarketFiles={hideFeaturedMarketFiles}
            hideMarketTag={hideMarketTag}
            onToggleSkill={onToggleSkill}
            onToggleSkillTreeNode={onToggleSkillTreeNode}
            onToggleDirNode={onToggleDirNode}
            onSelectFile={onSelectFile}
          />
        </div>
      )}
    </div>
  )
}

function SkillTreeList(props: {
  nodes: SkillTreeNode[]
  level: number
  marketSkillMap: Record<string, SkillMarketInfo>
  uploadedSkillNames: Set<string>
  editedSkillPaths: Set<string>
  expandedSkills: Set<string>
  skillFilesMap: Record<string, string[]>
  selectedSkill: SkillMetadata | null
  expandedDirNodes: Set<string>
  expandedSkillTreeNodes: Set<string>
  disabledSkills: Set<string>
  hideFeaturedMarketFiles: boolean
  hideMarketTag: boolean
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleSkillTreeNode: (nodeKey: string) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    nodes,
    level,
    marketSkillMap,
    uploadedSkillNames,
    editedSkillPaths,
    expandedSkills,
    skillFilesMap,
    selectedSkill,
    expandedDirNodes,
    expandedSkillTreeNodes,
    disabledSkills,
    hideFeaturedMarketFiles,
    hideMarketTag,
    onToggleSkill,
    onToggleSkillTreeNode,
    onToggleDirNode,
    onSelectFile
  } = props

  return (
    <div className="space-y-2">
      {nodes.map((node) => {
        const childCount = node.children.reduce(
          (sum, child) => sum + countSkillTreeSkills(child),
          0
        )
        const childrenExpanded = expandedSkillTreeNodes.has(node.key)

        return (
          <div key={node.key} className="space-y-1.5">
            {node.skill ? (
              (() => {
                const skill = node.skill
                const skillId = getSkillMetadataId(skill)
                const expanded = expandedSkills.has(skillId)
                const files = skillFilesMap[skillId] || []
                const selected = selectedSkill
                  ? getSkillMetadataId(selectedSkill) === skillId
                  : false
                const disabled = isSkillDisabled(skill, disabledSkills)
                const marketInfo =
                  skill.source === "user"
                    ? marketSkillMap[normalizeSkillName(skill.name)]
                    : undefined
                const hasMarketEntry =
                  !!marketInfo || uploadedSkillNames.has(normalizeSkillName(skill.name))
                const isEdited = editedSkillPaths.has(normalizeSkillPathKey(skill.path))
                const hideFileTree = hideFeaturedMarketFiles && isFeaturedSkill(marketInfo)

                return (
                  <SkillItem
                    key={skillId || skill.path}
                    skill={skill}
                    marketInfo={marketInfo}
                    hasMarketEntry={hasMarketEntry}
                    hideMarketTag={hideMarketTag}
                    isEdited={isEdited}
                    expanded={expanded}
                    selected={selected}
                    disabled={disabled}
                    hideFileTree={hideFileTree}
                    files={files}
                    expandedDirNodes={expandedDirNodes}
                    nestingLevel={level}
                    childCount={childCount}
                    onToggleSkill={onToggleSkill}
                    onToggleDirNode={onToggleDirNode}
                    onSelectFile={onSelectFile}
                  />
                )
              })()
            ) : (
              <button
                className="flex min-h-8 w-full items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/20 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/35"
                style={{ marginLeft: `${level * 14}px` }}
                onClick={() => onToggleSkillTreeNode(node.key)}
              >
                {childrenExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <Folder className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{node.label}</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {childCount}
                </Badge>
              </button>
            )}

            {node.skill && node.children.length > 0 && (
              <button
                className="ml-3 flex min-h-7 w-[calc(100%-0.75rem)] items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/15 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
                onClick={() => onToggleSkillTreeNode(node.key)}
              >
                {childrenExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <Folder className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">子技能</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {childCount}
                </Badge>
              </button>
            )}

            {node.children.length > 0 && childrenExpanded && (
              <div className="ml-3 border-l border-border/60 pl-2">
                <SkillTreeList
                  nodes={node.children}
                  level={level + 1}
                  marketSkillMap={marketSkillMap}
                  uploadedSkillNames={uploadedSkillNames}
                  editedSkillPaths={editedSkillPaths}
                  expandedSkills={expandedSkills}
                  skillFilesMap={skillFilesMap}
                  selectedSkill={selectedSkill}
                  expandedDirNodes={expandedDirNodes}
                  expandedSkillTreeNodes={expandedSkillTreeNodes}
                  disabledSkills={disabledSkills}
                  hideFeaturedMarketFiles={hideFeaturedMarketFiles}
                  hideMarketTag={hideMarketTag}
                  onToggleSkill={onToggleSkill}
                  onToggleSkillTreeNode={onToggleSkillTreeNode}
                  onToggleDirNode={onToggleDirNode}
                  onSelectFile={onSelectFile}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SkillItem(props: {
  skill: SkillMetadata
  marketInfo?: SkillMarketInfo
  hasMarketEntry: boolean
  hideMarketTag?: boolean
  isEdited: boolean
  expanded: boolean
  selected: boolean
  disabled: boolean
  hideFileTree?: boolean
  files: string[]
  expandedDirNodes: Set<string>
  nestingLevel?: number
  childCount?: number
  onToggleSkill: (skill: SkillMetadata) => void
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const {
    skill,
    marketInfo,
    hasMarketEntry,
    hideMarketTag = false,
    isEdited,
    expanded,
    selected,
    disabled,
    hideFileTree = false,
    files,
    expandedDirNodes,
    nestingLevel = 0,
    childCount = 0,
    onToggleSkill,
    onToggleDirNode,
    onSelectFile
  } = props

  const treeNodes = useMemo(
    () => (expanded && !hideFileTree && files.length > 0 ? buildFileTree(skill.path, files) : []),
    [expanded, files, hideFileTree, skill.path]
  )
  const isFeatured = isFeaturedSkill(marketInfo)
  const chineseName = getSkillChineseName(skill, marketInfo)
  const displayName = chineseName || skill.name

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden transition-colors",
        selected
          ? "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/20"
          : "border-border/70 bg-transparent"
      )}
    >
      <button
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors",
          selected ? "bg-primary/10" : "hover:bg-muted/50"
        )}
        style={{ paddingLeft: `${10 + nestingLevel * 14}px` }}
        onClick={() => onToggleSkill(skill)}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("text-sm truncate", disabled && "text-muted-foreground line-through")}>
            {displayName}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {childCount > 0 && (
            <Badge
              variant="outline"
              className="h-4 gap-1 border-border bg-background-interactive px-1.5 text-[10px] text-muted-foreground"
            >
              <Folder className="size-2.5 shrink-0" />
              {childCount}
            </Badge>
          )}
          {isFeatured && (
            <Badge
              variant="outline"
              className="h-4 gap-1 border-status-warning/25 bg-status-warning/10 px-1.5 text-[10px] text-status-warning"
            >
              <Sparkles className="size-2.5 shrink-0" />
              精品
            </Badge>
          )}
          {hasMarketEntry && !hideMarketTag && (
            <Badge
              variant="outline"
              className="h-4 gap-1 border-status-nominal/25 bg-status-nominal/10 px-1.5 text-[10px] text-status-nominal"
            >
              <Store className="size-2.5 shrink-0" />
              市场
            </Badge>
          )}
          {isEdited && (
            <Badge
              variant="outline"
              className="h-4 border-status-warning/25 bg-status-warning/10 px-1.5 text-[10px] text-status-warning"
            >
              已编辑
            </Badge>
          )}
        </span>
      </button>
      {expanded && (
        <div
          className={cn(
            "border-t",
            selected ? "border-primary/30 bg-primary/[0.03]" : "border-border/60 bg-muted/20"
          )}
        >
          {hideFileTree ? (
            <div className="pl-7 pr-2 py-2 text-xs text-muted-foreground">
              精品技能不支持查看，可以直接使用。
            </div>
          ) : treeNodes.length > 0 ? (
            <SkillFileTree
              nodes={treeNodes}
              level={0}
              skill={skill}
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
  expandedDirNodes: Set<string>
  onToggleDirNode: (nodeId: string) => void
  onSelectFile: (skill: SkillMetadata, filePath: string) => void
}): React.JSX.Element {
  const { nodes, level, skill, expandedDirNodes, onToggleDirNode, onSelectFile } = props

  return (
    <div className="py-1">
      {nodes.map((node) => {
        if (node.isDir) {
          const isExpanded = expandedDirNodes.has(node.id)
          return (
            <div key={node.id}>
              <button
                className={cn(
                  "w-full min-h-8 flex items-center gap-2 rounded-sm pr-2 py-1.5 text-left text-[11px] transition-colors",
                  isExpanded ? "text-foreground bg-background/60" : "text-muted-foreground",
                  "hover:bg-background/80"
                )}
                style={{ paddingLeft: `${22 + level * 14}px` }}
                onClick={() => onToggleDirNode(node.id)}
              >
                {isExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <Folder className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              </button>
              {isExpanded && (
                <SkillFileTree
                  nodes={node.children}
                  level={level + 1}
                  skill={skill}
                  expandedDirNodes={expandedDirNodes}
                  onToggleDirNode={onToggleDirNode}
                  onSelectFile={onSelectFile}
                />
              )}
            </div>
          )
        }

        return (
          <button
            key={node.id}
            className="group w-full min-h-8 flex items-center gap-2 rounded-sm border-l-2 border-l-transparent pr-2 py-1.5 text-left text-[11px] text-foreground/80 transition-colors hover:bg-background/80 hover:text-foreground"
            style={{ paddingLeft: `${22 + level * 14}px` }}
            onClick={() => onSelectFile(skill, node.path)}
          >
            <FileText className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </button>
        )
      })}
    </div>
  )
}

export function SkillDetail(props: {
  skill: SkillMetadata | null
  marketInfo?: SkillMarketInfo
  selectedFilePath: string | null
  content: string | null
  previewKind: FilePreviewKind
  binaryBase64: string | null
  binaryMimeType: string | null
  isDisabled: boolean
  onToggleEnabled: () => void
  onShowGuide?: () => void
  onDelete?: () => void
  deleteDisabledReason?: string
  onPublish?: () => void
  publishLabel?: string
  canEdit?: boolean
  onSaveContent?: (filePath: string, content: string) => Promise<SaveSkillFileResult>
  isEdited?: boolean
  hasMarketEntry?: boolean
  hideContentPreview?: boolean
  hideActions?: boolean
  contentOnly?: boolean
}): React.JSX.Element {
  const {
    skill,
    marketInfo,
    selectedFilePath,
    content,
    previewKind,
    binaryBase64,
    binaryMimeType,
    isDisabled,
    onToggleEnabled,
    onDelete,
    deleteDisabledReason,
    onPublish,
    publishLabel = "发布到市场",
    canEdit = false,
    onSaveContent,
    isEdited = false,
    hasMarketEntry = false,
    hideContentPreview = false,
    hideActions = false,
    contentOnly = false
  } = props
  const [isEditing, setIsEditing] = useState(false)
  const [draftContent, setDraftContent] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const selectedFileExt = selectedFilePath?.split(".").pop()?.toLowerCase() ?? ""
  const isEditableTextFile = !!selectedFilePath && KNOWN_TEXT_EXTS.has(selectedFileExt)
  const markdownFrontmatter = useMemo(
    () => splitMarkdownFrontmatter(selectedFilePath, content),
    [content, selectedFilePath]
  )
  const canEditCurrentFile =
    canEdit &&
    !hideContentPreview &&
    isEditableTextFile &&
    typeof content === "string" &&
    (previewKind === "text" || previewKind === "html")

  useEffect(() => {
    setIsEditing(false)
    setDraftContent(markdownFrontmatter.editableContent)
    setIsSaving(false)
    setSaveError(null)
  }, [selectedFilePath, content, canEditCurrentFile, markdownFrontmatter.editableContent])

  const handleStartEdit = useCallback(() => {
    if (!canEditCurrentFile) return
    setDraftContent(markdownFrontmatter.editableContent)
    setSaveError(null)
    setIsEditing(true)
  }, [canEditCurrentFile, markdownFrontmatter.editableContent])

  const handleCancelEdit = useCallback(() => {
    setDraftContent(markdownFrontmatter.editableContent)
    setSaveError(null)
    setIsEditing(false)
  }, [markdownFrontmatter.editableContent])

  const handleSaveEdit = useCallback(async () => {
    if (!canEditCurrentFile || !selectedFilePath || !onSaveContent || isSaving) return
    setSaveError(null)
    setIsSaving(true)
    try {
      const nextContent = mergeMarkdownFrontmatter(
        markdownFrontmatter.protectedPrefix,
        draftContent
      )
      const result = await onSaveContent(selectedFilePath, nextContent)
      if (result.success) {
        setIsEditing(false)
      } else {
        setSaveError(result.error || "保存失败")
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setIsSaving(false)
    }
  }, [
    canEditCurrentFile,
    draftContent,
    isSaving,
    markdownFrontmatter.protectedPrefix,
    onSaveContent,
    selectedFilePath
  ])

  if (!skill) {
    return <SkillsGuide />
  }

  const chineseName = getSkillChineseName(skill, marketInfo)
  const category = getSkillCategory(skill, marketInfo)
  const description = marketInfo?.description || skill.description || "暂无描述"
  const skillFrontmatterVersion = skill.metadata?.version?.trim() || ""
  const resolvedSkillVersion = skillFrontmatterVersion || skill.version || DEFAULT_SKILL_VERSION
  const skillVersionMissingInFrontmatter = !skillFrontmatterVersion
  const skillVersionTooltip = skillVersionMissingInFrontmatter
    ? `当前没有在 SKILL.md frontmatter 里找到 version，所以这里显示的是默认值 ${DEFAULT_SKILL_VERSION}。`
    : "这个值直接读取自 SKILL.md frontmatter 里的 version 字段。"
  const isFeatured = isFeaturedSkill(marketInfo)
  const isMarkdown = !!selectedFilePath && /\.md$/i.test(selectedFilePath)
  const previewContent =
    isMarkdown && markdownFrontmatter.hasFrontmatter
      ? markdownFrontmatter.editableContent.trim()
      : content
  const binaryDataUrl =
    binaryBase64 && binaryMimeType ? `data:${binaryMimeType};base64,${binaryBase64}` : null
  const isLoading = !!selectedFilePath && content === null && binaryBase64 === null
  const isDirty = isEditing && draftContent !== markdownFrontmatter.editableContent
  /**
   * 让“发布/更新到市场”按钮更亮眼：
   * - 发布：橙金渐变；
   * - 更新：青绿渐变；
   * 同时加阴影与悬停态，增强可点击感。
   */
  const publishButtonClassName = publishLabel.includes("更新")
    ? "cursor-pointer h-7 gap-1.5 text-xs border-0 text-white hover:text-white bg-gradient-to-r from-emerald-500 to-teal-500 shadow-[0_6px_16px_rgba(16,185,129,0.35)] hover:from-emerald-400 hover:to-teal-400 hover:shadow-[0_8px_20px_rgba(16,185,129,0.45)]"
    : "cursor-pointer h-7 gap-1.5 text-xs border-0 text-white hover:text-white bg-gradient-to-r from-amber-500 to-orange-500 shadow-[0_6px_16px_rgba(245,158,11,0.35)] hover:from-amber-400 hover:to-orange-400 hover:shadow-[0_8px_20px_rgba(245,158,11,0.45)]"

  return (
    <div
      className={cn("flex-1 flex flex-col min-w-0 overflow-hidden", !isEditing && "select-none")}
      onCopy={(e) => {
        if (!isEditing) e.preventDefault()
      }}
      onKeyDown={(e) => {
        if (!isEditing && (e.ctrlKey || e.metaKey) && e.key === "c") {
          e.preventDefault()
        }
      }}
    >
      {!contentOnly && (
        <>
          <div className="p-4 border-b border-border flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-base font-semibold truncate min-w-0 flex-1">
                  {chineseName || skill.name}
                </h2>
                {!hideActions && onPublish && (
                  <Button
                    variant="default"
                    size="sm"
                    className={cn(publishButtonClassName, "group shrink-0")}
                    onClick={onPublish}
                  >
                    <span className="flex size-4 items-center justify-center rounded-full bg-primary-foreground/20 ring-1 ring-primary-foreground/30 transition-transform duration-200 group-hover:scale-105">
                      <CloudUpload className="size-2.5" />
                    </span>
                    {publishLabel}
                  </Button>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                {chineseName && (
                  <p className="text-xs text-muted-foreground truncate">{skill.name}</p>
                )}
                {isFeatured && (
                  <Badge
                    variant="outline"
                    className="h-5 gap-1 border-status-warning/25 bg-status-warning/10 px-2 text-[10px] text-status-warning"
                  >
                    <Sparkles className="size-3 shrink-0" />
                    精品
                  </Badge>
                )}
                {hasMarketEntry && (
                  <Badge
                    variant="outline"
                    className="h-5 gap-1 border-status-nominal/25 bg-status-nominal/10 px-2 text-[10px] text-status-nominal"
                  >
                    <Store className="size-3 shrink-0" />
                    市场
                  </Badge>
                )}
                {isEdited && (
                  <Badge
                    variant="outline"
                    className="h-5 border-status-warning/25 bg-status-warning/10 px-2 text-[10px] text-status-warning"
                  >
                    已编辑
                  </Badge>
                )}
                <TooltipProvider delayDuration={180}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-5 gap-1 px-2 text-[10px] cursor-help",
                          skillVersionMissingInFrontmatter
                            ? "border-status-warning/25 bg-status-warning/10 text-status-warning"
                            : "border-status-info/25 bg-status-info/10 text-status-info"
                        )}
                      >
                        <GitBranch className="size-3 shrink-0" />
                        {resolvedSkillVersion}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
                      {skillVersionTooltip}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {category && (
                  <Badge variant="outline" className="h-5 px-2 text-[10px]">
                    {category}
                  </Badge>
                )}
              </div>
            </div>
            {!hideActions && (
              <div className="flex items-center gap-1.5 shrink-0">
                {canEditCurrentFile && !isEditing && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleStartEdit}
                  >
                    编辑
                  </Button>
                )}
                {canEditCurrentFile && isEditing && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleCancelEdit}
                      disabled={isSaving}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => void handleSaveEdit()}
                      disabled={!isDirty || isSaving}
                    >
                      {isSaving ? "保存中..." : "保存"}
                    </Button>
                  </>
                )}
                {onDelete &&
                  (deleteDisabledReason ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <span className="inline-flex cursor-not-allowed">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="pointer-events-none h-7 gap-1.5 text-xs text-muted-foreground opacity-55"
                            disabled
                            aria-disabled="true"
                          >
                            <Trash2 className="size-3" />
                            删除
                          </Button>
                        </span>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-auto max-w-56 px-3 py-2 text-xs"
                        side="bottom"
                        align="end"
                      >
                        {deleteDisabledReason}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={onDelete}
                    >
                      <Trash2 className="size-3" />
                      删除
                    </Button>
                  ))}
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
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                {description}
              </p>
              <div className="flex items-start gap-2 rounded-lg border border-sky-200/70 bg-sky-50/80 px-3 py-2.5 text-xs leading-relaxed text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">运行规则</p>
                  <p>
                    与插件技能同名时，斜杠列表会同时显示并用来源区分；选中后按对应
                    <code className="mx-1 rounded bg-sky-100 px-1 dark:bg-sky-500/20">
                      SKILL.md
                    </code>
                    绝对路径执行。相对脚本、资源和模板路径按
                    <code className="mx-1 rounded bg-sky-100 px-1 dark:bg-sky-500/20">
                      SKILL.md
                    </code>
                    所在目录解析，不会改写工作区 Hook 的
                    <code className="mx-1 rounded bg-sky-100 px-1 dark:bg-sky-500/20">
                      WORKSPACE_PATH
                    </code>
                    。
                  </p>
                </div>
              </div>
              {skillVersionMissingInFrontmatter && (
                <div className="flex items-start gap-2 rounded-lg border border-status-warning/25 bg-status-warning/10 px-3 py-2.5 text-xs leading-relaxed text-status-warning">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-status-warning-foreground" />
                  <p>
                    当前没有在{" "}
                    <code className="rounded bg-status-warning/15 px-1">SKILL.md frontmatter</code> 里找到{" "}
                    <code className="rounded bg-status-warning/15 px-1">version</code>，系统当前按{" "}
                    <code className="rounded bg-status-warning/15 px-1">{DEFAULT_SKILL_VERSION}</code>{" "}
                    处理。建议补上 version，方便发布、追踪和版本识别。
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {hideContentPreview ? (
        <div className="flex-1 min-h-0 p-4">
          <div className="rounded-lg border border-status-warning/25 bg-status-warning/10 px-4 py-3 text-sm text-status-warning">
            精品技能不支持查看，可以直接使用。
          </div>
        </div>
      ) : isEditing && canEditCurrentFile ? (
        <div className="flex-1 min-h-0 p-4 flex flex-col gap-2">
          <SkillFileEditor
            className="flex-1 min-h-0"
            value={draftContent}
            onChange={setDraftContent}
            onSave={() => void handleSaveEdit()}
            error={saveError}
            note={
              markdownFrontmatter.hasFrontmatter
                ? "Markdown 顶部元信息受保护，此处只编辑正文内容。"
                : null
            }
            disabled={isSaving}
          />
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-3">
            <div className="rounded-lg border border-border/70 bg-background/70 px-3">
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
                    className="h-full w-full rounded-md border border-border bg-background-elevated"
                  />
                </div>
              ) : previewKind === "html" ? (
                <div className="html-preview-light-canvas h-[80vh] min-h-[500px] overflow-hidden rounded-md border border-border">
                  <iframe
                    title={selectedFilePath ?? "html preview"}
                    srcDoc={content ?? ""}
                    className="h-full w-full"
                    sandbox=""
                  />
                </div>
              ) : !isMarkdown ? (
                <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
                  {content}
                </pre>
              ) : (
                <div className="streaming-markdown text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewContent ?? ""}</ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
