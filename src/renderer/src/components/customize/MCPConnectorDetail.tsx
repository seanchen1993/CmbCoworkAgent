import { useCallback, useEffect, useRef, useState } from "react"
import { Plug, Power, Trash2, Database, Store } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { McpConnectorConfig } from "@/types"
import { resolveMcpConnectorKind } from "../../../../main/mcp/connector-kind"

function getConnectorSummary(connector: McpConnectorConfig): string {
  if (resolveMcpConnectorKind(connector) === "stdio") {
    return [connector.command ?? "", ...(connector.args ?? [])].filter(Boolean).join(" ")
  }
  return connector.url ?? ""
}

function ProjectionGuide({ lazyLoad }: { lazyLoad?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">按需读取结果</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {lazyLoad
          ? "处理大量数据时，可以在任务中指定需要的字段和数量，减少无关内容。"
          : "开启懒加载后，可按任务需要查找工具，并限制返回的数据量。"}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        例如：查最近 20 条未关闭工单，只返回标题、状态和负责人。
      </p>
    </div>
  )
}

export function MCPConnectorDetail(props: {
  connector: McpConnectorConfig | null
  onToggleEnabled: (id: string, enabled: boolean) => void
  onToggleLazyLoad: (id: string, lazyLoad: boolean) => void
  onDelete: (connector: McpConnectorConfig) => void
  onEdit: (connector: McpConnectorConfig) => void
  onPublish?: (connector: McpConnectorConfig) => void
  publishLabel?: string
  hideActions?: boolean
  testByUrlOnly?: boolean
  actionsDisabled?: boolean
}): React.JSX.Element {
  const {
    connector,
    onToggleEnabled,
    onToggleLazyLoad,
    onDelete,
    onEdit,
    onPublish,
    publishLabel = "发布到市场",
    hideActions = false,
    testByUrlOnly = false,
    actionsDisabled = false
  } = props
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    tools?: string[]
    error?: string
  } | null>(null)
  const testRevision = useRef(0)

  useEffect(() => {
    setTestResult(null)
    setTesting(false)
    const revision = testRevision
    revision.current++
    return () => {
      revision.current++
    }
  }, [connector])

  const handleTest = useCallback(async () => {
    if (!connector || actionsDisabled) return
    const revision = ++testRevision.current
    setTesting(true)
    setTestResult(null)
    try {
      const res = testByUrlOnly
        ? await window.api.mcp.testConnection({
            config: {
              name: connector.name,
              kind: resolveMcpConnectorKind(connector),
              url: connector.url,
              command: connector.command,
              args: connector.args,
              env: connector.env,
              advanced: connector.advanced
            }
          })
        : await window.api.mcp.testConnection({ id: connector.id })
      if (revision === testRevision.current) setTestResult(res)
    } catch (e) {
      if (revision === testRevision.current)
        setTestResult({ success: false, error: e instanceof Error ? e.message : "测试失败" })
    } finally {
      if (revision === testRevision.current) setTesting(false)
    }
  }, [connector, testByUrlOnly, actionsDisabled])

  if (!connector) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="max-w-sm space-y-5 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted/60">
            <Plug className="size-6 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">连接你的工具与数据</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              添加 MCP 服务器，在对话中使用其提供的工具。支持远程服务和本机命令。
            </p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            选择一个连接器查看配置，或点击“添加连接器”创建连接。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
      <div className="p-4 border-b border-border flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[160px] flex-1">
          <h2 className="text-base font-semibold truncate">{connector.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {getConnectorSummary(connector)}
          </p>
        </div>
        {!hideActions && (
          <div className="flex flex-wrap items-center gap-1.5">
            {onPublish && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={actionsDisabled}
                onClick={() => onPublish(connector)}
              >
                <Store className="size-3" />
                {publishLabel}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={actionsDisabled}
              onClick={() => {
                if (confirm(`确定要删除连接器「${connector.name}」吗？`)) onDelete(connector)
              }}
            >
              <Trash2 className="size-3" />
              删除
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={actionsDisabled}
              onClick={() => onEdit(connector)}
            >
              编辑
            </Button>
            <Button
              variant={connector.enabled ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={actionsDisabled}
              onClick={() => onToggleEnabled(connector.id, !connector.enabled)}
            >
              <Power className="size-3" />
              {connector.enabled ? "已启用" : "已禁用"}
            </Button>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleTest}
          disabled={testing || actionsDisabled}
        >
          {testing ? "测试中..." : "测试连接"}
        </Button>
        {testResult && (
          <div
            className={cn(
              "mt-2 text-xs",
              testResult.success ? "text-muted-foreground" : "text-destructive"
            )}
          >
            {testResult.success ? (
              <div>
                <p>连接成功，共 {testResult.tools?.length ?? 0} 个工具：</p>
                {testResult.tools && testResult.tools.length > 0 && (
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {testResult.tools.slice(0, 10).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                    {testResult.tools.length > 10 && (
                      <li className="text-muted-foreground">
                        ... 等 {testResult.tools.length - 10} 个
                      </li>
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
            disabled={actionsDisabled}
            onClick={() => onToggleLazyLoad(connector.id, !connector.lazyLoad)}
          >
            <Database className="size-3" />
            {connector.lazyLoad ? "已开启" : "已关闭"}
          </Button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <ProjectionGuide lazyLoad={connector.lazyLoad} />
      </div>

      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground">
          MCP 连接器可访问你配置的数据与工具。请仅添加你信任的服务器。
        </p>
      </div>
    </div>
  )
}
