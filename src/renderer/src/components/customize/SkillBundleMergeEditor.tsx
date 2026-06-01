import { useEffect, useMemo, useState } from "react"
import { FileText, Loader2, RotateCcw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import {
  buildBundleUnifiedDiff,
  ensureTextBundleEvolverMarker,
  type TextBundleFile
} from "@/lib/skill-bundle-diff"
import { cn } from "@/lib/utils"

interface SkillBundleMergeEditorProps {
  open: boolean
  title: string
  description?: string
  baseFiles: TextBundleFile[]
  initialFiles: TextBundleFile[]
  confirmLabel?: string
  saving?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (files: TextBundleFile[]) => Promise<void> | void
}

function sortedFiles(files: TextBundleFile[]): TextBundleFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

export function SkillBundleMergeEditor({
  open,
  title,
  description,
  baseFiles,
  initialFiles,
  confirmLabel = "保存",
  saving = false,
  onOpenChange,
  onConfirm
}: SkillBundleMergeEditorProps): React.JSX.Element {
  const [draftFiles, setDraftFiles] = useState<TextBundleFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string>("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const next = sortedFiles(ensureTextBundleEvolverMarker(initialFiles))
    setDraftFiles(next)
    setSelectedPath(next.find((file) => file.path === "SKILL.md")?.path ?? next[0]?.path ?? "")
    setError(null)
  }, [initialFiles, open])

  const selectedFile = draftFiles.find((file) => file.path === selectedPath) ?? draftFiles[0] ?? null
  const diff = useMemo(() => buildBundleUnifiedDiff(baseFiles, draftFiles), [baseFiles, draftFiles])

  const updateSelectedContent = (content: string): void => {
    if (!selectedFile) return
    setDraftFiles((prev) => prev.map((file) => file.path === selectedFile.path ? { ...file, content } : file))
  }

  const resetDraft = (): void => {
    const next = sortedFiles(ensureTextBundleEvolverMarker(initialFiles))
    setDraftFiles(next)
    setSelectedPath(next.find((file) => file.path === selectedPath)?.path ?? next[0]?.path ?? "")
    setError(null)
  }

  const confirm = async (): Promise<void> => {
    try {
      setError(null)
      await onConfirm(ensureTextBundleEvolverMarker(draftFiles))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[1180px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border bg-muted/30">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              文件
            </div>
            <div className="max-h-[64vh] overflow-y-auto p-2">
              {draftFiles.map((file) => (
                <button
                  key={file.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-background",
                    selectedFile?.path === file.path && "bg-background text-foreground shadow-sm"
                  )}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono">{file.path}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 grid-rows-[minmax(240px,1fr)_minmax(220px,0.85fr)]">
            <div className="min-h-0 border-b border-border">
              <div className="flex h-9 items-center justify-between border-b border-border px-3">
                <span className="min-w-0 truncate text-xs font-mono text-muted-foreground">
                  {selectedFile?.path ?? "未选择文件"}
                </span>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={resetDraft} disabled={saving}>
                  <RotateCcw className="size-3.5" />
                  重置
                </Button>
              </div>
              <textarea
                className="h-[calc(100%-36px)] w-full resize-none bg-background p-3 font-mono text-xs leading-5 outline-none"
                spellCheck={false}
                value={selectedFile?.content ?? ""}
                onChange={(event) => updateSelectedContent(event.target.value)}
              />
            </div>
            <div className="min-h-0 overflow-y-auto bg-background">
              <DiffDisplay diff={diff} />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          {error && <p className="mr-auto self-center text-xs text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void confirm()} disabled={saving || draftFiles.length === 0}>
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
