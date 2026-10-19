import { useEffect, useRef, useState } from "react"
import { ProjectActionResults } from "./ProjectActionResults"
import { ProjectLibraryPanel } from "./ProjectLibraryPanel"
import { ProjectFunctionConsent } from "./ProjectFunctionConsent"
import { navigateProjectThread } from "./project-thread-navigation"
import { SparksDocumentationLink } from "../customize/SparksDocumentationLink"
import { projectRuntimeRecoveryMessage } from "./project-runtime-message"
import { projectLocalMetrics } from "../../../../shared/project-runtime/metrics"
import type {
  LocalProjectCommand,
  LocalProjectSummary,
  LocalProjectTemplate,
  LocalProjectView
} from "../../../../shared/project-runtime/platform-api"

const operationNames = {
  prepared: "准备就绪",
  started: "正在执行",
  cancel_requested: "正在停止",
  succeeded: "本阶段检查通过",
  failed: "未通过检查",
  cancelled: "已停止",
  unknown: "结果需要核对",
  transitioned: "此阶段已完成"
}
function message(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (/PROJECT_MODS_APPROVAL_REQUIRED/.test(text))
    return "请先在“本包功能权限”中核对源码和能力范围，并确认授权后再开始当前阶段。"
  const recovery = projectRuntimeRecoveryMessage(text)
  if (recovery) return recovery
  if (/VERSION_CONFLICT|INPUT_CHANGED|ARTIFACT_CHANGED|SCOPE_CHANGED/.test(text))
    return "项目或文件已变化。请更新记录，检查变化后重新准备。"
  if (/PLUGIN_UNAVAILABLE|PACKAGE_IDENTITY|SKILL_MISSING/.test(text))
    return "项目模板缺失、停用或无法读取。请恢复对应插件后重试。"
  if (/ALREADY_RUNNING|OPERATION_CONFLICT/.test(text)) return "已有步骤正在执行，请查看当前运行。"
  if (/APPROVAL/.test(text)) return "这一步需要人工确认，请先查看审批内容。"
  if (/ACTION_EXECUTION_REQUIRED/.test(text))
    return "这一步还需要调用其他插件，不能只检查文件。请开始当前阶段。"
  if (/ACTION_PROVIDER_CHANGED|ACTION_LOCK|ACTION_RUNTIME/.test(text))
    return "此步骤依赖的插件缺失、版本变化或尚未就绪。请恢复制作模板时使用的版本，再重新开始。"
  if (/RECONCILE_UNSUPPORTED/.test(text))
    return "无法自动确定上次执行结果，请核对原会话和实际产物，避免重复执行。"
  return "操作未完成。请展开问题详情，核对原因后重试。"
}

export function LocalProjectsPanel() {
  const [templates, setTemplates] = useState<LocalProjectTemplate[]>([])
  const [projects, setProjects] = useState<LocalProjectSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const refresh = async (more = false) => {
    const token = ++sequence.current
    setLoading(true)
    setError(undefined)
    try {
      const [nextTemplates, nextProjects] = await Promise.all([
        window.api.harnessBoard.localProjects.templates(),
        window.api.harnessBoard.localProjects.list(more ? projects.at(-1)?.projectId : undefined)
      ])
      if (token !== sequence.current) return
      setTemplates(nextTemplates)
      setProjects((previous) =>
        more
          ? [
              ...previous,
              ...nextProjects.filter((p) => !previous.some((old) => old.projectId === p.projectId))
            ]
          : nextProjects
      )
    } catch (cause) {
      if (token === sequence.current) setError(cause)
    } finally {
      if (token === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    return () => {
      sequence.current++
    }
  }, [])
  return (
    <section aria-label="本地项目任务" className="space-y-4 rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">本地项目任务</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            选择模板，填写目标，按阶段完成。无需填写企业项目编号。
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <SparksDocumentationLink initialFile="project-platform.md" label="使用说明" />
          <button
            type="button"
            disabled={loading}
            onClick={() => void refresh()}
            className="underline"
          >
            更新列表
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected(undefined)
              setCreating(true)
            }}
            className="underline"
          >
            新建本地任务
          </button>
        </div>
      </div>
      {!!error && <ProjectError error={error} />}
      {creating ? (
        <CreateLocalProject
          templates={templates}
          onCancel={() => setCreating(false)}
          onCreated={(view) => {
            setCreating(false)
            setSelected(view.project.projectId)
            void refresh()
          }}
        />
      ) : (
        <>
          {!projects.length && !loading && (
            <p className="text-sm text-muted-foreground">
              还没有本地任务。新建后会保留每一步的结果和检查记录。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                aria-pressed={selected === project.projectId}
                className="max-w-full rounded-lg border px-3 py-2 text-left text-sm aria-pressed:border-primary"
                onClick={() => setSelected(project.projectId)}
              >
                <span className="break-all">{project.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {project.status === "completed" ? "已完成" : `第 ${project.stageIndex + 1} 阶段`}
                </span>
              </button>
            ))}
          </div>
          {projects.length >= 20 && (
            <button
              disabled={loading}
              type="button"
              className="text-xs underline"
              onClick={() => void refresh(true)}
            >
              加载更多任务
            </button>
          )}
          {selected && (
            <LocalProjectRun key={selected} projectId={selected} onChanged={() => void refresh()} />
          )}
        </>
      )}
    </section>
  )
}

function ProjectError({ error }: { error: unknown }) {
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{message(error)}</p>
      <details className="text-xs">
        <summary className="cursor-pointer">问题详情</summary>
        <p className="break-all">{error instanceof Error ? error.message : String(error)}</p>
      </details>
    </div>
  )
}

function CreateLocalProject({
  templates,
  onCancel,
  onCreated
}: {
  templates: LocalProjectTemplate[]
  onCancel: () => void
  onCreated: (view: LocalProjectView) => void
}) {
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [template, setTemplate] = useState(
    templates.find((item) => !item.unavailableReason)?.installedPluginId ?? ""
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const active = useRef(true)
  const lock = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  return (
    <form
      className="grid max-w-2xl gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        if (lock.current) return
        lock.current = true
        setBusy(true)
        setError(undefined)
        try {
          const result = await window.api.harnessBoard.localProjects.create({
            name: name.trim(),
            goal: goal.trim(),
            workspace,
            installedPluginId: template
          })
          if (active.current) onCreated(result)
        } catch (cause) {
          if (active.current) setError(cause)
        } finally {
          lock.current = false
          if (active.current) setBusy(false)
        }
      }}
    >
      {!templates.length && (
        <p className="text-sm text-muted-foreground">
          暂无可用模板。请先在插件中安装项目模板包；开发示例为 project-docs-lite。
        </p>
      )}
      <label className="grid gap-1 text-sm">
        项目模板
        <select
          required
          value={template}
          disabled={busy}
          onChange={(event) => setTemplate(event.target.value)}
          className="rounded border bg-background p-2"
        >
          <option value="" disabled>
            请选择模板
          </option>
          {templates.map((item) => (
            <option
              key={item.installedPluginId}
              disabled={!!item.unavailableReason}
              value={item.installedPluginId}
            >
              {item.name} · {item.version}
              {item.unavailableReason ? "（暂不支持）" : ""}
            </option>
          ))}
        </select>
      </label>
      {templates
        .filter((item) => item.unavailableReason)
        .map((item) => (
          <p key={item.installedPluginId} className="text-xs text-muted-foreground">
            {item.name}：{item.unavailableReason}
          </p>
        ))}
      {template && (
        <p className="text-xs text-muted-foreground">
          {templates.find((item) => item.installedPluginId === template)?.stages.join(" → ")}
        </p>
      )}
      <label className="grid gap-1 text-sm">
        任务名称
        <input
          required
          maxLength={200}
          disabled={busy}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：写一份发布说明"
          className="rounded border bg-background p-2"
        />
      </label>
      <label className="grid gap-1 text-sm">
        希望完成什么
        <textarea
          required
          maxLength={8000}
          disabled={busy}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="描述目标、需要的内容和完成标准"
          className="min-h-24 rounded border bg-background p-2"
        />
      </label>
      <div className="text-sm">
        <button
          type="button"
          disabled={busy}
          className="underline"
          onClick={async () => {
            try {
              const result = await window.api.file.selectDirectory({ title: "选择任务工作目录" })
              if (active.current && !result.canceled && result.filePaths[0])
                setWorkspace(result.filePaths[0])
            } catch (cause) {
              if (active.current) setError(cause)
            }
          }}
        >
          选择工作目录
        </button>
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {workspace || "成果将保存在此目录"}
        </p>
      </div>
      {!!error && <ProjectError error={error} />}
      <p className="text-xs text-muted-foreground">
        创建仅保存配置；进入任务后点击“开始当前阶段”才会调用助手。
      </p>
      <div className="flex gap-4 text-sm">
        <button
          type="submit"
          disabled={busy || !workspace || !template}
          className="rounded border px-3 py-2 disabled:opacity-50"
        >
          {busy ? "正在创建…" : "创建任务"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          返回列表
        </button>
      </div>
    </form>
  )
}

export function LocalProjectRun({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [packageFunctionsReady, setPackageFunctionsReady] = useState(false)
  const [versions, setVersions] =
    useState<import("../../../../shared/project-runtime/version-report").ProjectVersionReport>()
  const [view, setView] = useState<LocalProjectView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const active = useRef(true)
  const lock = useRef(false)
  const latestRead = useRef(0)
  const latestNavigation = useRef(0)
  const load = async () => {
    const token = ++latestRead.current
    try {
      const next = await window.api.harnessBoard.localProjects.get(projectId)
      if (active.current && token === latestRead.current) {
        if (next.project.projectId !== projectId) throw Error("PROJECT_SCOPE_CHANGED")
        setView(next)
      }
    } catch (cause) {
      if (active.current && token === latestRead.current) setError(cause)
    }
  }
  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
      latestRead.current++
    }
  }, [])
  const observing =
    busy ||
    view?.operations.some((item) => item.status === "started" || item.status === "cancel_requested")
  useEffect(() => {
    if (!observing) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const observe = async () => {
      const token = latestRead.current
      try {
        const next = await window.api.harnessBoard.localProjects.get(projectId)
        if (
          !stopped &&
          active.current &&
          token === latestRead.current &&
          next.project.projectId === projectId
        ) {
          setView((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next
          )
        }
      } catch {
        // The explicit refresh/command reports errors. A background read never replaces the page.
      } finally {
        if (!stopped) timer = setTimeout(observe, 750)
      }
    }
    timer = setTimeout(observe, 250)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [projectId, observing])
  const command = async (input: LocalProjectCommand) => {
    if (!active.current) throw Error("PROJECT_SCOPE_CHANGED")
    const token = ++latestRead.current
    const next = await window.api.harnessBoard.localProjects.command(projectId, input)
    // A superseding read/cancel or unmount must also stop dependent approve/start calls.
    if (!active.current || token !== latestRead.current || next.project.projectId !== projectId)
      throw Error("PROJECT_SCOPE_CHANGED")
    latestRead.current++
    setView(next)
    return next
  }
  async function act(work: () => Promise<unknown>, allowWhileBusy = false) {
    if (!active.current || (lock.current && !allowWhileBusy)) return
    if (!allowWhileBusy) {
      lock.current = true
      setBusy(true)
    }
    setError(undefined)
    try {
      await work()
      if (active.current) onChanged()
    } catch (cause) {
      if (
        active.current &&
        !(cause instanceof Error && cause.message === "PROJECT_SCOPE_CHANGED")
      ) {
        setError(cause)
        await load()
      }
    } finally {
      if (!allowWhileBusy) {
        lock.current = false
        if (active.current) setBusy(false)
      }
    }
  }
  if (!view)
    return (
      <div>
        {error ? <ProjectError error={error} /> : <p className="text-sm">正在读取任务记录…</p>}
      </div>
    )
  const { project, operations } = view
  const metrics = projectLocalMetrics(operations)
  const stage = project.manifest.stages[project.stageIndex]
  const operation = operations.find(
    (item) =>
      item.expectedVersion === project.version &&
      ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(item.status)
  )
  const stageActions =
    project.manifest.actions?.filter((item) => stage?.actionIds?.includes(item.id)) ?? []
  const canCheckFilesOnly = stageActions.length === 0
  const prepareAnd = async (kind: "start" | "validate") => {
    const next = await command({
      kind: "prepare",
      expectedVersion: project.version,
      idempotencyKey: crypto.randomUUID()
    })
    const prepared = next.operations.find(
      (item) => item.expectedVersion === project.version && item.status === "prepared"
    )
    if (!prepared) throw Error("PROJECT_PREPARE_NOT_CONFIRMED")
    if (stage?.approval !== "human" || prepared.approval?.decision === "approved")
      await command({ kind, operationId: prepared.operationId })
  }
  return (
    <div className="space-y-4 border-t pt-4" aria-label="本地任务运行过程">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="break-all font-medium">
          {project.name} · {stage?.title ?? "已完成"}
        </h3>
        <button type="button" className="text-sm underline" onClick={() => void load()}>
          更新记录
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{project.goal}</p>
      {view.preview && <p className="rounded bg-muted p-2 text-sm">
        {view.preview.state === "active"
          ? `隔离试用版本 ${view.preview.revision}。此任务固定当前源码，结束本次试用后可创建新版本；不会更新正式插件。`
          : "此试用已结束或随应用重启失效，历史仍可查看。请回制作会话重新准备，不能从旧试用继续执行。"}
      </p>}
      {stageActions.length > 0 && (
        <div className="space-y-1 rounded bg-muted/30 p-3 text-sm">
          <p>助手完成本阶段后，将按顺序调用以下插件功能：</p>
          <ol className="list-inside list-decimal">
            {stageActions.map((item) => (
              <li key={item.id} className="break-words">
                {item.ref.plugin} · {item.id}
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            全部执行并通过检查后才能继续。仅有成果文件不能代替这些操作。
          </p>
        </div>
      )}
      <ol className="flex flex-wrap gap-3 text-xs">
        {project.manifest.stages.map((item, index) => (
          <li key={item.id}>
            {index < project.stageIndex
              ? "已完成"
              : index === project.stageIndex
                ? "当前"
                : "待开始"}
            ：{item.title}
          </li>
        ))}
      </ol>
      {!!error && <ProjectError error={error} />}
      {project.status === "active" && view.preview?.state !== "expired" &&
        !["started", "cancel_requested", "unknown"].includes(operation?.status ?? "") &&
        <ProjectFunctionConsent key={project.version} projectId={projectId}
          version={project.version} onReady={setPackageFunctionsReady} />}
      {operation && (
        <p role="status" className="text-sm">
          {busy ? "正在处理当前阶段，可在会话中查看助手工作。" : operationNames[operation.status]}
        </p>
      )}
      {operation?.status === "started" && (
        <p className="text-sm text-muted-foreground">
          打开“查看本次会话”可查看实时进度，处理文件修改等确认。确认后助手会继续执行。
        </p>
      )}
      <fieldset disabled={view.preview?.state === "expired" && !["started", "cancel_requested"].includes(operation?.status ?? "")} className="flex flex-wrap gap-3 text-sm">
        {stage && !operation && (
          <>
            <button
              type="button"
              disabled={busy || !packageFunctionsReady}
              className="rounded border px-3 py-2 disabled:opacity-50"
              onClick={() => void act(() => prepareAnd("start"))}
            >
              开始当前阶段
            </button>
            {canCheckFilesOnly && (
              <button
                type="button"
                disabled={busy}
                className="underline disabled:opacity-50"
                onClick={() => void act(() => prepareAnd("validate"))}
              >
                只检查已有成果
              </button>
            )}
          </>
        )}
        {operation?.status === "prepared" && stage?.approval === "human" && !operation.approval && (
          <>
            <p className="w-full text-sm">
              进入“{stage.title}”前需要你确认。
              {canCheckFilesOnly
                ? "可批准助手执行，也可仅检查已有成果。"
                : "批准后将执行助手任务和上方列出的插件功能。"}
            </p>
            <button
              type="button"
              disabled={busy || !packageFunctionsReady}
              className="rounded border px-3 py-2"
              onClick={() =>
                void act(async () => {
                  await command({
                    kind: "approve",
                    operationId: operation.operationId,
                    expectedVersion: operation.expectedVersion,
                    inputFingerprint: operation.inputFingerprint,
                    decision: "approved"
                  })
                  await command({ kind: "start", operationId: operation.operationId })
                })
              }
            >
              批准并执行
            </button>
            {canCheckFilesOnly && (
              <button
                type="button"
                disabled={busy}
                className="underline"
                onClick={() =>
                  void act(async () => {
                    await command({
                      kind: "approve",
                      operationId: operation.operationId,
                      expectedVersion: operation.expectedVersion,
                      inputFingerprint: operation.inputFingerprint,
                      decision: "approved"
                    })
                    await command({ kind: "validate", operationId: operation.operationId })
                  })
                }
              >
                批准，仅检查已有成果
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className="underline"
              onClick={() =>
                void act(() =>
                  command({
                    kind: "approve",
                    operationId: operation.operationId,
                    expectedVersion: operation.expectedVersion,
                    inputFingerprint: operation.inputFingerprint,
                    decision: "rejected"
                  })
                )
              }
            >
              拒绝本次执行
            </button>
          </>
        )}
        {operation?.status === "prepared" &&
          (stage?.approval !== "human" || operation.approval?.decision === "approved") && (
            <>
              <button
                type="button"
                disabled={busy || !packageFunctionsReady}
                onClick={() =>
                  void act(() => command({ kind: "start", operationId: operation.operationId }))
                }
              >
                继续执行
              </button>
              {canCheckFilesOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      command({ kind: "validate", operationId: operation.operationId })
                    )
                  }
                >
                  只检查已有成果
                </button>
              )}
            </>
          )}
        {operation?.status === "succeeded" && (
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2"
            onClick={() =>
              void act(() => command({ kind: "advance", operationId: operation.operationId }))
            }
          >
            {project.stageIndex + 1 < project.manifest.stages.length
              ? "进入下一阶段"
              : "确认完成任务"}
          </button>
        )}
        {operation &&
          ["prepared", "started", "succeeded", "cancel_requested"].includes(operation.status) && (
            <button
              type="button"
              disabled={operation.status === "cancel_requested"}
              className="underline"
              onClick={() =>
                void act(
                  () => command({ kind: "cancel", operationId: operation.operationId }),
                  true
                )
              }
            >
              停止本次步骤
            </button>
          )}
      </fieldset>
      {operation?.status === "unknown" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            上次运行的结果尚未确定。请先查看原会话与成果文件；系统不会自动重跑，避免重复修改。
          </p>
          <button
            type="button"
            disabled={busy}
            className="text-sm underline"
            onClick={() =>
              void act(() => command({ kind: "reconcile", operationId: operation.operationId }))
            }
          >
            核对上次执行结果
          </button>
          <p className="text-xs text-muted-foreground">
            只核对已保存的真实结束记录和当前成果。有文件但没有结束记录时，仍会保持“结果需要核对”。
          </p>
        </div>
      )}
      <ProjectLibraryPanel key={project.projectId} view={view} />
      <details open className="rounded-lg bg-muted/30 p-3">
        <summary className="cursor-pointer text-sm font-medium">检查结果与历史</summary>
        {!operations.length && (
          <p className="mt-2 text-xs text-muted-foreground">
            开始任务后，这里会记录结果、失败原因和检查项。
          </p>
        )}
        <ul className="mt-2 space-y-3">
          {operations.map((item) => (
            <li key={item.operationId} className="text-xs">
              <p>
                {project.manifest.stages.find((value) => value.id === item.stageId)?.title ??
                  item.stageId}{" "}
                · {operationNames[item.status]} · {new Date(item.updatedAt).toLocaleString()}
              </p>
              {item.execution?.threadId && (
                <button
                  type="button"
                  className="mt-1 underline"
                  onClick={() => {
                    const navigation = ++latestNavigation.current
                    void import("../../lib/store")
                      .then(({ useAppStore, isThreadDeletionPending }) =>
                        navigateProjectThread(
                          {
                            threadId: item.execution!.threadId,
                            projectId: project.projectId,
                            operationId: item.operationId,
                            stageId: item.stageId,
                            pluginDigest: project.pluginDigest,
                            workspace: project.workspace
                          },
                          {
                            read: (id) =>
                              window.api.threads.get(id, { requestScope: "foreground-hydration" }),
                            isCurrent: () =>
                              active.current && navigation === latestNavigation.current,
                            isRetired: isThreadDeletionPending,
                            add: (thread) => useAppStore.getState().addThreadSummary(thread),
                            select: (id) => useAppStore.getState().selectThread(id)
                          }
                        )
                      )
                      .catch((cause) => {
                        if (active.current) setError(cause)
                      })
                  }}
                >
                  查看本次会话
                </button>
              )}
              {item.approval?.decision === "rejected" && <p>你已拒绝本次执行，可重新准备。</p>}
              {item.execution?.threadId &&
                project.manifest.stages.some(
                  (stage) => stage.id === item.stageId && (stage.actionIds?.length ?? 0) > 0
                ) && (
                  <ProjectActionResults
                    projectId={project.projectId}
                    operationId={item.operationId}
                  />
                )}
              {item.receipts.map((receipt) => {
                const check = project.manifest.checks.find((value) => value.id === receipt.checkId)
                const artifact = project.manifest.artifacts.find(
                  (value) => value.id === check?.artifactId
                )
                return (
                  <p key={receipt.checkId} className="mt-1 break-all">
                    {receipt.result === "passed" ? "通过" : "待修复"} ·{" "}
                    {artifact?.path ?? receipt.checkId}
                    {receipt.result !== "passed" &&
                      (check?.kind === "file-exists"
                        ? "：未能确认文件存在，请生成此文件后重试。"
                        : "：未满足模板的内容检查，请修正成果后重试。")}
                  </p>
                )
              })}
              {item.status === "failed" && !item.receipts.length && (
                <p className="mt-1 text-muted-foreground">
                  本次步骤未完成；若已调用助手，请查看对应会话。核对问题详情和成果文件后可重新开始。
                </p>
              )}
            </li>
          ))}
        </ul>
      </details>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">耗时与重复执行</summary>
        <p className="mt-2">
          保留的 {metrics.retainedOperations} 条步骤记录中，失败 {metrics.failed} 次，结果未确认{" "}
          {metrics.unknown} 次，重复执行 {metrics.repeatedExecutions} 次。
        </p>
        <p className="mt-1">
          有完整起止记录的执行耗时：
          {metrics.observedExecutionMs === null
            ? "未知"
            : `${Math.round(metrics.observedExecutionMs / 1000)} 秒`}
          ； 已记录的审批等待：
          {metrics.observedApprovalWaitMs === null
            ? "未知"
            : `${Math.round(metrics.observedApprovalWaitMs / 1000)} 秒`}
          。
        </p>
        <p className="mt-1">
          只统计此页最多 20 条历史记录，执行耗时不含审批等待。模型用量见对应会话，费用尚无可靠记录。
        </p>
      </details>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">任务配置与版本</summary>
        <p className="mt-2 break-all">工作目录：{project.workspace}</p>
        <p>固定模板版本：{project.packageVersion}。插件更新不会替换本任务的模板副本。</p>
        <p className="mt-1">停止执行不撤销已写入的文件；检查通过后仍需点击进入下一阶段。</p>
        <p className="mt-1">
          阶段会话用于回看过程。需要重试时从本任务开始，继续使用固定版本和检查规则。
        </p>
        <button
          type="button"
          disabled={busy}
          className="mt-2 underline"
          onClick={() =>
            void act(async () => {
              const report = await window.api.harnessBoard.localProjects.versions(projectId)
              if (active.current) setVersions(report)
            })
          }
        >
          比较已安装版本
        </button>
        {versions && (
          <div className="mt-2 space-y-1">
            <p>
              本任务版本：{versions.retainedVersion}；已安装版本：
              {versions.installedVersion ?? "不可用"}。
            </p>
            {versions.differences.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
            <p>{versions.guidance}</p>
          </div>
        )}
      </details>
    </div>
  )
}
