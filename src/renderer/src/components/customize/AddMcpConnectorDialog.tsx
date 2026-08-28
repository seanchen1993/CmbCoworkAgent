import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, FileJson, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  McpConnectorConfig,
  McpConnectorUpsert,
  McpImportApplyResult,
  McpImportConflictStrategy,
  McpImportPreviewResult
} from "@/types"
import { resolveMcpConnectorKind } from "../../../../main/mcp/connector-kind"

export function AddMcpConnectorDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (preferredConnectorName?: string) => void
  editConnector?: McpConnectorConfig | null
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editConnector } = props
  const [name, setName] = useState(editConnector?.name ?? "")
  const [kind, setKind] = useState<"remote" | "stdio">(resolveMcpConnectorKind(editConnector))
  const [url, setUrl] = useState(editConnector?.url ?? "")
  const [command, setCommand] = useState(editConnector?.command ?? "")
  const [argsText, setArgsText] = useState(editConnector?.args?.join("\n") ?? "")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [headers, setHeaders] = useState<Array<[string, string]>>(
    editConnector?.advanced?.headers ? Object.entries(editConnector.advanced.headers) : []
  )
  const [envVars, setEnvVars] = useState<Array<[string, string]>>(
    editConnector?.env ? Object.entries(editConnector.env) : []
  )
  const [transport, setTransport] = useState<"sse" | "streamable-http" | "">(
    editConnector?.advanced?.transport ?? ""
  )
  const [reconnectEnabled, setReconnectEnabled] = useState(
    editConnector?.advanced?.reconnect?.enabled ?? false
  )
  const [reconnectMaxAttempts, setReconnectMaxAttempts] = useState(
    String(editConnector?.advanced?.reconnect?.maxAttempts ?? 3)
  )
  const [reconnectDelayMs, setReconnectDelayMs] = useState(
    String(editConnector?.advanced?.reconnect?.delayMs ?? 1000)
  )
  const [lazyLoad, setLazyLoad] = useState(editConnector?.lazyLoad ?? false)
  const [mode, setMode] = useState<"manual" | "json">("manual")
  const [jsonText, setJsonText] = useState("")
  const [jsonPreview, setJsonPreview] = useState<McpImportPreviewResult | null>(null)
  const [jsonPreviewing, setJsonPreviewing] = useState(false)
  const [conflictStrategy, setConflictStrategy] = useState<McpImportConflictStrategy>("rename")
  const [submitting, setSubmitting] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    tools?: string[]
    error?: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && editConnector) {
      setName(editConnector.name)
      setKind(resolveMcpConnectorKind(editConnector))
      setUrl(editConnector.url ?? "")
      setCommand(editConnector.command ?? "")
      setArgsText(editConnector.args?.join("\n") ?? "")
      setHeaders(
        editConnector.advanced?.headers ? Object.entries(editConnector.advanced.headers) : []
      )
      setEnvVars(editConnector.env ? Object.entries(editConnector.env) : [])
      setTransport(editConnector.advanced?.transport ?? "")
      setReconnectEnabled(editConnector.advanced?.reconnect?.enabled ?? false)
      setReconnectMaxAttempts(String(editConnector.advanced?.reconnect?.maxAttempts ?? 3))
      setReconnectDelayMs(String(editConnector.advanced?.reconnect?.delayMs ?? 1000))
      setLazyLoad(editConnector.lazyLoad ?? false)
      setMode("manual")
      setJsonText("")
      setJsonPreview(null)
      setTestResult(null)
    } else if (open && !editConnector) {
      setName("")
      setKind("remote")
      setUrl("")
      setCommand("")
      setArgsText("")
      setHeaders([])
      setEnvVars([])
      setTransport("")
      setReconnectEnabled(false)
      setReconnectMaxAttempts("3")
      setReconnectDelayMs("1000")
      setLazyLoad(false)
      setMode("manual")
      setJsonText("")
      setJsonPreview(null)
      setTestResult(null)
    }
  }, [open, editConnector])

  useEffect(() => {
    setTestResult(null)
  }, [
    name,
    kind,
    url,
    command,
    argsText,
    headers,
    envVars,
    transport,
    reconnectEnabled,
    reconnectMaxAttempts,
    reconnectDelayMs,
    lazyLoad,
    mode
  ])

  const resetForm = useCallback(() => {
    if (editConnector) {
      setName(editConnector.name)
      setKind(resolveMcpConnectorKind(editConnector))
      setUrl(editConnector.url ?? "")
      setCommand(editConnector.command ?? "")
      setArgsText(editConnector.args?.join("\n") ?? "")
      setHeaders(
        editConnector.advanced?.headers ? Object.entries(editConnector.advanced.headers) : []
      )
      setEnvVars(editConnector.env ? Object.entries(editConnector.env) : [])
      setTransport(editConnector.advanced?.transport ?? "")
      setReconnectEnabled(editConnector.advanced?.reconnect?.enabled ?? false)
      setReconnectMaxAttempts(String(editConnector.advanced?.reconnect?.maxAttempts ?? 3))
      setReconnectDelayMs(String(editConnector.advanced?.reconnect?.delayMs ?? 1000))
      setLazyLoad(editConnector.lazyLoad ?? false)
      setMode("manual")
      setJsonText("")
      setJsonPreview(null)
      setTestResult(null)
    } else {
      setName("")
      setKind("remote")
      setUrl("")
      setCommand("")
      setArgsText("")
      setHeaders([])
      setEnvVars([])
      setTransport("")
      setReconnectEnabled(false)
      setReconnectMaxAttempts("3")
      setReconnectDelayMs("1000")
      setLazyLoad(false)
      setMode("manual")
      setJsonText("")
      setJsonPreview(null)
      setTestResult(null)
    }
    setJsonPreviewing(false)
    setConflictStrategy("rename")
    setTestingConnection(false)
    setError(null)
  }, [editConnector])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetForm()
      onOpenChange(next)
    },
    [onOpenChange, resetForm]
  )

  const buildManualConfig = useCallback((): { config?: McpConnectorUpsert; error?: string } => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      return { error: "请输入名称" }
    }

    const trimmedUrl = url.trim()
    const trimmedCommand = command.trim()
    if (kind === "remote") {
      if (!trimmedUrl) {
        return { error: "请输入 MCP 服务器 URL" }
      }
      try {
        new URL(trimmedUrl)
      } catch {
        return { error: "URL 格式无效" }
      }
    } else if (!trimmedCommand) {
      return { error: "请输入启动命令" }
    }

    const headersObj: Record<string, string> = {}
    for (const [k, v] of headers) {
      if (k.trim()) headersObj[k.trim()] = v.trim()
    }
    const envObj: Record<string, string> = {}
    for (const [k, v] of envVars) {
      if (k.trim()) envObj[k.trim()] = v.trim()
    }
    const advanced: McpConnectorUpsert["advanced"] = {}
    if (Object.keys(headersObj).length > 0) advanced.headers = headersObj
    if (transport) advanced.transport = transport as "sse" | "streamable-http"
    if (reconnectEnabled) {
      advanced.reconnect = {
        enabled: true,
        maxAttempts: Math.max(1, parseInt(reconnectMaxAttempts, 10) || 3),
        delayMs: Math.max(100, parseInt(reconnectDelayMs, 10) || 1000)
      }
    }
    const args = argsText
      .split(/\r?\n/)
      .map((arg) => arg.trim())
      .filter(Boolean)

    return {
      config:
        kind === "stdio"
          ? {
              name: trimmedName,
              kind: "stdio",
              command: trimmedCommand,
              args,
              env: Object.keys(envObj).length > 0 ? envObj : undefined,
              enabled: editConnector ? editConnector.enabled : true,
              lazyLoad
            }
          : {
              name: trimmedName,
              kind: "remote",
              url: trimmedUrl,
              enabled: editConnector ? editConnector.enabled : true,
              advanced: Object.keys(advanced).length > 0 ? advanced : undefined,
              lazyLoad
            }
    }
  }, [
    name,
    kind,
    url,
    command,
    argsText,
    headers,
    envVars,
    transport,
    reconnectEnabled,
    reconnectMaxAttempts,
    reconnectDelayMs,
    lazyLoad,
    editConnector
  ])

  const handleSubmit = useCallback(async () => {
    const built = buildManualConfig()
    if (built.error || !built.config) {
      setError(built.error ?? "配置无效")
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      if (editConnector) {
        await window.api.mcp.update({ ...built.config, id: editConnector.id })
      } else {
        await window.api.mcp.create(built.config)
      }
      onSuccess(built.config.name)
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      setSubmitting(false)
    }
  }, [buildManualConfig, editConnector, onSuccess, handleOpenChange])

  const handleTestManualConnection = useCallback(async () => {
    const built = buildManualConfig()
    if (built.error || !built.config) {
      setError(built.error ?? "配置无效")
      return
    }

    setError(null)
    setTestResult(null)
    setTestingConnection(true)
    try {
      const result = await window.api.mcp.testConnection({ config: built.config })
      setTestResult(result)
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : "测试失败" })
    } finally {
      setTestingConnection(false)
    }
  }, [buildManualConfig])

  const handlePreviewJson = useCallback(async () => {
    if (!jsonText.trim()) {
      setError("请粘贴 MCP JSON 配置")
      return
    }
    setError(null)
    setJsonPreviewing(true)
    setJsonPreview(null)
    try {
      const preview = await window.api.mcp.previewImport({
        rawJson: jsonText,
        autoEnable: true
      })
      setJsonPreview(preview)
      if (preview.connectors.length === 0 && preview.errors.length > 0) {
        setError(preview.errors.join("\n"))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败")
    } finally {
      setJsonPreviewing(false)
    }
  }, [jsonText])

  const handleImportJson = useCallback(async () => {
    if (!jsonText.trim()) {
      setError("请粘贴 MCP JSON 配置")
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const result: McpImportApplyResult = await window.api.mcp.importConfig({
        rawJson: jsonText,
        autoEnable: true,
        conflictStrategy
      })
      const changedCount = result.created.length + result.updated.length
      if (changedCount > 0) {
        onSuccess(result.created[0]?.name ?? result.updated[0]?.name)
        if (result.errors.length === 0 && result.skipped.length === 0) {
          handleOpenChange(false)
          return
        }
      }

      const skippedText = result.skipped.map((item) => `${item.name}: ${item.reason}`)
      const partialMessage =
        changedCount > 0 ? [`已导入 ${changedCount} 个连接器，但有以下问题：`] : []
      setError(
        [...partialMessage, ...result.errors, ...skippedText].join("\n") || "没有导入任何连接器"
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败")
    } finally {
      setSubmitting(false)
    }
  }, [jsonText, conflictStrategy, onSuccess, handleOpenChange])

  const handleJsonFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      setJsonText(text)
      setJsonPreview(null)
      setError(null)
    } catch {
      setError("读取 JSON 文件失败")
    } finally {
      e.target.value = ""
    }
  }, [])

  const addHeader = useCallback(() => {
    setHeaders((prev) => [...prev, ["", ""]])
  }, [])

  const updateHeader = useCallback((idx: number, key: string, value: string) => {
    setHeaders((prev) => {
      const next = [...prev]
      next[idx] = [key, value]
      return next
    })
  }, [])

  const removeHeader = useCallback((idx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const addEnvVar = useCallback(() => {
    setEnvVars((prev) => [...prev, ["", ""]])
  }, [])

  const updateEnvVar = useCallback((idx: number, key: string, value: string) => {
    setEnvVars((prev) => {
      const next = [...prev]
      next[idx] = [key, value]
      return next
    })
  }, [])

  const removeEnvVar = useCallback((idx: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={`max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto_auto_auto] ${
          !editConnector && mode === "json" ? "sm:max-w-2xl" : "sm:max-w-md"
        }`}
      >
        <DialogHeader>
          <DialogTitle>{editConnector ? "编辑 MCP 连接器" : "添加 MCP 连接器"}</DialogTitle>
          <DialogDescription>连接到外部 MCP 服务器，为 Agent 提供额外工具。</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {!editConnector && (
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                className={`h-8 rounded-sm text-xs transition-colors ${
                  mode === "manual"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
                onClick={() => setMode("manual")}
              >
                手动填写
              </button>
              <button
                type="button"
                className={`h-8 rounded-sm text-xs transition-colors ${
                  mode === "json"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
                onClick={() => setMode("json")}
              >
                粘贴 JSON
              </button>
            </div>
          )}

          {mode === "manual" || editConnector ? (
            <>
              <div className="space-y-2">
                <label htmlFor="mcp-name" className="text-sm font-medium">
                  名称
                </label>
                <Input
                  id="mcp-name"
                  placeholder="例如：我的 MCP 服务"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">连接方式</label>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "remote" | "stdio")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="remote">Remote MCP server</option>
                  <option value="stdio">Local stdio command</option>
                </select>
              </div>

              {kind === "remote" ? (
                <div className="space-y-2">
                  <label htmlFor="mcp-url" className="text-sm font-medium">
                    Remote MCP server URL
                  </label>
                  <Input
                    id="mcp-url"
                    placeholder="https://..."
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="h-9"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label htmlFor="mcp-command" className="text-sm font-medium">
                      启动命令
                    </label>
                    <Input
                      id="mcp-command"
                      placeholder="例如：npx"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="mcp-args" className="text-sm font-medium">
                      命令参数
                    </label>
                    <textarea
                      id="mcp-args"
                      placeholder={"每行一个参数\n例如：--yes\n@negokaz/excel-mcp-server"}
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">按行拆分为 `args` 数组。</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium">环境变量</label>
                    <div className="mt-1 space-y-2">
                      {envVars.map(([k, v], idx) => (
                        <div key={idx} className="flex gap-2">
                          <Input
                            placeholder="Key"
                            value={k}
                            onChange={(e) => updateEnvVar(idx, e.target.value, v)}
                            className="h-8 text-xs"
                          />
                          <Input
                            placeholder="Value"
                            value={v}
                            onChange={(e) => updateEnvVar(idx, k, e.target.value)}
                            className="h-8 text-xs"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 shrink-0"
                            onClick={() => removeEnvVar(idx)}
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={addEnvVar}
                      >
                        添加环境变量
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {kind === "remote" && (
                <div>
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full py-2 text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => setAdvancedOpen((v) => !v)}
                  >
                    {advancedOpen ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                    高级设置
                  </button>
                  {advancedOpen && (
                    <div className="mt-2 space-y-3 pl-6 border-l border-border">
                      <div>
                        <label className="text-xs font-medium">自定义请求头</label>
                        <div className="mt-1 space-y-2">
                          {headers.map(([k, v], idx) => (
                            <div key={idx} className="flex gap-2">
                              <Input
                                placeholder="Key"
                                value={k}
                                onChange={(e) => updateHeader(idx, e.target.value, v)}
                                className="h-8 text-xs"
                              />
                              <Input
                                placeholder="Value"
                                value={v}
                                onChange={(e) => updateHeader(idx, k, e.target.value)}
                                className="h-8 text-xs"
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 shrink-0"
                                onClick={() => removeHeader(idx)}
                              >
                                ×
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={addHeader}
                          >
                            添加请求头
                          </Button>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium">传输类型</label>
                        <select
                          value={transport}
                          onChange={(e) =>
                            setTransport(e.target.value as "sse" | "streamable-http" | "")
                          }
                          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-3 text-xs"
                        >
                          <option value="">自动</option>
                          <option value="sse">SSE</option>
                          <option value="streamable-http">Streamable HTTP</option>
                        </select>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id="reconnect-enabled"
                            checked={reconnectEnabled}
                            onChange={(e) => setReconnectEnabled(e.target.checked)}
                          />
                          <label htmlFor="reconnect-enabled" className="text-xs font-medium">
                            启用重连
                          </label>
                        </div>
                        {reconnectEnabled && (
                          <div className="mt-2 flex gap-2">
                            <Input
                              placeholder="最大尝试次数"
                              value={reconnectMaxAttempts}
                              onChange={(e) => setReconnectMaxAttempts(e.target.value)}
                              className="h-8 text-xs"
                            />
                            <Input
                              placeholder="延迟(ms)"
                              value={reconnectDelayMs}
                              onChange={(e) => setReconnectDelayMs(e.target.value)}
                              className="h-8 text-xs"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="lazy-load"
                    checked={lazyLoad}
                    onChange={(e) => setLazyLoad(e.target.checked)}
                  />
                  <label htmlFor="lazy-load" className="text-xs font-medium">
                    懒加载
                  </label>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  启用后，工具不会立即加载到上下文中，而是通过 search_tool
                  搜索后按需加载；大结果工具可配合字段提示只返回
                  required_fields、max_array_items、max_result_chars
                  指定的必要内容。适合工具数量较多或返回内容较大的 MCP server。
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <label htmlFor="mcp-json" className="text-sm font-medium">
                  MCP JSON
                </label>
                <textarea
                  id="mcp-json"
                  placeholder={'粘贴包含 "mcpServers" 或 "mcp.servers" 的 JSON 配置'}
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value)
                    setJsonPreview(null)
                    setError(null)
                  }}
                  className="min-h-48 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs hover:bg-muted">
                    <FileJson className="size-3.5" />
                    选择 JSON 文件
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleJsonFileChange}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={handlePreviewJson}
                    disabled={jsonPreviewing || submitting}
                  >
                    {jsonPreviewing ? "解析中..." : "解析预览"}
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium">同名处理</p>
                  <p className="text-[11px] text-muted-foreground">
                    导入后默认启用，可在列表中随时关闭。
                  </p>
                </div>
                <select
                  value={conflictStrategy}
                  onChange={(e) => setConflictStrategy(e.target.value as McpImportConflictStrategy)}
                  className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="rename">自动重命名</option>
                  <option value="update">覆盖同名</option>
                  <option value="skip">跳过同名</option>
                </select>
              </div>

              {jsonPreview && (
                <div className="max-h-64 overflow-y-auto rounded-md border border-border/70">
                  {jsonPreview.connectors.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">未解析到连接器</p>
                  ) : (
                    <div className="divide-y divide-border/70">
                      {jsonPreview.connectors.map((connector, idx) => (
                        <div key={`${connector.name}-${idx}`} className="px-3 py-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <p className="min-w-0 truncate font-medium">{connector.name}</p>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {connector.conflict && (
                                <span className="rounded-sm border border-status-warning/30 bg-status-warning/10 px-1.5 py-0.5 text-[11px] text-status-warning-foreground">
                                  {connector.conflict === "existing" ? "同名" : "重复"}
                                </span>
                              )}
                              <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {connector.kind === "stdio" ? "stdio" : "remote"}
                              </span>
                            </div>
                          </div>
                          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {connector.kind === "stdio"
                              ? [connector.command ?? "", ...(connector.args ?? [])]
                                  .filter(Boolean)
                                  .join(" ")
                              : connector.url}
                          </p>
                          {(connector.hasHeaders || connector.hasEnv || connector.lazyLoad) && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {[
                                connector.hasHeaders ? "包含 headers" : "",
                                connector.hasEnv ? "包含 env" : "",
                                connector.lazyLoad ? "懒加载" : ""
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {jsonPreview?.errors.length ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {jsonPreview.errors.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          <p className="text-xs text-muted-foreground mt-2">
            MCP 连接器可访问你配置的数据与工具。请仅添加你信任的服务器。
          </p>
        </div>

        {error && (
          <p className="max-h-32 overflow-y-auto whitespace-pre-line text-sm text-destructive">
            {error}
          </p>
        )}

        {testResult && (
          <div
            className={`max-h-32 overflow-y-auto rounded-md border px-3 py-2 text-xs ${
              testResult.success
                ? "border-emerald-500/30 bg-emerald-500/5 text-muted-foreground"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            {testResult.success ? (
              <div>
                <p>连接成功，共 {testResult.tools?.length ?? 0} 个工具。</p>
                {testResult.tools && testResult.tools.length > 0 && (
                  <p className="mt-1 font-mono">
                    {testResult.tools.slice(0, 8).join(", ")}
                    {testResult.tools.length > 8
                      ? `, ... 等 ${testResult.tools.length - 8} 个`
                      : ""}
                  </p>
                )}
              </div>
            ) : (
              <p>{testResult.error}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {(mode === "manual" || editConnector) && (
            <Button
              type="button"
              variant="outline"
              onClick={handleTestManualConnection}
              disabled={submitting || testingConnection || jsonPreviewing}
            >
              <Plug className="size-3.5" />
              {testingConnection ? "测试中..." : "测试连接"}
            </Button>
          )}
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={mode === "json" && !editConnector ? handleImportJson : handleSubmit}
            disabled={submitting || jsonPreviewing}
          >
            {editConnector ? "保存" : mode === "json" ? "导入并启用" : "添加并启用"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
