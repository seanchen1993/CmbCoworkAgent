import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
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
import type { McpConnectorConfig, McpConnectorUpsert } from "@/types"
import { resolveMcpConnectorKind } from "../../../../main/mcp/connector-kind"

export function AddMcpConnectorDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
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
    editConnector?.advanced?.headers
      ? Object.entries(editConnector.advanced.headers)
      : []
  )
  const [envVars, setEnvVars] = useState<Array<[string, string]>>(
    editConnector?.env
      ? Object.entries(editConnector.env)
      : []
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && editConnector) {
      setName(editConnector.name)
      setKind(resolveMcpConnectorKind(editConnector))
      setUrl(editConnector.url ?? "")
      setCommand(editConnector.command ?? "")
      setArgsText(editConnector.args?.join("\n") ?? "")
      setHeaders(editConnector.advanced?.headers ? Object.entries(editConnector.advanced.headers) : [])
      setEnvVars(editConnector.env ? Object.entries(editConnector.env) : [])
      setTransport(editConnector.advanced?.transport ?? "")
      setReconnectEnabled(editConnector.advanced?.reconnect?.enabled ?? false)
      setReconnectMaxAttempts(String(editConnector.advanced?.reconnect?.maxAttempts ?? 3))
      setReconnectDelayMs(String(editConnector.advanced?.reconnect?.delayMs ?? 1000))
      setLazyLoad(editConnector.lazyLoad ?? false)
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
    }
  }, [open, editConnector])

  const resetForm = useCallback(() => {
    if (editConnector) {
      setName(editConnector.name)
      setKind(resolveMcpConnectorKind(editConnector))
      setUrl(editConnector.url ?? "")
      setCommand(editConnector.command ?? "")
      setArgsText(editConnector.args?.join("\n") ?? "")
      setHeaders(editConnector.advanced?.headers ? Object.entries(editConnector.advanced.headers) : [])
      setEnvVars(editConnector.env ? Object.entries(editConnector.env) : [])
      setTransport(editConnector.advanced?.transport ?? "")
      setReconnectEnabled(editConnector.advanced?.reconnect?.enabled ?? false)
      setReconnectMaxAttempts(String(editConnector.advanced?.reconnect?.maxAttempts ?? 3))
      setReconnectDelayMs(String(editConnector.advanced?.reconnect?.delayMs ?? 1000))
      setLazyLoad(editConnector.lazyLoad ?? false)
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
    }
    setError(null)
  }, [editConnector])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetForm()
      onOpenChange(next)
    },
    [onOpenChange, resetForm]
  )

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError("请输入名称")
      return
    }

    const trimmedUrl = url.trim()
    const trimmedCommand = command.trim()
    if (kind === "remote") {
      if (!trimmedUrl) {
        setError("请输入 MCP 服务器 URL")
        return
      }
      try {
        new URL(trimmedUrl)
      } catch {
        setError("URL 格式无效")
        return
      }
    } else if (!trimmedCommand) {
      setError("请输入启动命令")
      return
    }

    setError(null)
    setSubmitting(true)
    try {
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

      const config: McpConnectorUpsert =
        kind === "stdio"
          ? {
              name: trimmedName,
              kind: "stdio",
              command: trimmedCommand,
              args,
              env: Object.keys(envObj).length > 0 ? envObj : undefined,
              enabled: editConnector ? editConnector.enabled : false,
              lazyLoad
            }
          : {
              name: trimmedName,
              kind: "remote",
              url: trimmedUrl,
              enabled: editConnector ? editConnector.enabled : false,
              advanced: Object.keys(advanced).length > 0 ? advanced : undefined,
              lazyLoad
            }
      console.log("mcp submit config", config, JSON.stringify(config))
      if (editConnector) {
        await window.api.mcp.update({ ...config, id: editConnector.id })
      } else {
        await window.api.mcp.create(config)
      }
      onSuccess()
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      setSubmitting(false)
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
    editConnector,
    onSuccess,
    handleOpenChange
  ])

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editConnector ? "编辑 MCP 连接器" : "添加 MCP 连接器"}</DialogTitle>
          <DialogDescription>
            连接到外部 MCP 服务器，为 Agent 提供额外工具。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="mcp-name" className="text-sm font-medium">名称</label>
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
              <label htmlFor="mcp-url" className="text-sm font-medium">Remote MCP server URL</label>
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
                <label htmlFor="mcp-command" className="text-sm font-medium">启动命令</label>
                <Input
                  id="mcp-command"
                  placeholder="例如：npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="mcp-args" className="text-sm font-medium">命令参数</label>
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
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={addEnvVar}>
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
                      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={addHeader}>
                        添加请求头
                      </Button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium">传输类型</label>
                    <select
                      value={transport}
                      onChange={(e) => setTransport(e.target.value as "sse" | "streamable-http" | "")}
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
              启用后，工具不会立即加载到上下文中，而是通过 search_tool 搜索后按需加载。适合工具数量较多的MCP server。
            </p>
          </div>

          <p className="text-xs text-muted-foreground mt-2">
            MCP 连接器可访问你配置的数据与工具。请仅添加你信任的服务器。
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {editConnector ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
