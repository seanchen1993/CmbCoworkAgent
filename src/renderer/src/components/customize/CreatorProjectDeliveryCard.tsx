import { useEffect, useRef, useState } from "react"
import type {
  DevelopmentApi,
  DevelopmentProjectTrialRequest,
  DevelopmentStatus
} from "../../../../shared/mods/development"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { useAppStore } from "@/lib/store"
import { projectDeliveryError, projectDeliveryReconciliationText } from "./project-delivery-view"
import { InstalledPluginStartUse } from "./InstalledPluginStartUse"
import { creatorJourneyView } from "./creator-journey-view"

const button = "rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"

export function CreatorProjectDeliveryCard(props: {
  threadId: string
  workspace: string
  request?: DevelopmentProjectTrialRequest
  delivery?: DevelopmentStatus["projectDelivery"]
  preparedBySourceSet?: boolean
  api: DevelopmentApi
  onStatus(status: DevelopmentStatus): void
}) {
  const account = useAppStore((state) => state.accountRevision)
  return (
    <ScopedDelivery
      key={JSON.stringify([
        account,
        props.threadId,
        props.workspace,
        props.request?.id,
        props.request?.digest
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
  preparedBySourceSet,
  api,
  onStatus
}: Parameters<typeof CreatorProjectDeliveryCard>[0]) {
  const current =
    !!request && delivery?.requestId === request.id && delivery.sourceDigest === request.digest
  const [name, setName] = useState(
    current && delivery
      ? delivery.name
      : `${request && /^[a-z][a-z0-9-]{0,38}$/.test(request.name) ? request.name : "my-plugin"}-${
          request?.id
            .replace(/[^a-z0-9]/gi, "")
            .toLowerCase()
            .slice(-8) || "custom"
        }`
  )
  const [version, setVersion] = useState(current && delivery ? delivery.version : "1.0.0")
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
  const unresolved = !!delivery && ["unknown", "installing", "exporting"].includes(delivery.phase)
  const historical = !!delivery && !current
  const installed = current && !!delivery?.pluginId
  const verified = creatorJourneyView(request?.journey, {
    threadId,
    digest: request?.digest
  }).passed
  const validateStatus = (next: DevelopmentStatus) => {
    if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
    return next
  }
  const act = async (call: (assertCurrent: () => void) => Promise<DevelopmentStatus>) => {
    if (pending.current || !live.current) return
    pending.current = true
    setBusy(true)
    setError("")
    const account = useAppStore.getState().accountRevision
    const assertCurrent = () => {
      if (!live.current || useAppStore.getState().accountRevision !== account)
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
    }
    try {
      const next = await call(assertCurrent)
      assertCurrent()
      onStatus(validateStatus(next))
    } catch (cause) {
      if (live.current && useAppStore.getState().accountRevision === account) {
        setError(projectDeliveryError(cause))
        // Inspect a lost reply; never repeat installation or export automatically.
        try {
          const next = await api.status({ threadId })
          assertCurrent()
          onStatus(validateStatus(next))
        } catch {
          /* Preserve the error and native reconciliation action. */
        }
      }
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }
  const save = (operation: "install" | "export") =>
    act(async (assertCurrent) => {
      const deliver =
        operation === "install" ? api.installProjectDelivery : api.exportProjectDelivery
      if (!request || !deliver || unresolved) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      let prepared = delivery
      const allowed = (value: NonNullable<typeof delivery>) =>
        operation === "install" ? value.canInstall : value.canExport
      if (
        !current ||
        !prepared ||
        !allowed(prepared) ||
        (!preparedBySourceSet &&
          (prepared.name !== name.trim() || prepared.version !== version.trim()))
      ) {
        if (!api.prepareProjectDelivery) throw Error("PROJECT_DELIVERY_REVIEW_REQUIRED")
        const next = validateStatus(
          await api.prepareProjectDelivery({
            threadId,
            expectedWorkspace: workspace,
            requestId: request.id,
            digest: request.digest,
            name: name.trim(),
            version: version.trim()
          })
        )
        assertCurrent()
        prepared = next.projectDelivery
        // Retain prepared facts if installation subsequently loses its reply.
        onStatus(next)
      }
      assertCurrent()
      if (
        !prepared ||
        prepared.requestId !== request.id ||
        prepared.sourceDigest !== request.digest ||
        !["needs-confirmation", "exported"].includes(prepared.phase) ||
        !allowed(prepared) ||
        (!preparedBySourceSet &&
          (prepared.name !== name.trim() || prepared.version !== version.trim()))
      )
        throw Error("PROJECT_DELIVERY_CANDIDATE_CHANGED")
      return deliver({
        threadId,
        expectedWorkspace: workspace,
        deliveryId: prepared.id,
        digest: prepared.digest
      })
    })
  return (
    <section aria-label="项目候选保存为新插件" className="space-y-3 rounded-xl border p-4">
      <h4 className="font-semibold">
        {request ? (installed ? "插件已保存" : "保存插件") : "核对历史插件交付"}
      </h4>
      {!installed && request && !preparedBySourceSet && (
        <>
          <label className="grid gap-1 text-sm">
            插件名称
            <input
              aria-label="新插件标识"
              value={name}
              maxLength={48}
              disabled={busy || unresolved}
              className="rounded border bg-background px-3 py-2"
              placeholder="my-created-plugin"
              onChange={(event) => setName(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              可直接使用默认名称，或填写小写字母、数字和短横线。
            </span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">版本设置</summary>
            <label className="mt-2 grid gap-1">
              新插件版本
              <input
                aria-label="新插件版本"
                value={version}
                maxLength={64}
                disabled={busy || unresolved}
                className="rounded border bg-background px-3 py-2"
                onChange={(event) => setVersion(event.target.value)}
              />
            </label>
          </details>
        </>
      )}
      {historical && (
        <p className="text-sm text-muted-foreground">
          下方交付记录属于历史候选，请重新准备当前版本。
        </p>
      )}
      {unresolved && (
        <p role="status" className="text-sm">
          上次操作结果待核对，请先检查结果。
        </p>
      )}
      {request && !installed && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={
                busy ||
                unresolved ||
                !name.trim() ||
                !version.trim() ||
                !api.installProjectDelivery ||
                (!current && !api.prepareProjectDelivery)
              }
              onClick={() => void save("install")}
            >
              {busy ? "正在保存…" : "保存插件"}
            </button>
            {api.exportProjectDelivery && (
              <button
                type="button"
                className={button}
                disabled={
                  busy ||
                  unresolved ||
                  !name.trim() ||
                  !version.trim() ||
                  (!current && !api.prepareProjectDelivery)
                }
                onClick={() => void save("export")}
              >
                仅导出 ZIP…
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            保存为新插件，保留原插件。{!verified && "当前试用尚未通过。"}
          </p>
        </>
      )}
      {delivery && (
        <div className="space-y-3">
          <p className="text-sm">
            {delivery.name} · v{delivery.version}
          </p>
          {installed && (
            <>
              <p role="status" className="text-sm">
                新插件已安装。
              </p>
              <InstalledPluginStartUse
                threadId={threadId}
                workspace={workspace}
                pluginId={delivery.pluginId!}
                expected={{
                  name: delivery.name,
                  version: delivery.version,
                  digest: delivery.digest
                }}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {request && current && delivery.canExport && (
              <button
                type="button"
                className={button}
                disabled={busy || !api.exportProjectDelivery}
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
                导出 ZIP…
              </button>
            )}
            {delivery.canReconcile && api.reconcileProjectDelivery && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api.reconcileProjectDelivery!({
                      threadId,
                      expectedWorkspace: workspace,
                      deliveryId: delivery.id,
                      digest: delivery.digest
                    })
                  )
                }
              >
                核对实际交付结果
              </button>
            )}
          </div>
          {delivery.reconciliation && (
            <p role="status" className="text-sm">
              {projectDeliveryReconciliationText(delivery.reconciliation.outcome)}
            </p>
          )}
          {delivery.output && (
            <p className="break-all text-xs text-muted-foreground">导出位置：{delivery.output}</p>
          )}
          {delivery.pendingOutput && (
            <p className="break-all text-xs text-muted-foreground">
              待核对导出目标：{delivery.pendingOutput}
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">保存详情</summary>
            <p className="mt-2 break-all">来源候选：{delivery.sourceDigest}</p>
            <p className="break-all">新插件包：{delivery.digest}</p>
            <p>导出不包含本机知识库、凭据及试用数据。</p>
          </details>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
