import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  pluginCompatibilityReason,
  type PluginCompatibilityReport
} from "../../../../shared/plugin-compatibility"

export function NativePluginCompatibility({
  threadId,
  workspace,
  pluginId,
  version,
  enabled,
  revision,
  active
}: {
  threadId: string
  workspace: string
  pluginId: string
  version: string
  enabled: boolean
  revision: number
  active: boolean
}) {
  const identity = JSON.stringify([threadId, workspace, pluginId, version, enabled, revision])
  const scopeRef = useRef({ identity, active })
  if (scopeRef.current.identity !== identity || scopeRef.current.active !== active)
    scopeRef.current = { identity, active }
  const scope = scopeRef.current
  const sequence = useRef(0)
  const [state, setState] = useState<{
    scope: typeof scope
    loading?: boolean
    report?: PluginCompatibilityReport
    error?: string
  } | null>(null)
  useEffect(
    () => () => {
      sequence.current++
    },
    []
  )
  const current = state?.scope === scope && active ? state : null
  async function inspect() {
    const request = ++sequence.current
    setState({ scope, loading: true })
    try {
      const report = await window.api.nodeComposition.compatibility({
        threadId,
        expectedWorkspace: workspace,
        pluginId
      })
      if (request !== sequence.current || scopeRef.current !== scope) return
      if (
        !report?.source ||
        report.source.pluginId !== pluginId ||
        report.source.version !== version ||
        report.source.enabled !== enabled ||
        report.authorization !== "not-evaluated" ||
        report.chat !== "check-in-chat"
      )
        throw Error("来源或检查状态未确认，请刷新目录后重新检查。")
      setState({ scope, report })
    } catch (cause) {
      if (request === sequence.current && scopeRef.current === scope)
        setState({
          scope,
          error: pluginCompatibilityReason(
            cause instanceof Error ? cause.message : "适用范围尚未核对，请重试。"
          )
        })
    }
  }
  return (
    <section className="space-y-2 border-t pt-3" aria-label="插件适用范围">
      <Button
        variant="outline"
        size="sm"
        disabled={!active || current?.loading}
        onClick={() => void inspect()}
      >
        {current?.loading
          ? "正在检查适用范围…"
          : current?.report
            ? "重新检查适用范围"
            : "检查适用范围"}
      </Button>
      {!current?.report && !current?.loading && (
        <p className="text-xs text-muted-foreground">
          适用范围尚未核对。点击后只读检查当前安装版本，不会开始任务。
        </p>
      )}
      {current?.error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {current.error}
        </p>
      )}
      {current?.report && <CompatibilitySummary report={current.report} />}
    </section>
  )
}

function CompatibilitySummary({ report }: { report: PluginCompatibilityReport }) {
  const skills = report.entries.filter((entry) => entry.kind === "capability")
  const flows = report.entries.filter((entry) => entry.kind === "flow")
  const list = (entries: PluginCompatibilityReport["entries"]) =>
    entries.length ? (
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="break-words">
            <p>
              {entry.title}
              {entry.runtimeMode
                ? entry.runtimeMode === "host"
                  ? " · 宿主流程"
                  : " · 原引擎流程"
                : ""}{" "}
              · {entry.available ? "已通过项目组合检查" : "暂不能用于此类组合"}
            </p>
            {entry.reasons.map((reason, index) => (
              <p key={index} className="text-muted-foreground">
                {pluginCompatibilityReason(reason)}
              </p>
            ))}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-muted-foreground">未发现已核对的选项，继续从原插件入口使用。</p>
    )
  return (
    <div className="space-y-3 text-xs" aria-label="已核对的适用范围">
      <p>本次检查的安装版本 {report.source.version}。实际运行仍需在项目中预览并确认。</p>
      <div>
        <p className="font-medium">普通聊天</p>
        <p className="text-muted-foreground">
          当前聊天的可用性与权限尚未核对，请到“助手组合”查看适用功能并核对授权。项目阶段技能仍从原项目入口使用。
        </p>
      </div>
      <div>
        <p className="font-medium">项目独立技能</p>
        {list(skills)}
      </div>
      <div>
        <p className="font-medium">完整项目流程</p>
        {list(flows)}
      </div>
      {report.reasons.map((reason, index) => (
        <p key={index} className="break-words text-muted-foreground">
          {pluginCompatibilityReason(reason)}
        </p>
      ))}
      <p className="text-muted-foreground">
        检查通过不代表已授权，也不代表已有项目已切换到此安装版本；原检查和人工确认仍需通过。
        插件文件或配置变化后请重新检查。
      </p>
    </div>
  )
}
