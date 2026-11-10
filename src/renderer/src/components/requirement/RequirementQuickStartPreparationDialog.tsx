import { useState } from "react"
import { ArrowLeft, ArrowRight, Link, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export type QuickStartPreparedInput = {
  id: string
  title: string
  sourceName: string
  content: string
  sourcePath?: string
  url?: string
}

export function RequirementQuickStartPreparationDialog({
  source,
  target,
  onBack,
  onPrepared
}: {
  source: "file" | "link"
  target: "design" | "development"
  onBack: () => void
  onPrepared: (input: QuickStartPreparedInput) => void | Promise<void>
}): React.JSX.Element {
  const [file, setFile] = useState<{
    name: string
    path: string
    content: string
    size: number
  } | null>(null)
  const [url, setUrl] = useState("")
  const [saving, setSaving] = useState(false)
  const targetLabel = target === "design" ? "设计原型" : "直接开发"

  const selectFile = async (): Promise<void> => {
    try {
      const selected = await window.api.file.select()
      const granted = selected.files[0]
      if (selected.canceled || !granted) return
      if (target === "development") {
        const name = granted.filePath.split(/[\\/]/).pop() || "需求文件"
        if (!/\.(docx|md|txt)$/i.test(name)) {
          throw new Error("仅支持 .docx、.md、.txt 格式的需求文件")
        }
        setFile({ name, path: granted.filePath, content: "", size: 0 })
        return
      }
      const result = await window.api.file.parseSelected(granted)
      if (!result.success || !result.attachment) {
        throw new Error(result.error || "读取需求文件失败")
      }
      const attachment = result.attachment
      if (!/\.(docx|md|txt)$/i.test(attachment.filename)) {
        throw new Error("仅支持 .docx、.md、.txt 格式的需求文件")
      }
      setFile({
        name: attachment.filename,
        path: attachment.filePath,
        content: attachment.content,
        size: attachment.size
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取需求文件失败")
    }
  }

  const confirm = async (): Promise<void> => {
    if (source === "file" && !file) return
    const normalizedUrl = url.trim()
    if (source === "link" && !normalizedUrl) return
    setSaving(true)
    try {
      const title =
        source === "file"
          ? file!.name.replace(/\.[^.]+$/, "").trim() || "需求文件"
          : (() => {
              try {
                const parsed = new URL(normalizedUrl)
                return parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname
              } catch {
                return "链接需求"
              }
            })()
      await onPrepared({
        id: `quick-${crypto.randomUUID()}`,
        title,
        sourceName: source === "file" ? file!.name : "在线需求文档",
        content: source === "file" ? file!.content : "",
        ...(file ? { sourcePath: file.path } : {}),
        ...(normalizedUrl ? { url: normalizedUrl } : {})
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "快速开始失败")
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onBack()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="px-5 pb-4 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[#f8eee4] text-[#c48654]">
              {source === "file" ? <Upload className="size-4" /> : <Link className="size-4" />}
            </span>
            {source === "file" ? "准备需求文件" : "准备需求链接"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            {source === "file" ? "选择业务发起的需求文件" : "填写业务发起的需求链接"} ·{" "}
            {targetLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="border-y border-border/70 px-5 py-4">
          {source === "file" ? (
            <button
              type="button"
              onClick={() => void selectFile()}
              className="flex min-h-36 w-full flex-col items-center justify-center rounded-xl border border-dashed border-[#d8cbbb] bg-[#fdfbf7] px-6 text-center transition-colors hover:border-[#c99366] hover:bg-[#fdf8f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Upload className="mb-2 size-6 text-[#c48654]" />
              <span className="text-sm font-semibold text-foreground">
                {file?.name || "点击选择需求文件"}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">
                {file?.size
                  ? `${Math.ceil(file.size / 1024)} KB · 文件已就绪`
                  : file
                    ? "文件已就绪"
                    : "支持 .docx / .md / .txt 文件"}
              </span>
            </button>
          ) : (
            <div>
              <label className="mb-2 block text-xs font-semibold" htmlFor="quick-requirement-link">
                需求链接
              </label>
              <div className="relative">
                <Link className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#c48654]" />
                <Input
                  id="quick-requirement-link"
                  autoFocus
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://kb.example.com/requirement/..."
                  className="h-10 bg-white pl-9"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="bg-[#fbf8f4] px-5 py-3">
          <span className="mr-auto text-[11px] text-muted-foreground">
            确认后进入{target === "design" ? "设计会话" : "项目模式会话"}
          </span>
          <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
            <ArrowLeft className="size-4" />
            返回
          </Button>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={saving || (source === "file" ? !file : !url.trim())}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saving ? "准备中..." : `开始${targetLabel}`}
            {!saving ? <ArrowRight className="size-4" /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
