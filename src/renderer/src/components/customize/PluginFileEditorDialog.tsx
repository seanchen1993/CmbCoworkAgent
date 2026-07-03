import { useCallback, useEffect, useMemo, useState } from "react"
import { File, FileText, Loader2, Lock, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { PluginMetadata } from "@/types"

interface PluginFile {
  path: string
  relativePath: string
  editable: boolean
}

interface Props {
  plugin: PluginMetadata | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Pending dirty-state action awaiting user confirmation.
 *
 * - `close`: the parent Dialog wants to close while the draft is unsaved.
 * - `switch`: another file in the tree was clicked while the draft is unsaved.
 *
 * We funnel both through one shared confirmation Dialog so the UI doesn't
 * fall back to the blocking native `window.confirm` (style + a11y mismatch
 * with the rest of the app).
 */
type PendingAction = { kind: "close" } | { kind: "switch"; path: string } | null

/**
 * Lightweight in-app editor for files inside a user-uploaded plugin.
 *
 * - Files are listed read-only (no add/delete/rename). Edit happens in place.
 * - Only the `editable` flag from main decides whether the textarea is live;
 *   everything else (manifest, hooks, MCP, binaries) renders as inspectable
 *   text only. The renderer never bypasses that flag — the actual write IPC
 *   has the same gate as a defence in depth.
 */
export function PluginFileEditorDialog({ plugin, open, onOpenChange }: Props): React.JSX.Element {
  const [files, setFiles] = useState<PluginFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string>("")
  const [draft, setDraft] = useState<string>("")
  const [loadingList, setLoadingList] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  // Mirrors the IPC's write-gate (`origin === "local"`). Legacy installs and
  // self-published market plugins fail the origin check even though the
  // PluginsPanel entry button is visible to them. Surface that as a banner +
  // disabled textarea here so the user never types into a doomed save.
  const [pluginEditable, setPluginEditable] = useState<boolean>(true)

  const dirty = draft !== content

  const loadFiles = useCallback(async () => {
    if (!plugin) return
    setLoadingList(true)
    setSelectedPath(null)
    setContent("")
    setDraft("")
    try {
      const res = await window.api.plugins.listFiles(plugin.id)
      if (!res.success || !res.files) {
        toast.error(res.error || "加载文件失败")
        setFiles([])
        setPluginEditable(false)
        return
      }
      setFiles(res.files)
      // Older IPC responses may omit `pluginEditable` — treat omission as
      // not-editable (safe default) so the UI defers to the backend gate.
      setPluginEditable(res.pluginEditable === true)
      // Auto-select the first editable file so the editor isn't empty on open.
      const firstEditable = res.files.find((f) => f.editable)
      if (firstEditable) setSelectedPath(firstEditable.path)
      else if (res.files[0]) setSelectedPath(res.files[0].path)
    } finally {
      setLoadingList(false)
    }
  }, [plugin])

  useEffect(() => {
    if (open && plugin) {
      void loadFiles()
    } else {
      setFiles([])
      setSelectedPath(null)
      setContent("")
      setDraft("")
      setPendingAction(null)
      setPluginEditable(true)
    }
  }, [open, plugin, loadFiles])

  useEffect(() => {
    if (!plugin || !selectedPath) {
      setContent("")
      setDraft("")
      return
    }
    let cancelled = false
    setLoadingFile(true)
    void (async () => {
      const res = await window.api.plugins.readFile(plugin.id, selectedPath)
      if (cancelled) return
      if (!res.success) {
        toast.error(res.error || "读取文件失败")
        setContent("")
        setDraft("")
      } else {
        const text = res.content ?? ""
        setContent(text)
        setDraft(text)
      }
      setLoadingFile(false)
    })()
    return () => {
      cancelled = true
    }
  }, [plugin, selectedPath])

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!plugin || !selectedPath || !dirty || saving) return false
    if (!pluginEditable) return false
    const file = files.find((f) => f.path === selectedPath)
    if (!file?.editable) return false
    setSaving(true)
    try {
      const res = await window.api.plugins.writeFile(plugin.id, selectedPath, draft)
      if (!res.success) {
        toast.error(res.error || "保存失败")
        return false
      }
      setContent(draft)
      toast.success("已保存")
      return true
    } finally {
      setSaving(false)
    }
  }, [plugin, selectedPath, dirty, draft, files, saving, pluginEditable])

  // Funnel dialog-close requests through the dirty check so a stray Escape
  // press or backdrop click doesn't silently discard an edit.
  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true)
        return
      }
      if (dirty) {
        setPendingAction({ kind: "close" })
        return
      }
      onOpenChange(false)
    },
    [dirty, onOpenChange]
  )

  // Switching files mid-edit is just as destructive as closing — same guard.
  const requestSwitchFile = useCallback(
    (path: string) => {
      if (path === selectedPath) return
      if (dirty) {
        setPendingAction({ kind: "switch", path })
        return
      }
      setSelectedPath(path)
    },
    [dirty, selectedPath]
  )

  const handleDiscardPending = useCallback(() => {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.kind === "close") {
      onOpenChange(false)
    } else {
      setSelectedPath(action.path)
    }
  }, [pendingAction, onOpenChange])

  const handleCancelPending = useCallback(() => {
    setPendingAction(null)
  }, [])

  // Ctrl+S / Cmd+S to save. Only active while the dialog is open and the
  // current file is editable. We attach to the dialog root via ref delegation
  // through the textarea wrapper, and also catch the global key when focus
  // is anywhere inside the dialog content.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      const isSaveCombo = (e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")
      if (!isSaveCombo) return
      // Don't hijack when the confirmation modal is up — its buttons should
      // own the keyboard.
      if (pendingAction) return
      e.preventDefault()
      void handleSave()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [open, pendingAction, handleSave])

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath]
  )
  // Mirror the backend write-gate exactly: a file is writable iff the plugin
  // itself is editable (origin === "local") AND the file extension is in the
  // text allowlist. Using one derived flag keeps every UI control (save
  // button, textarea, badges) in lockstep with the IPC's actual decision.
  const canEditCurrent = pluginEditable && Boolean(selectedFile?.editable)

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          className="!max-w-[min(90vw,1100px)] !w-[min(90vw,1100px)] h-[80vh] flex flex-col p-0 gap-0"
        >
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0">
            <DialogTitle className="flex items-center gap-2">
              编辑插件文件
              {plugin && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                  {plugin.name}
                </Badge>
              )}
              {!pluginEditable && !loadingList && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-1">
                  <Lock className="size-2.5" />
                  整个插件只读
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {pluginEditable
                ? "支持编辑大多数文本文件（SKILL.md / README / 配置 / 脚本）。修改 manifest / hooks / MCP 配置后，请在插件列表里禁用再启用一次，配置才会重新加载。"
                : "此插件不是由本地上传安装，仅支持查看内容。如需修改，请先重新本地上传一份副本。"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 flex">
            {/* Left — file tree */}
            <div className="w-64 shrink-0 border-r border-border bg-muted/20 flex flex-col">
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border/60">
                文件
              </div>
              <ScrollArea className="flex-1">
                {loadingList ? (
                  <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 size-3.5 animate-spin" />
                    加载中…
                  </div>
                ) : files.length === 0 ? (
                  <div className="p-4 text-xs text-muted-foreground">没有可显示的文件</div>
                ) : (
                  <ul className="p-1.5">
                    {files.map((file) => {
                      const isSelected = file.path === selectedPath
                      const Icon = file.editable ? FileText : File
                      return (
                        <li key={file.path}>
                          <button
                            type="button"
                            onClick={() => requestSwitchFile(file.path)}
                            className={cn(
                              "w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 text-xs transition-colors",
                              isSelected
                                ? "bg-background border border-border shadow-sm"
                                : "hover:bg-muted/60",
                              !file.editable && "text-muted-foreground"
                            )}
                            title={file.relativePath}
                          >
                            <Icon className="size-3.5 shrink-0" />
                            <span className="truncate flex-1">{file.relativePath}</span>
                            {!file.editable && <Lock className="size-3 shrink-0" />}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </ScrollArea>
            </div>

            {/* Right — editor */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0">
                <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                  {selectedFile?.relativePath ?? "未选择文件"}
                </span>
                {selectedFile && !canEditCurrent && (
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-1">
                    <Lock className="size-2.5" />
                    只读
                  </Badge>
                )}
                {canEditCurrent && dirty && (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                    未保存
                  </Badge>
                )}
                <Button
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  disabled={!canEditCurrent || !dirty || saving}
                  onClick={() => void handleSave()}
                  title="保存 (Ctrl+S)"
                >
                  {saving ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  保存
                </Button>
              </div>
              <div className="flex-1 min-h-0">
                {!selectedFile ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    从左侧选择一个文件
                  </div>
                ) : loadingFile ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    正在读取…
                  </div>
                ) : canEditCurrent ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-full resize-none px-4 py-3 font-mono text-sm bg-background outline-none"
                  />
                ) : (
                  <pre className="w-full h-full overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap break-all bg-muted/20 text-muted-foreground">
                    {content}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingAction !== null} onOpenChange={(v) => !v && handleCancelPending()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogDescription>
              {pendingAction?.kind === "close"
                ? "当前文件存在未保存的修改，关闭后将丢失。"
                : "当前文件存在未保存的修改，切换后将丢失。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={handleCancelPending}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDiscardPending}>
              放弃修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
