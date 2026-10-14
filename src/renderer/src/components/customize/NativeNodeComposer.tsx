import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { openNativeNodePlan } from "@/lib/node-composition-intent"
import { useFeatureGate } from "@/lib/feature-gates"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { NativeNodeCatalog, NativeNodePlan } from "../../../../shared/node-composition"
import type { HarnessProjectListItem } from "../../../../shared/harness-board-types"

export function NativeNodeComposer({
  threadId,
  workspace,
  initialProjectId,
  pluginId,
  initialOpen = false,
  onContinue
}: {
  threadId: string
  workspace: string
  initialProjectId?: string
  pluginId?: string
  initialOpen?: boolean
  onContinue?: () => void
}) {
  const available = useFeatureGate(FEATURE_GATES.projectMode)
  const [open, setOpen] = useState(initialOpen)
  return (
    <section className="rounded-xl border p-4">
      <h3 className="font-medium">组合项目步骤</h3>
      <p className="my-2 text-sm text-muted-foreground">
        从 AutoBiz 等项目插件中选择要做的步骤。自动补齐前置步骤，保留原检查和人工确认。
      </p>
      {!available.enabled ? (
        <p className="text-sm">当前应用尚未开放项目模式，开放后可在这里选择项目步骤。</p>
      ) : (
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "收起项目步骤" : "选择项目步骤"}
        </Button>
      )}
      {open && available.enabled && (
        <NativeNodeSelection
          key={JSON.stringify([threadId, workspace, initialProjectId, pluginId])}
          threadId={threadId}
          workspace={workspace}
          initialProjectId={initialProjectId}
          pluginId={pluginId}
          onContinue={onContinue}
        />
      )}
    </section>
  )
}

function NativeNodeSelection({
  threadId,
  workspace,
  initialProjectId,
  pluginId,
  onContinue
}: {
  threadId: string
  workspace: string
  initialProjectId?: string
  pluginId?: string
  onContinue?: () => void
}) {
  const scope = { threadId, expectedWorkspace: workspace }
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [projectId, setProjectId] = useState(initialProjectId ?? "")
  const [catalog, setCatalog] = useState<NativeNodeCatalog | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [templateId, setTemplateId] = useState("")
  const [plan, setPlan] = useState<NativeNodePlan | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(true)
  const sequence = useRef(0)
  useEffect(() => {
    const requests = sequence
    const request = ++sequence.current
    void window.api.nodeComposition
      .projects(scope)
      .then((items) => {
        if (request !== sequence.current) return
        if (pluginId) items = items.filter((item) => item.harnessAdapter.id === pluginId)
        setProjects(items)
        if (initialProjectId && items.some((item) => item.projectId === initialProjectId)) {
          void load(initialProjectId)
        } else if (initialProjectId) {
          setProjectId("")
          setError("新项目暂不可用，请确认插件已启用后重试。")
        }
      })
      .catch((cause) => {
        if (request === sequence.current) setError(String(cause.message ?? cause))
      })
      .finally(() => {
        if (request === sequence.current) setBusy(false)
      })
    return () => {
      ++requests.current
    }
    // The owner keys this component by thread and workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function load(projectId: string) {
    const request = ++sequence.current
    setCatalog(null)
    setPlan(null)
    setError("")
    setProjectId(projectId)
    if (!projectId) {
      setBusy(false)
      return
    }
    setBusy(true)
    try {
      const value = await window.api.nodeComposition.catalog({ ...scope, projectId })
      if (request !== sequence.current) return
      const custom = value.config.templates.find((item) => item.templateType === "custom")
      if (!custom) throw Error("这个插件不支持自选步骤，请从原项目入口使用。")
      setCatalog(value)
      setTemplateId(custom.id)
      setSelected(custom.requiredNodes)
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  async function preview() {
    if (!catalog || busy) return
    const request = ++sequence.current
    setBusy(true)
    setError("")
    setPlan(null)
    try {
      const value = await window.api.nodeComposition.preview({
        ...scope,
        projectId: catalog.project.projectId,
        templateId,
        selected
      })
      if (request === sequence.current) setPlan(value)
    } catch (cause) {
      if (request === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  const required = new Set(
    catalog?.config.templates.find((item) => item.id === templateId)?.requiredNodes ?? []
  )
  return (
    <div className="mt-4 space-y-4" aria-label="项目节点组合">
      <label className="block text-sm">
        选择项目
        <select
          aria-label="选择节点所属项目"
          value={projectId}
          disabled={busy}
          className="mt-1 block w-full rounded border bg-background p-2"
          onChange={(event) => void load(event.target.value)}
        >
          <option value="">请选择</option>
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {!busy && !projects.length && (
        <p className="text-sm">
          {pluginId ? "这个工作区没有绑定此插件版本的可用项目。" : "这个工作区还没有可用项目。"}
          请先为插件新建项目，或回到对应项目的聊天再打开此页。
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在读取和检查项目步骤…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {catalog && (
        <>
          <p className="text-sm text-muted-foreground">
            此处只选择当前项目的步骤，前置检查和人工确认会保留。
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.nodes.map((node) => (
              <label key={node.id} className="min-w-0 space-y-1 rounded-lg border p-3 text-sm">
                <span className="flex gap-2">
                  <input
                    type="checkbox"
                    disabled={busy || required.has(node.id)}
                    checked={selected.includes(node.id)}
                    onChange={(event) => {
                      setPlan(null)
                      setSelected((old) =>
                        event.target.checked
                          ? [...old, node.id]
                          : old.filter((id) => id !== node.id)
                      )
                    }}
                  />
                  <strong>{node.label}</strong>
                  {required.has(node.id) && <span>（必选）</span>}
                </span>
                <p className="text-muted-foreground">{node.description}</p>
                {(node.inputs.length > 0 || node.outputs.length > 0) && (
                  <details>
                    <summary>需要哪些资料，会得到什么</summary>
                    <p className="break-all">需要：{node.inputs.join("、") || "按原步骤要求"}</p>
                    <p className="break-all">产出：{node.outputs.join("、") || "按原步骤要求"}</p>
                  </details>
                )}
              </label>
            ))}
          </div>
          <Button disabled={busy || !selected.length} onClick={() => void preview()}>
            检查并预览步骤
          </Button>
        </>
      )}
      {plan && (
        <section aria-label="节点组合预览" className="space-y-3 rounded-lg border p-3 text-sm">
          <h4 className="font-medium">将按这个顺序执行</h4>
          <ol className="list-inside list-decimal space-y-1">
            {plan.ordered.map((id) => (
              <li key={id}>
                {plan.nodes.find((node) => node.id === id)?.label ?? id}
                {plan.added.includes(id) && "（为保留输入和检查自动补齐）"}
              </li>
            ))}
          </ol>
          <p>接下来为这组步骤创建需求。创建不会自动运行，原有阶段检查和审批继续生效。</p>
          {plan.optionalOmissions.length > 0 && (
            <div>
              <p>以下资料在原插件中为可选项，本次未启用：</p>
              <ul className="list-inside list-disc">
                {plan.optionalOmissions.map((item) => (
                  <li key={`${item.nodeId}:${item.path}`} className="break-all">
                    {plan.nodes.find((node) => node.id === item.nodeId)?.label}：{item.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              const request = ++sequence.current
              setBusy(true)
              setError("")
              void openNativeNodePlan(scope, plan)
                .then(() => {
                  if (request === sequence.current) onContinue?.()
                })
                .catch((cause) => {
                  if (request === sequence.current)
                    setError(cause instanceof Error ? cause.message : String(cause))
                })
                .finally(() => {
                  if (request === sequence.current) setBusy(false)
                })
            }}
          >
            在项目里创建需求
          </Button>
        </section>
      )}
    </div>
  )
}
