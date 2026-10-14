import { developmentCapabilityLabel } from "./development-capability-label"
import { WandSparkles } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { rememberReuseSelection } from "./development-reuse-receipts"
import { prepareDevelopmentCreation, type DevelopmentSetupApi } from "./development-creation-setup"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  DevelopmentApi,
  DevelopmentStatus,
  DevelopmentTrialStatus
} from "../../../../shared/mods/development"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type { DevelopmentReuseOrigin } from "./DevelopmentReusePanel"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { ProjectDevelopmentPreviewPanel } from "./ProjectDevelopmentPreviewPanel"

const phases: Record<DevelopmentTrialStatus["phase"], string> = {
  "needs-approval": "等待你确认能力",
  queued: "已排队，等待本轮结束或界面空闲",
  preflight: "正在检查新版本",
  retiring: "正在停止旧版本",
  active: "本会话已生效",
  stopped: "已停止试用",
  failed: "新版本试用失败",
  unknown: "结果待核对"
}
const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (/DEVELOPMENT_SETUP_PARTIAL/.test(message))
    return "部分开关可能已开启，但创作尚未确认。保留已有设置，请刷新状态后再试；不会自动关闭其它会话使用的功能。"
  if (/DEVELOPMENT_SETTINGS_RECOVERY/.test(message))
    return "项目设置需要恢复，请到“添加功能 → 我已添加”查看提示。"
  if (/WORKSPACE_REQUIRED|LOCAL_WORKSPACE/.test(message)) return "请先选择本地项目，再制作灵件。"
  if (/DEVELOPMENT_MODS_DISABLED/.test(message))
    return "灵件功能尚未开启。点击下方开启按钮即可完成应用、项目和本会话设置。"
  if (/STALE|SCOPE|REVISION|DIGEST/.test(message))
    return "会话、项目或版本已变化，请刷新状态后核对。"
  if (/BUSY/.test(message)) return "任务或版本仍在处理中，请等待停止完成后再操作。"
  if (/LIMIT/.test(message)) return "开发草稿或执行资源已达上限，请核对后再继续。"
  if (/CANCEL/.test(message)) return "操作已取消，请刷新并核对实际状态。"
  return "暂时无法确认操作结果。请刷新状态，查看是否已完成。"
}

export function ModsDevelopmentPanel({
  threadId,
  workspaceHint,
  mode = "entry",
  api = window.api.mods.development,
  onReturnToChat,
  onOpenWorkbench,
  settingsApi = window.api.mods,
  onPromoted,
  onReuse,
  promotionBlocked = false
}: {
  threadId: string | null
  workspaceHint?: string | null
  mode?: "entry" | "chat"
  api?: DevelopmentApi
  onReturnToChat?: () => void
  onOpenWorkbench?: () => void
  settingsApi?: DevelopmentSetupApi
  onPromoted?: (document: AuthoringDocument) => void
  onReuse?: (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => void
  promotionBlocked?: boolean
}) {
  if (!threadId || !api || workspaceHint === null)
    return mode === "chat" ? (
      <span
        className="px-2 py-1 text-xs text-muted-foreground"
        title="请先选择本地项目，再制作灵件。"
      >
        制作灵件 · 先选项目
      </span>
    ) : (
      <p className="text-sm">请选择本地项目会话后开启对话创作。</p>
    )
  return (
    <ScopedDevelopment
      key={JSON.stringify([threadId, workspaceHint])}
      threadId={threadId}
      workspaceHint={workspaceHint}
      api={api}
      mode={mode}
      onReturnToChat={onReturnToChat}
      onOpenWorkbench={onOpenWorkbench}
      settingsApi={settingsApi}
      onPromoted={onPromoted}
      onReuse={onReuse}
      promotionBlocked={promotionBlocked}
    />
  )
}

function ScopedDevelopment({
  threadId,
  workspaceHint,
  api,
  mode,
  onReturnToChat,
  onOpenWorkbench,
  settingsApi,
  onPromoted,
  onReuse,
  promotionBlocked
}: {
  threadId: string
  workspaceHint?: string | null
  api: DevelopmentApi
  mode: "entry" | "chat"
  onReturnToChat?: () => void
  onOpenWorkbench?: () => void
  settingsApi: DevelopmentSetupApi
  onPromoted?: (document: AuthoringDocument) => void
  onReuse?: (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => void
  promotionBlocked: boolean
}) {
  const [open, setOpen] = useState(false)
  const focusChatAfterClose = useRef(false)
  const [status, setStatus] = useState<DevelopmentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [consent, setConsent] = useState<string | null>(null)
  const live = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  const canonical = useRef<string | null>(null)
  const accept = useCallback(
    (next: DevelopmentStatus) => {
      if (
        next.threadId !== threadId ||
        !next.workspace ||
        (workspaceHint !== undefined &&
          normalizeWorkspacePathKey(next.workspace) !== normalizeWorkspacePathKey(workspaceHint)) ||
        (canonical.current !== null &&
          normalizeWorkspacePathKey(canonical.current) !==
            normalizeWorkspacePathKey(next.workspace))
      ) {
        setStatus(null)
        setConsent(null)
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
      canonical.current = next.workspace
      setStatus(next)
    },
    [threadId, workspaceHint]
  )
  const read = useCallback(async () => {
    if (pending.current) return
    const ticket = ++generation.current
    try {
      const next = await api.status({ threadId })
      if (!live.current || generation.current !== ticket) return
      accept(next)
    } catch (error) {
      if (live.current && generation.current === ticket) setMessage(publicError(error))
    }
  }, [api, threadId, accept])
  useEffect(() => {
    live.current = true
    void read()
    const unsubscribe = api.onChanged((event) => {
      if (event.threadId === threadId) void read()
    })
    return () => {
      live.current = false
      unsubscribe()
    }
  }, [api, threadId, read])
  const operate = async <T,>(
    call: (workspace: string, assertCurrent: () => void) => Promise<T>,
    done: (value: T) => void
  ) => {
    if (pending.current || !canonical.current) return
    pending.current = true
    const ticket = ++generation.current
    setBusy(true)
    setMessage("")
    try {
      const workspace = canonical.current
      const assertCurrent = () => {
        if (!live.current || ticket !== generation.current || canonical.current !== workspace)
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
      const result = await call(workspace, assertCurrent)
      if (!live.current || ticket !== generation.current) return
      done(result)
    } catch (error) {
      if (live.current && ticket === generation.current) setMessage(publicError(error))
    } finally {
      pending.current = false
      if (live.current && ticket === generation.current) {
        setBusy(false)
        await read()
      }
    }
  }
  const enable = (enabled: boolean) =>
    void operate(
      async (expectedWorkspace, assertCurrent) => {
        if (enabled) {
          await prepareDevelopmentCreation(settingsApi, threadId, expectedWorkspace, assertCurrent)
          assertCurrent()
        }
        try {
          const next = await api.setEnabled({ threadId, expectedWorkspace, enabled })
          assertCurrent()
          return next
        } catch (error) {
          if (enabled) throw Error("DEVELOPMENT_SETUP_PARTIAL", { cause: error })
          throw error
        }
      },
      (next) => {
        accept(next)
        if (enabled) {
          if (mode === "chat") {
            focusChatAfterClose.current = true
            setOpen(false)
          } else onReturnToChat?.()
        }
      }
    )
  const awaitingApproval =
    status?.trials.filter((row) => row.phase === "needs-approval").length ?? 0
  const active = status?.trials.some(
    (row) => row.activeRevision !== undefined && row.phase !== "stopped"
  )
  const label = active ? "灵件试用中" : status?.enabled ? "可以开始制作" : "制作灵件"
  const saveForReuse =
    onReuse ??
    (onOpenWorkbench
      ? (document: AuthoringDocument, origin: DevelopmentReuseOrigin) => {
          rememberReuseSelection(JSON.stringify([threadId, workspaceHint]), { document, origin })
          setOpen(false)
          onOpenWorkbench()
        }
      : undefined)
  const content = (
    <section
      aria-label="灵件对话创作"
      className={
        mode === "chat"
          ? "space-y-3 text-sm"
          : "mx-auto max-w-3xl space-y-3 rounded-xl border bg-card p-4"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{mode === "chat" ? "灵件制作" : "在当前聊天制作灵件"}</h2>
        {status?.enabled && <span className="text-xs">本会话可以开始制作</span>}
      </div>
      {mode === "entry" && (
        <>
          <p className="text-sm text-muted-foreground">
            在当前聊天描述想要的效果，助手会制作一份可试用的草稿。
          </p>
          <p className="text-xs text-muted-foreground">
            试用前会请你确认。已授权范围内的修改会在每轮聊天结束后自动更新；增加权限时会再问你。只影响当前聊天，不会自动安装正式版。
          </p>
        </>
      )}
      <details open>
        <summary className="hidden">创作控制与说明</summary>
        {mode === "chat" && (
          <p className="text-xs text-muted-foreground">
            在聊天中描述想要的效果。已授权范围内的修改会在本轮结束后更新；增加权限时会再问你，不会自动安装正式版。
          </p>
        )}
        {!status?.enabled && (
          <p className="mb-2 text-xs text-muted-foreground">
            会开启应用和当前项目的灵件功能，并在当前聊天制作；已有授权的灵件可能恢复运行。新功能试用前会请你确认。
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!status?.enabled ? (
            <button
              type="button"
              className={button}
              disabled={busy || !status}
              onClick={() => enable(true)}
            >
              开启灵件并开始制作
            </button>
          ) : (
            <>
              {onReturnToChat && (
                <button type="button" className={button} onClick={onReturnToChat}>
                  返回当前聊天继续描述
                </button>
              )}
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => enable(false)}
              >
                结束创作并停止本会话试用
              </button>
            </>
          )}
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setMessage("")
              void read()
            }}
          >
            刷新状态
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          状态会自动更新；显示未更新时可刷新，不会重新制作。
        </p>
      </details>
      {status?.enabled && <ProjectDevelopmentPreviewPanel threadId={threadId} workspace={status.workspace} />}
      {status?.enabled && <p className="text-xs text-muted-foreground">结束创作会停止本会话的灵件试用。项目试用请从任务页面停止并核对结果；结果未确认时不会自动释放或重跑。</p>}
      {status?.enabled && !status.drafts.length && (
        <p className="text-sm">
          还没有制作中的灵件。回到聊天试着说：“在输入框上方显示本会话工具调用次数”。
        </p>
      )}
      {status?.trials.map((row) => {
        const key = JSON.stringify([
          row.componentId,
          row.revision,
          row.compiledDigest,
          row.capabilities
        ])
        return (
          <article
            key={row.componentId}
            aria-label={`组件试用 ${row.componentId}`}
            className={
              mode === "chat"
                ? "space-y-1 rounded border p-2 text-sm"
                : "space-y-2 rounded border p-3 text-sm"
            }
          >
            <p className="break-all font-medium">
              {row.componentId} · 新版本 v{row.revision} · {phases[row.phase]}
            </p>
            {row.activeRevision !== undefined &&
              (row.phase !== "active" || row.activeRevision !== row.revision) && (
                <p>正在使用：v{row.activeRevision}。新版本尚未替换它。</p>
              )}
            <details key={`${key}:${row.phase}`} open={row.phase === "needs-approval"}>
              <summary>核对版本与能力</summary>
              <ul className="list-inside list-disc">
                {row.capabilities.map((capability) => (
                  <li key={capability} className="break-all">
                    {developmentCapabilityLabel(capability)}
                  </li>
                ))}
              </ul>
              {!row.capabilities.length && <p>这个版本没有申请额外权限。</p>}
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">技术详情</summary>
                <p className="break-all text-xs">
                  源码摘要：{row.bundleDigest}
                  <br />
                  编译摘要：{row.compiledDigest}
                  <br />
                  能力标识：{row.capabilities.join("、") || "无"}
                </p>
              </details>
            </details>
            {row.phase === "needs-approval" && (
              <>
                <p className="text-xs">
                  此批准仅适用于本会话；以上能力范围内的后续更新会在轮次结束后自动应用，新增能力需再次确认。不会自动安装正式版或影响其它会话。
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={consent === key}
                    onChange={(event) => setConsent(event.target.checked ? key : null)}
                  />
                  我已核对本版本能力，同意仅在本会话试用，并允许该组件已批准能力范围内的后续自动更新。
                </label>
                <button
                  type="button"
                  className={button}
                  disabled={busy || consent !== key}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.approve({
                          threadId,
                          expectedWorkspace,
                          id: row.componentId,
                          revision: row.revision,
                          digest: row.compiledDigest
                        }),
                      (next) => {
                        accept(next)
                        setConsent(null)
                      }
                    )
                  }
                >
                  确认并试用
                </button>
              </>
            )}
            {row.phase !== "stopped" && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void operate(
                    (expectedWorkspace) =>
                      api.stop({ threadId, expectedWorkspace, id: row.componentId }),
                    accept
                  )
                }
              >
                停止此组件试用
              </button>
            )}
            {row.phase === "failed" && (
              <p>新版本没有生效。请回到聊天说明问题，让助手继续修改；正在使用的版本见上方。</p>
            )}
            {row.phase === "unknown" && (
              <p>暂时无法确认是否已停止。请先检查运行过程，确认已完成的操作，再继续。</p>
            )}
            {row.error && (
              <p role="status">
                {row.phase === "queued" && row.error === "MODS_DEVELOPMENT_BUSY"
                  ? "等待当前界面操作结束；已生效的旧版仍保留。"
                  : publicError(new Error(row.error))}
              </p>
            )}
          </article>
        )
      })}
      {(onPromoted || saveForReuse) && !!status?.drafts.length && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm">
            满意后先保存，再确认安装。安装后可在其他聊天中使用。
          </p>
          {status.drafts.map((draft) => (
            <div key={draft.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="break-all">
                {draft.name} · v{draft.revision}
              </span>
              {onPromoted && (
                <button
                  type="button"
                  className={button}
                  disabled={busy || promotionBlocked}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.promote({
                          threadId,
                          expectedWorkspace,
                          id: draft.id,
                          revision: draft.revision
                        }),
                      (value) => {
                        if (value.workspace !== canonical.current)
                          throw Error("DEVELOPMENT_SCOPE_CHANGED")
                        onPromoted(value)
                      }
                    )
                  }
                >
                  保存复用并打开源码
                </button>
              )}
              {saveForReuse && (
                <button
                  type="button"
                  className={button}
                  disabled={busy || promotionBlocked}
                  onClick={() =>
                    void operate(
                      (expectedWorkspace) =>
                        api.promote({
                          threadId,
                          expectedWorkspace,
                          id: draft.id,
                          revision: draft.revision
                        }),
                      (value) => {
                        if (
                          value.workspace !== canonical.current ||
                          value.source.digest !== draft.digest
                        )
                          throw Error("DEVELOPMENT_SCOPE_CHANGED")
                        saveForReuse(value, {
                          id: draft.id,
                          revision: draft.revision,
                          digest: draft.digest
                        })
                      }
                    )
                  }
                >
                  保存并复用…
                </button>
              )}
            </div>
          ))}
          {promotionBlocked && (
            <p className="text-xs">请先保存或取消当前高级源码编辑，再打开另一份开发草稿。</p>
          )}
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在确认操作结果…
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {onOpenWorkbench && (
        <button
          type="button"
          className={button}
          onClick={() => {
            setOpen(false)
            onOpenWorkbench()
          }}
        >
          打开灵件管理
        </button>
      )}
    </section>
  )
  if (mode === "entry") return content
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${label}${awaitingApproval ? `，${awaitingApproval} 项待确认` : ""}`}
        >
          <WandSparkles className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {label}
          {awaitingApproval > 0 && (
            <span
              role="status"
              className="rounded bg-amber-100 px-1.5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
            >
              {awaitingApproval} 项待确认
            </span>
          )}
          {message && <span className="text-amber-700 dark:text-amber-400">需核对</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        onCloseAutoFocus={(event) => {
          if (focusChatAfterClose.current) {
            focusChatAfterClose.current = false
            if (onReturnToChat) {
              event.preventDefault()
              onReturnToChat()
            }
          }
        }}
        align="start"
        side="top"
        className="max-h-[min(70vh,640px)] w-[min(420px,calc(100vw-24px))] overflow-y-auto"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
