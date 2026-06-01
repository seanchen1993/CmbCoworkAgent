import React, { useState } from "react"
import { Upload, Copy, Check, ChevronDown, ChevronRight, ExternalLink } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { DEFAULT_SCENE_CATEGORY, SCENE_CATEGORY_OPTIONS } from "@/lib/skill-data-service"

interface UserInfoLite {
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  pathName?: string
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
    guidance?: string,
    chineseName?: string,
    userId?: string
  ) => Promise<{ success: boolean; error?: string }>
  isUpdate?: boolean
  existingItem?: {
    name: string
    description: string
    category: string
    guidance?: string
    chinese_name?: string
    user_id?: string
  }
  generatedFile?: {
    label?: string
    build: () => Promise<{ success: boolean; file?: File; error?: string }>
  }
  lockName?: boolean
  titleOverride?: string
  descriptionOverride?: string
  submitLabel?: string
  submittingLabel?: string
}

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

export function UniversalUploadDialog({
  open,
  onOpenChange,
  onSuccess,
  resourceType,
  onUpload,
  isUpdate,
  existingItem,
  generatedFile,
  lockName = false,
  titleOverride,
  descriptionOverride,
  submitLabel,
  submittingLabel
}: UniversalUploadDialogProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<string>(DEFAULT_SCENE_CATEGORY)
  const [guidance, setGuidance] = useState("")
  const [chineseName, setChineseName] = useState("")
  const [userId, setUserId] = useState<string | undefined>(undefined)
  const [nameFromFile, setNameFromFile] = useState(false) // name 是否来自文件解析（锁定）
  const [submitReasonOpen, setSubmitReasonOpen] = useState(false)

  const loadCurrentUserId = React.useCallback(async () => {
    try {
      const userInfo = await window.api.models.getUserInfo()
      setUserId(buildUserIdFromUserInfo(userInfo))
    } catch (e) {
      console.error("[UniversalUploadDialog] Failed to load user info:", e)
      setUserId(undefined)
    }
  }, [])

  // Initialize form with existing data for update mode
  React.useEffect(() => {
    if (open && existingItem) {
      setName(existingItem.name || "")
      setDescription(existingItem.description || "")
      setCategory(existingItem.category || DEFAULT_SCENE_CATEGORY)
      setGuidance(existingItem.guidance || "")
      setChineseName(existingItem.chinese_name || "")
      setNameFromFile(false)
    } else if (open) {
      // Reset form for new upload
      setName("")
      setDescription("")
      setCategory(DEFAULT_SCENE_CATEGORY)
      setGuidance("")
      setChineseName("")
      setNameFromFile(false)
    }
    if (open) {
      void loadCurrentUserId()
    }
  }, [isUpdate, existingItem, open, loadCurrentUserId])

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

    // 对 skill 的 .md / .zip 文件，尝试从文件内容中提取 name
    if (resourceType === "skill") {
      const ext = selectedFile.name.toLowerCase().slice(selectedFile.name.lastIndexOf("."))
      if (ext === ".md" || ext === ".zip") {
        try {
          const buffer = await selectedFile.arrayBuffer()
          const result = (await window.electron.ipcRenderer.invoke("skills:parseNameFromFile", {
            buffer,
            fileName: selectedFile.name
          })) as { success: boolean; name?: string; error?: string }

          if (result.success && result.name) {
            setName(result.name)
            setNameFromFile(true)
            return
          } else {
            setError(result.error || "无法从文件中提取 name，请手动填写")
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "解析文件失败，请手动填写名称")
        }
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

    if (!guidance.trim()) {
      setError("请填写使用指引")
      return
    }

    setError(null)
    setUploading(true)

    try {
      let uploadFile = file
      if (generatedFile) {
        const generated = await generatedFile.build()
        if (!generated.success || !generated.file) {
          setError(generated.error || "生成上传文件失败")
          return
        }
        uploadFile = generated.file
      }

      const normalizedUserId = userId?.trim() || undefined
      const result = await onUpload(
        uploadFile,
        name.trim(),
        description.trim(),
        category,
        guidance.trim(),
        chineseName.trim(),
        normalizedUserId
      )

      if (result.success) {
        onSuccess()
        onOpenChange(false)
        // Reset form
        setFile(null)
        setName("")
        setDescription("")
        setCategory(DEFAULT_SCENE_CATEGORY)
        setGuidance("")
        setChineseName("")
        setUserId(undefined)
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
        setGuidance("")
        setChineseName("")
        setError(null)
        setShowJsonTemplate(false)
        setNameFromFile(false)
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
  const canSubmit =
    (isUpdate || !!file || !!generatedFile) &&
    !!name.trim() &&
    !!chineseName.trim() &&
    !!description.trim() &&
    !!category.trim() &&
    !!guidance.trim()

  const getSubmitDisabledReason = () => {
    if (uploading) return submittingLabel || (isUpdate ? "更新中..." : "上传中...")
    if (!isUpdate && !file && !generatedFile) return "请选择文件"
    if (!name.trim()) return "请填写英文名称"
    if (!chineseName.trim()) return "请填写中文名称"
    if (!description.trim()) return "请填写描述"
    if (!category.trim()) return "请选择场景"
    if (!guidance.trim()) return "请填写使用指引"
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>{descriptionOverride || getFileTypeDescription()}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[50vh] overflow-auto">
          {/* Plugin Template */}
          {resourceType === "plugin" && PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              <span>首次上传插件？可以先下载插件模板文件，按模板结构修改后再上传。</span>
              <a
                href={PLUGIN_TEMPLATE_ZIP_DOWNLOAD_URL}
                target="_blank"
                rel="noreferrer"
                className="ml-1 inline-flex items-center gap-1 font-medium text-blue-700 underline-offset-2 hover:underline"
              >
                下载插件模板
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}

          {resourceType === "plugin" && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed space-y-2">
              <p>
                插件 MCP 使用根目录 <span className="font-mono">.mcp.json</span> 配置。remote MCP
                默认注入当前用户 Header；可用{" "}
                <span className="font-mono">injectUserHeaders: false</span> 关闭，用{" "}
                <span className="font-mono">priority</span> / <span className="font-mono">scope</span>{" "}
                控制调用优先级，用 <span className="font-mono">fallback</span>{" "}
                声明失败后是否允许切到全局同名 MCP。Fallback 需要同时声明{" "}
                <span className="font-mono">safeToRetry: true</span>，只适合查询类或幂等工具。
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
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
                  className="h-7 text-xs"
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
              {showPluginMcpTemplate && (
                <div className="h-[180px] overflow-auto">
                  <pre className="bg-background p-3 rounded border text-xs overflow-x-auto">
                    <code>{pluginMcpTemplate}</code>
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* File Upload Area */}
          {generatedFile ? (
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <Upload className="size-4 text-primary" />
                <p className="text-sm font-medium">{generatedFile.label || "将自动生成上传文件"}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                点击提交时会自动打包当前资源并上传，无需手动选择文件。
              </p>
            </div>
          ) : (
            <div
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/30 hover:border-muted-foreground/50",
                uploading && "pointer-events-none opacity-60"
              )}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => document.getElementById("upload-file-input")?.click()}
            >
              <input
                id="upload-file-input"
                type="file"
                accept={getAcceptedTypes()}
                className="hidden"
                onChange={onInputChange}
                disabled={uploading}
                required={!isUpdate}
              />
              {file ? (
                <div>
                  <Upload className="size-8 mx-auto text-green-600 mb-2" />
                  <p className="text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">点击重新选择文件</p>
                </div>
              ) : (
                <>
                  <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">拖拽文件到此处，或点击选择</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    支持: {getAcceptedTypes()}
                    {isUpdate && <span className="block mt-1">更新时文件为可选项</span>}
                  </p>
                </>
              )}
            </div>
          )}

          {/* Name Input */}
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              英文名称 *<span>（英文名称 = zip文件名 = md里的name）</span>
            </label>
            <Input
              id="name"
              placeholder="输入资源名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={uploading || isUpdate || nameFromFile || lockName}
              className={isUpdate || nameFromFile || lockName ? "bg-muted" : ""}
              required
            />
            {isUpdate ? (
              <p className="text-xs text-muted-foreground">更新时名称不可修改</p>
            ) : lockName ? (
              <p className="text-xs text-muted-foreground">名称来自当前资源，不可修改</p>
            ) : nameFromFile ? (
              <p className="text-xs text-muted-foreground">名称已从文件中自动提取，不可修改</p>
            ) : resourceType === "skill" ? (
              <p className="text-xs text-muted-foreground">
                名称需与 .zip 文件名或 .md 文件中 frontmatter 的{" "}
                <code className="bg-muted px-1 rounded">name</code> 字段保持一致
              </p>
            ) : null}
          </div>

          {/* Chinese Name Input */}
          <div className="space-y-2">
            <label htmlFor="chinese-name" className="block text-sm font-medium">
              中文名称 *
            </label>
            <Input
              id="chinese-name"
              placeholder="输入中文名称"
              value={chineseName}
              onChange={(e) => setChineseName(e.target.value)}
              disabled={uploading}
              required
            />
          </div>

          {/* Description Input */}
          <div className="space-y-2">
            <label htmlFor="description" className="block text-sm font-medium">
              描述 *
            </label>
            <textarea
              id="description"
              placeholder="输入资源描述"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={uploading}
              required
              rows={3}
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            />
          </div>

          {/* Category Select */}
          <div className="space-y-2">
            <label htmlFor="category" className="block text-sm font-medium">
              选择场景 *
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={uploading}
              required
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            >
              {category &&
                !SCENE_CATEGORY_OPTIONS.includes(
                  category as (typeof SCENE_CATEGORY_OPTIONS)[number]
                ) && <option value={category}>{category}</option>}
              {SCENE_CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          {/* Guidance Input - Available for all modes */}
          <div className="space-y-2">
            <label htmlFor="guidance" className="block text-sm font-medium">
              使用指引 *
            </label>
            <textarea
              id="guidance"
              placeholder="帮助其他用户了解如何使用这个资源。案例，你可以告诉大模型：使用xx技能给我干xx事情"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              disabled={uploading}
              required
              rows={3}
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            />
          </div>

          {/* JSON Template for MCP */}
          {resourceType === "mcp" && (
            <div className="p-4 bg-muted rounded-md">
              <p className="text-sm text-muted-foreground mb-3">
                需要帮助？可以复制 JSON 模板，按需修改后上传。
              </p>
              <div className="flex items-center gap-2 mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyJsonTemplate}
                  disabled={uploading}
                >
                  {jsonTemplateCopied ? (
                    <Check className="mr-2 h-4 w-4" />
                  ) : (
                    <Copy className="mr-2 h-4 w-4" />
                  )}
                  {jsonTemplateCopied ? "模板已复制" : "复制 JSON 模板"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowJsonTemplate(!showJsonTemplate)}
                  disabled={uploading}
                >
                  {showJsonTemplate ? (
                    <ChevronDown className="mr-2 h-4 w-4" />
                  ) : (
                    <ChevronRight className="mr-2 h-4 w-4" />
                  )}
                  {showJsonTemplate ? "隐藏模板" : "查看模板"}
                </Button>
              </div>
              {showJsonTemplate && (
                <div className="mt-3 h-[150px] overflow-auto">
                  <pre className="bg-background p-3 rounded border text-xs overflow-x-auto">
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
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleDialogClose(false)} disabled={uploading}>
            取消
          </Button>
          <Popover open={!!submitDisabledReason && submitReasonOpen}>
            <PopoverTrigger asChild>
              <span
                className="inline-flex"
                onMouseEnter={() => setSubmitReasonOpen(true)}
                onMouseLeave={() => setSubmitReasonOpen(false)}
                onFocus={() => setSubmitReasonOpen(true)}
                onBlur={() => setSubmitReasonOpen(false)}
              >
                <Button onClick={handleUpload} disabled={uploading || !canSubmit}>
                  {uploading
                    ? submittingLabel || (isUpdate ? "更新中..." : "上传中...")
                    : submitLabel || (isUpdate ? "更新" : "上传")}
                </Button>
              </span>
            </PopoverTrigger>
            <PopoverContent className="w-auto max-w-56 px-3 py-2 text-xs" align="end" side="top">
              {submitDisabledReason}
            </PopoverContent>
          </Popover>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
