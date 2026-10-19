import { useEffect, useRef, useState } from "react"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { BizRetryDecisionCard } from "./BizRetryNotice"
import { ProjectChatCapabilities } from "./ProjectChatCapabilities"
import { ProjectCompositionGuide } from "./ProjectCompositionGuide"
import { ProjectCompositionWorkflow } from "./ProjectCompositionWorkflow"
import { ProjectCompositionProblem } from "./ProjectCompositionProblem"
import { ProjectCompositionToolApprovals } from "./ProjectCompositionToolApprovals"
import { ProjectFunctionConsent } from "./ProjectFunctionConsent"
import { ProjectCompositionUnitContext } from "./ProjectCompositionUnitContext"
import { compositionUnitConfigurationKey } from "../../../../shared/project-runtime/composition-api"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type {
  CompositionRun,
  ProjectCompositionApproval,
  ProjectCompositionLegacyDecision,
  ProjectCompositionApi,
  ProjectCompositionCatalog,
  ProjectCompositionPreview,
  ProjectCompositionScope
} from "../../../../shared/project-runtime/composition-api"
import {
  addCompositionEntry,
  changeCompositionOrder,
  compositionApprovalInput,
  compositionErrorText,
  compositionProblem,
  compositionDraftIssues,
  compositionDraftKey,
  compositionRunBelongsTo,
  compositionRunLabel,
  compositionScopeKey,
  compositionSourceKey,
  emptyCompositionDraft,
  readCompositionDraft,
  type ProjectCompositionDraft
} from "@/lib/project-composition-ui"

interface Props {
  scope: ProjectCompositionScope
  api?: ProjectCompositionApi
  onClose?: () => void
}
const button = "rounded-md border px-3 py-2 text-sm disabled:opacity-50"
const field = "min-w-0 w-full rounded-md border bg-background p-2 text-sm"

/** The project page owns this one entry. Ordinary chat never mounts this panel. */
export function ProjectCompositionPanel(props: Props) {
  const api =
    props.api ??
    (
      window.api as typeof window.api & {
        projectComposition?: ProjectCompositionApi
      }
    ).projectComposition
  if (!api) return <p role="status">项目组合服务尚未就绪，请稍后重新打开。</p>
  return <ProjectCompositionEditor key={compositionScopeKey(props.scope)} {...props} api={api} />
}

function ProjectCompositionEditor({ scope, api, onClose }: Props & { api: ProjectCompositionApi }) {
  const [catalog, setCatalog] = useState<ProjectCompositionCatalog | null>(null)
  const [draft, setDraft] = useState<ProjectCompositionDraft>(() => emptyCompositionDraft(scope))
  const [preview, setPreview] = useState<ProjectCompositionPreview | null>(null)
  const [run, setRun] = useState<CompositionRun | null>(null)
  const [unitReady, setUnitReady] = useState<Record<string, boolean>>({})
  const [unitContextReady, setUnitContextReady] = useState<Record<string, boolean>>({})
  const [legacyDecision, setLegacyDecision] = useState<ProjectCompositionLegacyDecision | null>(
    null
  )
  const [legacyDecisionRefresh, setLegacyDecisionRefresh] = useState(0)
  const [approval, setApproval] = useState<ProjectCompositionApproval | null>(null)
  const [artifact, setArtifact] = useState<Awaited<
    ReturnType<ProjectCompositionApi["readArtifact"]>
  > | null>(null)
  const [copied, setCopied] = useState(false)
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const request = useRef(0)
  const lock = useRef(false)
  const startKey = useRef<string | undefined>(undefined)
  const runRef = useRef(run)
  runRef.current = run

  const fail = compositionErrorText
  const acceptRun = (next: CompositionRun) => {
    if (!compositionRunBelongsTo(next, scope)) throw Error("COMPOSITION_SCOPE_CHANGED")
    const previous = runRef.current
    if (previous?.id === next.id && previous.version > next.version) return
    runRef.current = next
    setRun(next)
    try {
      localStorage.setItem(`${compositionDraftKey(scope)}:run`, next.id)
    } catch {
      setNotice("运行已提交，但本机未能记住运行入口。请暂时保持面板打开。")
    }
  }
  const refresh = async () => {
    if (lock.current) return
    const ticket = ++request.current
    setLoading(true)
    setError("")
    try {
      const next = await api.catalog(scope)
      if (!alive.current || request.current !== ticket) return
      setCatalog(next)
      setPreview(null)
    } catch (cause) {
      if (alive.current && request.current === ticket) setError(fail(cause))
    } finally {
      if (alive.current && request.current === ticket) setLoading(false)
    }
  }
  useEffect(() => {
    alive.current = true
    try {
      setDraft(readCompositionDraft(scope, localStorage.getItem(compositionDraftKey(scope))))
      const runId = localStorage.getItem(`${compositionDraftKey(scope)}:run`)
      if (runId)
        void api
          .read({ scope, runId })
          .then((next) => {
            if (alive.current && !runRef.current) acceptRun(next)
          })
          .catch((cause) => {
            if (alive.current) setError(fail(cause))
          })
    } catch (cause) {
      setNotice(fail(cause))
    }
    void refresh()
    return () => {
      alive.current = false
    }
    // The parent key isolates every project/thread/workspace incarnation of this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!run || !["running", "waiting-approval", "cancel-requested"].includes(run.status)) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (disposed || !alive.current) return
      if (!lock.current) {
        try {
          const next = await api.read({ scope, runId: run.id })
          if (!disposed && alive.current) acceptRun(next)
        } catch (cause) {
          if (!disposed && alive.current) setError(fail(cause))
        }
      }
      if (!disposed) timer = setTimeout(read, 1500)
    }
    timer = setTimeout(read, 1500)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
    // Poll only this visible run. Versions are checked independently by acceptRun.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, run?.id, run?.status])

  useEffect(() => {
    let disposed = false
    setApproval(null)
    setLegacyDecision(null)
    setDecision(null)
    if (run?.status === "waiting-approval") {
      void api
        .readLegacyDecision({ scope, runId: run.id })
        .then((next) => {
          if (!disposed && alive.current) setLegacyDecision(next)
        })
        .catch((cause) => {
          if (!disposed && alive.current) setError(fail(cause))
        })
      void api
        .waitingApproval({ scope, runId: run.id })
        .then((next) => {
          if (!disposed && alive.current) setApproval(next)
        })
        .catch((cause) => {
          if (!disposed && alive.current) setError(fail(cause))
        })
    }
    return () => {
      disposed = true
    }
    // Approval receipts are bound to the displayed run version and original operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, run?.id, run?.version, run?.status, legacyDecisionRefresh])

  const update = (next: ProjectCompositionDraft) => {
    setDraft(next)
    setDirty(true)
    setPreview(null)
    startKey.current = undefined
    setNotice("")
    setError("")
  }
  const edit = (work: () => ProjectCompositionDraft) => {
    try {
      update(work())
    } catch (cause) {
      setError(fail(cause))
    }
  }
  const mutate = async (work: () => Promise<void>) => {
    if (lock.current || loading) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(fail(cause))
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  const issues = catalog ? compositionDraftIssues(draft, catalog.entries) : []
  const disabled = loading || busy
  const label = (id: string) => draft.labels[id] ?? "自动补齐的必要步骤"
  const unitStatus = (status: CompositionRun["units"][number]["status"]) =>
    ({
      pending: "等待前序完成",
      running: "执行中",
      "waiting-approval": "等待原流程确认",
      succeeded: "已通过原引擎检查",
      failed: "失败",
      cancelled: "已取消",
      unknown: "待核对"
    })[status]

  return (
    <section aria-label="项目能力" className="min-w-0 space-y-5 overflow-x-hidden p-3 sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold">
            {catalog?.projectName ?? "当前项目"} · 项目能力
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            对话能力按需启用，完整流程按顺序执行。原有检查和确认步骤会保留。
          </p>
        </div>
        {onClose && (
          <button type="button" className={button} onClick={onClose}>
            返回项目对话
          </button>
        )}
      </header>
      <ProjectCompositionGuide />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled} onClick={() => void refresh()}>
          刷新能力目录
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled}
          onClick={() => {
            try {
              const text = JSON.stringify(draft)
              readCompositionDraft(scope, text)
              localStorage.setItem(compositionDraftKey(scope), text)
              setDirty(false)
              setNotice("流程草稿已保存在本机，尚未启动运行。")
            } catch (cause) {
              setError(fail(cause))
            }
          }}
        >
          保存流程草稿
        </button>
        {dirty && <span className="self-center text-xs text-muted-foreground">有未保存的修改</span>}
      </div>
      {loading && <p role="status">正在读取当前项目的能力…</p>}
      {notice && <ProjectCompositionProblem role="status" value={notice} />}
      {error && (
        <ProjectCompositionProblem
          role="alert"
          value={error}
          status={run?.status}
          className="break-words text-sm text-destructive"
        />
      )}
      {catalog && (
        <>
          {catalog.diagnostics?.map((message) => (
            <ProjectCompositionProblem
              key={message}
              value={message}
              className="break-words text-sm text-muted-foreground"
            />
          ))}
          {!catalog.entries.length && (
            <p className="text-sm">安装支持项目组合的插件后，可在这里选择能力或完整流程。</p>
          )}
          <ProjectChatCapabilities scope={scope} api={api} catalog={catalog} />
          {(["flow"] as const).map((kind) => (
            <section key={kind} className="space-y-2">
              <h3 className="font-medium">按顺序执行 · 完整流程</h3>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                {catalog.entries
                  .filter((entry) => entry.kind === kind)
                  .map((entry) => (
                    <article
                      key={compositionSourceKey(entry.source)}
                      className="min-w-0 space-y-2 rounded-lg border p-3"
                    >
                      <h4 className="break-words font-medium">{entry.title}</h4>
                      <p className="break-words text-xs text-muted-foreground">
                        来源：{entry.sourceName}
                      </p>
                      {entry.description && (
                        <p className="break-words text-sm">{entry.description}</p>
                      )}
                      {!entry.available && (
                        <ProjectCompositionProblem
                          value={entry.reasons.join("；") || "暂不可组合，需要宿主验证。"}
                        />
                      )}
                      <button
                        type="button"
                        className={button}
                        disabled={disabled || !entry.available}
                        aria-label={`添加 ${entry.title} · ${entry.sourceName}`}
                        onClick={() =>
                          edit(() =>
                            addCompositionEntry(draft, entry, `unit-${crypto.randomUUID()}`)
                          )
                        }
                      >
                        添加到项目组合
                      </button>
                    </article>
                  ))}
              </div>
              {!catalog.entries.some((entry) => entry.kind === kind) && (
                <p className="text-sm text-muted-foreground">暂无已声明的完整流程。</p>
              )}
            </section>
          ))}
          <section aria-label="组合顺序与资料交接" className="space-y-3">
            <label className="grid min-w-0 gap-1 text-sm">
              这次要做什么
              <textarea
                className={field}
                rows={3}
                maxLength={16000}
                disabled={disabled}
                aria-label="这次要做什么"
                placeholder="说明要解决的问题、需要交付的结果和要求。"
                value={draft.definition.goal ?? ""}
                onChange={(event) => {
                  const definition = { ...draft.definition }
                  delete definition.goal
                  update({
                    ...draft,
                    definition: {
                      ...definition,
                      ...(event.target.value.trim() ? { goal: event.target.value } : {})
                    }
                  })
                }}
              />
            </label>
            <h3 className="font-medium">已选内容 · 按顺序执行</h3>
            {!draft.definition.units.length && (
              <p className="text-sm">从上方添加完整流程。不能直接混排未经验证的原生项目阶段。</p>
            )}
            {draft.definition.units.map((unit, index, units) => {
              const entry = catalog.entries.find(
                (item) => compositionSourceKey(item.source) === compositionSourceKey(unit.source)
              )
              return (
                <article key={unit.id} className="min-w-0 space-y-3 rounded-lg border p-3">
                  <h4 className="break-words font-medium">
                    {index + 1}. {label(unit.id)}
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {([-1, 1] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        className={button}
                        disabled={
                          disabled || index + direction < 0 || index + direction >= units.length
                        }
                        aria-label={`${direction < 0 ? "上移" : "下移"} ${label(unit.id)}`}
                        onClick={() =>
                          edit(() => {
                            const next = [...units]
                            const moved = next[index]
                            next[index] = next[index + direction]
                            next[index + direction] = moved
                            return changeCompositionOrder(draft, next)
                          })
                        }
                      >
                        {direction < 0 ? "上移" : "下移"}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={button}
                      disabled={disabled}
                      aria-label={`移除 ${label(unit.id)}`}
                      onClick={() =>
                        edit(() =>
                          changeCompositionOrder(
                            draft,
                            units.filter((item) => item.id !== unit.id)
                          )
                        )
                      }
                    >
                      移除
                    </button>
                  </div>
                  {entry?.workflow && <ProjectCompositionWorkflow
                    title={label(unit.id)} catalog={entry.workflow} value={unit.workflow}
                    disabled={disabled}
                    onChange={(workflow) => edit(() => ({ ...draft, definition: {
                      ...draft.definition,
                      units: units.map((item) => {
                        if (item.id !== unit.id) return item
                        const next = { ...item }
                        if (workflow) next.workflow = workflow
                        else delete next.workflow
                        return next
                      })
                    } }))}
                  />}
                  {entry?.inputs.map((input) => (
                    <label key={input.id} className="grid min-w-0 gap-1 text-sm">
                      {input.title}
                      {input.required ? "（必需资料）" : "（可选资料）"}
                      <select
                        className={field}
                        disabled={disabled}
                        aria-label={`${label(unit.id)} · ${input.title}`}
                        value={(() => {
                          const selected = unit.inputs.find((item) => item.inputId === input.id)
                          return selected
                            ? JSON.stringify([selected.fromUnitId, selected.artifactId])
                            : ""
                        })()}
                        onChange={(event) =>
                          edit(() => {
                            const inputs = unit.inputs.filter((item) => item.inputId !== input.id)
                            if (event.target.value) {
                              const [fromUnitId, artifactId] = JSON.parse(event.target.value) as [
                                string,
                                string
                              ]
                              inputs.push({ inputId: input.id, fromUnitId, artifactId })
                            }
                            return {
                              ...draft,
                              definition: {
                                ...draft.definition,
                                units: units.map((item) =>
                                  item.id === unit.id ? { ...unit, inputs } : item
                                )
                              }
                            }
                          })
                        }
                      >
                        <option value="">选择前序步骤产物</option>
                        {units.slice(0, index).flatMap((previous) =>
                          previous.outputs.map((output) => (
                            <option
                              key={`${previous.id}:${output.id}`}
                              value={JSON.stringify([previous.id, output.id])}
                            >
                              {label(previous.id)} →{" "}
                              {catalog.entries
                                .find(
                                  (item) =>
                                    compositionSourceKey(item.source) ===
                                    compositionSourceKey(previous.source)
                                )
                                ?.outputs.find((item) => item.id === output.id)?.title ??
                                output.path}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  ))}
                  {!!unit.outputs.length && (
                    <p className="break-words text-xs text-muted-foreground">
                      产出：
                      {unit.outputs
                        .map(
                          (output) =>
                            entry?.outputs.find((item) => item.id === output.id)?.title ??
                            output.path
                        )
                        .join("、")}
                    </p>
                  )}
                </article>
              )
            })}
            {!!issues.length && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {issues.map((issue) => (
                  <li key={issue} className="break-words">
                    {issue}
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className={button}
              disabled={disabled || !!issues.length}
              onClick={() =>
                void mutate(async () => {
                  setPreview(null)
                  const next = await api.preview({
                    scope,
                    catalogRevision: catalog.revision,
                    definition: draft.definition
                  })
                  if (!alive.current) return
                  if (
                    next.contextKey !== catalog.contextKey ||
                    next.definition.parentProjectId !== scope.projectId ||
                    !isSameWorkspacePath(next.definition.workspace, scope.expectedWorkspace)
                  )
                    throw Error("COMPOSITION_SCOPE_CHANGED")
                  startKey.current = crypto.randomUUID()
                  setPreview(next)
                })
              }
            >
              检查并预览组合
            </button>
          </section>
        </>
      )}
      {preview && (
        <section aria-label="项目组合预览" className="min-w-0 space-y-3 rounded-lg border p-3">
          <h3 className="font-medium">确认本次执行内容</h3>
          <p className="whitespace-pre-wrap break-words text-sm">
            任务：{preview.definition.goal ?? "旧流程未填写任务说明"}
          </p>
          <ol className="list-inside list-decimal space-y-1 text-sm">
            {preview.definition.units.map((unit) => (
              <li key={unit.id} className="break-words">
                {label(unit.id)}
                {preview.addedUnitIds.includes(unit.id) && "（自动补齐的必要步骤）"}
                {unit.workflow && <p className="ml-3 text-xs text-muted-foreground">
                  实际执行步骤：{unit.workflow.nodeIds.map((id) =>
                    catalog?.entries.find((entry) => compositionSourceKey(entry.source) ===
                      compositionSourceKey(unit.source))?.workflow?.config.nodes.find((node) =>
                        node.id === id)?.label ?? id).join(" → ")}
                </p>}
                {unit.inputs.map((input) => {
                  const producer = preview.definition.units.find(
                    (item) => item.id === input.fromUnitId
                  )
                  const output = producer?.outputs.find((item) => item.id === input.artifactId)
                  const producerEntry =
                    producer &&
                    catalog?.entries.find(
                      (item) =>
                        compositionSourceKey(item.source) === compositionSourceKey(producer.source)
                    )
                  const outputTitle =
                    producerEntry?.outputs.find((item) => item.id === input.artifactId)?.title ??
                    output?.path ??
                    input.artifactId
                  return (
                    <p key={input.inputId} className="ml-3 text-xs text-muted-foreground">
                      接收 {label(input.fromUnitId)} 的“{outputTitle}”，由原流程验证后交接
                    </p>
                  )
                })}
              </li>
            ))}
          </ol>
          {!!preview.entryInputFallbacks?.length && <section className="rounded border border-amber-500/40 p-3 text-sm">
            <h4 className="font-medium">自选步骤的入口资料要求</h4>
            <p className="mt-1 text-xs">未执行对应上游步骤，以下资料须按原插件指引处理，不能视为已通过上游检查。</p>
            <ul className="mt-2 space-y-2 text-xs">
              {preview.entryInputFallbacks.map((item, index) => <li key={index}>
                {label(item.unitId)} · {item.nodeId} · {item.path}：{item.guidance}
              </li>)}
            </ul>
          </section>}
          {!!preview.optionalOmissions?.length && <details className="text-sm">
            <summary>本次省略的可选输入（{preview.optionalOmissions.length} 项）</summary>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {preview.optionalOmissions.map((item, index) => <li key={index}>
                {label(item.unitId)} · {item.nodeId}：{item.path}
              </li>)}
            </ul>
            <p className="mt-2 text-xs">省略项由原插件依赖检查确认，报告将按实际执行范围说明。</p>
          </details>}
          {preview.issues.map((issue) => (
            <ProjectCompositionProblem role="alert" key={issue} value={issue} />
          ))}
          <p className="text-sm">
            确认后才启动。前序失败或等待审批时，后续步骤不会执行。当前运行使用冻结配置。
          </p>
          <button
            type="button"
            className={button}
            disabled={disabled || !!preview.issues.length}
            onClick={() =>
              void mutate(async () => {
                const next = await api.prepare({
                  scope,
                  previewId: preview.id,
                  requestId: startKey.current!
                })
                if (!alive.current) return
                acceptRun(next)
                setPreview(null)
                setNotice("请配置各步骤参数并确认权限，然后启动。")
              })
            }
          >
            配置参数
          </button>
          <button type="button" className={button} disabled={busy} onClick={() => setPreview(null)}>
            返回修改
          </button>
        </section>
      )}
      {run && (
        <section aria-label="项目组合运行过程" className="min-w-0 space-y-3 rounded-lg border p-3">
          <h3 className="font-medium">{run.configurationPending ? "配置参数与授权" : `运行过程 · ${compositionRunLabel(run)}`}</h3>
          {run.configurationPending && (
            <section aria-label="组合步骤配置" className="space-y-3">
              <p className="text-sm">各步骤使用独立参数。保存参数不会授权代码；原流程尚未启动。</p>
              {run.definition.units.map(unit => {
                const key = compositionUnitConfigurationKey({ scope, runId: run.id,
                  unitId: unit.id, expectedVersion: run.version })
                return <section key={unit.id} aria-label={`配置步骤：${label(unit.id)}`} className="rounded border p-3">
                  <h4 className="text-sm font-medium">{label(unit.id)}</h4>
                  <ProjectFunctionConsent projectId={key} version={run.version}
                    api={api.unitMods} approvalLabel="授权此步骤"
                    onReady={ready => setUnitReady(previous => previous[key] === ready ? previous : { ...previous, [key]: ready })} />
                  <ProjectCompositionUnitContext api={api} scope={scope} run={run} unitId={unit.id}
                    configurationReady={!!unitReady[key]}
                    onReady={ready => setUnitContextReady(previous => previous[key] === ready ? previous : { ...previous, [key]: ready })}
                    onSaved={acceptRun} />
                </section>
              })}
              <button type="button" className={button}
                disabled={disabled || run.definition.units.some(unit => {
                  const key = compositionUnitConfigurationKey({ scope, runId: run.id, unitId: unit.id, expectedVersion: run.version })
                  return !unitReady[key] || !unitContextReady[key]
                })}
                onClick={() => void mutate(async () => {
                  const next = await api.startPrepared({ scope, runId: run.id, expectedVersion: run.version })
                  if (!alive.current) return
                  acceptRun(next)
                  setNotice("已提交运行，请以下方原引擎核实的状态为准。")
                })}>
                确认并启动
              </button>
            </section>
          )}
          {!run.configurationPending && ["running", "waiting-approval", "cancel-requested"].includes(run.status) && (
            <ProjectCompositionToolApprovals key={run.id} scope={scope} runId={run.id} api={api} />
          )}
          {run.status === "waiting-approval" && (
            <p className="text-sm">原流程正在等待确认，后续步骤尚未执行。</p>
          )}
          {approval && run.status === "waiting-approval" && (
            <section aria-label="原流程审批" className="space-y-2 rounded-md border p-3">
              <h4 className="font-medium">
                {approval.kind === "legacy-human-gate" ? "原流程人工确认" : approval.stageTitle}
              </h4>
              {approval.kind === "legacy-human-gate" && (
                <p className="whitespace-pre-wrap break-words text-sm">{approval.message}</p>
              )}
              {approval.kind !== "legacy-human-gate" &&
                approval.checks.map((check) => (
                  <p key={check} className="break-words text-sm">
                    检查：{check}
                  </p>
                ))}
              {approval.kind !== "legacy-human-gate" &&
                approval.artifacts.map((artifact) => (
                  <p key={artifact} className="break-words text-sm">
                    产物：{artifact}
                  </p>
                ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => setDecision("approved")}
                >
                  批准此阶段
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => setDecision("rejected")}
                >
                  拒绝此阶段
                </button>
              </div>
              {decision && (
                <div className="space-y-2" role="group" aria-label="确认审批决定">
                  <p className="text-sm">
                    确认{decision === "approved" ? "批准" : "拒绝"}“
                    {approval.kind === "legacy-human-gate" ? "原流程人工确认" : approval.stageTitle}
                    ”？决定将交由原流程处理。
                  </p>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void mutate(async () => {
                        const next = await api.approve(
                          compositionApprovalInput(scope, run, approval, decision)
                        )
                        if (!alive.current) return
                        acceptRun(next)
                        setApproval(null)
                        setDecision(null)
                        setNotice("审批决定已提交。请核对并恢复，让原流程继续检查。")
                      })
                    }
                  >
                    确认{decision === "approved" ? "批准" : "拒绝"}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => setDecision(null)}
                  >
                    返回核对
                  </button>
                </div>
              )}
            </section>
          )}
          {legacyDecision && run.status === "waiting-approval" && (
            <BizRetryDecisionCard
              key={legacyDecision.notificationId}
              notificationId={legacyDecision.notificationId}
              message={legacyDecision.message}
              humanGatePending={legacyDecision.humanGatePending}
              disabled={busy}
              onDecide={async (input) => {
                if (lock.current)
                  return { applied: false, message: "正在核对运行状态，请稍后再试。" }
                lock.current = true
                setBusy(true)
                try {
                  const result = await api.decideLegacyDecision({
                    scope,
                    runId: run.id,
                    unitId: legacyDecision.unitId,
                    notificationId: legacyDecision.notificationId,
                    expectedVersion: run.version,
                    ...input
                  })
                  if (alive.current && result.applied)
                    setNotice("业务决定已提交。请核对并恢复，让原流程继续检查。")
                  if (alive.current && !result.applied) setError(result.message)
                  return result
                } catch (cause) {
                  if (alive.current) setError(fail(cause))
                  const problem = compositionProblem(cause)
                  throw Error([problem.message, problem.nextStep].filter(Boolean).join(" "))
                } finally {
                  try {
                    const next = await api.read({ scope, runId: run.id })
                    if (alive.current) acceptRun(next)
                  } catch (cause) {
                    if (alive.current) setError(fail(cause))
                  }
                  lock.current = false
                  if (alive.current) {
                    setBusy(false)
                    setLegacyDecisionRefresh((value) => value + 1)
                  }
                }
              }}
            />
          )}
          {run.status === "unknown" && (
            <p className="text-sm">
              运行结果尚不明确。先核对原任务状态，不能直接重放有副作用的步骤。
            </p>
          )}
          <ol className="space-y-2 text-sm">
            {run.units.map((unit, index) => (
              <li key={unit.id} className="break-words">
                {index + 1}. {label(unit.id)} ·{" "}
                {unit.status === "succeeded" && !unit.proof
                  ? "完成结果待核对"
                  : unitStatus(unit.status)}
                {unit.reason && (
                  <ProjectCompositionProblem
                    value={unit.reason}
                    status={unit.status}
                    className="text-xs text-muted-foreground"
                  />
                )}
                {unit.status !== "pending" && (
                  <div className="mt-2">
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      aria-label={`打开运行文件夹 ${label(unit.id)}`}
                      onClick={() =>
                        void mutate(async () => {
                          await api.openWorkspace({ scope, runId: run.id, unitId: unit.id })
                        })
                      }
                    >
                      打开运行文件夹
                    </button>
                    {unit.status === "succeeded" &&
                      !run.definition.units.find((item) => item.id === unit.id)?.outputs.length && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          此流程未声明可交接的结果文件，可在运行文件夹中查看。
                        </p>
                      )}
                  </div>
                )}
                {unit.proof?.artifacts.map((output) => (
                  <div key={output.id} className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                      {output.path}
                    </span>
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      aria-label={`查看结果 ${label(unit.id)} · ${output.id}`}
                      onClick={() =>
                        void mutate(async () => {
                          const next = await api.readArtifact({
                            scope,
                            runId: run.id,
                            unitId: unit.id,
                            artifactId: output.id
                          })
                          if (alive.current) {
                            setArtifact(next)
                            setCopied(false)
                          }
                        })
                      }
                    >
                      查看结果
                    </button>
                  </div>
                ))}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  const next = await api.read({ scope, runId: run.id })
                  if (alive.current) acceptRun(next)
                })
              }
            >
              核对运行状态
            </button>
            {["waiting-approval", "unknown"].includes(run.status) && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    const next = await api.resume({
                      scope,
                      runId: run.id,
                      expectedVersion: run.version
                    })
                    if (alive.current) acceptRun(next)
                  })
                }
              >
                核对并恢复
              </button>
            )}
            {!["succeeded", "failed", "cancelled"].includes(run.status) && (
              <button
                type="button"
                className={button}
                disabled={busy || run.status === "cancel-requested"}
                onClick={() =>
                  void mutate(async () => {
                    const next = await api.cancel({
                      scope,
                      runId: run.id,
                      expectedVersion: run.version
                    })
                    if (alive.current) acceptRun(next)
                  })
                }
              >
                取消后续步骤
              </button>
            )}
          </div>
        </section>
      )}
      <Dialog
        open={artifact !== null}
        onOpenChange={(open) => {
          if (!open) setArtifact(null)
        }}
      >
        <DialogContent className="max-h-[85vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto">
          <DialogTitle className="break-words">{artifact?.title ?? "运行结果"}</DialogTitle>
          <p className="break-all text-xs text-muted-foreground">{artifact?.path}</p>
          {artifact?.content !== null && artifact?.content !== undefined ? (
            <>
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm">
                {artifact.content}
              </pre>
              <button
                type="button"
                className={button}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(artifact.content!)
                    .then(() => {
                      if (alive.current) setCopied(true)
                    })
                    .catch(() => {
                      if (alive.current) setError("复制未完成，请选中结果文字复制。")
                    })
                }}
              >
                {copied ? "已复制" : "复制结果文字"}
              </button>
            </>
          ) : (
            <p className="text-sm">{artifact?.message ?? "此文件暂不支持文本预览。"}</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
