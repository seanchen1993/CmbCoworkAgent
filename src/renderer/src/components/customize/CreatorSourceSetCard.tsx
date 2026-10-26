import { useCallback, useEffect, useRef, useState } from "react"
import type { DevelopmentApi, DevelopmentStatus } from "../../../../shared/mods/development"
import { captureConfigurationScope } from "@/lib/configuration-target"
import { InstalledPluginStartUse } from "./InstalledPluginStartUse"
import { useAppStore } from "@/lib/store"
import { sourceSetError } from "./source-set-view"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"

const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
type Props = {
  threadId: string
  workspace: string
  status?: DevelopmentStatus["sourceSet"]
  api: DevelopmentApi
  onStatus(value: DevelopmentStatus): void
}
export function CreatorSourceSetCard(props: Props) {
  const account = useAppStore((state) => state.accountRevision)
  return (
    <ScopedSourceSetCard
      key={JSON.stringify([account, props.threadId, props.workspace])}
      {...props}
    />
  )
}
function ScopedSourceSetCard({ threadId, workspace, status, api, onStatus }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const pending = useRef(false),
    live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const run = useCallback(
    async (work: () => Promise<DevelopmentStatus>) => {
      if (pending.current || !live.current) return
      pending.current = true
      setBusy(true)
      setError("")
      const scopeCurrent = captureConfigurationScope({ threadId, workspace })
      const account = useAppStore.getState().accountRevision
      const current = () => account === useAppStore.getState().accountRevision && scopeCurrent()
      try {
        const next = await work()
        if (!live.current || !current()) return
        if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
        onStatus(next)
      } catch (cause) {
        if (live.current && current())
          setError(
            cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message)
              ? cause.message
              : "SOURCE_SET_PREPARATION_FAILED"
          )
        // A lost installation reply must reveal the original pending intent, never retry it.
        if (live.current && current()) {
          try {
            const next = await api.status({ threadId })
            if (
              live.current &&
              current() &&
              next.threadId === threadId &&
              isSameWorkspacePath(next.workspace, workspace)
            )
              onStatus(next)
          } catch {
            /* Preserve the failure until the user can read native status again. */
          }
        }
      } finally {
        pending.current = false
        if (live.current) setBusy(false)
      }
    },
    [threadId, workspace, onStatus, api]
  )
  const advance = useCallback(
    () =>
      status &&
      api.advanceSourceSet &&
      run(() =>
        api.advanceSourceSet!({
          threadId,
          expectedWorkspace: workspace,
          id: status.id
        })
      ),
    [status, api, run, threadId, workspace]
  )
  // Original grant/config notifications may continue preparation, never consent to an installation.
  useEffect(() => {
    if (
      !status ||
      status.phase !== "dependencies" ||
      status.dependencies.some((dep) => dep.phase !== "installed")
    )
      return
    return window.api.mods.onConfigurationChanged(() => {
      void advance()
    })
  }, [status, advance])
  return (
    <section aria-label="导入项目作者源码" className="space-y-3 rounded border p-3">
      <p className="text-sm">
        从作者源码目录安装模板及所需能力。每个依赖分别安装、授权，随后自动编译；安装不代表业务验收通过。
      </p>
      <button
        className={button}
        disabled={
          busy ||
          !api.importSourceSet ||
          (!!status && !["ready", "cancelled"].includes(status.phase))
        }
        onClick={() =>
          void run(() => api.importSourceSet!({ threadId, expectedWorkspace: workspace }))
        }
      >
        选择作者源码目录
      </button>
      {status && status.phase !== "cancelled" && (
        <>
          <p className="font-medium">{status.title}</p>
          {status.phase === "needs-review" && (
            <p>
              已恢复来源记录。未安装项请重新点击“安装此依赖”；未知项先核对实际结果。已安装项请检查使用条件，再点击“核对权限并准备模板”。旧批准不会自动恢复。
            </p>
          )}
          {status.dependencies.map((dep) => (
            <div key={dep.id} className="space-y-2 rounded border p-3">
              <p>
                {dep.name} · {dep.version}
              </p>
              <details className="text-xs">
                <summary>来源身份</summary>
                <p className="break-all">{dep.digest}</p>
              </details>
              {dep.phase === "prepared" && (
                <button
                  className={button}
                  disabled={busy || !api.installSourceSetDependency}
                  onClick={() =>
                    void run(() =>
                      api.installSourceSetDependency!({
                        threadId,
                        expectedWorkspace: workspace,
                        id: status.id,
                        dependencyId: dep.id
                      })
                    )
                  }
                >
                  安装此依赖
                </button>
              )}
              {["unknown", "installing"].includes(dep.phase) && (
                <>
                  <p>上次安装结果待核对，不能直接重新安装。</p>
                  <button
                    className={button}
                    disabled={busy || !api.reconcileSourceSetDependency}
                    onClick={() =>
                      void run(() =>
                        api.reconcileSourceSetDependency!({
                          threadId,
                          expectedWorkspace: workspace,
                          id: status.id,
                          dependencyId: dep.id
                        })
                      )
                    }
                  >
                    核对实际安装结果
                  </button>
                </>
              )}
              {dep.phase === "installed" && dep.pluginId && (
                <InstalledPluginStartUse
                  purpose="dependency"
                  threadId={threadId}
                  workspace={workspace}
                  pluginId={dep.pluginId}
                  expected={{ name: dep.name, version: dep.version, digest: dep.digest }}
                />
              )}
            </div>
          ))}
          {status.phase !== "ready" && (
            <button
              className={button}
              disabled={
                busy ||
                status.dependencies.some((dep) => dep.phase !== "installed") ||
                !api.advanceSourceSet
              }
              onClick={() => void advance()}
            >
              {busy ? "正在核对与编译…" : "核对权限并准备模板"}
            </button>
          )}
          {status.phase === "ready" && (
            <p role="status">已按本机实际授权编译。请在下方交付卡确认安装模板，然后开始使用。</p>
          )}
          {status.phase !== "ready" && (
            <button
              className={button}
              disabled={busy || !api.cancelSourceSet}
              onClick={() =>
                void run(() =>
                  api.cancelSourceSet!({ threadId, expectedWorkspace: workspace, id: status.id })
                )
              }
            >
              结束此准备（保留已安装依赖）
            </button>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="text-sm">
          <p>{sourceSetError(error)}</p>
          <details>
            <summary>诊断详情</summary>
            <code>{error}</code>
          </details>
        </div>
      )}
    </section>
  )
}
