import React, { useState } from "react"
import {
  Upload,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertCircle,
  Plus,
  Trash2,
  Loader2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { DEFAULT_SCENE_CATEGORY, SCENE_CATEGORY_OPTIONS } from "@/lib/skill-data-service"

const DEFAULT_MARKET_VERSION = "v1.0.0"

interface UserInfoLite {
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  pathName?: string
}

export interface GeneratedMarketFileBuildContext {
  name: string
  description: string
  category: string
  version: string
  guidance: string
  chineseName: string
  userId?: string
  extraJson?: string
}

interface UniversalUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  resourceType: "skill" | "mcp" | "plugin"
  onUpload: (
    file: File | null,
    name: string,
    description: string,
    category: string,
    version: string,
    guidance?: string,
    chineseName?: string,
    userId?: string,
    extraJson?: string,
    ip?: string
  ) => Promise<{ success: boolean; error?: string }>
  isUpdate?: boolean
  existingItem?: {
    name: string
    description: string
    category: string
    version?: string
    guidance?: string
    chinese_name?: string
    user_id?: string
    extra_json?: string
    ip?: string
  }
  isAdminModeActive?: boolean
  generatedFile?: {
    label?: string
    build: (
      context: GeneratedMarketFileBuildContext
    ) => Promise<{ success: boolean; file?: File; error?: string }>
  }
  loadPluginSkills?: () => Promise<string[]>
  lockName?: boolean
  titleOverride?: string
  descriptionOverride?: string
  submitLabel?: string
  submittingLabel?: string
}

type ExistingUploadItem = NonNullable<UniversalUploadDialogProps["existingItem"]>

const buildUserIdFromUserInfo = (userInfo: UserInfoLite | null): string | undefined => {
  if (!userInfo) return undefined
  const rawId = (userInfo.sapId || userInfo.ystId || "").trim()
  const rawName = (userInfo.userName || "").trim()
  const rawPathName = userInfo.pathName
  const segments = [rawId, rawName, rawPathName].filter(Boolean)
  return segments.length > 0 ? segments.join(" / ") : undefined
}

const PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL =
  import.meta.env.VITE_PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL?.trim()

type MarketExtraJson = {
  skills?: string[]
  grayUserIds?: string[]
  updated_at?: string
  [key: string]: unknown
}

function sanitizeSkillNames(skills: string[]): string[] {
  return Array.from(new Set(skills.map((skill) => skill.trim()).filter(Boolean)))
}

function normalizePluginSkillsForForm(skills: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const skill of skills) {
    const trimmed = skill.trim()
    if (!trimmed) {
      normalized.push("")
      continue
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

function sanitizeUserIds(userIds: string[]): string[] {
  return Array.from(new Set(userIds.map((userId) => userId.trim()).filter(Boolean)))
}

function normalizeUserIdsForForm(userIds: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const userId of userIds) {
    const trimmed = userId.trim()
    if (!trimmed) {
      normalized.push("")
      continue
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

function parseMarketExtraJson(extraJson?: string): MarketExtraJson {
  if (!extraJson?.trim()) return {}
  try {
    const parsed = JSON.parse(extraJson) as MarketExtraJson
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function parsePluginSkillsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  return Array.isArray(parsed.skills)
    ? sanitizeSkillNames(parsed.skills.filter((item): item is string => typeof item === "string"))
    : []
}

function parseGrayUserIdsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  return Array.isArray(parsed.grayUserIds)
    ? sanitizeUserIds(parsed.grayUserIds.filter((item): item is string => typeof item === "string"))
    : []
}

function buildMarketTimestamp(): string {
  return new Date().toISOString()
}

function buildExtraJson(options: {
  skills: string[]
  userIds: string[]
  existingExtraJson?: string
  includeSkills?: boolean
}): string {
  const { skills, userIds, existingExtraJson, includeSkills = false } = options
  const normalizedSkills = sanitizeSkillNames(skills)
  const normalizedUserIds = sanitizeUserIds(userIds)
  const payload: MarketExtraJson = {
    ...parseMarketExtraJson(existingExtraJson),
    updated_at: buildMarketTimestamp()
  }

  if (includeSkills) {
    if (normalizedSkills.length > 0) {
      payload.skills = normalizedSkills
    } else {
      delete payload.skills
    }
  }

  if (normalizedUserIds.length > 0) {
    payload.grayUserIds = normalizedUserIds
  } else {
    delete payload.grayUserIds
  }

  return JSON.stringify(payload)
}

function getResourceTypeLabel(resourceType: UniversalUploadDialogProps["resourceType"]): string {
  switch (resourceType) {
    case "skill":
      return "Skill"
    case "mcp":
      return "MCP"
    case "plugin":
      return "Plugin"
    default:
      return "Resource"
  }
}

function buildFormInitializationKey(
  resourceType: UniversalUploadDialogProps["resourceType"],
  isUpdate: boolean | undefined,
  existingItem?: ExistingUploadItem
): string {
  if (!isUpdate || !existingItem) {
    return `create:${resourceType}`
  }

  return JSON.stringify({
    resourceType,
    name: existingItem.name || "",
    description: existingItem.description || "",
    category: existingItem.category || DEFAULT_SCENE_CATEGORY,
    version: existingItem.version || DEFAULT_MARKET_VERSION,
    guidance: existingItem.guidance || "",
    chinese_name: existingItem.chinese_name || "",
    user_id: existingItem.user_id || "",
    extra_json: existingItem.extra_json || ""
  })
}

function FormSection({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-4 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-5 border-primary pl-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function FieldBlock({
  label,
  htmlFor,
  required = false,
  helper,
  children
}: {
  label: string
  htmlFor?: string
  required?: boolean
  helper?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2.5">
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1 text-sm font-medium text-foreground"
      >
        <span>{label}</span>
        {required ? <span className="text-destructive">*</span> : null}
      </label>
      {children}
      {helper ? <div className="text-xs leading-5 text-muted-foreground">{helper}</div> : null}
    </div>
  )
}

const textareaClassName =
  "min-h-[112px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

export function UniversalUploadDialog({
  open,
  onOpenChange,
  onSuccess,
  resourceType,
  onUpload,
  isUpdate,
  existingItem,
  isAdminModeActive = false,
  generatedFile,
  loadPluginSkills,
  lockName = false,
  titleOverride,
  descriptionOverride,
  submitLabel,
  submittingLabel
}: UniversalUploadDialogProps): React.JSX.Element {
  const fileInputId = React.useId()
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<string>(DEFAULT_SCENE_CATEGORY)
  const [version, setVersion] = useState(DEFAULT_MARKET_VERSION)
  const [guidance, setGuidance] = useState("")
  const [chineseName, setChineseName] = useState("")
  const [userId, setUserId] = useState<string | undefined>(undefined)
  const [pluginSkills, setPluginSkills] = useState<string[]>([])
  const [grayUserIds, setGrayUserIds] = useState<string[]>([])
  const [nameFromFile, setNameFromFile] = useState(false) // name 是否来自文件解析（锁定）
  const [versionFromSkillFile, setVersionFromSkillFile] = useState(false)
  const [versionFoundInSkillFrontmatter, setVersionFoundInSkillFrontmatter] = useState(false)
  const [submitReasonOpen, setSubmitReasonOpen] = useState(false)
  const [parsingPluginSkills, setParsingPluginSkills] = useState(false)
  const lastInitializedFormKeyRef = React.useRef<string | null>(null)

  const isSkillResource = resourceType === "skill"
  const isPluginResource = resourceType === "plugin"
  const isVersionReadonly = isSkillResource
  const shouldPreserveExistingPublisherMetadata =
    Boolean(isUpdate) && isAdminModeActive && Boolean(existingItem)
  const hasExistingItem = Boolean(existingItem)
  const existingItemName = existingItem?.name || ""
  const existingItemDescription = existingItem?.description || ""
  const existingItemCategory = existingItem?.category || DEFAULT_SCENE_CATEGORY
  const existingItemVersion = existingItem?.version || DEFAULT_MARKET_VERSION
  const existingItemGuidance = existingItem?.guidance || ""
  const existingItemChineseName = existingItem?.chinese_name || ""
  const existingItemExtraJson = existingItem?.extra_json

  const resetVersionState = React.useCallback(() => {
    setVersion(DEFAULT_MARKET_VERSION)
    setVersionFromSkillFile(false)
    setVersionFoundInSkillFrontmatter(false)
  }, [])

  const loadCurrentUserId = React.useCallback(async () => {
    try {
      const userInfo = (await window.api.models.getUserInfo()) as UserInfoLite | null
      setUserId(buildUserIdFromUserInfo(userInfo))
    } catch (e) {
      console.error("[UniversalUploadDialog] Failed to load user info:", e)
      setUserId(undefined)
    }
  }, [])

  const buildUploadContext = React.useCallback(
    (
      skills: string[] = pluginSkills,
      userIds: string[] = grayUserIds
    ): GeneratedMarketFileBuildContext => {
      const extraJson = buildExtraJson({
        skills: isPluginResource ? normalizePluginSkillsForForm(skills) : [],
        userIds: normalizeUserIdsForForm(userIds),
        existingExtraJson: existingItem?.extra_json,
        includeSkills: isPluginResource
      })

      const uploadUserId = shouldPreserveExistingPublisherMetadata
        ? existingItem?.user_id?.trim() || undefined
        : userId?.trim() || undefined

      return {
        name: name.trim(),
        description: description.trim(),
        category: category.trim() || DEFAULT_SCENE_CATEGORY,
        version: version.trim() || DEFAULT_MARKET_VERSION,
        guidance: guidance.trim(),
        chineseName: chineseName.trim(),
        userId: uploadUserId,
        extraJson
      }
    },
    [
      category,
      chineseName,
      description,
      existingItem?.extra_json,
      existingItem?.user_id,
      grayUserIds,
      guidance,
      isAdminModeActive,
      isUpdate,
      isPluginResource,
      name,
      pluginSkills,
      shouldPreserveExistingPublisherMetadata,
      userId,
      version
    ]
  )

  const parsePluginSkillsFromFile = React.useCallback(async (pluginFile: File): Promise<string[]> => {
    const buffer = await pluginFile.arrayBuffer()
    const detail = await window.api.plugins.inspectZip(buffer)
    return sanitizeSkillNames(detail.skills)
  }, [])

  const canRefreshPluginSkills =
    open && isUpdate && isPluginResource && !file && typeof loadPluginSkills === "function"

  const handleRefreshPluginSkills = React.useCallback(async () => {
    if (!loadPluginSkills) return

    setParsingPluginSkills(true)
    setError(null)

    try {
      const skills = await loadPluginSkills()
      console.log("[UniversalUploadDialog] Refreshed plugin skills:", skills)
      setPluginSkills(normalizePluginSkillsForForm(skills))
    } catch (e) {
      setError(e instanceof Error ? e.message : "刷新 Plugin Skills 失败")
    } finally {
      setParsingPluginSkills(false)
    }
  }, [loadPluginSkills])

  const formInitializationKey = buildFormInitializationKey(
    resourceType,
    isUpdate,
    hasExistingItem
      ? {
          name: existingItemName,
          description: existingItemDescription,
          category: existingItemCategory,
          version: existingItemVersion,
          guidance: existingItemGuidance,
          chinese_name: existingItemChineseName,
          user_id: existingItem?.user_id,
          extra_json: existingItemExtraJson,
          ip: existingItem?.ip
        }
      : undefined
  )

  // Only hydrate the form when the dialog first opens or when the target item actually changes.
  React.useEffect(() => {
    if (!open) {
      lastInitializedFormKeyRef.current = null
      return
    }

    void loadCurrentUserId()

    if (lastInitializedFormKeyRef.current === formInitializationKey) {
      return
    }

    lastInitializedFormKeyRef.current = formInitializationKey
    setFile(null)
    setError(null)

    if (isUpdate && hasExistingItem) {
      setName(existingItemName)
      setDescription(existingItemDescription)
      setCategory(existingItemCategory)
      setVersion(existingItemVersion)
      setGuidance(existingItemGuidance)
      setChineseName(existingItemChineseName)
      setPluginSkills(
        resourceType === "plugin" ? parsePluginSkillsFromExtraJson(existingItemExtraJson) : []
      )
      setGrayUserIds(parseGrayUserIdsFromExtraJson(existingItemExtraJson))
      setNameFromFile(false)
      setVersionFromSkillFile(false)
      setVersionFoundInSkillFrontmatter(false)
      return
    }

    // Reset form for new upload
    setName("")
    setDescription("")
    setCategory(DEFAULT_SCENE_CATEGORY)
    resetVersionState()
    setGuidance("")
    setChineseName("")
    setPluginSkills([])
    setGrayUserIds([])
    setNameFromFile(false)
  }, [
    existingItemCategory,
    existingItemChineseName,
    existingItemDescription,
    existingItemExtraJson,
    existingItemGuidance,
    existingItemName,
    existingItemVersion,
    formInitializationKey,
    hasExistingItem,
    isUpdate,
    loadCurrentUserId,
    open,
    resetVersionState,
    resourceType
  ])

  const getAcceptedTypes = () => {
    switch (resourceType) {
      case "skill":
        return ".md,.zip"
      case "mcp":
        return ".json"
      case "plugin":
        return ".zip"
      default:
        return "*"
    }
  }

  const getFileTypeDescription = () => {
    switch (resourceType) {
      case "skill":
        return ".md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含 SKILL.md，可包含父目录和嵌套子技能"
      case "mcp":
        return "上传 .json 文件，包含 MCP 连接器配置，必须是utf-8"
      case "plugin":
        return "上传 .zip 文件，包含插件代码和配置文件"
      default:
        return "请选择正确的文件类型"
    }
  }

  const validateFile = (selectedFile: File): string | null => {
    const ext = selectedFile.name.toLowerCase().slice(selectedFile.name.lastIndexOf("."))

    switch (resourceType) {
      case "skill":
        if (ext !== ".md" && ext !== ".zip") {
          return "仅支持 .md 或 .zip 文件"
        }
        break
      case "mcp":
        if (ext !== ".json") {
          return "仅支持 .json 文件"
        }
        break
      case "plugin":
        if (ext !== ".zip") {
          return "仅支持 .zip 文件"
        }
        break
      default:
        return "不支持的资源类型"
    }
    return null
  }

  const handleFile = async (selectedFile: File) => {
    const validationError = validateFile(selectedFile)
    if (validationError) {
      setError(validationError)
      return
    }

    setFile(selectedFile)
    setError(null)
    setNameFromFile(false)
    if (resourceType !== "skill") {
      setVersionFromSkillFile(false)
      setVersionFoundInSkillFrontmatter(false)
    }
    if (resourceType !== "plugin") {
      setPluginSkills([])
    }

    // 对 skill 的 .md / .zip 文件，尝试从文件内容中提取 name
    if (resourceType === "skill") {
      const ext = selectedFile.name.toLowerCase().slice(selectedFile.name.lastIndexOf("."))
      if (ext === ".md" || ext === ".zip") {
        try {
          const buffer = await selectedFile.arrayBuffer()
          const result = (await window.electron.ipcRenderer.invoke("skills:parseNameFromFile", {
            buffer,
            fileName: selectedFile.name
          })) as {
            success: boolean
            name?: string
            version?: string
            versionFoundInFrontmatter?: boolean
            error?: string
          }

          if (result.success && result.name) {
            setName(result.name)
            setNameFromFile(true)
            setVersion(result.version || DEFAULT_MARKET_VERSION)
            setVersionFromSkillFile(true)
            setVersionFoundInSkillFrontmatter(Boolean(result.versionFoundInFrontmatter))
            return
          } else {
            setError(result.error || "无法从文件中提取 name，请手动填写")
            setVersion(DEFAULT_MARKET_VERSION)
            setVersionFromSkillFile(false)
            setVersionFoundInSkillFrontmatter(false)
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "解析文件失败，请手动填写名称")
          setVersion(DEFAULT_MARKET_VERSION)
          setVersionFromSkillFile(false)
          setVersionFoundInSkillFrontmatter(false)
        }
      }
    }

    if (resourceType === "plugin") {
      try {
        setPluginSkills(await parsePluginSkillsFromFile(selectedFile))
      } catch (e) {
        console.warn("[UniversalUploadDialog] Failed to inspect plugin zip:", e)
        setPluginSkills([])
      }
    }

    // 其他类型或解析失败时，用文件名兜底（仅在 name 为空时）
    if (!name) {
      const baseName = selectedFile.name.replace(/\.(md|zip|json)$/i, "")
      setName(baseName)
    }
  }

  const handleUpload = async () => {
    if (!isUpdate && !file && !generatedFile) {
      setError("请选择文件")
      return
    }

    if (!name.trim()) {
      setError("请填写英文名称")
      return
    }

    if (!chineseName.trim()) {
      setError("请填写中文名称")
      return
    }

    if (!description.trim()) {
      setError("请填写描述")
      return
    }

    if (!category.trim()) {
      setError("请选择场景")
      return
    }

    if (!version.trim()) {
      setError("请填写版本号")
      return
    }

    if (!guidance.trim()) {
      setError("请填写使用指引")
      return
    }

    const normalizedGrayUserIds = normalizeUserIdsForForm(grayUserIds)
    const normalizedPluginSkills = isPluginResource
      ? normalizePluginSkillsForForm(pluginSkills)
      : pluginSkills

    const grayUserIdsChanged =
      normalizedGrayUserIds.length !== grayUserIds.length ||
      normalizedGrayUserIds.some((userId, index) => userId !== grayUserIds[index])
    if (grayUserIdsChanged) {
      setGrayUserIds(normalizedGrayUserIds)
    }
    if (normalizedGrayUserIds.some((userId) => !userId.trim())) {
      setError("请完整填写灰度用户 User ID，或删除空白项")
      return
    }

    if (isPluginResource) {
      const pluginSkillsChanged =
        normalizedPluginSkills.length !== pluginSkills.length ||
        normalizedPluginSkills.some((skill, index) => skill !== pluginSkills[index])
      if (pluginSkillsChanged) {
        setPluginSkills(normalizedPluginSkills)
      }
      if (normalizedPluginSkills.some((skill) => !skill.trim())) {
        setError("请完整填写 Skills，或删除空白项")
        return
      }
    }

    setError(null)
    setUploading(true)

    try {
      const uploadContext = buildUploadContext(normalizedPluginSkills, normalizedGrayUserIds)
      let uploadFile = file
      if (generatedFile) {
        const generated = await generatedFile.build(uploadContext)
        if (!generated.success || !generated.file) {
          setError(generated.error || "生成上传文件失败")
          return
        }
        uploadFile = generated.file
      }
      const uploadIp = shouldPreserveExistingPublisherMetadata
        ? (existingItem?.ip ?? "")
        : (localStorage.getItem("localIp") || "")

      const result = await onUpload(
        uploadFile,
        uploadContext.name,
        uploadContext.description,
        uploadContext.category,
        uploadContext.version,
        uploadContext.guidance,
        uploadContext.chineseName,
        uploadContext.userId,
        uploadContext.extraJson,
        uploadIp
      )

      if (result.success) {
        onSuccess()
        onOpenChange(false)
        // Reset form
        setFile(null)
        setName("")
        setDescription("")
        setCategory(DEFAULT_SCENE_CATEGORY)
        resetVersionState()
        setGuidance("")
        setChineseName("")
        setUserId(undefined)
        setPluginSkills([])
        setGrayUserIds([])
      } else {
        setError(result.error || "Upload failed")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setUploading(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) handleFile(droppedFile)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const onDragLeave = () => setDragOver(false)

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) handleFile(selectedFile)
    e.target.value = ""
  }

  const handleDialogClose = (open: boolean) => {
    if (!uploading) {
      onOpenChange(open)
      if (!open) {
        // Reset form when closing
        setFile(null)
        setName("")
        setDescription("")
        setCategory(DEFAULT_SCENE_CATEGORY)
        resetVersionState()
        setGuidance("")
        setChineseName("")
        setPluginSkills([])
        setGrayUserIds([])
        setError(null)
        setShowJsonTemplate(false)
        setNameFromFile(false)
        setVersionFromSkillFile(false)
        setVersionFoundInSkillFrontmatter(false)
        setParsingPluginSkills(false)
      }
    }
  }

  const getTitle = () => {
    if (titleOverride) return titleOverride
    if (isUpdate) {
      switch (resourceType) {
        case "skill":
          return "更新技能"
        case "mcp":
          return "更新MCP连接器"
        case "plugin":
          return "更新插件"
        default:
          return "更新资源"
      }
    } else {
      switch (resourceType) {
        case "skill":
          return "上传技能到市场"
        case "mcp":
          return "上传MCP连接器到市场"
        case "plugin":
          return "上传插件到市场"
        default:
          return "上传到市场"
      }
    }
  }

  const [jsonTemplateCopied, setJsonTemplateCopied] = useState(false)
  const [showJsonTemplate, setShowJsonTemplate] = useState(false)
  const [pluginMcpTemplateCopied, setPluginMcpTemplateCopied] = useState(false)
  const [showPluginMcpTemplate, setShowPluginMcpTemplate] = useState(false)
  const hasValidGrayUserIds = grayUserIds.every((item) => item.trim().length > 0)
  const hasValidPluginSkills =
    !isPluginResource || pluginSkills.every((skill) => skill.trim().length > 0)
  const canSubmit =
    (isUpdate || !!file || !!generatedFile) &&
    !!name.trim() &&
    !!chineseName.trim() &&
    !!description.trim() &&
    !!category.trim() &&
    !!version.trim() &&
    !!guidance.trim() &&
    hasValidGrayUserIds &&
    hasValidPluginSkills

  const resourceTypeLabel = getResourceTypeLabel(resourceType)
  const uploadActionText = uploading
    ? submittingLabel || (isUpdate ? "更新中..." : "上传中...")
    : submitLabel || (isUpdate ? "更新" : "上传")

  const updatePluginSkill = (index: number, value: string) => {
    setPluginSkills((current) => current.map((skill, i) => (i === index ? value : skill)))
  }

  const addPluginSkill = () => {
    setPluginSkills((current) => [...current, ""])
  }

  const removePluginSkill = (index: number) => {
    setPluginSkills((current) => current.filter((_, i) => i !== index))
  }

  const normalizePluginSkillsState = () => {
    setPluginSkills((current) => normalizePluginSkillsForForm(current))
  }

  const updateGrayUserId = (index: number, value: string) => {
    setGrayUserIds((current) => current.map((userId, i) => (i === index ? value : userId)))
  }

  const addGrayUserId = () => {
    setGrayUserIds((current) => [...current, ""])
  }

  const removeGrayUserId = (index: number) => {
    setGrayUserIds((current) => current.filter((_, i) => i !== index))
  }

  const normalizeGrayUserIdsState = () => {
    setGrayUserIds((current) => normalizeUserIdsForForm(current))
  }

  const getSubmitDisabledReason = () => {
    if (uploading) return submittingLabel || (isUpdate ? "更新中..." : "上传中...")
    if (!isUpdate && !file && !generatedFile) return "请选择文件"
    if (!name.trim()) return "请填写英文名称"
    if (!chineseName.trim()) return "请填写中文名称"
    if (!description.trim()) return "请填写描述"
    if (!category.trim()) return "请选择场景"
    if (!version.trim()) return "请填写版本号"
    if (!guidance.trim()) return "请填写使用指引"
    if (grayUserIds.some((userId) => !userId.trim())) {
      return "请完整填写灰度用户 User ID，或删除空白项"
    }
    if (isPluginResource && pluginSkills.some((skill) => !skill.trim())) {
      return "请完整填写 Skills，或删除空白项"
    }
    return undefined
  }

  const submitDisabledReason = getSubmitDisabledReason()

  const handleCopyJsonTemplate = () => {
    const template = `{
  "mcpServers": {
    "pubmed": {
      "type": "sse",
      "name": "测试MCP服务",
      "url": "http://test.com",
      "enabled": false,
      "advanced": {
        "headers": {
          "Token": "xxx"
        },
        "transport": "sse",
        "reconnect": {
          "enabled": true,
          "maxAttempts": 3,
          "delayMs": 1000
        }
      }
    }
  }
}`
    navigator.clipboard
      .writeText(template)
      .then(() => {
        setJsonTemplateCopied(true)
        setTimeout(() => setJsonTemplateCopied(false), 2000)
      })
      .catch(() => {
        setError("复制模板失败，请手动复制")
      })
  }

  const pluginMcpTemplate = `{
  "search-service": {
    "url": "https://example.com/mcp",
    "transport": "streamable-http",
    "headers": {
      "X-App": "my-plugin"
    },
    "injectUserHeaders": true,
    "priority": 50,
    "scope": "plugin-active",
    "fallback": {
      "enabled": true,
      "to": "global",
      "match": "toolNameAndSchema",
      "safeToRetry": true
    }
  },
  "local-helper": {
    "command": "node",
    "args": ["./mcp-server.js"],
    "env": {
      "NODE_ENV": "production"
    }
  }
}`

  const handleCopyPluginMcpTemplate = () => {
    navigator.clipboard
      .writeText(pluginMcpTemplate)
      .then(() => {
        setPluginMcpTemplateCopied(true)
        setTimeout(() => setPluginMcpTemplateCopied(false), 2000)
      })
      .catch(() => {
        setError("复制插件 MCP 模板失败，请手动复制")
      })
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>{descriptionOverride || getFileTypeDescription()}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] pr-3">
          <div className="space-y-10 m-1">
            <FormSection
              title="文件与上传方式"
              description="先选择要上传的文件。更新时也可以只修改表单信息。"
            >
              {resourceType === "plugin" && PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL ? (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <span>首次上传插件？可以先下载插件模板文件，按模板结构修改后再上传。</span>
                  <a
                    href={PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                  >
                    下载插件模板
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              ) : null}

              {resourceType === "plugin" ? (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs leading-6 text-muted-foreground">
                  <p>
                    插件 MCP 使用根目录 <span className="font-mono">.mcp.json</span> 配置。remote
                    MCP 默认注入当前用户 Header；可用{" "}
                    <span className="font-mono">injectUserHeaders: false</span> 关闭，用{" "}
                    <span className="font-mono">priority</span> /{" "}
                    <span className="font-mono">scope</span> 控制调用优先级，用{" "}
                    <span className="font-mono">fallback</span> 声明失败后是否允许切到全局同名
                    MCP。Fallback 需要同时声明 <span className="font-mono">safeToRetry: true</span>
                    ，只适合查询类或幂等工具。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={handleCopyPluginMcpTemplate}
                      disabled={uploading}
                    >
                      {pluginMcpTemplateCopied ? (
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Copy className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {pluginMcpTemplateCopied ? "已复制" : "复制 .mcp.json 示例"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setShowPluginMcpTemplate(!showPluginMcpTemplate)}
                      disabled={uploading}
                    >
                      {showPluginMcpTemplate ? (
                        <ChevronDown className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {showPluginMcpTemplate ? "隐藏示例" : "查看示例"}
                    </Button>
                  </div>
                  {showPluginMcpTemplate ? (
                    <div className="mt-3 overflow-hidden rounded-md border border-border bg-background">
                      <div className="max-h-[220px] overflow-auto p-3">
                        <pre className="text-xs overflow-x-auto">
                          <code>{pluginMcpTemplate}</code>
                        </pre>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {generatedFile ? (
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Upload className="mt-0.5 size-4 text-primary" />
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">
                        {generatedFile.label || "将自动生成上传文件"}
                      </p>
                      <p className="text-sm leading-6 text-muted-foreground">
                        点击提交时会自动打包当前资源并上传，无需手动选择文件。
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "cursor-pointer rounded-md border-2 border-dashed p-6 text-center transition-colors",
                    dragOver
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/30 hover:border-muted-foreground/50",
                    uploading && "pointer-events-none opacity-60"
                  )}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onClick={() => document.getElementById(fileInputId)?.click()}
                >
                  <input
                    id={fileInputId}
                    type="file"
                    accept={getAcceptedTypes()}
                    className="hidden"
                    onChange={onInputChange}
                    disabled={uploading}
                    required={!isUpdate}
                  />
                  {file ? (
                    <div className="space-y-2">
                      <Upload className="mx-auto size-8 text-green-600" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">{file.name}</p>
                        <p className="text-xs text-muted-foreground">点击重新选择文件</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="mx-auto size-10 text-muted-foreground" />
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">拖拽文件到此处，或点击选择</p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          支持 {getAcceptedTypes()}
                          {isUpdate ? "，更新时不重新上传也可以提交。" : "。"}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </FormSection>

            <FormSection title="基础信息" description="这部分会直接展示在市场中。">
              <div className="grid gap-5 lg:grid-cols-2">
                <FieldBlock
                  label="英文名称"
                  htmlFor="name"
                  required
                  helper={
                    isUpdate ? (
                      "更新时名称不可修改。"
                    ) : lockName ? (
                      "名称来自当前资源，不可修改。"
                    ) : nameFromFile ? (
                      "名称已从文件中自动提取，不可修改。"
                    ) : resourceType === "skill" ? (
                      <>
                        名称需与文件名或 frontmatter 中的{" "}
                        <code className="rounded bg-muted px-1">name</code> 保持一致。
                      </>
                    ) : (
                      "建议使用稳定的英文标识，便于搜索和版本管理。"
                    )
                  }
                >
                  <Input
                    id="name"
                    placeholder="输入资源名称"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={uploading || isUpdate || nameFromFile || lockName}
                    className={cn("h-10", (isUpdate || nameFromFile || lockName) && "bg-muted")}
                    required
                  />
                </FieldBlock>

                <FieldBlock
                  label="中文名称"
                  htmlFor="chinese-name"
                  required
                  helper="建议使用业务同学容易理解的命名。"
                >
                  <Input
                    id="chinese-name"
                    placeholder="输入中文名称"
                    value={chineseName}
                    onChange={(e) => setChineseName(e.target.value)}
                    disabled={uploading}
                    className="h-10"
                    required
                  />
                </FieldBlock>
              </div>

              <FieldBlock
                label="描述"
                htmlFor="description"
                required
                helper="一句话说明这个资源解决什么问题，适合什么场景。"
              >
                <textarea
                  id="description"
                  placeholder="输入资源描述"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={uploading}
                  required
                  rows={4}
                  className={textareaClassName}
                />
              </FieldBlock>

              <FieldBlock
                label="使用指引"
                htmlFor="guidance"
                required
                helper="建议给出一句可以直接复制给模型的示例提示词，帮助其他人快速上手。"
              >
                <textarea
                  id="guidance"
                  placeholder="帮助其他用户了解如何使用这个资源。案例，你可以告诉大模型：使用xx技能给我干xx事情"
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  disabled={uploading}
                  required
                  rows={4}
                  className={textareaClassName}
                />
              </FieldBlock>
            </FormSection>

            <FormSection title="发布配置" description="这里控制分类和版本。">
              <div className="grid gap-5 lg:grid-cols-2">
                <FieldBlock
                  label="选择场景"
                  required
                  helper="选择最贴近的使用场景，方便市场内筛选和分发。"
                >
                  <Select value={category} onValueChange={setCategory} disabled={uploading}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="请选择场景" />
                    </SelectTrigger>
                    <SelectContent>
                      {category &&
                      !SCENE_CATEGORY_OPTIONS.includes(
                        category as (typeof SCENE_CATEGORY_OPTIONS)[number]
                      ) ? (
                        <SelectItem value={category}>{category}</SelectItem>
                      ) : null}
                      {SCENE_CATEGORY_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldBlock>

                <FieldBlock
                  label="版本号"
                  htmlFor="version"
                  required
                  helper={
                    isSkillResource ? (
                      <div className="space-y-2">
                        <p className="leading-5">
                          Skill 版本由文档 frontmatter 的{" "}
                          <code className="rounded bg-muted px-1">version</code>{" "}
                          自动读取；未填写时按{" "}
                          <code className="rounded bg-muted px-1">{DEFAULT_MARKET_VERSION}</code>{" "}
                          处理，因此这里不允许手动修改。
                          {versionFromSkillFile && versionFoundInSkillFrontmatter
                            ? " 当前显示的是从技能文档解析出的版本。"
                            : ""}
                          {!versionFromSkillFile ? " 当前显示的是默认版本。" : ""}
                        </p>
                        {versionFromSkillFile && !versionFoundInSkillFrontmatter ? (
                          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
                            <p className="leading-5">
                              当前没有从{" "}
                              <code className="rounded bg-amber-100 px-1">md / SKILL.md</code>{" "}
                              里找到 <code className="rounded bg-amber-100 px-1">version</code>
                              ，所以展示的是默认版本{" "}
                              <code className="rounded bg-amber-100 px-1">
                                {DEFAULT_MARKET_VERSION}
                              </code>
                              。
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        MCP 和 Plugin 的版本由发布人维护，默认从{" "}
                        <code className="rounded bg-muted px-1">{DEFAULT_MARKET_VERSION}</code>{" "}
                        开始。
                      </>
                    )
                  }
                >
                  <Input
                    id="version"
                    placeholder="输入版本号，例如 v1.0.0"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    disabled={uploading || isVersionReadonly}
                    className={cn("h-10", isVersionReadonly && "bg-muted")}
                    required
                  />
                </FieldBlock>
              </div>
            </FormSection>

            <FormSection title="高级配置" description="可选项，按需要填写。">
              <div className="space-y-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h4 className="text-sm font-medium text-foreground">灰度用户 User IDs</h4>
                      <p className="text-xs leading-5 text-muted-foreground">
                        选填。填写后仅这些用户可在市场列表看到该资源；留空则默认所有用户可见。
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={addGrayUserId}
                      disabled={uploading}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      新增用户
                    </Button>
                  </div>
                  {grayUserIds.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">
                      暂无灰度用户，当前默认全部用户可见。
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {grayUserIds.map((userIdValue, index) => (
                        <div key={`gray-user-${index}`} className="flex items-center gap-2">
                          <Input
                            value={userIdValue}
                            placeholder="输入 SAP ID 或用户标识"
                            onChange={(e) => updateGrayUserId(index, e.target.value)}
                            onBlur={normalizeGrayUserIdsState}
                            disabled={uploading}
                            className="h-10"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-10 w-10 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => removeGrayUserId(index)}
                            disabled={uploading}
                            aria-label="删除灰度用户"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  {resourceType === "plugin" ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <h4 className="text-sm font-medium text-foreground">Skills</h4>
                          <p className="text-xs leading-5 text-muted-foreground">
                            优先回填列表里 extra_json 的 skills；上传新 zip 或点击刷新时，会按当前
                            Plugin 文件重新解析，重复项会自动去重。
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {canRefreshPluginSkills ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => void handleRefreshPluginSkills()}
                              disabled={uploading || parsingPluginSkills}
                            >
                              {parsingPluginSkills ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              刷新
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={addPluginSkill}
                            disabled={uploading || parsingPluginSkills}
                          >
                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                            新增 Skill
                          </Button>
                        </div>
                      </div>

                      {parsingPluginSkills ? (
                        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          正在从当前 Plugin 文件中解析 Skills...
                        </div>
                      ) : null}

                      {pluginSkills.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">
                          暂无 Skills。这里可以留空，也可以按需手动新增。
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {pluginSkills.map((skill, index) => (
                            <div key={`plugin-skill-${index}`} className="flex items-center gap-2">
                              <Input
                                value={skill}
                                placeholder="输入 Skill 名称"
                                onChange={(e) => updatePluginSkill(index, e.target.value)}
                                onBlur={normalizePluginSkillsState}
                                disabled={uploading || parsingPluginSkills}
                                className="h-10"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-10 w-10 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => removePluginSkill(index)}
                                disabled={uploading || parsingPluginSkills}
                                aria-label="删除 Skill"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : resourceType === "mcp" ? (
                    <>
                      <div className="space-y-1">
                        <h4 className="text-sm font-medium text-foreground">JSON 模板</h4>
                        <p className="text-xs leading-5 text-muted-foreground">
                          不确定 MCP 配置格式时，可以先复制模板，再按需修改后上传。
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={handleCopyJsonTemplate}
                          disabled={uploading}
                        >
                          {jsonTemplateCopied ? (
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                          ) : (
                            <Copy className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {jsonTemplateCopied ? "模板已复制" : "复制 JSON 模板"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => setShowJsonTemplate(!showJsonTemplate)}
                          disabled={uploading}
                        >
                          {showJsonTemplate ? (
                            <ChevronDown className="mr-1.5 h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {showJsonTemplate ? "隐藏模板" : "查看模板"}
                        </Button>
                      </div>
                      {showJsonTemplate ? (
                        <div className="overflow-hidden rounded-md border border-border bg-background">
                          <div className="max-h-[220px] overflow-auto p-3">
                            <pre className="text-xs overflow-x-auto">
                              <code>{`{
  "mcpServers": {
    "pubmed": {
      "type": "sse",
      "name": "测试MCP服务",
      "url": "http://test.com",
      "enabled": false,
      "advanced": {
        "headers": {
          "Token": "xxx"
        },
        "transport": "sse",
        "reconnect": {
          "enabled": true,
          "maxAttempts": 3,
          "delayMs": 1000
        }
      }
    }
  }
}`}</code>
                            </pre>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm leading-6 text-muted-foreground">
                      当前资源没有额外的高级配置项，补齐基础信息后即可直接提交。
                    </div>
                  )}
                </div>
              </div>
            </FormSection>

            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p className="leading-6">{error}</p>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <Separator className="my-4" />

        <DialogFooter className="items-center gap-3 sm:justify-between sm:space-x-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            <span>
              {submitDisabledReason ||
                `${resourceTypeLabel} 已准备好提交${grayUserIds.length > 0 ? `，灰度用户 ${grayUserIds.length} 人` : ""}。`}
            </span>
          </div>

          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="outline" onClick={() => handleDialogClose(false)} disabled={uploading}>
              取消
            </Button>
            <Popover open={!!submitDisabledReason && submitReasonOpen}>
              <PopoverTrigger asChild>
                <span
                  className="inline-flex w-full sm:w-auto"
                  onMouseEnter={() => setSubmitReasonOpen(true)}
                  onMouseLeave={() => setSubmitReasonOpen(false)}
                  onFocus={() => setSubmitReasonOpen(true)}
                  onBlur={() => setSubmitReasonOpen(false)}
                >
                  <Button
                    onClick={handleUpload}
                    disabled={uploading || !canSubmit}
                    className="w-full sm:w-auto"
                  >
                    {uploadActionText}
                  </Button>
                </span>
              </PopoverTrigger>
              <PopoverContent className="w-auto max-w-64 px-3 py-2 text-xs" align="end" side="top">
                {submitDisabledReason}
              </PopoverContent>
            </Popover>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
