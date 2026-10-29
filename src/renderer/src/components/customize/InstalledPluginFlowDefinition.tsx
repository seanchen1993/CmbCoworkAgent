import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import type { PluginFlowDefinition } from "../../../../shared/plugin-flow-definition"

export function InstalledPluginFlowDefinition({
  pluginId,
  name,
  version
}: {
  pluginId: string
  name: string
  version: string
}) {
  const pluginVersion = useAppStore((state) => state.pluginVersion)
  const accountRevision = useAppStore((state) => state.accountRevision)
  const [refresh, setRefresh] = useState(0)
  const request = useRef(0)
  const identity = JSON.stringify([
    pluginId,
    name,
    version,
    pluginVersion,
    accountRevision,
    refresh
  ])
  const [state, setState] = useState<{
    identity: string
    definition?: PluginFlowDefinition
    error?: string
  }>({ identity: "" })
  useEffect(() => {
    const sequence = request
    const token = ++sequence.current
    void window.api.plugins
      .flowDefinition({ pluginId, expected: { name, version } })
      .then((definition) => {
        if (sequence.current === token) setState({ identity, definition })
      })
      .catch((cause) => {
        if (sequence.current === token)
          setState({ identity, error: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => {
      sequence.current++
    }
  }, [identity, pluginId, name, version])
  const current = state.identity === identity ? state : undefined
  const definition = current?.definition
  const nodeTitle = (id: string) => definition?.nodes.find((node) => node.id === id)?.title ?? id
  return (
    <section aria-label="已安装插件流程定义" className="space-y-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">插件流程定义（只读）</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={!current}
          onClick={() => setRefresh((value) => value + 1)}
        >
          重新读取流程定义
        </Button>
      </div>
      <p className="break-words">
        {name} · 当前安装版本 {version}
      </p>
      <p className="text-muted-foreground">创建项目后按此流程运行；修改流程请进入创造者模式。</p>
      {!current && <p role="status">正在读取已安装版本的流程定义…</p>}
      {current?.error && (
        <p role="alert" className="break-words text-destructive">
          流程定义读取失败：{current.error}
        </p>
      )}
      {definition && (
        <>
          {!definition.source.enabled && (
            <p className="text-muted-foreground">此插件已停用，仍可查看已安装版本的定义。</p>
          )}
          {definition.diagnostics.map((message, index) => (
            <p
              key={index}
              role={definition.status === "invalid" ? "alert" : "status"}
              className={
                definition.status === "invalid"
                  ? "break-words text-destructive"
                  : "text-muted-foreground"
              }
            >
              {message}
            </p>
          ))}
          {definition.status === "ready" && (
            <>
              <div className="space-y-2" aria-label="插件声明的流程模板">
                {definition.templates.map((template) => (
                  <article key={template.id} className="space-y-1 rounded-lg border p-3">
                    <h4 className="font-medium">{template.title}</h4>
                    {template.nodeIds ? (
                      template.nodeIds.length ? (
                        <ol className="list-inside list-decimal space-y-1">
                          {template.nodeIds.map((id) => (
                            <li key={id}>{nodeTitle(id)}</li>
                          ))}
                        </ol>
                      ) : (
                        <p>此模板声明的步骤列表为空。</p>
                      )
                    ) : (
                      <p className="text-muted-foreground">此模板未声明固定步骤序列。</p>
                    )}
                    {template.requiredNodeIds.length > 0 && (
                      <p>声明的必选步骤：{template.requiredNodeIds.map(nodeTitle).join("、")}</p>
                    )}
                  </article>
                ))}
              </div>
              {definition.nodes.length > 0 &&
                (definition.templates.length === 0 ||
                  definition.templates.some((template) => template.nodeIds === undefined)) && (
                  <ul className="list-inside list-disc space-y-1" aria-label="未声明固定顺序的步骤">
                    {definition.nodes.map((node) => (
                      <li key={node.id}>
                        {node.title}
                        {node.optional && "（可选阶段）"}
                      </li>
                    ))}
                  </ul>
                )}
              {!definition.nodes.length && <p>此安装包没有声明步骤。</p>}
              <details key={identity} className="space-y-2" aria-label="步骤详情">
                <summary className="cursor-pointer">查看步骤详情</summary>
                {definition.declarationPath && (
                  <p className="break-all text-xs text-muted-foreground">
                    定义来源：{definition.declarationPath}
                  </p>
                )}
                {definition.templates
                  .filter((template) => template.description)
                  .map((template) => (
                    <p key={template.id} className="whitespace-pre-wrap text-muted-foreground">
                      {template.title}：{template.description}
                    </p>
                  ))}
                {definition.nodes.map((node) => (
                  <article key={node.id} className="space-y-1 rounded-lg border p-3">
                    <h5 className="font-medium">
                      {node.title}
                      {node.optional && "（可选阶段）"}
                    </h5>
                    <p className="break-all text-xs text-muted-foreground">{node.id}</p>
                    {node.description && <p className="whitespace-pre-wrap">{node.description}</p>}
                    {node.optional && (
                      <p>
                        可选阶段：{node.optional.title}
                        {node.optional.insertAfter &&
                          `；声明插入位置：${nodeTitle(node.optional.insertAfter)} 之后`}
                      </p>
                    )}
                    {node.skill && <p className="break-all">技能：{node.skill}</p>}
                    {node.approval === "human" && <p>执行前需要人工确认。</p>}
                    {node.resultApproval === "human" && <p>成果需要人工确认。</p>}
                    {node.inputs.length > 0 && <p>输入：{node.inputs.join("、")}</p>}
                    {node.outputs.length > 0 && <p>产出：{node.outputs.join("、")}</p>}
                    {node.checks.length > 0 && <p>检查/检查点：{node.checks.join("、")}</p>}
                  </article>
                ))}
              </details>
            </>
          )}
        </>
      )}
    </section>
  )
}
