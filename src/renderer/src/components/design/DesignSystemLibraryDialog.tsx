import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react"
import { ArrowLeft, Copy, Download, Globe2, LoaderCircle, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { cn } from "@/lib/utils"
import {
  clearBrowserPageConfirmation,
  setBrowserPageConfirmation,
  updateBrowserPageConfirmation
} from "@/lib/browser-page-confirmation"
import {
  openResourcePanelOverlay,
  closeResourcePanelOverlay
} from "@/lib/resource-panel-overlay-events"
import {
  DESIGN_SYSTEM_MAX_BYTES,
  type DesignSystemDraft,
  type DesignSystemInfo
} from "../../../../shared/design-system"

export type DesignSystemLibraryMode = "select" | "manage" | "inspect"

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const sourceLabel = (system: DesignSystemInfo) =>
  system.source === "web"
    ? "网页提取"
    : system.source === "file"
      ? "文件上传"
      : system.source === "builtin-copy"
        ? "内置规范副本"
        : system.ownership === "user"
          ? "我的规范"
          : "系统内置"

export function DesignSystemLibraryDialog({
  systems,
  mode,
  initialId,
  onChanged,
  onSelect,
  onClose
}: {
  systems: DesignSystemInfo[]
  mode: DesignSystemLibraryMode
  initialId?: string | null
  onChanged: () => Promise<void>
  onSelect: (system: DesignSystemInfo | null) => void
  onClose: () => void
}) {
  const initial = systems.find((item) => item.id === initialId)
  const [group, setGroup] = useState<"builtin" | "user">(
    initial?.ownership === "user" ? "user" : "builtin"
  )
  const [selectedId, setSelectedId] = useState<string | null>(
    initialId || systems.find((item) => item.isLatest !== false)?.id || null
  )
  const [loaded, setLoaded] = useState<{ system: DesignSystemInfo; content: string } | null>(null)
  const [panel, setPanel] = useState<"library" | "upload" | "capture" | "edit">("library")
  const [draft, setDraft] = useState<DesignSystemDraft | null>(null)
  const [url, setUrl] = useState("")
  const [captureSource, setCaptureSource] = useState<"url" | "current-browser">("url")
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState("")
  const [browserActive, setBrowserActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const operation = useRef(0)
  const activeRequest = useRef<string | null>(null)
  const confirmationId = useRef<string | null>(null)
  const replaceFile = useRef(false)
  const saving = useRef(false)
  const busyRef = useRef(false)
  const items = systems.filter(
    (item) =>
      item.isLatest !== false &&
      (group === "user" ? item.ownership === "user" : item.ownership !== "user")
  )

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.api.design.onSystemExtractionProgress((event) => {
      if (mounted.current && activeRequest.current === event.requestId) {
        setProgress(event.message)
        if (confirmationId.current)
          updateBrowserPageConfirmation(confirmationId.current, { message: event.message })
      }
    })
    const invalidateRequests = () => {
      operation.current++
    }
    return () => {
      mounted.current = false
      invalidateRequests()
      unsubscribe()
      if (activeRequest.current)
        void window.api.design.cancelSystemExtraction(activeRequest.current).catch(() => {})
      if (confirmationId.current) {
        clearBrowserPageConfirmation(confirmationId.current)
        closeResourcePanelOverlay("browser")
      }
    }
  }, [])

  useEffect(() => {
    let current = true
    setLoaded(null)
    setReading(false)
    if (!selectedId) return
    setReading(true)
    window.api.design
      .readSystem(selectedId)
      .then((result) => {
        if (!current) return
        if (!result.success || !result.system || result.content === undefined)
          throw new Error(result.error || "读取设计规范失败")
        setLoaded({ system: result.system, content: result.content })
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : "读取设计规范失败")
      })
      .finally(() => {
        if (current) setReading(false)
      })
    return () => {
      current = false
    }
  }, [selectedId])

  const setWorking = (value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }
  const stopCapture = () => {
    operation.current++
    const requestId = activeRequest.current
    activeRequest.current = null
    if (requestId) void window.api.design.cancelSystemExtraction(requestId).catch(() => {})
    setWorking(false)
  }
  const clearBrowser = () => {
    if (confirmationId.current) {
      clearBrowserPageConfirmation(confirmationId.current)
      confirmationId.current = null
      closeResourcePanelOverlay("browser")
    }
    if (mounted.current) setBrowserActive(false)
  }
  const close = () => {
    if (saving.current) return
    stopCapture()
    clearBrowser()
    onClose()
  }
  const showPanel = (next: typeof panel) => {
    setError(null)
    setMessage(null)
    setPanel(next)
  }
  const validateContent = (content: string) => {
    if (!content.trim()) throw new Error("设计规范内容不能为空")
    if (new Blob([content]).size > DESIGN_SYSTEM_MAX_BYTES)
      throw new Error("设计规范文件不能超过 1 MB")
    if (content.includes("\0") || content.includes("\ufffd"))
      throw new Error("请选择 UTF-8 编码的 Markdown 文本文件")
  }
  const acceptDraft = (next: DesignSystemDraft, replace: boolean) => {
    validateContent(next.content)
    setDraft((current) => (replace && current ? { ...current, content: next.content } : next))
    setPanel("edit")
    setError(null)
    if (replace) setMessage("已替换为修改稿，保存后才会更新规范。")
  }
  const selectFile = async (replace = false) => {
    if (busyRef.current) return
    const token = ++operation.current
    setWorking(true)
    setError(null)
    try {
      const result = await window.api.design.selectSystemFile()
      if (!mounted.current || token !== operation.current || result.canceled) return
      if (!result.success || !result.draft) throw new Error(result.error || "读取文件失败")
      acceptDraft(result.draft, replace)
    } catch (reason) {
      if (mounted.current && token === operation.current)
        setError(reason instanceof Error ? reason.message : "上传失败")
    } finally {
      if (mounted.current && token === operation.current) setWorking(false)
    }
  }
  const readLocalFile = async (file: File | undefined, replace: boolean) => {
    if (!file || busyRef.current) return
    const token = ++operation.current
    setWorking(true)
    setError(null)
    try {
      if (!/\.md$/i.test(file.name)) throw new Error("请选择 .md 格式的设计规范文件")
      if (file.size > DESIGN_SYSTEM_MAX_BYTES) throw new Error("设计规范文件不能超过 1 MB")
      const content = (await file.text()).replace(/^\uFEFF/, "")
      if (!mounted.current || token !== operation.current) return
      acceptDraft(
        {
          name:
            content
              .match(/^#\s+(.+)$/m)?.[1]
              ?.trim()
              .slice(0, 80) || file.name.replace(/\.md$/i, "").slice(0, 80),
          content,
          source: "file"
        },
        replace
      )
    } catch (reason) {
      if (mounted.current && token === operation.current)
        setError(reason instanceof Error ? reason.message : "读取失败")
    } finally {
      if (mounted.current && token === operation.current) setWorking(false)
    }
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    void readLocalFile(event.dataTransfer.files[0], false)
  }
  const save = async (apply: boolean) => {
    if (!draft || busyRef.current) return
    setError(null)
    try {
      validateContent(draft.content)
      if (!draft.name.trim()) throw new Error("请填写设计系统名称")
    } catch (reason) {
      setError((reason as Error).message)
      return
    }
    saving.current = true
    setWorking(true)
    try {
      const result = await window.api.design.saveSystem(draft)
      if (!result.success || !result.system) throw new Error(result.error || "保存设计规范失败")
      await onChanged()
      if (!mounted.current) return
      if (apply) {
        onSelect(result.system)
        onClose()
        return
      }
      setSelectedId(result.system.id)
      setGroup("user")
      setPanel("library")
      setDraft(null)
      setMessage("已保存到“我的”。已有设计继续使用原版本。")
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "保存失败")
    } finally {
      saving.current = false
      if (mounted.current) setWorking(false)
    }
  }
  const download = async () => {
    const content = draft?.content ?? loaded?.content
    if (!content || busyRef.current) return
    setWorking(true)
    setError(null)
    try {
      const result = await window.api.design.exportSystem(content)
      if (!mounted.current || result.canceled) return
      if (!result.success) throw new Error(result.error || "下载失败")
      setMessage("已导出 design.md，可在本地修改后重新上传。")
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "下载失败")
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  const extract = async (source: "url" | "current-browser") => {
    if (busyRef.current) return
    const requestId = crypto.randomUUID()
    const token = ++operation.current
    activeRequest.current = requestId
    setWorking(true)
    setError(null)
    setProgress("正在读取页面样式…")
    if (confirmationId.current)
      updateBrowserPageConfirmation(confirmationId.current, {
        phase: "capturing",
        error: undefined
      })
    try {
      const result = await window.api.design.extractSystem({
        requestId,
        source,
        url: source === "url" ? url.trim() : undefined
      })
      if (!mounted.current || token !== operation.current || result.canceled) return
      if (!result.success || !result.draft) throw new Error(result.error || "提取设计规范失败")
      acceptDraft(result.draft, false)
      clearBrowser()
      setMessage("提取完成。请检查规范，可在线修改或下载后重新上传。")
    } catch (reason) {
      if (mounted.current && token === operation.current) {
        const text = reason instanceof Error ? reason.message : "提取失败"
        setError(text)
        if (confirmationId.current)
          updateBrowserPageConfirmation(confirmationId.current, {
            phase: "ready",
            error: text,
            message: "请完成登录或调整目标页面后重试。"
          })
      }
    } finally {
      if (activeRequest.current === requestId) activeRequest.current = null
      if (mounted.current && token === operation.current) setWorking(false)
    }
  }
  const openBrowser = async () => {
    if (busyRef.current || confirmationId.current) return
    if (captureSource === "url") {
      try {
        const parsed = new URL(url.trim())
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error()
      } catch {
        setError("请输入不含账号密码的 HTTP 或 HTTPS 链接")
        return
      }
    }
    const id = crypto.randomUUID()
    confirmationId.current = id
    setBrowserActive(true)
    const cancel = () => {
      stopCapture()
      clearBrowser()
    }
    setBrowserPageConfirmation({
      id,
      phase: captureSource === "url" ? "opening" : "ready",
      title: "确认当前页面后提取设计规范",
      confirmLabel: "确认页面并提取规范",
      busyLabel: "正在提取规范…",
      message: "请完成登录并进入目标页面，确认后提取设计规范。",
      onConfirm: () => {
        void extract("current-browser")
      },
      onConfirmRestricted: () => {},
      onCancel: cancel,
      onEditUrl: cancel
    })
    openResourcePanelOverlay("browser")
    if (captureSource === "url") {
      try {
        const result = await window.api.design.openImportBrowser(url.trim())
        if (confirmationId.current !== id || !mounted.current) return
        updateBrowserPageConfirmation(id, {
          phase: "ready",
          error: result.success ? undefined : result.error
        })
      } catch (reason) {
        updateBrowserPageConfirmation(id, {
          phase: "ready",
          error: reason instanceof Error ? reason.message : "打开浏览器失败"
        })
      }
    }
  }

  const currentSystem = loaded?.system
  const inspect = mode === "inspect"
  const title = inspect
    ? "本次设计使用的规范"
    : panel === "library"
      ? mode === "select"
        ? "选择设计系统"
        : "设计系统库"
      : panel === "capture"
        ? "从网页提取设计规范"
        : panel === "upload"
          ? "上传 design.md"
          : draft?.baseId
            ? "更新我的设计系统"
            : "预览与修改设计规范"
  const latestUserCount = systems.filter(
    (item) => item.ownership === "user" && item.isLatest !== false
  ).length

  return (
    <Dialog
      open={!browserActive}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="flex max-h-[90vh] w-[calc(100vw_-_2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => {
          if (saving.current) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy || panel === "edit") event.preventDefault()
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <div className="flex items-center gap-2">
            {panel !== "library" && (
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label="返回设计系统库"
                onClick={() => showPanel("library")}
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>
            {inspect
              ? "本次设计固定使用此版本。库中的更新不会改变已有设计。"
              : "管理页面的色彩、字体、组件和交互规范；保存到“我的”后可重复使用。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          {panel === "library" ? (
            <>
              {!inspect && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
                  <div role="tablist" aria-label="设计系统来源" className="flex gap-1">
                    {(["builtin", "user"] as const).map((value) => (
                      <button
                        key={value}
                        id={`design-system-tab-${value}`}
                        type="button"
                        role="tab"
                        aria-controls="design-system-library-panel"
                        aria-selected={group === value}
                        className={cn(
                          "rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring",
                          group === value
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground"
                        )}
                        onClick={() => {
                          setGroup(value)
                          setSelectedId(
                            systems.find(
                              (item) =>
                                item.isLatest !== false &&
                                (value === "user"
                                  ? item.ownership === "user"
                                  : item.ownership !== "user")
                            )?.id || null
                          )
                          setError(null)
                        }}
                      >
                        {value === "builtin" ? "系统内置" : `我的 · ${latestUserCount}`}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => showPanel("upload")}>
                      <Upload className="size-3.5" />
                      上传 design.md
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => showPanel("capture")}>
                      <Globe2 className="size-3.5" />
                      从网页提取
                    </Button>
                  </div>
                </div>
              )}
              <div
                id="design-system-library-panel"
                role={inspect ? undefined : "tabpanel"}
                aria-labelledby={inspect ? undefined : `design-system-tab-${group}`}
                className={cn(
                  "grid min-h-[340px]",
                  !inspect && "md:grid-cols-[260px_minmax(0,1fr)]"
                )}
              >
                {!inspect && (
                  <div className="flex max-h-[440px] flex-col gap-2 overflow-y-auto border-b border-border p-4 md:border-b-0 md:border-r">
                    {items.length ? (
                      items.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          aria-pressed={selectedId === item.id}
                          className={cn(
                            "rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            selectedId === item.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/30"
                          )}
                          onClick={() => {
                            setSelectedId(item.id)
                            setError(null)
                          }}
                        >
                          <span className="block text-sm font-medium text-foreground">
                            {item.name}
                          </span>
                          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                            {item.description}
                          </span>
                          <span className="mt-2 block text-[11px] text-muted-foreground">
                            {item.ownership === "user"
                              ? `我的 · v${item.version || 1}`
                              : "系统内置"}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="py-8 text-sm text-muted-foreground">
                        上传文件或从网页提取，创建你的第一份设计规范。
                      </p>
                    )}
                  </div>
                )}
                <div className="min-w-0 p-5">
                  {reading ? (
                    <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                      正在读取规范…
                    </p>
                  ) : loaded && currentSystem ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-medium">{currentSystem.name}</h3>
                        <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {currentSystem.ownership === "user"
                            ? `我的 · v${currentSystem.version}`
                            : "系统内置 · 只读"}
                        </span>
                      </div>
                      <p className="mt-2 break-all text-xs text-muted-foreground">
                        来源：{sourceLabel(currentSystem)}
                        {currentSystem.sourceUrl && ` · ${currentSystem.sourceUrl}`}
                      </p>
                      <div className="mt-4 max-h-[320px] overflow-auto rounded-lg bg-muted/30">
                        <MarkdownPreview
                          content={loaded.content}
                          showHeader={false}
                          showModeToggle={false}
                          defaultExpanded
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {!inspect &&
                          (currentSystem.ownership === "user" ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setDraft({
                                    name: currentSystem.name,
                                    content: loaded.content,
                                    baseId: currentSystem.id,
                                    sourceUrl: currentSystem.sourceUrl
                                  })
                                  showPanel("edit")
                                }}
                              >
                                编辑
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setDraft({
                                    name: currentSystem.name,
                                    content: loaded.content,
                                    baseId: currentSystem.id,
                                    sourceUrl: currentSystem.sourceUrl
                                  })
                                  showPanel("edit")
                                  void selectFile(true)
                                }}
                              >
                                上传新版本
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setDraft({
                                  name: `${currentSystem.name} · 我的版本`.slice(0, 80),
                                  content: loaded.content,
                                  source: "builtin-copy"
                                })
                                showPanel("edit")
                              }}
                            >
                              <Copy className="size-3.5" />
                              复制到我的并编辑
                            </Button>
                          ))}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void download()}
                        >
                          <Download className="size-3.5" />
                          下载 design.md
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="py-8 text-sm text-muted-foreground">请选择一份设计规范。</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-5 p-6">
              <p className="text-xs text-muted-foreground">
                {panel === "edit"
                  ? "预览与修改 → 保存到我的"
                  : `${panel === "capture" ? "提取网页" : "上传文件"} → 预览与修改 → 保存到我的`}
              </p>
              {panel === "upload" && (
                <div
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                  className="space-y-3 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-8 text-center"
                >
                  <Upload className="mx-auto size-6 text-primary" />
                  <p className="text-sm font-medium">拖入 design.md，或选择文件</p>
                  <p className="text-xs text-muted-foreground">
                    支持任意文件名的 .md 文件，UTF-8 编码，最大 1 MB。
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      replaceFile.current = false
                      fileInput.current?.click()
                    }}
                  >
                    选择 .md 文件
                  </Button>
                </div>
              )}
              {panel === "capture" && (
                <>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="网页来源">
                    <Button
                      variant={captureSource === "url" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => setCaptureSource("url")}
                    >
                      粘贴链接
                    </Button>
                    <Button
                      variant={captureSource === "current-browser" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => setCaptureSource("current-browser")}
                    >
                      内置浏览器当前页
                    </Button>
                  </div>
                  {captureSource === "url" && (
                    <label className="block space-y-2 text-sm">
                      页面链接
                      <input
                        className={fieldClass}
                        type="url"
                        placeholder="https://example.com"
                        value={url}
                        disabled={busy}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                    </label>
                  )}
                  <p className="text-xs leading-5 text-muted-foreground">
                    提取当前页面的实际样式生成规范草稿。需要登录时，请在内置浏览器中完成登录并确认目标页面。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || (captureSource === "url" && !url.trim())}
                      onClick={() =>
                        captureSource === "url" ? void extract("url") : void openBrowser()
                      }
                    >
                      {busy && <LoaderCircle className="size-4 animate-spin" />}
                      {captureSource === "url" ? "开始提取" : "确认浏览器页面"}
                    </Button>
                    {captureSource === "url" && (
                      <Button
                        variant="outline"
                        disabled={busy || !url.trim()}
                        onClick={() => void openBrowser()}
                      >
                        在浏览器打开并确认
                      </Button>
                    )}
                    {activeRequest.current && (
                      <Button variant="outline" onClick={stopCapture}>
                        取消提取
                      </Button>
                    )}
                  </div>
                  {busy && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {progress}
                    </p>
                  )}
                </>
              )}
              {panel === "edit" && draft && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      {draft.baseId
                        ? "保存为新版本，已有设计保留原版本。"
                        : "保存后进入“我的”，可重复使用。"}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void download()}
                      >
                        <Download className="size-3.5" />
                        下载 design.md
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void selectFile(true)}
                      >
                        重新上传修改稿
                      </Button>
                    </div>
                  </div>
                  <label className="block space-y-2 text-sm">
                    名称
                    <input
                      className={fieldClass}
                      maxLength={80}
                      value={draft.name}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="block min-w-0 space-y-2 text-sm">
                      design.md 内容
                      <textarea
                        className={cn(
                          fieldClass,
                          "min-h-[320px] resize-y font-mono text-xs leading-6"
                        )}
                        value={draft.content}
                        disabled={busy}
                        spellCheck={false}
                        onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                      />
                    </label>
                    <div className="min-w-0">
                      <p className="mb-2 text-sm">规范预览</p>
                      <div className="max-h-[400px] overflow-auto rounded-lg border border-border">
                        <MarkdownPreview
                          content={draft.content}
                          showHeader={false}
                          showModeToggle={false}
                          defaultExpanded
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="px-6 pb-4 text-sm text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="px-6 pb-4 text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-wrap gap-2 border-t border-border px-6 py-4">
          {panel === "library" && mode === "select" && (
            <Button
              variant="ghost"
              onClick={() => {
                onSelect(null)
                onClose()
              }}
            >
              不使用设计系统
            </Button>
          )}
          <Button variant="outline" disabled={saving.current} onClick={close}>
            {panel === "edit" ? "取消" : "关闭"}
          </Button>
          {panel === "library" && mode === "select" && (
            <Button
              disabled={!loaded || reading || busy}
              onClick={() => {
                if (loaded) {
                  onSelect(loaded.system)
                  onClose()
                }
              }}
            >
              用于本次设计
            </Button>
          )}
          {panel === "edit" && (
            <>
              <Button
                variant={mode === "select" ? "outline" : "default"}
                disabled={busy || !draft?.name.trim() || !draft.content.trim()}
                onClick={() => void save(false)}
              >
                {busy && <LoaderCircle className="size-4 animate-spin" />}
                {draft?.baseId ? "保存新版本" : "保存到我的"}
              </Button>
              {mode === "select" && (
                <Button
                  disabled={busy || !draft?.name.trim() || !draft.content.trim()}
                  onClick={() => void save(true)}
                >
                  保存并用于本次设计
                </Button>
              )}
            </>
          )}
        </DialogFooter>
        <input
          ref={fileInput}
          type="file"
          accept=".md,text/markdown"
          className="hidden"
          aria-label="上传设计规范文件"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            void readLocalFile(file, replaceFile.current)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
