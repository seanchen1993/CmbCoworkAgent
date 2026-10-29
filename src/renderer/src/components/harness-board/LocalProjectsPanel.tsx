import { useEffect, useRef, useState } from "react"
import { ProjectActionResults } from "./ProjectActionResults"
import { ProjectCheckDiagnostics } from "./ProjectCheckDiagnostics"
import { LocalProjectImport } from "./LocalProjectImport"
import { ProjectLibraryPanel } from "./ProjectLibraryPanel"
import { ProjectFunctionConsent } from "./ProjectFunctionConsent"
import { navigateProjectThread } from "./project-thread-navigation"
import { SparksDocumentationLink } from "../customize/SparksDocumentationLink"
import { projectRuntimeRecoveryMessage } from "./project-runtime-message"
import { projectLocalMetrics } from "../../../../shared/project-runtime/metrics"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { useAppStore } from "@/lib/store"
import {
  dismissHostProjectIntent,
  hostProjectIntentCurrent,
  useHostProjectIntent
} from "@/lib/host-project-intent"
import { readHostProjectThreadTarget, resolveHostProjectThread } from "@/lib/host-project-thread"
import {
  dismissHostPluginStartUse,
  hostPluginStartUseCurrent,
  useHostPluginStartUseIntent,
  type HostPluginStartUseIntent
} from "@/lib/plugin-start-use-intent"
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
  if (/TEMPLATE_IDENTITY|PACKAGE_IDENTITY_MISMATCH/.test(text))
    return "项目插件身份尚未就绪或已变化。请更新列表，重新选择插件后再创建。"
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
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(false)
  const startUseIntent = useHostPluginStartUseIntent()
  const [startUse, setStartUse] = useState<HostPluginStartUseIntent>()
  const [templatesReady, setTemplatesReady] = useState(false)
  const accountRevision = useAppStore((state) => state.accountRevision)
  const threads = useAppStore((state) => state.threads)
  const sequence = useRef(0)
  const projectIntent = useHostProjectIntent()
  useEffect(() => {
    if (!projectIntent) return
    let current = true
    setSelected(undefined)
    setCreating(false)
    setImporting(false)
    setError(undefined)
    void resolveHostProjectThread(projectIntent.target, {
      readThread: id => window.api.threads.get(id, { requestScope: "foreground-hydration" }),
      readProject: id => window.api.harnessBoard.localProjects.get(id),
      isCurrent: () => current && hostProjectIntentCurrent(projectIntent)
    }).then(id => {
      if (!current) return
      if (id && hostProjectIntentCurrent(projectIntent)) {
        setSelected(id)
        setCreating(false)
        setImporting(false)
      } else setError(Error("HOST_PROJECT_NAVIGATION_CHANGED"))
      dismissHostProjectIntent(projectIntent.id)
    }).catch(cause => {
      if (!current) return
      setError(cause)
      dismissHostProjectIntent(projectIntent.id)
    })
    return () => { current = false }
  }, [projectIntent])
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
      setTemplatesReady(true)
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
  useEffect(() => {
    if (!startUseIntent || loading || !templatesReady) return
    const identity = startUseIntent.report.identity
    const matches = templates.filter((item) => item.installedPluginId === identity.pluginId)
    if (
      !hostPluginStartUseCurrent(startUseIntent) ||
      matches.length !== 1 ||
      matches[0].name !== identity.name ||
      matches[0].version !== identity.version ||
      matches[0].unavailableReason
    ) {
      setError(Error("PROJECT_HOST_PACKAGE_IDENTITY_MISMATCH"))
    } else {
      setSelected(undefined)
      setStartUse(startUseIntent)
      setCreating(true)
    }
    dismissHostPluginStartUse(startUseIntent.id)
  }, [startUseIntent, loading, templatesReady, templates])
  useEffect(() => {
    if (startUse && !hostPluginStartUseCurrent(startUse)) {
      setCreating(false)
      setStartUse(undefined)
      setError(Error("PLUGIN_START_USE_SCOPE_CHANGED"))
    }
  }, [startUse, accountRevision, threads])
  return (
    <section aria-label="项目列表" className="space-y-4 rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">项目列表</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            选择项目插件，填写配置，按阶段完成并保留运行记录。
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
              setStartUse(undefined)
              setCreating(true)
              setImporting(false)
            }}
            className="underline"
          >
            新建项目
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setCreating(false)
              setImporting(true)
              setSelected(undefined)
            }}
          >
            导入旧项目成果
          </button>
        </div>
      </div>
      {!!error && <ProjectError error={error} />}
      {importing ? (
        <LocalProjectImport
          templates={templates}
          onCancel={() => setImporting(false)}
          onCreated={(view) => {
            setImporting(false)
            setSelected(view.project.projectId)
            void refresh()
          }}
        />
      ) : creating ? (
        <CreateLocalProject
          key={startUse?.id ?? "manual"}
          templates={templates}
          startUse={startUse}
          onCancel={() => {
            setCreating(false)
            setStartUse(undefined)
          }}
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
              还没有项目。新建后会保留每一步的结果和检查记录。
            </p>
          )}
          <HostProjectListItems projects={projects} selected={selected} onSelect={setSelected} />
          {projects.length >= 20 && (
            <button
              disabled={loading}
              type="button"
              className="text-xs underline"
              onClick={() => void refresh(true)}
            >
              加载更多项目
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

export function HostProjectListItems({
  projects,
  selected,
  onSelect
}: {
  projects: LocalProjectSummary[]
  selected?: string
  onSelect: (projectId: string) => void
}) {
  return (
    <div className="grid gap-2">
      {projects.map((project) => (
        <button
          key={project.projectId}
          type="button"
          data-project-runtime="host"
          aria-label={`打开项目 ${project.name}`}
          aria-pressed={selected === project.projectId}
          className="rounded-xl border bg-background p-4 text-left aria-pressed:border-primary"
          onClick={() => onSelect(project.projectId)}
        >
          <span className="font-medium">{project.name}</span>
          <span className="ml-3 text-sm text-muted-foreground">
            {project.status === "completed" ? "已完成" : `第 ${project.stageIndex + 1} 阶段`}
          </span>
          <p className="mt-1 truncate text-xs text-muted-foreground">{project.workspace}</p>
        </button>
      ))}
    </div>
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

export function CreateLocalProject({
  templates,
  startUse,
  installedPluginId,
  onBusyChange,
  onCancel,
  onCreated
}: {
  templates: LocalProjectTemplate[]
  startUse?: HostPluginStartUseIntent
  installedPluginId?: string
  onBusyChange?: (busy: boolean) => void
  onCancel: () => void
  onCreated: (view: LocalProjectView) => void
}) {
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [workspace, setWorkspace] = useState("")
  const captureTemplate = (id: string) => {
    const identity = templates.find((item) => item.installedPluginId === id)?.expectedTemplate
    return { id, expectedTemplate: identity ? { ...identity } : undefined }
  }
  const [selection, setSelection] = useState(() =>
    captureTemplate(
      installedPluginId ??
        startUse?.report.identity.pluginId ??
        templates.find((item) => !item.unavailableReason)?.installedPluginId ??
        ""
    )
  )
  const template = selection.id
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
        const account = useAppStore.getState().accountRevision
        const current = () => active.current && useAppStore.getState().accountRevision === account
        setBusy(true)
        onBusyChange?.(true)
        setError(undefined)
        try {
          if (startUse) {
            if (!hostPluginStartUseCurrent(startUse)) throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
            const actual = await window.api.plugins.prepareStartUse(startUse.input)
            if (!current()) return
            const fixed = startUse.report.identity
            if (
              !hostPluginStartUseCurrent(startUse) ||
              actual.kind !== "host-project" ||
              !actual.canOpen ||
              actual.identity.pluginId !== fixed.pluginId ||
              actual.identity.name !== fixed.name ||
              actual.identity.version !== fixed.version ||
              actual.identity.digest !== fixed.digest
            )
              throw Error("PROJECT_HOST_PACKAGE_IDENTITY_MISMATCH")
          }
          if (
            !startUse &&
            (!selection.expectedTemplate || selection.expectedTemplate.pluginId !== template)
          )
            throw Error("PROJECT_HOST_TEMPLATE_IDENTITY_REQUIRED")
          const result = await window.api.harnessBoard.localProjects.create({
            name: name.trim(),
            goal: goal.trim(),
            workspace,
            installedPluginId: template,
            ...(startUse
              ? {
                  expectedPlugin: startUse.report.identity,
                  startUseScope: {
                    threadId: startUse.input.threadId,
                    expectedWorkspace: startUse.input.expectedWorkspace
                  }
                }
              : { expectedTemplate: selection.expectedTemplate })
          })
          if (current() && (!startUse || hostPluginStartUseCurrent(startUse))) onCreated(result)
        } catch (cause) {
          if (active.current) setError(cause)
        } finally {
          lock.current = false
          if (active.current) {
            setBusy(false)
            onBusyChange?.(false)
          }
        }
      }}
    >
      {!templates.length && (
        <p className="text-sm text-muted-foreground">
          暂无可用模板。请先在插件中安装项目模板包；开发示例为 project-docs-lite。
        </p>
      )}
      {!installedPluginId && (
        <label className="grid gap-1 text-sm">
          项目插件
          <select
            required
            value={template}
            disabled={busy || !!startUse}
            onChange={(event) => setSelection(captureTemplate(event.target.value))}
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
      )}
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
        项目名称
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
        创建仅保存配置；进入项目后点击“开始当前阶段”才会调用助手。
      </p>
      <div className="flex gap-4 text-sm">
        <button
          type="submit"
          disabled={busy || !workspace || !template}
          className="rounded border px-3 py-2 disabled:opacity-50"
        >
          {busy ? "正在创建…" : "创建项目"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          返回列表
        </button>
      </div>
    </form>
  )
}

export function LocalProjectRun({
  projectId,
  onChanged
}: {
  projectId: string
  onChanged: () => void
}) {
  const [resultFeedback, setResultFeedback] = useState<{ scope: string; text: string }>()
  const [stageInstructions, setStageInstructions] = useState<{ scope: string; text: string }>()
  const [packageFunctionsReady, setPackageFunctionsReady] = useState(false)
  const [providerConsent, setProviderConsent] = useState<{
    operationId: string
    policyDigest: string
  }>()
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
    (!!view?.inputWait && view.inputWait.resumable !== false) ||
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
  const operation = view?.operations.find(
    (item) =>
      item.expectedVersion === view.project.version &&
      ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(item.status)
  )
  const feedbackScope = JSON.stringify([
    projectId,
    view?.project.version,
    view?.project.stageIndex,
    operation?.operationId
  ])
  const feedbackText = resultFeedback?.scope === feedbackScope ? resultFeedback.text : ""
  useEffect(() => setResultFeedback(undefined), [feedbackScope])
  const latestStageOperation = view?.operations.find(
    (item) =>
      item.expectedVersion === view.project.version &&
      item.stageId === view.project.manifest.stages[view.project.stageIndex]?.id
  )
  const instructionsScope = JSON.stringify([
    projectId,
    view?.project.version,
    view?.project.stageIndex,
    latestStageOperation?.operationId
  ])
  const instructionsText =
    stageInstructions?.scope === instructionsScope ? stageInstructions.text : ""
  useEffect(() => setStageInstructions(undefined), [instructionsScope])
  if (!view)
    return (
      <div>
        {error ? <ProjectError error={error} /> : <p className="text-sm">正在读取任务记录…</p>}
      </div>
    )
  const { project, operations } = view
  const metrics = projectLocalMetrics(operations)
  const stage = project.manifest.stages[project.stageIndex]
  const importedStage = Boolean(stage && view.importedSource?.prefixStageIds.includes(stage.id))
  const reexecuteImportedStage = Boolean(
    stage && view.importedSource?.reexecuteStageIds?.includes(stage.id)
  )
  const validateImportedStage = importedStage && !reexecuteImportedStage
  const canAddStageInstructions =
    !validateImportedStage &&
    !operation &&
    latestStageOperation?.status === "failed" &&
    !operations.some((item) => ["started", "cancel_requested", "unknown"].includes(item.status))
  const pendingStageInstructions = canAddStageInstructions ? instructionsText.trim() : ""
  const executionKind = validateImportedStage ? ("validate-imported" as const) : ("start" as const)
  const resultApprovalRequired = view.resultApprovalRequired ?? stage?.resultApproval === "human"
  const resultApproved =
    !resultApprovalRequired ||
    (operation?.resultApproval?.decision === "approved" &&
      view.resultReview &&
      operation.resultApproval.artifactFingerprint === view.resultReview.artifactFingerprint &&
      operation.resultApproval.receiptFingerprint === view.resultReview.receiptFingerprint &&
      operation.resultApproval.policyDigest === view.resultReview.policyDigest)
  const stageActions =
    project.manifest.actions?.filter((item) => stage?.actionIds?.includes(item.id)) ?? []
  const canCheckFilesOnly =
    !importedStage &&
    stageActions.length === 0 &&
    !operation?.contextProvider &&
    !project.manifest.checks.some(
      (check) => stage?.checkIds.includes(check.id) && check.kind === "action"
    )
  const providerApproved =
    !operation?.contextProvider ||
    (providerConsent?.operationId === operation.operationId &&
      providerConsent.policyDigest === operation.contextProvider.policyDigest)
  const prepareAnd = async (kind: "start" | "validate") => {
    const next = await command({
      kind: "prepare",
      expectedVersion: project.version,
      idempotencyKey: crypto.randomUUID(),
      ...(kind === "start" && pendingStageInstructions
        ? { stageInstructions: pendingStageInstructions }
        : {})
    })
    const prepared = next.operations.find(
      (item) => item.expectedVersion === project.version && item.status === "prepared"
    )
    if (!prepared) throw Error("PROJECT_PREPARE_NOT_CONFIRMED")
    if (
      next.project.version !== project.version ||
      next.project.stageIndex !== project.stageIndex ||
      next.project.pluginDigest !== project.pluginDigest ||
      prepared.stageId !== stage?.id
    )
      throw Error("PROJECT_SCOPE_CHANGED")
    if (kind === "start" && pendingStageInstructions) {
      if (prepared.stageInstructions !== pendingStageInstructions)
        throw Error("PROJECT_PREPARE_NOT_CONFIRMED")
      setStageInstructions(undefined)
    }
    if (
      (stage?.approval !== "human" && !prepared.contextProvider) ||
      prepared.approval?.decision === "approved"
    )
      await command({
        kind: kind === "start" ? executionKind : kind,
        operationId: prepared.operationId
      })
  }
  const retryRejectedResult = async () => {
    if (operation?.status !== "succeeded" || operation.resultApproval?.decision !== "rejected")
      throw Error("PROJECT_SCOPE_CHANGED")
    const cancelled = await command({ kind: "cancel", operationId: operation.operationId })
    if (
      cancelled.project.version !== project.version ||
      cancelled.project.stageIndex !== project.stageIndex ||
      cancelled.project.pluginDigest !== project.pluginDigest ||
      !cancelled.operations.some(
        (item) => item.operationId === operation.operationId && item.status === "cancelled"
      )
    )
      throw Error("PROJECT_SCOPE_CHANGED")
    await prepareAnd("start")
  }
  return (
    <div className="space-y-4 border-t pt-4" aria-label="本地任务运行过程">
      {validateImportedStage && (
        <p className="text-sm text-muted-foreground">
          当前成果来自旧项目。点击“重新验证导入成果”只执行实际检查，随后确认这份成果；历史成功不会自动计入新任务。
        </p>
      )}
      {reexecuteImportedStage && (
        <p className="text-sm text-muted-foreground">
          旧材料已保留。当前阶段需要重新执行技能并通过检查，再由你确认新成果；旧项目的完成状态不会自动沿用。
        </p>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="break-all font-medium">
          {project.name} · {stage?.title ?? "已完成"}
        </h3>
        <button type="button" className="text-sm underline" onClick={() => void load()}>
          更新记录
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{project.goal}</p>
      {view.inputWait && (
        <div role="status" className="rounded border p-3 text-sm space-y-2">
          <p>
            {view.inputWait.resumable === false
              ? "问题与已提交的回答均已保留，但此步骤存在尚未证明已结束的外部操作。请在原会话核对执行结果，当前不能自动续接或重跑。"
              : view.inputWait.status === "waiting"
                ? "此步骤正在等待你的回答，请打开阶段会话填写输入卡片。"
                : "回答已保存。继续前会核对原任务检查点、插件版本与子任务状态，避免重复执行。"}
          </p>
          {view.inputWait.status === "answered" && view.inputWait.resumable !== false && (
            <button
              type="button"
              className="underline"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  command({
                    kind: "resume-input",
                    operationId: view.inputWait!.operationId,
                    requestId: view.inputWait!.requestId
                  })
                )
              }
            >
              继续已保存输入
            </button>
          )}
        </div>
      )}
      {view.preview && (
        <p className="text-xs text-muted-foreground">
          {view.preview.state === "active"
            ? `正在试用版本 ${view.preview.revision}`
            : "此试用已结束或随应用重启失效，历史仍可查看。请回制作会话重新准备，不能从旧试用继续执行。"}
        </p>
      )}
      {stageActions.length > 0 && (
        <details className="space-y-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">本步骤使用的功能（{stageActions.length}）</summary>
          <ol className="list-inside list-decimal">
            {stageActions.map((item) => (
              <li key={item.id} className="break-words">
                {item.ref.plugin} · {item.id}
              </li>
            ))}
          </ol>
        </details>
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
      {view.resultReviewError && (
        <p role="alert" className="text-sm text-destructive">
          {view.resultReviewError}
        </p>
      )}
      {view.continuation && (
        <p role="status" className="text-sm">
          {view.continuation.reason === "completed"
            ? "任务已完成。"
            : view.continuation.reason === "budget"
              ? "本次连续执行已到边界，可检查结果后继续。"
              : ["approval_required", "result_approval_required"].includes(view.continuation.reason)
                ? "任务已停在需要你确认的位置，请处理下方待办。"
                : "连续执行已停止，请核对当前步骤的结果与待办后继续。"}
        </p>
      )}
      {project.status === "active" &&
        view.preview?.state !== "expired" &&
        !["started", "cancel_requested", "unknown"].includes(operation?.status ?? "") && (
          <ProjectFunctionConsent
            key={project.version}
            projectId={projectId}
            version={project.version}
            onReady={setPackageFunctionsReady}
          />
        )}
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
      {canAddStageInstructions && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">补充要求（可选）</summary>
          <label className="block space-y-2 text-sm">
            <span>本次阶段补充说明（可选）</span>
            <textarea
              aria-label="本次阶段补充说明（可选）"
              maxLength={4000}
              disabled={busy}
              value={instructionsText}
              onChange={(event) =>
                setStageInstructions({ scope: instructionsScope, text: event.target.value })
              }
              className="min-h-24 w-full rounded border bg-background p-2"
            />
            <span className="block text-xs text-muted-foreground">填写后点击“开始当前阶段”。</span>
          </label>
        </details>
      )}
      <fieldset
        disabled={
          view.preview?.state === "expired" &&
          !["started", "cancel_requested"].includes(operation?.status ?? "")
        }
        className="flex flex-wrap gap-3 text-sm"
      >
        {stage &&
          !importedStage &&
          !["started", "cancel_requested", "unknown"].includes(operation?.status ?? "") && (
            <button
              type="button"
              disabled={busy || !packageFunctionsReady || Boolean(pendingStageInstructions)}
              className="rounded border border-primary bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
              onClick={() =>
                void act(() => command({ kind: "continue", expectedVersion: project.version }))
              }
            >
              开始执行
            </button>
          )}
        {pendingStageInstructions && (
          <p className="w-full text-muted-foreground">
            已有补充说明，请点击“开始当前阶段”；连续执行不会携带这份说明。
          </p>
        )}
        {stage && !operation && (
          <>
            <button
              type="button"
              disabled={busy || !packageFunctionsReady}
              className="rounded border px-3 py-2 disabled:opacity-50"
              onClick={() => void act(() => prepareAnd("start"))}
            >
              {validateImportedStage ? "重新验证导入成果" : "开始当前阶段"}
            </button>
            {canCheckFilesOnly && (
              <button
                type="button"
                disabled={busy || Boolean(pendingStageInstructions)}
                className="underline disabled:opacity-50"
                onClick={() => void act(() => prepareAnd("validate"))}
              >
                只检查已有成果
              </button>
            )}
          </>
        )}
        {operation?.status === "prepared" &&
          (stage?.approval === "human" || operation.contextProvider) &&
          !operation.approval && (
            <>
              <p className="w-full text-sm">
                进入“{stage?.title}”前需要你确认。
                {canCheckFilesOnly
                  ? "可批准助手执行，也可仅检查已有成果。"
                  : "批准后将执行助手任务和上方列出的插件功能。"}
              </p>
              {operation.contextProvider && (
                <div
                  className="w-full space-y-2 rounded border p-3"
                  aria-label="本次上下文脚本执行确认"
                >
                  <p>{operation.contextProvider.notice}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    本次操作 {operation.operationId} · 策略{" "}
                    {operation.contextProvider.policyDigest.slice(0, 12)}
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={providerApproved}
                      onChange={(event) =>
                        setProviderConsent(
                          event.target.checked
                            ? {
                                operationId: operation.operationId,
                                policyDigest: operation.contextProvider!.policyDigest
                              }
                            : undefined
                        )
                      }
                    />
                    我已核对本次上下文脚本及其网络、外部副作用，同意仅此阶段操作执行。
                  </label>
                </div>
              )}
              <button
                type="button"
                disabled={busy || !packageFunctionsReady || !providerApproved}
                className="rounded border px-3 py-2"
                onClick={() =>
                  void act(async () => {
                    await command({
                      kind: "approve",
                      operationId: operation.operationId,
                      expectedVersion: operation.expectedVersion,
                      inputFingerprint: operation.inputFingerprint,
                      decision: "approved",
                      ...(operation.contextProvider
                        ? {
                            contextProviderApproval: {
                              policyDigest: operation.contextProvider.policyDigest,
                              allowNetworkSideEffects: true as const
                            }
                          }
                        : {})
                    })
                    await command({ kind: executionKind, operationId: operation.operationId })
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
          ((stage?.approval !== "human" && !operation.contextProvider) ||
            operation.approval?.decision === "approved") && (
            <>
              <button
                type="button"
                disabled={busy || !packageFunctionsReady}
                onClick={() =>
                  void act(() =>
                    command({ kind: executionKind, operationId: operation.operationId })
                  )
                }
              >
                {validateImportedStage ? "重新验证导入成果" : "继续执行"}
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
        {operation?.status === "succeeded" && resultApprovalRequired && !resultApproved && (
          <div className="w-full space-y-2 rounded border p-3" aria-label="成果确认">
            <p>“{stage.title}”已完成检查，请确认成果。</p>
            {operation.resultApproval?.decision === "rejected" && (
              <>
                <p>你已拒绝这版成果，流程尚未推进。</p>
                {operation.resultApproval.feedback && (
                  <p className="whitespace-pre-wrap break-words" aria-label="已保存的修改意见">
                    已保存的修改意见：{operation.resultApproval.feedback}
                  </p>
                )}
              </>
            )}
            <label className="block space-y-1">
              <span>修改意见（拒绝时保存，可选）</span>
              <textarea
                aria-label="成果修改意见"
                className="block w-full rounded border bg-background p-2"
                rows={3}
                maxLength={4000}
                disabled={busy}
                readOnly={operation.resultApproval?.decision === "rejected"}
                value={
                  operation.resultApproval?.decision === "rejected"
                    ? (operation.resultApproval.feedback ?? "")
                    : feedbackText
                }
                onChange={(event) =>
                  setResultFeedback({ scope: feedbackScope, text: event.target.value })
                }
                placeholder="说明需要修改的内容；不会改变原检查和权限要求。"
              />
              <span className="text-xs text-muted-foreground">
                {operation.resultApproval?.decision === "rejected"
                  ? "本次拒绝和意见已保存，不能改写；重新执行会保留这份记录。"
                  : "最多 4000 字符，先拒绝保存再重新执行。"}
              </span>
            </label>
            <button
              type="button"
              disabled={busy || !view.resultReview || Boolean(operation.resultApproval)}
              className="rounded border px-3 py-2"
              onClick={() =>
                void act(() =>
                  command({
                    kind: "approve-result",
                    operationId: operation.operationId,
                    review: view.resultReview!,
                    decision: "approved"
                  })
                )
              }
            >
              接受当前成果
            </button>
            <button
              type="button"
              disabled={busy || !view.resultReview || Boolean(operation.resultApproval)}
              className="ml-3 underline"
              onClick={() =>
                void act(() =>
                  command({
                    kind: "approve-result",
                    operationId: operation.operationId,
                    review: view.resultReview!,
                    decision: "rejected",
                    ...(feedbackText.trim() ? { feedback: feedbackText.trim() } : {})
                  })
                )
              }
            >
              拒绝当前成果
            </button>
            {operation.resultApproval?.decision === "rejected" && !validateImportedStage && (
              <div className="space-y-1">
                <button
                  type="button"
                  disabled={busy || !packageFunctionsReady}
                  className="rounded border px-3 py-2 disabled:opacity-50"
                  onClick={() => void act(retryRejectedResult)}
                >
                  按修改意见重新执行
                </button>
                <p className="text-xs text-muted-foreground">
                  使用已保存的意见创建新的本阶段操作，保留原检查和拒绝记录；需要执行确认时会再次停下。
                </p>
              </div>
            )}
          </div>
        )}
        {operation?.status === "succeeded" && resultApproved && (
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
      <details
        open={!!operation || ["failed", "unknown"].includes(latestStageOperation?.status ?? "")}
        className="rounded-lg bg-muted/30 p-3"
      >
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
                    const account = useAppStore.getState().accountRevision
                    void import("../../lib/store")
                      .then(({ useAppStore, isThreadDeletionPending }) =>
                        navigateProjectThread(
                          {
                            threadId: item.execution!.threadId,
                            projectId: project.projectId,
                            operationId: item.operationId,
                            stageId: item.stageId,
                            pluginDigest: item.pluginDigest,
                            workspace: project.workspace
                          },
                          {
                            read: (id) =>
                              window.api.threads.get(id, { requestScope: "foreground-hydration" }),
                            isCurrent: () =>
                              active.current && navigation === latestNavigation.current &&
                              account === useAppStore.getState().accountRevision,
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
              {item.stageInstructions && (
                <p
                  className="whitespace-pre-wrap break-words"
                  aria-label="本次操作已保存的阶段补充说明"
                >
                  本次操作的阶段补充说明：{item.stageInstructions}
                </p>
              )}
              {item.resultApproval?.decision === "rejected" && item.resultApproval.feedback && (
                <p className="whitespace-pre-wrap break-words">
                  成果修改意见：{item.resultApproval.feedback}
                </p>
              )}
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
              <ProjectCheckDiagnostics terminal={item.execution?.terminal} />
              {(item.status === "failed" || item.status === "unknown") &&
                !item.receipts.length &&
                !item.execution?.terminal?.checkDiagnostics?.length &&
                (item.status === "failed" ||
                  projectRuntimeRecoveryMessage(item.execution?.terminal?.code ?? "")) && (
                  <p aria-label="本次步骤问题说明" className="mt-1 text-muted-foreground">
                    {projectRuntimeRecoveryMessage(item.execution?.terminal?.code ?? "") ??
                      "本次步骤未完成；若已调用助手，请查看对应会话。核对问题详情和成果文件后可重新开始。"}
                  </p>
                )}
            </li>
          ))}
        </ul>
      </details>
      <HostProjectSessions projectId={project.projectId} workspace={project.workspace}
        operationThreadIds={operations.flatMap(item => item.execution?.threadId ? [item.execution.threadId] : [])} />
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
        <p className="mt-1">
          停止执行不撤销已写入的文件。连续执行会在需要确认、执行失败或结果待核对时停下。
        </p>
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
        {!view.preview && project.status === "active" && (
          <div className="mt-3 space-y-2">
            <button
              type="button"
              className="underline"
              disabled={busy || !!operation}
              onClick={() =>
                void act(() => command({ kind: "review-plan", expectedVersion: project.version }))
              }
            >
              检查是否可采用已安装插件的新步骤
            </button>
            <p>
              仅在无活动任务且已完成阶段的规则、技能与成果保持有效时，允许替换后续步骤。需要恢复适配的外部动作会明确阻止迁移。
            </p>
            {view.migrationReview && (
              <div className="rounded border p-2" aria-label="步骤更新确认">
                <p>目标插件版本：{view.migrationReview.targetVersion}</p>
                <p>保留已完成阶段：{view.migrationReview.preservedStageIds.join(" → ") || "无"}</p>
                <p>后续阶段：{view.migrationReview.remainingStageIds.join(" → ")}</p>
                <button
                  type="button"
                  className="mt-2 underline"
                  disabled={busy}
                  onClick={() =>
                    void act(() => command({ kind: "migrate-plan", review: view.migrationReview! }))
                  }
                >
                  确认更新后续步骤
                </button>
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  )
}

/** Keep older stage sessions reachable after project-owned threads leave the ordinary chat list. */
function HostProjectSessions({ projectId, workspace, operationThreadIds }: {
  projectId: string
  workspace: string
  operationThreadIds: string[]
}) {
  const threads = useAppStore(state => state.threads) ?? []
  const hasMore = useAppStore(state => state.threadDirectoryHasMore)
  const loading = useAppStore(state => state.threadDirectoryLoadingMore)
  const [error, setError] = useState<string>()
  const lifecycle = useRef(0)
  useEffect(() => () => { lifecycle.current++ }, [])
  const shown = new Set(operationThreadIds)
  const sessions = threads.flatMap(thread => {
    const target = readHostProjectThreadTarget(thread)
    return target && target.projectId === projectId && !shown.has(target.threadId) &&
      isSameWorkspacePath(target.workspace, workspace) ? [{ thread, target }] : []
  })
  return <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer">更早的阶段会话</summary>
    <ul className="mt-2 space-y-2">
      {sessions.map(({ thread, target }) => <li key={thread.thread_id}>
        <button type="button" className="underline" onClick={() => {
          const revision = ++lifecycle.current
          const account = useAppStore.getState().accountRevision
          void import("../../lib/store").then(({ useAppStore, isThreadDeletionPending }) =>
            navigateProjectThread(target, {
              read: id => window.api.threads.get(id, { requestScope: "foreground-hydration" }),
              isCurrent: () => lifecycle.current === revision &&
                account === useAppStore.getState().accountRevision,
              isRetired: isThreadDeletionPending,
              add: value => useAppStore.getState().addThreadSummary(value),
              select: id => useAppStore.getState().selectThread(id)
            })
          ).catch(() => setError("无法打开原阶段会话，请更新项目记录后重试。"))
        }}>{thread.title || target.stageId}</button>
      </li>)}
    </ul>
    {!sessions.length && <p className="mt-2">已加载记录中没有更早的阶段会话。</p>}
    {hasMore && <button type="button" disabled={loading} className="mt-2 underline"
      onClick={() => void useAppStore.getState().loadMoreThreads().catch(() =>
        setError("会话列表暂时无法读取，请重试。"))}>
      {loading ? "正在读取会话…" : "加载更多会话"}
    </button>}
    {error && <p role="alert">{error}</p>}
  </details>
}
