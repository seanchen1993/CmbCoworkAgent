import { useEffect, useRef, useState } from "react"
import type { HostLegacyImportReview } from "../../../../shared/project-runtime/host-types"
import type {
  LocalProjectImportApi,
  LocalProjectTemplate,
  LocalProjectView
} from "../../../../shared/project-runtime/platform-api"
import { projectRuntimeRecoveryMessage } from "./project-runtime-message"

export function LocalProjectImport({
  templates,
  onCancel,
  onCreated
}: {
  templates: LocalProjectTemplate[]
  onCancel(): void
  onCreated(view: LocalProjectView): void
}) {
  const [sources, setSources] = useState<Awaited<ReturnType<LocalProjectImportApi["sources"]>>>([])
  const [sourceId, setSourceId] = useState("")
  const [pluginId, setPluginId] = useState("")
  const [plan, setPlan] = useState<Awaited<ReturnType<LocalProjectImportApi["target"]>>>()
  const [prefix, setPrefix] = useState(1)
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [adapterId, setAdapterId] = useState("")
  const [parameters, setParameters] = useState<Record<string, string>>({})
  const [review, setReview] = useState<HostLegacyImportReview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const sequence = useRef(0)
  const projectId = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    let current = true
    void window.api.harnessBoard.localProjects.legacyImport.sources().then(
      (value) => {
        if (current) setSources(value)
      },
      (cause) => {
        if (current) setError(String(cause))
      }
    )
    return () => {
      current = false
      sequence.current++
    }
  }, [])
  const selectTemplate = async (id: string) => {
    const token = ++sequence.current
    setPluginId(id)
    setPlan(undefined)
    setReview(undefined)
    setError("")
    setPaths({})
    setAdapterId("")
    setParameters({})
    setPrefix(1)
    if (!id) return
    try {
      const value = await window.api.harnessBoard.localProjects.legacyImport.target(id)
      if (token === sequence.current) {
        setPlan(value)
        if (value.adapters?.length === 1) setAdapterId(value.adapters[0].id)
      }
    } catch (cause) {
      if (token === sequence.current) setError(String(cause))
    }
  }
  const eligible = plan?.stages.findIndex((stage) => !stage.eligible) ?? 0
  const adapter = plan?.adapters?.find((item) => item.id === adapterId)
  const frozenSource = sources.find(source => source.projectId === sourceId)?.frozen === true
  const prefixLimit = eligible === -1 ? plan!.stages.length : eligible
  const stages = plan?.stages.slice(0, prefix) ?? []
  const artifacts = [
    ...new Map(stages.flatMap((stage) => stage.artifacts).map((item) => [item.id, item])).values()
  ]
  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="导入旧项目成果">
      <h3 className="font-medium">导入旧项目成果</h3>
      <p className="text-sm text-muted-foreground">
        从已纳入平台执行管理的旧项目导入到独立工作目录。确认后旧项目的执行入口会冻结，原文件保留。
        历史成功仅作为来源记录；新任务会逐步执行真实检查，并由你重新确认成果。
      </p>
      {!sources.length && (
        <p className="text-sm">暂无可导入的登记项目。未纳入执行管理的旧项目需先完成适配与登记。</p>
      )}
      <fieldset disabled={busy || Boolean(review)} className="grid gap-3 text-sm">
        <label>
          旧项目
          <select
            aria-label="旧项目"
            className="ml-2 rounded border bg-background p-2"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">选择旧项目</option>
            {sources.map((source) => (
              <option key={source.projectId} value={source.projectId}>
                {source.packageId} · {source.workspace}
                {source.frozen ? "（已冻结，可核对续传）" : ""}
              </option>
            ))}
          </select>
        </label>
        {frozenSource && <div className="rounded border p-3">
          <p>旧入口已冻结。请读取上次核对方案，核实原目标目录后继续；不会另建一套导入或解除冻结。</p>
          <button type="button" className="mt-2 underline" onClick={() => void act(async () => {
            const token = ++sequence.current
            const saved = await window.api.harnessBoard.localProjects.legacyImport.resumeReview(sourceId)
            if (token !== sequence.current) return
            projectId.current = saved.target.projectId
            setPluginId(saved.target.installedPluginId)
            setName(saved.target.name)
            setGoal(saved.target.goal)
            setWorkspace(saved.target.workspace)
            setPlan(undefined)
            setReview(saved)
          })}>核对并恢复上次导入</button>
        </div>}
        <label>
          新插件
          <select
            aria-label="新插件"
            className="ml-2 rounded border bg-background p-2"
            value={pluginId}
            onChange={(e) => void selectTemplate(e.target.value)}
          >
            <option value="">选择目标插件</option>
            {templates
              .filter((template) => !template.unavailableReason)
              .map((template) => (
                <option key={template.installedPluginId} value={template.installedPluginId}>
                  {template.name} · {template.version}
                </option>
              ))}
          </select>
        </label>
        {!!plan?.adapters?.length && (
          <label>
            导入方式
            <select
              aria-label="导入方式"
              className="ml-2 rounded border bg-background p-2"
              value={adapterId}
              onChange={(event) => { setAdapterId(event.target.value); setParameters({}) }}
            >
              {plan.adapters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              <option value="">手动映射已兼容的产物</option>
            </select>
          </label>
        )}
        {adapter && <div className="space-y-2">
          <p>按插件的导入规则读取旧材料与实际阶段记录。系统会列明需要重新执行或重新验收的步骤。</p>
          {adapter.parameters.map((parameter) => <label key={parameter.id} className="block">
            {parameter.label}
            <input
              aria-label={parameter.label}
              className="ml-2 rounded border bg-background p-2"
              value={parameters[parameter.id] ?? ""}
              maxLength={500}
              onChange={(event) => setParameters(previous => ({ ...previous, [parameter.id]: event.target.value }))}
            />
          </label>)}
        </div>}
        {plan && !adapter && prefixLimit === 0 && (
          <p>
            {projectRuntimeRecoveryMessage(plan.stages[0]?.reason ?? "") ??
              "目标插件未声明可重新验收的前序阶段。请在创造者模式为导入阶段补齐成果确认与真实检查。"}
          </p>
        )}
        {!adapter && prefixLimit > 0 && (
          <label>
            导入并重新验证至
            <select
              className="ml-2 rounded border bg-background p-2"
              value={prefix}
              onChange={(e) => setPrefix(Number(e.target.value))}
            >
              {plan!.stages.slice(0, prefixLimit).map((stage, index) => (
                <option key={stage.id} value={index + 1}>
                  {stage.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          新任务名称
          <input
            className="ml-2 rounded border bg-background p-2"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          任务目标
          <textarea
            className="mt-1 w-full rounded border bg-background p-2"
            value={goal}
            maxLength={4000}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            className="underline"
            onClick={() =>
              void act(async () => {
                const selected = await window.api.file.selectDirectory({
                  title: "选择独立的新任务目录"
                })
                if (!selected.canceled && selected.filePaths[0]) setWorkspace(selected.filePaths[0])
              })
            }
          >
            选择独立的新任务目录
          </button>
          <p className="break-all text-xs">{workspace}</p>
        </div>
        {!adapter && !!artifacts.length && (
          <div className="space-y-2">
            <p>核对原产物的位置（相对于旧项目目录）：</p>
            {artifacts.map((artifact) => (
              <label key={artifact.id} className="block">
                <span>
                  {artifact.id} → {artifact.path}
                </span>
                <input
                  className="ml-2 rounded border bg-background p-2"
                  aria-label={`原产物 ${artifact.id}`}
                  value={paths[artifact.id] ?? artifact.path}
                  onChange={(e) =>
                    setPaths((previous) => ({ ...previous, [artifact.id]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {review ? (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>已核对 {review.files.length} 个文件；原项目与新插件的版本、文件摘要均已固定。</p>
          {review.adaptation && <div className="space-y-1">
            <p>旧项目检查点：{review.adaptation.checkpoint.value}（仅用于选择导入范围）</p>
            <p>已保留 {review.adaptation.sourceFiles.length} 份原材料，导入后可在 {review.adaptation.materialPath} 核对。</p>
            <ol className="list-decimal pl-5">
              {review.prefixStageIds.map((id) => <li key={id}>
                {plan?.stages.find(stage => stage.id === id)?.title ?? id}：
                {review.adaptation!.reexecuteStageIds.includes(id) ? "重新执行技能并检查" : "重新检查导入成果"}，通过后需人工确认
              </li>)}
            </ol>
          </div>}
          <p>
            确认将冻结旧项目的执行入口，并复制上述文件到新任务。检查未通过前不会标记任何阶段完成。
          </p>
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2"
            onClick={() =>
              void act(async () => {
                const token = sequence.current
                const created = await window.api.harnessBoard.localProjects.legacyImport.confirm(review)
                if (token === sequence.current) onCreated(created)
              })
            }
          >
            确认冻结并导入
          </button>
          <button
            type="button"
            disabled={busy}
            className="ml-3 underline"
            onClick={() => setReview(undefined)}
          >
            重新核对配置
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={
            busy ||
            frozenSource ||
            !sourceId ||
            !pluginId ||
            !workspace ||
            !name.trim() ||
            !goal.trim() ||
            (adapter ? adapter.parameters.some(parameter => !parameters[parameter.id]?.trim()) : !prefixLimit)
          }
          className="rounded border px-3 py-2 disabled:opacity-50"
          onClick={() =>
            void act(async () => {
              const token = sequence.current
              const target = {
                projectId: projectId.current,
                name: name.trim(),
                goal: goal.trim(),
                workspace,
                installedPluginId: pluginId
              }
              const api = window.api.harnessBoard.localProjects.legacyImport
              const nextReview = adapter
                ? await api.reviewAdapter({ sourceProjectId: sourceId, target, adapterId: adapter.id,
                    parameters: Object.fromEntries(adapter.parameters.map(parameter =>
                      [parameter.id, parameters[parameter.id].trim()])) })
                : await api.review({
                  sourceProjectId: sourceId,
                  target,
                  prefixStageIds: stages.map((stage) => stage.id),
                  artifacts: artifacts.map((artifact) => ({
                    artifactId: artifact.id,
                    sourcePath: paths[artifact.id] ?? artifact.path
                  }))
                })
              if (token === sequence.current) setReview(nextReview)
            })
          }
        >
          核对导入方案
        </button>
      )}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          <p>
            {projectRuntimeRecoveryMessage(error) ??
              "导入未完成，请核对具体原因。已冻结的旧项目不会自动解冻，可保留本次核对结果继续处理。"}
          </p>
          <details>
            <summary>问题详情</summary>
            <p className="break-all">{error}</p>
          </details>
        </div>
      )}
      <button type="button" disabled={busy} className="ml-3 text-sm underline" onClick={onCancel}>
        关闭
      </button>
    </section>
  )
}
