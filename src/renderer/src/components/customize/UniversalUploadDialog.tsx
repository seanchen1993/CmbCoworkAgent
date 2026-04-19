import React, { useState } from "react"
import { Upload, Copy, Check, ChevronDown, ChevronRight } from "lucide-react"
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
import { cn } from "@/lib/utils"

interface UserInfoLite {
  sapId?: string
  ystId?: string
  userName?: string
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
  existingItem?: { name: string; description: string; category: string; guidance?: string; chinese_name?: string; user_id?: string }
}

export function UniversalUploadDialog({
  open,
  onOpenChange,
  onSuccess,
  resourceType,
  onUpload,
  isUpdate,
  existingItem
}: UniversalUploadDialogProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<"研发场景" | "通用场景">("研发场景")
  const [guidance, setGuidance] = useState("")
  const [chineseName, setChineseName] = useState("")
  const [userId, setUserId] = useState<string | undefined>(undefined)
  const [nameFromFile, setNameFromFile] = useState(false)  // name 是否来自文件解析（锁定）

  const buildUserIdFromUserInfo = (userInfo: UserInfoLite | null): string | undefined => {
    if (!userInfo) return undefined
    const rawId = (userInfo.ystId || userInfo.sapId || "").trim()
    const rawName = (userInfo.userName || "").trim()
    if (rawId && rawName) return `${rawId} / ${rawName}`
    if (rawId) return rawId
    if (rawName) return rawName
    return undefined
  }

  const loadCurrentUserId = async () => {
    try {
      const userInfo = await window.api.models.getUserInfo()
      setUserId(buildUserIdFromUserInfo(userInfo))
    } catch (e) {
      console.error("[UniversalUploadDialog] Failed to load user info:", e)
      setUserId(undefined)
    }
  }

  // Initialize form with existing data for update mode
  React.useEffect(() => {
    if (isUpdate && existingItem && open) {
      setName(existingItem.name || "")
      setDescription(existingItem.description || "")
      setCategory(existingItem.category as "研发场景" | "通用场景" || "研发场景")
      setGuidance(existingItem.guidance || "")
      setChineseName(existingItem.chinese_name || "")
      setNameFromFile(false)
    } else if (!isUpdate && open) {
      // Reset form for new upload
      setName("")
      setDescription("")
      setCategory("研发场景")
      setGuidance("")
      setChineseName("")
      setNameFromFile(false)
    }
    if (open) {
      void loadCurrentUserId()
    }
  }, [isUpdate, existingItem, open])

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
        return ".md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含 SKILL.md。SKILL.md必须在根目录"
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
          const result = await window.electron.ipcRenderer.invoke("skills:parseNameFromFile", {
            buffer,
            fileName: selectedFile.name
          }) as { success: boolean; name?: string; error?: string }

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
    // For updates, file is optional; for new uploads, file is required
    if ((!isUpdate && !file) || !name.trim()) {
      setError(isUpdate ? "请填写名称" : "请选择文件并填写名称")
      return
    }

    setError(null)
    setUploading(true)

    try {
      const normalizedUserId = userId?.trim() || undefined
      const result = await onUpload(
        file,
        name.trim(),
        description.trim(),
        category,
        guidance,
        chineseName.trim() || undefined,
        normalizedUserId
      )

      if (result.success) {
        onSuccess()
        onOpenChange(false)
        // Reset form
        setFile(null)
        setName("")
        setDescription("")
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
        setError(null)
        setShowJsonTemplate(false)
        setNameFromFile(false)
      }
    }
  }

  const getTitle = () => {
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

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>
            {getFileTypeDescription()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[50vh] overflow-auto">
          {/* File Upload Area */}
          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
              dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-muted-foreground/50",
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

          {/* Name Input */}
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              英文名称 *
              <span>（英文名称 = zip文件名 = md里的name）</span>
            </label>
            <Input
              id="name"
              placeholder="输入资源名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={uploading || isUpdate || nameFromFile}
              className={(isUpdate || nameFromFile) ? "bg-muted" : ""}
            />
            {isUpdate ? (
              <p className="text-xs text-muted-foreground">更新时名称不可修改</p>
            ) : nameFromFile ? (
              <p className="text-xs text-muted-foreground">名称已从文件中自动提取，不可修改</p>
            ) : resourceType === "skill" ? (
              <p className="text-xs text-muted-foreground">
                名称需与 .zip 文件名或 .md 文件中 frontmatter 的 <code className="bg-muted px-1 rounded">name</code> 字段保持一致
              </p>
            ) : null}
          </div>


          {/* Chinese Name Input */}
          <div className="space-y-2">
            <label htmlFor="chinese-name" className="block text-sm font-medium">
              中文名称
            </label>
            <Input
              id="chinese-name"
              placeholder="输入中文名称（可选）"
              value={chineseName}
              onChange={(e) => setChineseName(e.target.value)}
              disabled={uploading}
            />
          </div>

          {/* Description Input */}
          <div className="space-y-2">
            <label htmlFor="description" className="block text-sm font-medium">
              描述
            </label>
            <textarea
              id="description"
              placeholder="输入资源描述（可选）"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={uploading}
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
              onChange={(e) => setCategory(e.target.value as "研发场景" | "通用场景")}
              disabled={uploading}
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            >
              <option value="研发场景">研发场景</option>
              <option value="通用场景">通用场景</option>
            </select>
          </div>

          {/* Guidance Input - Available for all modes */}
          <div className="space-y-2">
            <label htmlFor="guidance" className="block text-sm font-medium">
              使用指引
            </label>
            <textarea
              id="guidance"
              placeholder="输入使用指引（可选）- 帮助其他用户了解如何使用这个资源"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              disabled={uploading}
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
                  {jsonTemplateCopied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {jsonTemplateCopied ? "模板已复制" : "复制 JSON 模板"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowJsonTemplate(!showJsonTemplate)}
                  disabled={uploading}
                >
                  {showJsonTemplate ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
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
          <Button
            variant="outline"
            onClick={() => handleDialogClose(false)}
            disabled={uploading}
          >
            取消
          </Button>
          <Button
            onClick={handleUpload}
            disabled={uploading || (!isUpdate && !file) || !name.trim()}
          >
            {uploading ? (isUpdate ? "更新中..." : "上传中...") : (isUpdate ? "更新" : "上传")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
