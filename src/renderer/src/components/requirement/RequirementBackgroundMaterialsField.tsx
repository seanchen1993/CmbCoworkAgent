import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useState,
  type ReactNode
} from "react"
import { FileText, Link, Plus, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  isSupportedRequirementBackgroundFileName,
  MAX_REQUIREMENT_BACKGROUND_FILE_BYTES,
  MAX_REQUIREMENT_BACKGROUND_FILES,
  MAX_REQUIREMENT_BACKGROUND_URLS,
  REQUIREMENT_BACKGROUND_FILE_ACCEPT
} from "../../../../shared/file-attachment"

function isImageFileName(fileName: string): boolean {
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(fileName.trim())
}

export type RequirementBackgroundMaterialsFieldHandle = {
  getUrlsForSubmit: () => string[] | null
}

type RequirementBackgroundMaterialsFieldProps = {
  files: File[]
  urls: string[]
  disabled?: boolean
  browserControlTag?: ReactNode
  onFilesChange: (files: File[]) => void
  onUrlsChange: (urls: string[]) => void
}

export const RequirementBackgroundMaterialsField = forwardRef<
  RequirementBackgroundMaterialsFieldHandle,
  RequirementBackgroundMaterialsFieldProps
>(function RequirementBackgroundMaterialsField(
  { files, urls, disabled = false, browserControlTag, onFilesChange, onUrlsChange },
  ref
): React.JSX.Element {
  const fileInputId = useId()
  const [urlDraft, setUrlDraft] = useState("")

  const addFiles = (nextFiles: File[]): void => {
    const unsupported = nextFiles.find(
      (item) => !isSupportedRequirementBackgroundFileName(item.name)
    )
    if (unsupported) {
      toast.error(`补充材料「${unsupported.name}」格式不支持`)
      return
    }
    const oversized = nextFiles.find((item) => item.size > MAX_REQUIREMENT_BACKGROUND_FILE_BYTES)
    if (oversized) {
      toast.error(`补充材料「${oversized.name}」超过 10MB 限制`)
      return
    }
    const byIdentity = new Map(
      files.map((item) => [`${item.name}:${item.size}:${item.lastModified}`, item])
    )
    nextFiles.forEach((item) =>
      byIdentity.set(`${item.name}:${item.size}:${item.lastModified}`, item)
    )
    if (byIdentity.size > MAX_REQUIREMENT_BACKGROUND_FILES) {
      toast.error(`需求背景补充材料最多上传 ${MAX_REQUIREMENT_BACKGROUND_FILES} 个文件`)
      return
    }
    onFilesChange([...byIdentity.values()])
  }

  const commitUrlDraft = useCallback((): string[] | null => {
    const value = urlDraft.trim()
    if (!value) return urls
    let normalizedUrl = ""
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error()
      normalizedUrl = parsed.toString()
    } catch {
      toast.error("请输入有效的 http 或 https 链接")
      return null
    }
    if (urls.includes(normalizedUrl)) {
      toast.info("该背景链接已添加")
      setUrlDraft("")
      return urls
    }
    if (urls.length >= MAX_REQUIREMENT_BACKGROUND_URLS) {
      toast.error(`需求背景链接最多添加 ${MAX_REQUIREMENT_BACKGROUND_URLS} 个`)
      return null
    }
    const nextUrls = [...urls, normalizedUrl]
    onUrlsChange(nextUrls)
    setUrlDraft("")
    return nextUrls
  }, [onUrlsChange, urlDraft, urls])

  const addUrl = (): void => {
    commitUrlDraft()
  }

  useImperativeHandle(ref, () => ({ getUrlsForSubmit: commitUrlDraft }), [commitUrlDraft])

  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">需求背景补充材料</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          上传本地资料或添加线上链接，帮助 Agent 更完整地理解需求背景。
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/[0.035] p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Upload className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-foreground">上传本地文件</div>
            <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              DOCX、MD、TXT、HTML 或图片 · 最多 10 个 · 单个不超过 10MB
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <label
              htmlFor={fileInputId}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              className={cn(disabled && "pointer-events-none opacity-50")}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                if (!disabled) event.currentTarget.control?.click()
              }}
            >
              <Plus className="size-3.5" />
              选择文件
            </label>
          </Button>
          <input
            id={fileInputId}
            type="file"
            multiple
            accept={REQUIREMENT_BACKGROUND_FILE_ACCEPT}
            disabled={disabled}
            className="hidden"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              event.target.value = ""
            }}
          />
        </div>

        <div className="rounded-lg border border-border/80 bg-muted/15 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
            <span className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Link className="size-3.5" />
              </span>
              添加线上链接
            </span>
            {browserControlTag}
          </div>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Link className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={urlDraft}
                onChange={(event) => setUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addUrl()
                }}
                placeholder="https://..."
                aria-label="线上背景资料链接"
                className="h-9 bg-white pl-9"
                disabled={disabled}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !urlDraft.trim()}
              onClick={addUrl}
            >
              添加
            </Button>
          </div>
        </div>
      </div>

      {files.length > 0 ? (
        <div className="mt-3 space-y-2">
          {files.map((file) => (
            <div
              key={`${file.name}:${file.size}:${file.lastModified}`}
              className="flex items-center gap-2 rounded-lg bg-muted/45 px-3 py-2"
            >
              <FileText className="size-3.5 shrink-0 text-primary" />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate text-xs text-foreground">{file.name}</span>
                {isImageFileName(file.name) ? (
                  <span className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                    需多模态模型识别
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {Math.ceil(file.size / 1024)} KB
              </span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`移除 ${file.name}`}
                onClick={() => onFilesChange(files.filter((item) => item !== file))}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {urls.length > 0 ? (
        <div className="mt-3 space-y-2">
          {urls.map((url) => (
            <div key={url} className="flex items-center gap-2 rounded-lg bg-muted/45 px-3 py-2">
              <Link className="size-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">{url}</span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`移除 ${url}`}
                onClick={() => onUrlsChange(urls.filter((item) => item !== url))}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})
