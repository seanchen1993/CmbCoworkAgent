import { useEffect, useRef, useState } from "react"
import type {
  DevelopmentApi,
  DevelopmentProjectTrialRequest,
  DevelopmentStatus
} from "../../../../shared/mods/development"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { projectDeliveryError } from "./project-delivery-view"

const button = "rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"

export function CreatorProjectDeliveryCard(props: {
  threadId: string
  workspace: string
  request: DevelopmentProjectTrialRequest
  delivery?: DevelopmentStatus["projectDelivery"]
  api: DevelopmentApi
  onStatus(status: DevelopmentStatus): void
}) {
  return (
    <ScopedDelivery
      key={JSON.stringify([
        props.threadId,
        props.workspace,
        props.request.id,
        props.request.digest
      ])}
      {...props}
    />
  )
}

function ScopedDelivery({
  threadId,
  workspace,
  request,
  delivery,
  api,
  onStatus
}: Parameters<typeof CreatorProjectDeliveryCard>[0]) {
  const initialName = /^[a-z][a-z0-9-]{0,40}$/.test(request.name)
    ? `${request.name}-custom`
    : "my-created-plugin"
  const [name, setName] = useState(initialName)
  const [version, setVersion] = useState("1.0.0")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const live = useRef(true)
  const pending = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const current = delivery?.requestId === request.id && delivery.sourceDigest === request.digest
  const act = async (call: () => Promise<DevelopmentStatus>) => {
    if (pending.current || !live.current) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      const next = await call()
      if (!live.current) return
      if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
      onStatus(next)
    } catch (cause) {
      if (live.current) setError(projectDeliveryError(cause))
    } finally {
      if (live.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section
      aria-label="项目候选保存为新插件"
      className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <h4 className="font-semibold">保存当前项目候选为新插件</h4>
      <p className="text-xs leading-5 text-muted-foreground">
        保存会冻结当前候选源码，创建独立的新插件，保留原插件。可保存尚未完成试用的候选；
        保存、安装和导出均不代表业务验收通过。试用记录对应上方来源版本，改名后的插件没有因此自动重跑。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          新插件标识
          <input
            aria-label="新插件标识"
            value={name}
            maxLength={48}
            disabled={busy}
            className="rounded border bg-background px-3 py-2"
            placeholder="my-created-plugin"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            以小写字母开头，最多 48 位，只含小写字母、数字和短横线，与已安装插件区分。
          </span>
        </label>
        <label className="grid content-start gap-1 text-sm">
          新插件版本
          <input
            aria-label="新插件版本"
            value={version}
            maxLength={64}
            disabled={busy}
            className="rounded border bg-background px-3 py-2"
            placeholder="1.0.0"
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className={button}
        disabled={busy || !name.trim() || !version.trim() || !api.prepareProjectDelivery}
        onClick={() =>
          void act(() =>
            api.prepareProjectDelivery!({
              threadId,
              expectedWorkspace: workspace,
              requestId: request.id,
              digest: request.digest,
              name: name.trim(),
              version: version.trim()
            })
          )
        }
      >
        准备保存为新插件
      </button>
      {delivery && !current && (
        <p role="status" className="text-sm">
          下方原交付记录属于另一候选，请重新核对当前版本后准备保存。
        </p>
      )}
      {delivery && current && (
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <p className="font-medium">
            {delivery.name} · v{delivery.version}
          </p>
          <p role="status" className="text-sm">
            {delivery.phase === "installed"
              ? "新插件已安装。"
              : delivery.phase === "exported"
                ? "新插件包已导出。"
                : delivery.phase === "installing"
                  ? "正在安装新插件，请等待并核对结果。"
                  : delivery.phase === "exporting"
                    ? "正在导出插件，请等待并核对结果。"
                    : delivery.phase === "needs-confirmation"
                      ? "独立插件内容已准备，请选择安装或导出并确认。"
                      : "交付结果待核对，请刷新工作区并检查实际结果。"}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={busy || !delivery.canInstall || !api.installProjectDelivery}
              onClick={() =>
                void act(() =>
                  api.installProjectDelivery!({
                    threadId,
                    expectedWorkspace: workspace,
                    deliveryId: delivery.id,
                    digest: delivery.digest
                  })
                )
              }
            >
              确认安装新插件
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || !delivery.canExport || !api.exportProjectDelivery}
              onClick={() =>
                void act(() =>
                  api.exportProjectDelivery!({
                    threadId,
                    expectedWorkspace: workspace,
                    deliveryId: delivery.id,
                    digest: delivery.digest
                  })
                )
              }
            >
              导出新插件 ZIP…
            </button>
          </div>
          {delivery.pluginId && (
            <p className="text-xs text-muted-foreground">
              下一步：在“添加功能 → 我已添加”找到“{delivery.name}
              ”，从其项目入口使用；首次使用需填写参数并确认权限。
            </p>
          )}
          {delivery.output && (
            <p className="break-all text-xs text-muted-foreground">导出位置：{delivery.output}</p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">保存来源与版本</summary>
            <p className="mt-2 break-all">来源候选：{delivery.sourceDigest}</p>
            <p className="break-all">新插件包：{delivery.digest}</p>
          </details>
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在核对保存操作…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        导出包包含插件源码与声明，不包含本机知识库目录、凭据、授权及试用数据；目标环境需重新配置。
      </p>
    </section>
  )
}
