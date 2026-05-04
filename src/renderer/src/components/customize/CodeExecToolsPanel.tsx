import { useCallback, useEffect, useMemo, useState } from "react"
import {
  FileCode2,
  Loader2,
  Play,
  Save,
  Trash2,
  Wrench
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { ManagedSavedCodeExecTool, SavedCodeExecPreviewResult } from "@/types"

interface EditorState {
  toolName: string
  description: string
  code: string
  timeoutMs: string
  paramsText: string
}

interface SuccessfulPreviewState {
  code: string
  params: Record<string, unknown>
  paramsText: string
  output: string
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const TIMEOUT_MIN = 1_000
const TIMEOUT_MAX = 120_000

function getToolStatusBadgeClass(enabled: boolean): string {
  return enabled
    ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : "border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
}

function getToolToggleButtonClass(enabled: boolean): string {
  return enabled
    ? "border-amber-500/30 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
    : "border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
}

function createEditorState(tool: ManagedSavedCodeExecTool): EditorState {
  return {
    toolName: tool.toolName,
    description: tool.description,
    code: tool.code,
    timeoutMs: String(tool.timeoutMs),
    paramsText: formatParamsText(tool.lastPreviewParams)
  }
}

function formatParamsText(params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) {
    return "{\n  \n}"
  }

  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return "{\n  \n}"
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatStructuredValue(value: unknown): string {
  if (value == null) return "暂无"
  if (typeof value === "string") return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseParamsText(
  paramsText: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = paramsText.trim()
  if (!trimmed) {
    return { ok: true, value: {} }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "params 必须是 JSON 对象" }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "params JSON 解析失败"
    }
  }
}

function isToolDirty(tool: ManagedSavedCodeExecTool, editor: EditorState | null): boolean {
  if (!editor) return false
  return (
    tool.toolName !== editor.toolName ||
    tool.description !== editor.description ||
    tool.code !== editor.code ||
    tool.timeoutMs !== Number(editor.timeoutMs.trim())
  )
}

function getToolNameError(toolName: string): string | null {
  const normalized = toolName.replace(/^saved__?/i, "").trim()
  if (!normalized) {
    return "tool_name 不能为空"
  }

  if (!TOOL_NAME_PATTERN.test(normalized)) {
    return "tool_name 仅支持英文、数字、下划线(_)和短横线(-)，不能包含中文、空格或其他符号"
  }

  return null
}

function parseTimeoutText(timeoutText: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = timeoutText.trim()
  if (!trimmed) {
    return { ok: false, error: "timeout 不能为空" }
  }

  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < TIMEOUT_MIN || parsed > TIMEOUT_MAX) {
    return { ok: false, error: `超时时间必须在 ${TIMEOUT_MIN}ms 到 ${TIMEOUT_MAX}ms 之间` }
  }

  return { ok: true, value: parsed }
}

export function CodeExecToolsPanel(): React.JSX.Element {
  const [tools, setTools] = useState<ManagedSavedCodeExecTool[]>([])
  const [codeExecEnabled, setCodeExecEnabled] = useState(true)
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runResult, setRunResult] = useState<SavedCodeExecPreviewResult | null>(null)
  const [lastSuccessfulPreview, setLastSuccessfulPreview] = useState<SuccessfulPreviewState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadTools = useCallback(async (preferredToolId?: string) => {
    setLoading(true)
    setLoadError(null)

    try {
      const [nextTools, settings] = await Promise.all([
        window.api.codeExecTools.list(),
        window.api.codeExecTools.getSettings()
      ])
      setTools(nextTools)
      setCodeExecEnabled(settings.codeExecEnabled)
      setSelectedToolId((current) => {
        const candidate = preferredToolId ?? current
        if (candidate && nextTools.some((tool) => tool.toolId === candidate)) {
          return candidate
        }
        return null
      })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载工具列表失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTools()
  }, [loadTools])

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.toolId === selectedToolId) ?? null,
    [selectedToolId, tools]
  )

  useEffect(() => {
    if (!selectedTool) {
      setEditor(null)
      setRunResult(null)
      setLastSuccessfulPreview(null)
      return
    }

    setEditor(createEditorState(selectedTool))
    setRunResult(null)
    setLastSuccessfulPreview(null)
  }, [selectedToolId])

  useEffect(() => {
    setActionError(null)
  }, [selectedToolId])

  const dirty = selectedTool ? isToolDirty(selectedTool, editor) : false
  const timeoutValidation = editor ? parseTimeoutText(editor.timeoutMs) : null
  const codeChanged = selectedTool && editor ? selectedTool.code !== editor.code : false
  const matchedPreview =
    selectedTool && editor && lastSuccessfulPreview
      ? (
          lastSuccessfulPreview.code === editor.code &&
          lastSuccessfulPreview.paramsText === editor.paramsText
            ? lastSuccessfulPreview
            : null
        )
      : null
  const saveBlockedByPreview = Boolean(codeChanged && !matchedPreview)
  const visibleActionMessage =
    actionMessage &&
    !actionMessage.includes("已启用") &&
    !actionMessage.includes("已关闭") &&
    !actionMessage.includes("工具已保存")
      ? actionMessage
      : null

  const handleRunPreview = useCallback(async () => {
    if (!selectedTool || !editor) return

    const parsedTimeout = parseTimeoutText(editor.timeoutMs)
    if (!parsedTimeout.ok) {
      setActionError(parsedTimeout.error)
      setActionMessage(null)
      return
    }

    const parsedParams = parseParamsText(editor.paramsText)
    if (!parsedParams.ok) {
      setActionError(parsedParams.error)
      setActionMessage(null)
      return
    }

    setRunning(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const result = await window.api.codeExecTools.runPreview({
        code: editor.code,
        params: parsedParams.value,
        timeoutMs: parsedTimeout.value
      })

      setRunResult(result)
      if (result.ok) {
        try {
          const updatedTool = await window.api.codeExecTools.setLastPreviewParams(selectedTool.toolId, parsedParams.value)
          setTools((prev) => prev.map((tool) => (tool.toolId === updatedTool.toolId ? updatedTool : tool)))
        } catch (error) {
          console.warn("[code_exec_tools] failed to persist preview params:", error)
        }

        setLastSuccessfulPreview({
          code: editor.code,
          params: parsedParams.value,
          paramsText: editor.paramsText,
          output: result.output
        })
      } else {
        setLastSuccessfulPreview(null)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "试运行失败")
      setActionMessage(null)
    } finally {
      setRunning(false)
    }
  }, [editor, selectedTool])

  const handleSave = useCallback(async () => {
    if (!selectedTool || !editor) return
    const nextToolNameError = getToolNameError(editor.toolName)
    if (nextToolNameError) {
      setActionError(nextToolNameError)
      setActionMessage(null)
      return
    }

    const parsedTimeout = parseTimeoutText(editor.timeoutMs)
    if (!parsedTimeout.ok) {
      setActionError(parsedTimeout.error)
      setActionMessage(null)
      return
    }

    if (selectedTool.code !== editor.code && !matchedPreview) {
      setActionError("代码已修改，请先试运行成功后再保存")
      setActionMessage(null)
      return
    }

    setSaving(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const updated = await window.api.codeExecTools.update({
        id: selectedTool.toolId,
        toolName: editor.toolName,
        description: editor.description,
        code: editor.code,
        timeoutMs: parsedTimeout.value,
        ...(matchedPreview
          ? {
              previewParams: matchedPreview.params,
              previewOutput: matchedPreview.output
            }
          : {})
      })

      await loadTools(updated.toolId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }, [editor, loadTools, matchedPreview, selectedTool])

  const handleDelete = useCallback(async () => {
    if (!selectedTool) return
    const confirmed = window.confirm(`确认删除工具 ${selectedTool.toolName} 吗？`)
    if (!confirmed) return

    setDeleting(true)
    setActionError(null)
    setActionMessage(null)

    try {
      await window.api.codeExecTools.delete(selectedTool.toolId)
      await loadTools()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }, [loadTools, selectedTool])

  const handleToggleToolEnabled = useCallback(async () => {
    if (!selectedTool) return

    setActionError(null)
    setActionMessage(null)

    try {
      const updated = await window.api.codeExecTools.setEnabled(selectedTool.toolId, !selectedTool.enabled)
      setTools((prev) => prev.map((tool) => (tool.toolId === updated.toolId ? updated : tool)))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "切换启用状态失败")
    }
  }, [selectedTool])

  const handleToggleCodeExecEnabled = useCallback(async () => {
    const next = !codeExecEnabled
    setActionError(null)
    setActionMessage(null)

    try {
      await window.api.codeExecTools.setCodeExecEnabled(next)
      setCodeExecEnabled(next)
      setActionMessage(next ? "code_exec 已启用" : "code_exec 已关闭")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "切换 code_exec 状态失败")
    }
  }, [codeExecEnabled])

  return (
    <>
      <div className="w-[340px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-bold truncate">编程式工具调用</h2>
            </div>
            <label className="flex shrink-0 items-center gap-1.5 cursor-pointer">
              <span className="text-xs text-muted-foreground">
                {codeExecEnabled ? "已启用" : "已关闭"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={codeExecEnabled}
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  codeExecEnabled ? "bg-primary" : "bg-muted-foreground/30"
                )}
                onClick={handleToggleCodeExecEnabled}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-3 rounded-full bg-white shadow-sm transition-transform",
                    codeExecEnabled ? "translate-x-3" : "translate-x-0"
                  )}
                />
              </button>
            </label>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {loadError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {loadError}
              </div>
            ) : tools.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-3">
                暂无自主生成工具
              </p>
            ) : (
              tools.map((tool) => (
                <button
                  key={tool.toolId}
                  className={cn(
                    "w-full rounded-md border border-border/70 px-3 py-2 text-left transition-colors",
                    !tool.enabled && "opacity-70",
                    selectedTool?.toolId === tool.toolId ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedToolId(tool.toolId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{tool.toolName}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        getToolStatusBadgeClass(tool.enabled)
                      )}
                    >
                      {tool.enabled ? "已启用" : "已关闭"}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {tool.toolId}
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {tool.description || "暂无描述"}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1 overflow-auto">
        {selectedTool && editor ? (
          <div className="p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Wrench className="size-4 text-emerald-500 shrink-0" />
                  <h3 className="truncate text-base font-bold">编辑工具编排</h3>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!dirty || saving || running || deleting || !timeoutValidation?.ok || saveBlockedByPreview}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存修改
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleToolEnabled}
                  className={getToolToggleButtonClass(selectedTool.enabled)}
                  disabled={deleting || saving || running || dirty}
                >
                  {selectedTool.enabled ? "关闭" : "启用"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting || saving || running}
                >
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  删除
                </Button>
              </div>
            </div>

            {actionError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {actionError}
              </div>
            )}
            {visibleActionMessage && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                {visibleActionMessage}
              </div>
            )}

            <div className="space-y-6">
              <section className="grid items-stretch gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                <section className="flex h-full flex-col space-y-4 rounded-sm border border-border bg-muted/10 p-3">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">工具名</label>
                    <Input
                      value={editor.toolName}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, toolName: event.target.value } : current
                        )
                      }
                      placeholder="例如：list_github_issues"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      仅支持英文、数字、下划线(_)和短横线(-)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground"> 超时</label>
                    <Input
                      value={editor.timeoutMs}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, timeoutMs: event.target.value } : current
                        )
                      }
                      inputMode="numeric"
                      placeholder="20000"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      工具的超时时间。范围 {TIMEOUT_MIN}ms - {TIMEOUT_MAX}ms
                    </p>
                    {timeoutValidation && !timeoutValidation.ok ? (
                      <p className="text-[11px] text-destructive">{timeoutValidation.error}</p>
                    ) : null}
                  </div>

                  <div className="flex flex-1 flex-col space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">工具描述</label>
                    <textarea
                      value={editor.description}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, description: event.target.value } : current
                        )
                      }
                      className="min-h-[104px] flex-1 rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </section>

                <section className="flex h-full flex-col space-y-3 rounded-sm border border-border bg-muted/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">试运行</h4>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRunPreview}
                      disabled={running || saving || deleting}
                    >
                      {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                      运行
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">工具入参</label>
                    <textarea
                      value={editor.paramsText}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, paramsText: event.target.value } : current
                        )
                      }
                      className="min-h-[72px] w-full rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-2 rounded-sm border border-border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">运行结果</span>
                      {runResult && (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            runResult.ok
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-destructive/10 text-destructive"
                          )}
                        >
                          {runResult.ok ? "成功" : runResult.stage || "失败"}
                        </span>
                      )}
                    </div>

                    <pre className="max-h-[112px] overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5">
                      {runResult
                        ? formatStructuredValue(runResult.ok ? runResult.parsedOutput ?? runResult.output : runResult.output)
                        : "填写入参后点击“运行”查看结果"}
                    </pre>

                    {runResult?.logs?.length ? (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">logs</div>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5">
                          {runResult.logs.join("\n")}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </section>
              </section>

              <Separator />

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium text-muted-foreground">code</label>
                    {codeChanged ? (
                      <span
                        className={cn(
                          "text-[11px]",
                          matchedPreview
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-amber-700 dark:text-amber-400"
                        )}
                      >
                        {matchedPreview
                          ? "当前代码已试运行成功，可以保存"
                          : "修改后需试运行成功才可保存"}
                      </span>
                    ) : null}
                  </div>
                </div>
                <textarea
                  value={editor.code}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, code: event.target.value } : current
                    )
                  }
                  className="min-h-[360px] w-full rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  spellCheck={false}
                />
              </section>

              <Separator />

              <div className="grid gap-6 xl:grid-cols-2">
                <section className="space-y-4 rounded-sm border border-border p-4">
                  <h4 className="text-sm font-semibold">详情</h4>
                  <DetailRow label="tool_id" value={selectedTool.toolId} mono />
                  <DetailRow label="创建时间" value={formatTime(selectedTool.createdAt)} />
                  <DetailRow label="更新时间" value={formatTime(selectedTool.updatedAt)} />
                  <DetailRow
                    label="依赖"
                    value={selectedTool.dependencies.length ? selectedTool.dependencies.join(", ") : "暂无"}
                    mono
                  />
                </section>

                <JsonBlock title="input_schema" value={selectedTool.inputSchema} />
              </div>
            </div>
          </div>
        ) : (
          <EmptyState loading={loading} />
        )}
      </div>
    </>
  )
}

function DetailRow(props: { label: string; value: string; mono?: boolean; valueClassName?: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{props.label}</div>
      <div className={cn("text-sm break-all", props.mono && "font-mono text-xs", props.valueClassName)}>
        {props.value}
      </div>
    </div>
  )
}

function JsonBlock(props: { title: string; value: unknown }): React.JSX.Element {
  return (
    <section className="space-y-2 rounded-sm border border-border p-4">
      <h4 className="text-sm font-semibold">{props.title}</h4>
      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/20 px-3 py-2 font-mono text-xs leading-5">
        {formatStructuredValue(props.value)}
      </pre>
    </section>
  )
}

function EmptyState(props: { loading: boolean }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
      {props.loading ? (
        <div className="flex h-full flex-col items-center justify-center px-8 py-12 text-center">
          <Loader2 className="mb-4 size-10 animate-spin text-muted-foreground/60" />
          <h3 className="text-base font-bold">编程式工具调用</h3>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            正在加载已保存的 code_exec 工具...
          </p>
        </div>
      ) : (
        <div className="w-full max-w-3xl space-y-5">
          <div className="rounded-2xl border border-border/60 bg-muted/25 p-6">
            <div className="flex items-start gap-4">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
                <FileCode2 className="size-7 text-muted-foreground/60" />
              </div>
              <div className="min-w-0 space-y-2">
                <h3 className="text-lg font-semibold text-foreground/80">编程式工具调用</h3>
                <p className="text-sm leading-7 text-muted-foreground">
                  <span className="font-mono text-foreground/70">code_exec</span> 是内置工具，支持在 JS 脚本中编排多个 MCP
                  工具调用，可以减少 LLM 的调用次数、减少限流。支持将脚本沉淀为内置工具，让 CmbDevClaw 越用越好用。
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-muted/25 p-6 space-y-4">
            <p className="text-sm font-medium text-foreground/70">使用方式</p>

            <div className="space-y-3">
              <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-xl border border-border/60 bg-background/70 px-4 py-3">
                <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  1
                </div>
                <p className="text-[13px] leading-6 text-muted-foreground">
                  在需要连续调用多个 MCP 工具时，CmbDevClaw 会主动尝试使用
                  <span className="font-mono text-foreground/70">code_exec</span> 一步完成。您也可以在多步连续 MCP 工具调用成功后主动提示使用
                   <span className="font-mono text-foreground/70">code_exec</span> 工具再运行一次。
                </p>
              </div>

              <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-xl border border-border/60 bg-background/70 px-4 py-3">
                <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  2
                </div>
                <p className="text-[13px] leading-6 text-muted-foreground">
                  <span className="font-mono text-foreground/70">code_exec</span> 执行成功后会询问是否要保存为内置工具。
                </p>
              </div>

              <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-xl border border-border/60 bg-background/70 px-4 py-3">
                <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  3
                </div>
                <p className="text-[13px] leading-6 text-muted-foreground">
                  在当前页面可以对注册为工具的 JS 脚本进行启用、管理、编辑和试运行，更合理的工具描述和工具名称有助于 CmbDevClaw 能更好地发现、使用当前工具。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
