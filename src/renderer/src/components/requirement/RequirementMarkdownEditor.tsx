import { useRef, useState } from "react"
import { Loader2, Paperclip, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "htm",
  "html",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
])
const HTML_UPLOAD_EXTENSIONS = new Set(["html", "htm"])
const SUPPORTED_UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.ico,.avif,.html,.htm"
const MAX_UPLOAD_FILES = 20

function fileExtension(file: File): string {
  return file.name.split(".").pop()?.toLowerCase() ?? ""
}

function isSupportedUpload(file: File): boolean {
  return SUPPORTED_UPLOAD_EXTENSIONS.has(fileExtension(file))
}

function isImageUpload(file: File): boolean {
  const extension = fileExtension(file)
  return SUPPORTED_UPLOAD_EXTENSIONS.has(extension) && !HTML_UPLOAD_EXTENSIONS.has(extension)
}

export function RequirementMarkdownEditor({
  requirementId,
  title,
  filePath,
  content,
  onSaved,
  onCancel
}: {
  requirementId: string
  title: string
  filePath: string
  content: string
  onSaved: (content: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(content)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const saveInFlightRef = useRef(false)
  const uploadInFlightRef = useRef(false)

  const save = async (): Promise<void> => {
    if (saveInFlightRef.current || draft === content) return
    saveInFlightRef.current = true
    setSaving(true)
    try {
      const result = await window.api.requirements.savePrdFile({
        reqId: requirementId,
        filePath,
        content: draft
      })
      if (!result.success) throw new Error(result.error || "保存失败")
      onSaved(draft)
      toast.success("PRD 已保存")
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "保存 PRD 失败")
    } finally {
      saveInFlightRef.current = false
      setSaving(false)
    }
  }

  const uploadFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0 || uploadInFlightRef.current) return
    if (files.length > MAX_UPLOAD_FILES) {
      toast.error(`单次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
      return
    }
    const unsupportedFiles = files.filter((file) => !isSupportedUpload(file))
    if (unsupportedFiles.length > 0) {
      toast.error(`仅支持上传图片和 HTML：${unsupportedFiles.map((file) => file.name).join("、")}`)
      return
    }

    uploadInFlightRef.current = true
    const editor = editorRef.current
    const selectionStart = editor?.selectionStart ?? draft.length
    const selectionEnd = editor?.selectionEnd ?? selectionStart
    setUploading(true)
    try {
      const links: string[] = []
      for (const file of files) {
        const result = await window.api.requirements.uploadPrdAsset({
          reqId: requirementId,
          prdFilePath: filePath,
          fileName: file.name,
          bytes: await file.arrayBuffer()
        })
        if (!result.success || !result.relativePath) {
          throw new Error(result.error || `上传 ${file.name} 失败`)
        }
        const label = file.name.replaceAll("[", "\\[").replaceAll("]", "\\]")
        const destination = result.relativePath.includes(" ")
          ? `<${result.relativePath}>`
          : result.relativePath
        links.push(
          isImageUpload(file) ? `![${label}](${destination})` : `[${label}](${destination})`
        )
      }

      const insertion = links.join("\n")
      const scrollTop = editorRef.current?.scrollTop ?? 0
      const scrollLeft = editorRef.current?.scrollLeft ?? 0
      setDraft(
        (current) => `${current.slice(0, selectionStart)}${insertion}${current.slice(selectionEnd)}`
      )
      requestAnimationFrame(() => {
        const currentEditor = editorRef.current
        const nextPosition = selectionStart + insertion.length
        currentEditor?.focus({ preventScroll: true })
        currentEditor?.setSelectionRange(nextPosition, nextPosition)
        if (currentEditor) {
          currentEditor.scrollTop = scrollTop
          currentEditor.scrollLeft = scrollLeft
        }
      })
      toast.success(
        files.length === 1 ? `已上传：${files[0].name}` : `已上传 ${files.length} 个文件`
      )
    } catch (uploadError) {
      toast.error(uploadError instanceof Error ? uploadError.message : "上传附件失败")
    } finally {
      uploadInFlightRef.current = false
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200 hover:border-primary/70">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-slate-100/80 px-3.5">
        <span className="text-xs font-semibold text-foreground/75">MD 编辑</span>
        <span
          className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground/80"
          title={filePath}
        >
          {filePath.replace(/^\/+/, "")}
        </span>
        <div className="flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={SUPPORTED_UPLOAD_ACCEPT}
            className="hidden"
            onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))}
          />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={saving || uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Paperclip className="size-3" />
                  )}
                  上传
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64 text-xs">
                仅支持图片和 HTML，也可以粘贴或拖入
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={saving || draft === content}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            保存
          </Button>
        </div>
      </header>
      <textarea
        ref={editorRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length === 0) return
          event.preventDefault()
          void uploadFiles(files)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault()
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files)
          if (files.length === 0) return
          event.preventDefault()
          void uploadFiles(files)
        }}
        aria-label={`编辑 ${title} PRD`}
        className="h-full min-h-[360px] w-full flex-1 resize-none border-0 bg-white p-5 font-mono text-sm leading-6 text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-primary/20"
        spellCheck={false}
        autoFocus
      />
    </section>
  )
}
