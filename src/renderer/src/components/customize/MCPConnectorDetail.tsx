import { useCallback, useEffect, useRef, useState } from "react"
import { Plug, Power, Trash2, Database } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { McpConnectorConfig } from "@/types"

export function MCPConnectorDetail(props: {
  connector: McpConnectorConfig | null
  onToggleEnabled: (id: string, enabled: boolean) => void
  onToggleLazyLoad: (id: string, lazyLoad: boolean) => void
  onDelete: (connector: McpConnectorConfig) => void
  onEdit: (connector: McpConnectorConfig) => void
}): React.JSX.Element {
  const { connector, onToggleEnabled, onToggleLazyLoad, onDelete, onEdit } = props
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; tools?: string[]; error?: string } | null>(null)
  const prevConnectorId = useRef<string | null>(null)

  useEffect(() => {
    if (connector?.id !== prevConnectorId.current) {
      setTestResult(null)
      setTesting(false)
      prevConnectorId.current = connector?.id ?? null
    }
  }, [connector?.id])

  const handleTest = useCallback(async () => {
    if (!connector) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.mcp.testConnection({ id: connector.id })
      setTestResult(res)
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : "测试失败" })
    } finally {
      setTesting(false)
    }
  }, [connector])

  if (!connector) {
    return (
      <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
        <div className="max-w-md space-y-6">
          <div className="text-center space-y-3">
            <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
              <Plug className="size-7 text-muted-foreground/60" />
            </div>
            <h3 className="text-lg font-semibold text-foreground/80">MCP 连接器</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              MCP（Model Context Protocol）是一种开放协议，让 AI 能够连接远程工具服务器。通过 MCP 连接器，AI 可以调用服务器提供的各种工具（Tools），从而获取外部数据、执行远程操作，大幅扩展能力边界。
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">什么是 MCP？</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                MCP 服务器是一个远程服务，它向 AI 暴露一组工具（Tools）。AI 在对话过程中会根据需要自动调用这些工具来获取信息或执行操作。例如，一个搜索类 MCP 可以让 AI 直接查询网络信息并返回结果。当前支持 <span className="font-medium text-foreground/60">SSE</span> 和 <span className="font-medium text-foreground/60">Streamable HTTP</span> 两种传输协议，也可设为自动检测。
              </p>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">如何添加？</p>
              <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                <li className="flex gap-2"><span className="text-foreground/40 shrink-0">1.</span>点击 <span className="font-medium text-foreground/60">+</span> 按钮，填写连接器名称和远程服务器 URL</li>
                <li className="flex gap-2"><span className="text-foreground/40 shrink-0">2.</span>可选择传输类型（SSE / Streamable HTTP / 自动），并配置自定义请求头</li>
                <li className="flex gap-2"><span className="text-foreground/40 shrink-0">3.</span>保存后点击「测试连接」验证是否可用，成功后会显示服务器提供的工具列表</li>
                <li className="flex gap-2"><span className="text-foreground/40 shrink-0">4.</span>还可配置断线重连策略：最大重试次数和重连延迟</li>
              </ul>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium text-foreground/70">适用场景</p>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                网络搜索、知识库检索、代码仓库操作、项目管理工具集成、消息通知推送……几乎任何提供 MCP 协议接口的远程服务都可以接入。连接器支持随时启用 / 禁用，不影响其他功能。
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold truncate">{connector.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{connector.url}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (confirm(`确定要删除连接器「${connector.name}」吗？`)) onDelete(connector)
            }}
          >
            <Trash2 className="size-3" />
            删除
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onEdit(connector)}>
            编辑
          </Button>
          <Button
            variant={connector.enabled ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onToggleEnabled(connector.id, !connector.enabled)}
          >
            <Power className="size-3" />
            {connector.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? "测试中..." : "测试连接"}
        </Button>
        {testResult && (
          <div className={cn("mt-2 text-xs", testResult.success ? "text-muted-foreground" : "text-destructive")}>
            {testResult.success ? (
              <div>
                <p>连接成功，共 {testResult.tools?.length ?? 0} 个工具：</p>
                {testResult.tools && testResult.tools.length > 0 && (
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {testResult.tools.slice(0, 10).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                    {testResult.tools.length > 10 && (
                      <li className="text-muted-foreground">... 等 {testResult.tools.length - 10} 个</li>
                    )}
                  </ul>
                )}
              </div>
            ) : (
              <p>{testResult.error}</p>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">懒加载</p>
            <p className="text-xs text-muted-foreground">
              {connector.lazyLoad
                ? "工具通过 search_tool 搜索后按需加载"
                : "所有工具直接加载到上下文中"}
            </p>
          </div>
          <Button
            variant={connector.lazyLoad ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onToggleLazyLoad(connector.id, !connector.lazyLoad)}
          >
            <Database className="size-3" />
            {connector.lazyLoad ? "已开启" : "已关闭"}
          </Button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground">
          MCP 连接器可访问你配置的数据与工具。请仅添加你信任的服务器。
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4" />
      </ScrollArea>
    </div>
  )
}
