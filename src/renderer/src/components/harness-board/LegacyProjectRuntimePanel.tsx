import { useEffect, useRef, useState } from "react"
import type { LegacyProjectRuntimeView } from "../../../../shared/project-runtime/legacy-operations"
import { projectRuntimeRecoveryMessage } from "./project-runtime-message"

export function LegacyProjectRuntimePanel({ projectId }: { projectId: string }) {
  return <ScopedLegacyProjectRuntime key={projectId} projectId={projectId} />
}
function ScopedLegacyProjectRuntime({ projectId }: { projectId: string }) {
  const [view, setView] = useState<LegacyProjectRuntimeView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const active = useRef(false)
  const pending = useRef(false)
  const sequence = useRef(0)
  async function read(kind: "view" | "enable" | "disable") {
    if (pending.current) return
    const token = ++sequence.current
    pending.current = true
    setBusy(true); setError("")
    try {
      const next = await window.api.harnessBoard.legacyProjects[kind](projectId)
      if (active.current && token === sequence.current) setView(next)
    } catch (cause) {
      if (active.current && token === sequence.current)
        setError(cause instanceof Error ? cause.message : "PROJECT_RUNTIME_UNAVAILABLE")
    } finally {
      if (token === sequence.current) pending.current = false
      if (active.current && token === sequence.current) setBusy(false)
    }
  }
  useEffect(() => {
    active.current = true
    void read("view")
    return () => { active.current = false; sequence.current++; pending.current = false }
  }, [projectId])
  const unresolved = view?.operations.some(item => item.status === "started" || item.status === "unknown")
  const labels = { started: "正在执行", succeeded: "本次会话已结束", failed: "本次会话出错",
    cancelled: "本次会话已停止", unknown: "结果需要核对" }
  return <details className="space-y-2 text-xs">
    <summary className="cursor-pointer font-medium">保留插件版本与运行记录 · 可选</summary>
    <p className="leading-5 text-muted-foreground">开启后，这个项目的后续会话继续使用当前插件副本，并记录每次执行。
      仍从原阶段入口开始，原来的审批和检查照常执行。</p>
    {!view ? <p className="text-muted-foreground">{error ? "暂时无法确认是否已保留插件版本，请更新执行记录。" : "正在读取项目版本与执行记录…"}</p> :
      view.binding ? <p>已保留插件版本 {view.binding.packageVersion}。安装更新不会替换此项目副本。</p> :
      <p className="text-muted-foreground">尚未开启，当前仍使用原项目方式。</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={() => void read("view")}>更新执行记录</button>
      {view && !view.binding && <button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={() => void read("enable")}>为此项目开启</button>}
      {view?.binding && <button type="button" disabled={busy || unresolved} className="underline disabled:opacity-50" onClick={() => void read("disable")}>恢复使用已安装版本</button>}
    </div>
    {unresolved && <p className="text-muted-foreground">还有执行中的会话或待核对结果，暂不能切换版本。请先查看对应会话与项目产物，避免重复操作。</p>}
    {error && <div role="alert" className="text-destructive">
      <p>{projectRuntimeRecoveryMessage(error) ?? (/RUNNING|ACTIVE/.test(error) ? "项目仍有任务执行，请结束后再切换。" :
        /MIXED_RUNTIME/.test(error) ? "此插件包含尚未支持固定版本的外部服务，可继续使用原项目入口。" :
        "未能读取或调整运行记录，请查看问题详情。原项目数据未迁移。")}</p>
      <details><summary className="cursor-pointer">问题详情</summary><p className="break-all">{error}</p></details>
    </div>}
    {!!view?.operations.length && <ul className="space-y-2">{view.operations.map(item => <li key={item.operationId}>
      <p>{item.featureId === "__project_session__" ? "项目会话" : item.featureId} · {labels[item.status]} · {new Date(item.startedAt).toLocaleString()}</p>
      <button type="button" className="underline" onClick={() => {
        void import("../../lib/store").then(({ useAppStore }) => {
          if (active.current) return useAppStore.getState().selectThread(item.threadId)
          return undefined
        }).catch(() => { if (active.current) setError("PROJECT_THREAD_UNAVAILABLE") })
      }}>查看原会话</button>
      {item.terminalCode && <details className="text-muted-foreground"><summary className="cursor-pointer">结束详情</summary><p className="break-all">{item.terminalCode}</p></details>}
    </li>)}</ul>}
    <p className="text-muted-foreground">这里只说明会话执行结果，阶段是否完成仍以原插件检查为准。
      恢复使用已安装版本会影响下一次运行，不撤销已写入的文件；历史记录仍会保留。</p>
  </details>
}
