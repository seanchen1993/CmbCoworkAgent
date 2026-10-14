import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AppNotification } from "../../../../shared/app-notifications"
import type { HarnessRunDetailViewModel } from "../../../../shared/harness-board-types"
import { ProjectRuntimeOverview } from "./ProjectRuntimeOverview"
import {
  createProjectCapabilityController,
  projectCapabilityState,
  projectCapabilityUnavailable,
  type ProjectCapabilityActivity
} from "./project-capability-controller"

export interface ProjectCapabilityPanelProps {
  detail: HarnessRunDetailViewModel
  selectedNodeId?: string
  disabledReason?: string
  loadLatest: (detail: HarnessRunDetailViewModel) => Promise<{
    detail: HarnessRunDetailViewModel
    notifications: AppNotification[]
  }>
  readActivity: (detail: HarnessRunDetailViewModel) => ProjectCapabilityActivity
  createSession: (detail: HarnessRunDetailViewModel) => Promise<string>
  onOpenSession: (threadId: string) => void
  onShowApproval: (threadId?: string) => void
  onSelectCurrent: (nodeId: string) => void
}

export function ProjectCapabilityPanel(
  props: ProjectCapabilityPanelProps
): React.JSX.Element | null {
  return <><ProjectRuntimeOverview detail={props.detail} /><ProjectCapabilityContent {...props} /></>
}

function ProjectCapabilityContent(props: ProjectCapabilityPanelProps): React.JSX.Element | null {
  const propsRef = useRef(props)
  propsRef.current = props
  const key = `${props.detail.project.projectId}:${props.detail.run.slug}`
  const scope = useRef({ key, token: Symbol(key), mounted: true })
  if (scope.current.key !== key) scope.current = { key, token: Symbol(key), mounted: true }
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  // Invalidate the old scope during commit, before a queued IPC continuation can navigate.
  useLayoutEffect(() => {
    scope.current.mounted = true
    return () => {
      scope.current.mounted = false
    }
  }, [])
  useEffect(() => {
    setBusy(false)
    setMessage("")
  }, [key])
  const prepare = useMemo(
    () =>
      createProjectCapabilityController({
        isCurrent: (token) => scope.current.mounted && scope.current.token === token,
        canAct: () => !propsRef.current.disabledReason,
        load: (detail) => propsRef.current.loadLatest(detail),
        activity: (detail) => propsRef.current.readActivity(detail),
        create: (detail) => propsRef.current.createSession(detail),
        open: (threadId) => propsRef.current.onOpenSession(threadId),
        showApproval: (threadId) => propsRef.current.onShowApproval(threadId),
        message: setMessage,
        busy: setBusy
      }),
    []
  )
  const capability = props.detail.projectCapability
  if (!capability) return null
  if (capability.status === "invalid") {
    return (
      <section aria-label="项目能力说明" className="mb-4 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">项目能力说明暂不可用</h3>
        <p className="mt-2 break-words text-sm text-muted-foreground">{capability.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">仍可使用原项目阶段、产物和会话入口。</p>
      </section>
    )
  }
  const state = projectCapabilityState(props.detail, props.selectedNodeId)
  const activity = props.readActivity(props.detail)
  const unavailable =
    props.disabledReason ||
    (!activity.known ? "无法确认运行状态，请刷新后重试。" : null) ||
    projectCapabilityUnavailable(props.detail)
  const needsApproval = activity.gatePending
  const running =
    activity.runningThreadId ||
    activity.managedRunning ||
    props.detail.run.managedRun?.status === "running"
  // Existing execution/approval can always be inspected, even when no next instruction remains.
  const disabled =
    busy ||
    Boolean(props.disabledReason) ||
    !activity.known ||
    (!needsApproval && !running && Boolean(unavailable))
  const actionLabel = needsApproval
    ? "查看人工确认"
    : running
      ? "查看运行中的会话"
      : "准备下一步会话"
  return (
    <section
      aria-label="项目能力控制台"
      className="mb-4 space-y-4 rounded-xl border border-border/70 bg-background/80 p-4"
    >
      <header className="space-y-1">
        <h3 className="break-words text-base font-semibold">{capability.manifest.name}</h3>
        <p className="break-words text-sm text-muted-foreground">
          {capability.manifest.description}
        </p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
        <div className="min-w-0 space-y-1">
          <p className="break-words text-sm font-medium">
            当前阶段：{state.current?.label ?? "未知"}
          </p>
          <p className="text-xs text-muted-foreground">
            {state.current?.status.label ?? "等待阶段数据"}
          </p>
          <p className="break-words text-xs text-muted-foreground">
            {state.nextAction?.slashSkill
              ? `阶段技能：/${state.nextAction.slashSkill.replace(/^\//, "")}`
              : "下一步由当前阶段配置提供"}
          </p>
          {state.nextAction?.userMessage && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              下一步：{state.nextAction.userMessage}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void prepare(props.detail, scope.current.token)}
          className="rounded-md border border-primary/30 bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "正在确认当前状态…" : actionLabel}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        准备会话会创建原项目技能会话并填入下一步指令；由你在会话中发送，尚未执行或验收阶段。
      </p>
      {unavailable && !needsApproval && !running && (
        <p className="text-sm text-muted-foreground">{unavailable}</p>
      )}
      {message && (
        <p role="status" className="break-words text-sm">
          {message}
        </p>
      )}
      {state.selected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">正在查看：{state.selected.label}</h4>
            {state.selected.id !== state.current?.id && state.current && (
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => props.onSelectCurrent(state.current!.id)}
              >
                返回当前阶段
              </button>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">
            {state.guidance?.guidance ?? "此阶段没有专属说明，请按原阶段技能与检查规则操作。"}
          </p>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">阶段规则（声明说明）</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["前置检查", state.guidance?.before],
                  ["后置验收", state.guidance?.after]
                ] as const
              ).map(([title, rules]) => (
                <div key={title}>
                  <h5 className="text-xs font-semibold">{title}</h5>
                  {rules?.length ? (
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm">
                      {rules.map((rule, i) => (
                        <li key={i} className="whitespace-pre-wrap break-words">
                          {rule}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      未声明，仍以原技能与 Hooks 为准。
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              规则说明不代表检查已执行，也不授予审批或执行权限。
            </p>
          </details>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 rounded-lg border p-3">
              <h5 className="text-sm font-medium">实际产物问题</h5>
              {state.issues.length ? (
                <ul className="mt-2 space-y-2 text-xs">
                  {state.issues.map((artifact) => (
                    <li key={artifact.id} className="break-words">
                      {artifact.artifactLabel}：
                      {artifact.validation?.status === "invalid"
                        ? artifact.validation.message
                        : (artifact.artifactStatusLabel ?? artifact.status.label)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {state.selected.artifacts.length
                    ? "未发现产物缺失或无效；文件已生成不代表验收通过。"
                    : "暂无产物证据。"}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                在下方产物面板查看实际文件；验收有效性以原验证器为准。
              </p>
            </div>
            <div className="min-w-0 rounded-lg border p-3">
              <h5 className="text-sm font-medium">最近 Hook 记录（历史证据）</h5>
              {state.hooks.length ? (
                <ul className="mt-2 space-y-2 text-xs">
                  {state.hooks.map((hook, i) => (
                    <li key={`${hook.eventId}:${i}`} className="break-words">
                      <span>
                        {
                          {
                            success: "历史成功",
                            blocked: "被阻止",
                            skipped: "已跳过",
                            error: "错误",
                            unknown: "未知"
                          }[hook.eventStatus]
                        }{" "}
                        · {hook.ts || "时间未知"}
                      </span>
                      <p className="whitespace-pre-wrap">{hook.message}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  暂无 Hook 记录，不能判断检查已通过。
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">历史成功不证明当前产物仍有效。</p>
            </div>
          </div>
        </div>
      )}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">使用帮助</summary>
        <div className="mt-3 space-y-3">
          {capability.manifest.help.map((entry, i) => (
            <div key={i}>
              <h4 className="text-sm font-semibold">{entry.title}</h4>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {entry.body}
              </p>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}
