import { useEffect, useRef, useState } from "react"
import { FileText, Link, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { rememberSkillImport, acknowledgeSkillImport } from "@/lib/skill-import-receipts"
import {
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MARKDOWN_BYTES,
  type SkillImportRequest,
  type SkillImportResult
} from "../../../../shared/skill-import"

/** Shared by the existing Cmb skills panel and Bot resources. Installation still
 * uses skills.upload, including nested-name confirmation and catalog refresh. */
export function UploadSkillDialog({
  open,
  onOpenChange,
  onSuccess
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onSuccess(uploadedSkillDirName?: string): void
}) {
  const [source, setSource] = useState("file")
  const [url, setUrl] = useState("")
  const [markdown, setMarkdown] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState<"reading" | "installing" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Extract<SkillImportResult, { success: true }> | null>(
    null
  )
  const [conflicts, setConflicts] = useState<{ name: string; relativePath: string }[]>([])
  const active = useRef<string | null>(null)
  const locked = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const live = useRef(true)
  const importId = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const id = active.current
      active.current = null
      if (id) void window.api.skills.cancelImport(id).catch(() => {})
    }
  }, [])
  const close = (value: boolean) => {
    if (busy === "installing") return
    if (!value) {
      const id = active.current
      active.current = null
      if (id) void window.api.skills.cancelImport(id).catch(() => {})
      locked.current = false
      setBusy(null)
    }
    onOpenChange(value)
  }
  const preview = async (input: SkillImportRequest) => {
    if (locked.current) return
    locked.current = true
    const id = crypto.randomUUID()
    active.current = id
    setBusy("reading")
    setError(null)
    setCandidate(null)
    setConflicts([])
    try {
      const result = await window.api.skills.previewImport(id, input)
      if (active.current !== id || !live.current) return
      if (result.success) {
        importId.current = crypto.randomUUID()
        setCandidate(result)
      } else setError(result.error)
    } catch (failure) {
      if (active.current === id && live.current)
        setError(failure instanceof Error ? failure.message : "读取技能失败")
    } finally {
      if (active.current === id) {
        active.current = null
        locked.current = false
        if (live.current) setBusy(null)
      }
    }
  }
  const readFile = async (file: File) => {
    if (locked.current) return
    if (!/\.(md|zip)$/i.test(file.name) || file.size > SKILL_IMPORT_MAX_BYTES) {
      setError("请选择不超过 5 MiB 的 .md 或 .zip 文件")
      return
    }
    const id = crypto.randomUUID()
    active.current = id
    locked.current = true
    setBusy("reading")
    setError(null)
    try {
      const buffer = await file.arrayBuffer()
      if (active.current !== id || !live.current) return
      locked.current = false
      await preview({ kind: "file", fileName: file.name, buffer })
    } catch (failure) {
      if (active.current === id && live.current)
        setError(failure instanceof Error ? failure.message : "无法读取文件")
    } finally {
      if (active.current === id) {
        active.current = null
        locked.current = false
        if (live.current) setBusy(null)
      }
    }
  }
  const readText = () => {
    const bytes = new TextEncoder().encode(markdown)
    if (bytes.byteLength > SKILL_IMPORT_MARKDOWN_BYTES) {
      setError("技能正文超过 256 KiB")
      return
    }
    void preview({ kind: "file", fileName: "SKILL.md", buffer: bytes.buffer })
  }
  const install = async (allowNestedNameDuplicates = false) => {
    if (locked.current || !candidate) return
    locked.current = true
    setBusy("installing")
    setError(null)
    try {
      importId.current = rememberSkillImport(candidate.preview.sha256, importId.current)
      const result = await window.api.skills.upload(
        candidate.file.buffer,
        candidate.file.fileName,
        {
          allowNestedNameDuplicates,
          expectedSha256: candidate.preview.sha256,
          importId: importId.current
        }
      )
      if (!live.current) return
      if (!result.success) {
        setConflicts(result.nestedNameConflicts ?? [])
        setError(result.error || "导入失败，请重试")
        return
      }
      // Losing a local acknowledgment is safe: the next attempt uses the same
      // durable install receipt. It does not turn a successful install into failure.
      try {
        acknowledgeSkillImport(candidate.preview.sha256, importId.current)
      } catch {
        /* retain retry */
      }
      setCandidate(null)
      setConflicts([])
      setMarkdown("")
      setUrl("")
      onOpenChange(false)
      onSuccess(result.skillName)
    } catch (failure) {
      if (live.current)
        setError(
          failure instanceof Error ? failure.message : "导入未确认，请在技能列表中核对后重试"
        )
    } finally {
      locked.current = false
      if (live.current) setBusy(null)
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导入技能</DialogTitle>
          <DialogDescription>导入到 CMBDevClaw 技能库，供工作台和 Bot 使用。</DialogDescription>
        </DialogHeader>
        {candidate ? (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-4">
              <div className="flex items-center gap-3">
                <FileText className="shrink-0 text-muted-foreground" size={22} />
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-medium">{candidate.preview.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {candidate.preview.resourceCount
                      ? `${candidate.preview.resourceCount} 个附属文件`
                      : "文本技能"}
                    {candidate.preview.hasHooks && " · 包含执行检查"}
                  </p>
                </div>
              </div>
              {candidate.preview.description && (
                <p className="mt-3 text-sm leading-relaxed">{candidate.preview.description}</p>
              )}
              {candidate.preview.dependencies && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {candidate.preview.dependencies.state === "structured" &&
                  candidate.preview.dependencies.checks.length
                    ? `已读取 ${candidate.preview.dependencies.checks.length} 项依赖声明；尚未核验运行环境。导入后可在 Bot 技能卡中检查。`
                    : "运行依赖未核验；兼容性文字不能作为环境已满足的依据。"}
                </p>
              )}
              {candidate.preview.compatibility && (
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                  运行要求：{candidate.preview.compatibility}
                </p>
              )}
            </div>
            <details open className="rounded-lg border p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                查看技能正文
              </summary>
              <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
                {candidate.preview.markdown}
              </pre>
            </details>
            <p className="text-xs leading-relaxed text-muted-foreground">
              将保存当前内容。后续更新由你确认；导入不会安装依赖或运行脚本，使用时沿用已有权限和审批。
            </p>
            {!!candidate.preview.unsupportedBotHooks.length && (
              <p
                role="status"
                className="rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed"
              >
                此技能需要 {candidate.preview.unsupportedBotHooks.join("、")} 检查，Bot
                暂未支持。导入后可在 CMBDevClaw 原任务中使用。
              </p>
            )}
            {!!conflicts.length && (
              <div
                role="group"
                aria-label="同名子技能确认"
                className="rounded-lg border p-3 text-xs"
              >
                <p>以下子技能与已有技能同名，仍可通过目录区分：</p>
                <ul className="mt-2 list-inside list-disc">
                  {conflicts.map((item) => (
                    <li key={item.relativePath}>
                      {item.name}（{item.relativePath}）
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-3"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void install(true)}
                >
                  仍然导入
                </Button>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setCandidate(null)
                  setConflicts([])
                  setError(null)
                }}
              >
                返回
              </Button>
              <Button disabled={!!busy || !!conflicts.length} onClick={() => void install()}>
                {busy === "installing" && (
                  <Loader2 size={14} className="motion-safe:animate-spin" />
                )}
                {busy === "installing" ? "正在导入" : "确认导入"}
              </Button>
            </div>
          </div>
        ) : (
          <Tabs
            value={source}
            onValueChange={(value) => {
              if (!busy) {
                setSource(value)
                setError(null)
              }
            }}
            className="space-y-4"
          >
            <TabsList className="grid w-full grid-cols-3" aria-label="技能导入方式">
              <TabsTrigger value="file" disabled={!!busy}>
                <Upload size={14} />
                本地文件
              </TabsTrigger>
              <TabsTrigger value="url" disabled={!!busy}>
                <Link size={14} />
                链接
              </TabsTrigger>
              <TabsTrigger value="text" disabled={!!busy}>
                <FileText size={14} />
                粘贴内容
              </TabsTrigger>
            </TabsList>
            <TabsContent value="file">
              <button
                type="button"
                disabled={!!busy}
                className={cn(
                  "flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  dragOver ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                )}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (!busy) setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragOver(false)
                  const file = event.dataTransfer.files[0]
                  if (file && !busy) void readFile(file)
                }}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={28} strokeWidth={1.5} className="text-muted-foreground" />
                <span className="text-sm">选择文件，或拖放到这里</span>
                <span className="text-xs text-muted-foreground">
                  SKILL.md 或含附属文件的 ZIP · 最大 5 MiB
                </span>
              </button>
              <input
                ref={fileInput}
                aria-label="选择技能文件"
                type="file"
                accept=".md,.zip"
                className="hidden"
                disabled={!!busy}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (file) void readFile(file)
                }}
              />
            </TabsContent>
            <TabsContent value="url" className="space-y-3">
              <Input
                aria-label="技能文件链接"
                placeholder="https://…/SKILL.md"
                value={url}
                disabled={!!busy}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && url.trim() && !busy)
                    void preview({ kind: "url", url })
                }}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                使用 Markdown 或 ZIP 的直接下载链接。需要网页登录的文件，请下载后从本地导入。
              </p>
              <Button
                disabled={!!busy || !url.trim()}
                onClick={() => void preview({ kind: "url", url })}
              >
                读取并预览
              </Button>
            </TabsContent>
            <TabsContent value="text" className="space-y-3">
              <textarea
                className="w-full resize-y rounded-lg border bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                aria-label="技能 Markdown 内容"
                rows={9}
                value={markdown}
                disabled={!!busy}
                maxLength={SKILL_IMPORT_MARKDOWN_BYTES}
                onChange={(event) => setMarkdown(event.target.value)}
                placeholder={
                  "---\nname: release-review\ndescription: 发布评审\n---\n核对变更、测试结果和回退步骤。"
                }
              />
              <Button disabled={!!busy || !markdown.trim()} onClick={readText}>
                预览技能
              </Button>
            </TabsContent>
          </Tabs>
        )}
        {busy === "reading" && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="motion-safe:animate-spin" />
            正在读取技能…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
