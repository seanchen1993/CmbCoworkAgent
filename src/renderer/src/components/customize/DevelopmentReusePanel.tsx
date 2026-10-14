import {
  getReuseReceipt,
  installationFacts,
  reuseReceiptKey,
  useReceiptField,
  type ReuseReceipt
} from "./development-reuse-receipts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type { AuthoringPreparedInstallation } from "../../../../shared/mods/authoring-install"
import type { ClawProfile } from "../../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { AuthoringInstallPanel } from "./AuthoringInstallPanel"
import { AuthoringPreviewPanel } from "./AuthoringPreviewPanel"

export interface DevelopmentReuseOrigin {
  id: string
  revision: number
  digest: string
}
interface Props {
  threadId: string
  document: AuthoringDocument
  origin: DevelopmentReuseOrigin
  onOpenThread: (threadId: string) => Promise<void>
  onReturnToChat?: () => void
}
const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"

/** Coordinates existing trusted APIs; each effect remains a separate visible user action. */
export function DevelopmentReusePanel(props: Props): React.JSX.Element {
  return (
    <ReceiptOwner
      key={JSON.stringify([
        props.threadId,
        props.document.workspace,
        props.document.id,
        props.document.currentRevision,
        props.document.source.digest,
        props.origin
      ])}
      {...props}
    />
  )
}

function ReceiptOwner(props: Props): React.JSX.Element {
  const [receipt, setReceipt] = useState(() =>
    getReuseReceipt(reuseReceiptKey(props.threadId, props))
  )
  if (!receipt)
    return (
      <section role="status" className="rounded border p-4 text-sm">
        其他复用步骤仍在处理中或已打开，暂时没有可用位置。请等待完成或关闭其他步骤后重试。
        <button
          className={button}
          onClick={() => setReceipt(getReuseReceipt(reuseReceiptKey(props.threadId, props)))}
        >
          重新检查复用位置
        </button>
      </section>
    )
  return <Reuse {...props} receipt={receipt} />
}

function Reuse({
  threadId,
  document,
  origin,
  onOpenThread,
  onReturnToChat,
  receipt
}: Props & { receipt: ReuseReceipt }): React.JSX.Element {
  const scope = useMemo(
    () => ({ threadId, expectedWorkspace: document.workspace }),
    [threadId, document.workspace]
  )
  const [stopped, setStopped] = useReceiptField(receipt, "stopped")
  const [installed, setInstalled] = useReceiptField(receipt, "installed")
  const [authorizationPending, setAuthorizationPending] = useReceiptField(
    receipt,
    "authorizationPending"
  )
  const [claw, setClaw] = useReceiptField(receipt, "claw")
  const [applied, setApplied] = useReceiptField(receipt, "applied")
  const [savedProfile, setSavedProfile] = useReceiptField(receipt, "savedProfile")
  const [created, setCreated] = useReceiptField(receipt, "created")
  const [createdBinding, setCreatedBinding] = useReceiptField(receipt, "createdBinding")
  const [busy, setBusy] = useReceiptField(receipt, "busy")
  const [mod, setMod] = useState<FunctionPluginStatus | null>(null)
  const [consent, setConsent] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState("")
  const alive = useRef(false),
    pending = useRef(false)
  useEffect(() => {
    alive.current = true
    const unsubscribe = window.api.mods.development.onChanged(({ threadId: changed }) => {
      if (changed !== threadId) return
      void window.api.mods.development
        .status({ threadId })
        .then((status) => {
          if (!alive.current) return
          const draft = status.drafts.find((row) => row.id === origin.id)
          if (
            status.workspace !== document.workspace ||
            !draft ||
            draft.revision !== origin.revision ||
            draft.digest !== origin.digest
          )
            setInvalid(true)
        })
        .catch(() => {
          if (alive.current) setInvalid(true)
        })
    })
    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [threadId, document.workspace, origin.id, origin.revision, origin.digest])

  const verify = useCallback(async () => {
    if (!alive.current || invalid || document.source.digest !== origin.digest) throw Error("STALE")
    const status = await window.api.mods.development.status({ threadId })
    const draft = status.drafts.find((row) => row.id === origin.id)
    if (
      !alive.current ||
      status.workspace !== document.workspace ||
      !draft ||
      draft.revision !== origin.revision ||
      draft.digest !== origin.digest
    )
      throw Error("STALE")
    if (
      stopped &&
      status.trials.some((row) => row.draftId === origin.id && row.phase !== "stopped")
    )
      throw Error("STALE")
    const saved = await window.api.mods.authoring.read({ ...scope, id: document.id })
    if (
      !alive.current ||
      saved.workspace !== document.workspace ||
      saved.currentRevision !== document.currentRevision ||
      saved.source.digest !== origin.digest
    )
      throw Error("STALE")
    return status
  }, [threadId, document, origin.id, origin.revision, origin.digest, invalid, stopped, scope])
  const installApi = useMemo(() => {
    const api = window.api.mods.authoringInstall
    return {
      ...api,
      prepare: async (input: Parameters<typeof api.prepare>[0]) => {
        await verify()
        const result = await api.prepare(input)
        if (result.ok) receipt.set("prepared", result.value)
        return result
      },
      rollbackPrepare: async (input: Parameters<typeof api.rollbackPrepare>[0]) => {
        await verify()
        return api.rollbackPrepare(input)
      },
      apply: async (input: Parameters<typeof api.apply>[0]) => {
        await verify()
        if (receipt.data.busy) throw Error("BUSY")
        const candidate = receipt.data.prepared
        receipt.set("busy", true)
        try {
          const result = await api.apply(input)
          if (
            result.ok &&
            result.value.state === "settled" &&
            candidate &&
            candidate.handle === input.handle &&
            candidate.sourceDigest === origin.digest &&
            candidate.installationId === result.value.installationId &&
            candidate.versionId === result.value.versionId
          )
            receipt.set("installed", installationFacts(candidate))
          return result
        } finally {
          receipt.set("busy", false)
        }
      }
    }
  }, [verify, receipt, origin.digest])
  const perform = async (action: () => Promise<void>) => {
    if (pending.current || receipt.data.busy || restoring || invalid) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await verify()
      await action()
    } catch (cause) {
      if (alive.current) {
        const stale = cause instanceof Error && /STALE|SCOPE|CHANGED/.test(cause.message)
        if (stale) setInvalid(true)
        setError(
          stale
            ? "会话、源码、安装或组合已变化，请重新核对；已发生的操作不会自动撤销。"
            : "此步骤未确认完成。已停止或已安装的状态会保留，请核对后重试。"
        )
      }
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const currentMod = useCallback(
    async (candidate = installed) => {
      if (!candidate) throw Error("STALE")
      const status = await window.api.mods.status(threadId)
      const matches =
        status.functionMods?.filter(
          (row) =>
            row.pluginId === candidate.installationId && row.digest === candidate.compiledDigest
        ) ?? []
      if (
        !alive.current ||
        status.workspace !== document.workspace ||
        matches.length !== 1 ||
        matches[0].state === "invalid" ||
        matches[0].state === "disabled"
      )
        throw Error("STALE")
      return matches[0]
    },
    [installed, threadId, document.workspace]
  )
  const installedResult = (candidate: AuthoringPreparedInstallation) => {
    // Installation is already settled. Preserve its receipt even if the follow-up read fails.
    setInstalled(installationFacts(candidate))
    if (!alive.current) return
    setMod(null)
    setConsent(false)
    setAuthorized(false)
    setAuthorizationPending(false)
    setClaw(null)
    setApplied(null)
    setSavedProfile(null)
    if (candidate.sourceDigest !== origin.digest) {
      setInvalid(true)
      setError("安装已完成，但该版本与本次复用源码不同。请重新选择版本后核对权限。")
      return
    }
    void perform(async () => {
      const current = await currentMod(candidate)
      await verify()
      if (!alive.current) return
      setMod(current)
    })
  }
  useEffect(() => {
    if (!restoring || busy) return
    let cancelled = false
    void (async () => {
      try {
        const status = await verify()
        const result = await window.api.mods.authoringInstall.resolveInstalled({
          ...scope,
          draftId: document.id,
          revision: document.currentRevision,
          sourceDigest: document.source.digest
        })
        if (!result.ok) throw Error(result.code)
        const recovered = result.value
        if (
          installed &&
          (!recovered ||
            recovered.installationId !== installed.installationId ||
            recovered.versionId !== installed.versionId ||
            recovered.compiledDigest !== installed.compiledDigest)
        )
          throw Error("STALE")
        if (recovered && recovered.sourceDigest !== origin.digest) throw Error("STALE")
        const stoppedNow = !status.trials.some(
          (row) => row.draftId === origin.id && row.phase !== "stopped"
        )
        const installedMod = recovered && stoppedNow ? await currentMod(recovered) : null
        if (receipt.data.claw) {
          const current = await window.api.mods.clawView(threadId)
          const remembered = receipt.data.claw
          const saved = receipt.data.savedProfile
          if (saved) {
            if (
              current.workspace !== document.workspace ||
              current.revision !== saved.revision ||
              JSON.stringify(current.profiles.find((row) => row.id === saved.profile.id)) !==
                JSON.stringify(saved.profile)
            )
              throw Error("STALE")
            if (
              current.bindingRevision === saved.bindingRevision + 1 &&
              JSON.stringify(current.active) === JSON.stringify(saved.profile)
            ) {
              receipt.set("applied", current.active)
              receipt.set("savedProfile", null)
            } else if (current.bindingRevision !== saved.bindingRevision) throw Error("STALE")
            receipt.set("claw", current)
          } else if (
            current.workspace !== document.workspace ||
            current.revision !== remembered.revision ||
            current.bindingRevision !== remembered.bindingRevision ||
            JSON.stringify(current.active) !== JSON.stringify(remembered.active)
          )
            throw Error("STALE")
        }
        await verify()
        if (!cancelled && alive.current && installedMod) {
          setInstalled(recovered)
          setStopped(true)
          setMod(installedMod)
          setAuthorized(installedMod.state === "ready")
          setAuthorizationPending(false)
        }
      } catch (cause) {
        if (!cancelled && alive.current) {
          setError(
            "已保留之前完成的步骤，但当前状态未核对成功。请重新读取；不会重复安装或创建会话。"
          )
          if (cause instanceof Error && /STALE|SCOPE|CHANGED/.test(cause.message)) setInvalid(true)
        }
      } finally {
        if (!cancelled && alive.current) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    busy,
    restoring,
    currentMod,
    document.id,
    document.currentRevision,
    document.source.digest,
    document.workspace,
    installed,
    origin.digest,
    origin.id,
    receipt,
    scope,
    setInstalled,
    setStopped,
    setAuthorizationPending,
    threadId,
    verify
  ])
  const readClaw = async () => {
    const current = await currentMod()
    if (current.state !== "ready") throw Error("STALE")
    const view = await window.api.mods.clawView(threadId)
    if (view.workspace !== document.workspace || !view.applicable) throw Error("STALE")
    await verify()
    if (savedProfile) {
      const stored = view.profiles.find((row) => row.id === savedProfile.profile.id)
      if (
        view.revision !== savedProfile.revision ||
        JSON.stringify(stored) !== JSON.stringify(savedProfile.profile)
      )
        throw Error("STALE")
      if (
        view.bindingRevision === savedProfile.bindingRevision + 1 &&
        JSON.stringify(view.active) === JSON.stringify(savedProfile.profile)
      ) {
        if (alive.current) {
          setClaw(view)
          setApplied(view.active)
          setSavedProfile(null)
        }
        return
      }
      if (view.bindingRevision !== savedProfile.bindingRevision) throw Error("STALE")
    }
    if (alive.current) {
      setClaw(view)
      setApplied(
        applied && JSON.stringify(view.active) === JSON.stringify(applied) ? view.active : null
      )
    }
  }
  const applyClaw = async () => {
    if (!claw || !mod) throw Error("STALE")
    const current = await currentMod()
    const latest = await window.api.mods.clawView(threadId)
    if (
      current.state !== "ready" ||
      latest.workspace !== claw.workspace ||
      latest.revision !== (savedProfile?.revision ?? claw.revision) ||
      latest.bindingRevision !== (savedProfile?.bindingRevision ?? claw.bindingRevision)
    )
      throw Error("STALE")
    if (applied && JSON.stringify(latest.active) === JSON.stringify(applied)) return
    const base = latest.active
    const preserved: ClawProfile["capabilities"] =
      base?.capabilities ??
      latest.capabilities
        .filter((row) => row.state === "ready" && row.digest)
        .map((row) => ({
          pluginId: row.pluginId,
          name: row.name,
          digest: row.digest!
        }))
    const existing = preserved.find((row) => row.pluginId === current.pluginId)
    const profile: ClawProfile = savedProfile?.profile ?? {
      ...base,
      id: `reuse-${crypto.randomUUID()}`,
      name: `${document.name} · 复用`,
      capabilities: [
        ...preserved.filter((row) => row.pluginId !== current.pluginId),
        {
          pluginId: current.pluginId,
          name: current.name,
          digest: current.digest!,
          ...(existing?.components ? { components: existing.components } : {})
        }
      ]
    }
    if (
      savedProfile &&
      JSON.stringify(latest.profiles.find((row) => row.id === profile.id)) !==
        JSON.stringify(savedProfile.profile)
    )
      throw Error("STALE")
    let savedRevision = savedProfile?.revision
    if (savedRevision === undefined) {
      await verify()
      const saved = await window.api.mods.clawChange(threadId, {
        kind: "save",
        profile,
        revision: latest.revision,
        workspace: latest.workspace
      })
      savedRevision = saved.revision
      const stored = saved.profiles.find((row) => row.id === profile.id)
      setSavedProfile({
        profile: stored ?? profile,
        revision: saved.revision,
        bindingRevision: latest.bindingRevision
      })
      if (!stored) throw Error("STALE")
    }
    await verify()
    const result = await window.api.mods.clawChange(threadId, {
      kind: "apply",
      id: profile.id,
      revision: savedRevision,
      workspace: latest.workspace,
      bindingRevision: latest.bindingRevision
    })
    setApplied(result.active)
    setClaw(result)
    setSavedProfile(null)
    await verify()
  }
  const newChat = async () => {
    if (!applied || !claw) throw Error("STALE")
    const current = await currentMod()
    const latest = await window.api.mods.clawView(threadId)
    if (
      current.state !== "ready" ||
      latest.revision !== claw.revision ||
      latest.bindingRevision !== claw.bindingRevision ||
      latest.active?.id !== applied.id
    )
      throw Error("STALE")
    await verify()
    let targetId = created
    if (!targetId) {
      const thread = await window.api.threads.create({ workspacePath: document.workspace })
      targetId = thread.thread_id
      setCreated(targetId)
    }
    await verify()
    const target = await window.api.mods.clawView(targetId)
    if (target.workspace !== document.workspace || target.revision !== latest.revision)
      throw Error("STALE")
    const captured = createdBinding ?? {
      id: targetId,
      revision: target.revision,
      bindingRevision: target.bindingRevision
    }
    setCreatedBinding(captured)
    if (
      captured.id !== targetId ||
      captured.revision !== target.revision ||
      (target.bindingRevision !== captured.bindingRevision &&
        target.bindingRevision !== captured.bindingRevision + 1)
    )
      throw Error("STALE")
    if (JSON.stringify(target.active) === JSON.stringify(applied)) {
      await verify()
      if (alive.current) await onOpenThread(targetId)
      return
    }
    if (target.bindingRevision !== captured.bindingRevision) throw Error("STALE")
    await verify()
    await window.api.mods.clawChange(targetId, {
      kind: "apply",
      id: applied.id,
      revision: target.revision,
      workspace: target.workspace,
      bindingRevision: target.bindingRevision
    })
    await verify()
    if (alive.current) await onOpenThread(targetId)
  }
  return (
    <section aria-label="保存并正式复用" className="space-y-4 rounded border p-4">
      <h3 className="font-medium">保存并正式复用 · {document.name}</h3>
      <p className="text-sm">
        开发源码 v{origin.revision}{" "}
        已保存。按下面的步骤安装、授权并加入助手。已完成的步骤可以展开回看。
      </p>
      <details open={!!error} className="rounded border p-3 text-sm">
        <summary className="cursor-pointer">版本详情与进度恢复</summary>
        <p className="break-all font-mono text-xs">源码摘要：{origin.digest}</p>
        <p className="text-xs text-muted-foreground">
          重启应用后可只读恢复正式安装事实。组合与新会话进度仅在本次运行期间保留；重启后请先核对已有组合和会话，避免重复创建。
        </p>
        {!invalid && !restoring && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              setError("")
              setRestoring(true)
            }}
          >
            只读恢复复用进度
          </button>
        )}
      </details>
      {invalid && <p role="alert">此复用计划已过期，请重新选择当前开发版本。</p>}
      {error && <p role="alert">{error} 展开“版本详情与进度恢复”可只读核对。</p>}
      {restoring && <p role="status">正在只读核对已完成的复用步骤…</p>}
      <p className="text-sm font-medium">
        {stopped ? "1. 本会话试用已停止" : "1. 停止试用"}
      </p>
      {!stopped && (
        <div className="space-y-2">
          <p className="text-sm">正式安装前先停止此试用，避免同时运行两个版本。</p>
          <button
            className={button}
            disabled={busy || restoring || invalid}
            onClick={() =>
              void perform(async () => {
                const before = await verify()
                const trial = before.trials.find((row) => row.draftId === origin.id)
                if (trial && trial.phase !== "stopped")
                  await window.api.mods.development.stop({ ...scope, id: trial.componentId })
                const after = await verify()
                if (after.trials.some((row) => row.draftId === origin.id && row.phase !== "stopped"))
                  throw Error("STOP_UNCONFIRMED")
                if (alive.current) setStopped(true)
                if (alive.current) setRestoring(true)
              })
            }
          >
            停止此试用并继续正式复用
          </button>
        </div>
      )}
      {stopped && !invalid && !restoring && (
        <details open={!installed} className="space-y-3 rounded border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {installed ? "2. 正式版本已安装 · 回看预览与安装" : "2. 预览并安装正式版本"}
          </summary>
          {installed && <p className="text-xs text-muted-foreground">
            安装事实已确认；不表示运行预览已经通过，后续失败也不会自动卸载。
          </p>}
          <AuthoringPreviewPanel
            threadId={threadId}
            workspace={document.workspace}
            document={document}
            dirty={false}
          />
          <AuthoringInstallPanel
            threadId={threadId}
            workspace={document.workspace}
            document={document}
            dirty={false}
            api={installApi}
            onSettled={installedResult}
            onReconciled={() => setRestoring(true)}
          />
        </details>
      )}
      {installed && !mod && !invalid && (
        <button
          className={button}
          disabled={busy || restoring}
          onClick={() =>
            void perform(async () => {
              const current = await currentMod()
              await verify()
              if (alive.current) setMod(current)
            })
          }
        >
          重新核对已安装版本（只读）
        </button>
      )}
      {installed && mod && !invalid && (
        <details open={!authorized || authorizationPending} className="space-y-2 rounded border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {authorized ? "3. 正式权限已确认 · 回看权限" : "3. 确认正式权限"}
          </summary>
          <p className="text-sm">
            正式授权比本会话试用范围更广：可读取项目和会话、注册命令和工具、保存偏好、扩展界面、调用或拦截工具及调用已配置模型。模型调用产生实际用量，每插件每项目每分钟最多
            30 次、32768 个预留输出 Token。写文件与执行命令仍需批准最终参数。
          </p>
          <p className="break-all text-xs">
            正式版本：{installed.versionId} · {mod.digest}
          </p>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || restoring}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我已核对这个正式版本及以上权限
          </label>
          <button
            className={button}
            disabled={busy || !consent || authorizationPending || authorized}
            onClick={() =>
              void perform(async () => {
                const current = await currentMod()
                if (current.pluginId !== mod.pluginId || current.digest !== mod.digest)
                  throw Error("STALE")
                await verify()
                setAuthorizationPending(true)
                await window.api.mods.approveFunction(
                  threadId,
                  current.pluginId,
                  current.digest!,
                  document.workspace
                )
                await verify()
                if ((await currentMod()).state !== "ready") throw Error("STALE")
                if (alive.current) {
                  setAuthorized(true)
                  setAuthorizationPending(false)
                }
              })
            }
          >
            授权此正式版本
          </button>
          {authorizationPending && (
            <>
              <p className="text-sm">正式授权结果待核对；请先只读确认，不重复提交授权。</p>
              <button
                className={button}
                disabled={busy || restoring}
                onClick={() =>
                  void perform(async () => {
                    const current = await currentMod()
                    await verify()
                    if (alive.current) {
                      setAuthorized(current.state === "ready")
                      setAuthorizationPending(false)
                    }
                  })
                }
              >
                只读核对正式授权状态
              </button>
            </>
          )}
        </details>
      )}
      {authorized && !invalid && (
        <details open={!applied || !!error} className="space-y-2 rounded border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {applied ? "4. 已加入当前助手 · 回看组合" : "4. 加入当前助手"}
          </summary>
          <button
            className={button}
            disabled={busy || restoring}
            onClick={() => void perform(readClaw)}
          >
            核对当前 Claw 组合
          </button>
          {claw && (
            <>
              <p className="text-sm">
                保留当前组合“{claw.active?.name ?? "默认启用的所有已授权组件"}
                ”的其他组件、Skill、MCP、模型和流程，加入本版本。已有本组件的选择范围保持不变；首次加入包含它的全部声明组件。
              </p>
              {savedProfile && (
                <p className="text-sm">
                  组合“{savedProfile.profile.name}
                  ”已保存，应用结果尚未确认。重试复用这份已保存组合，不另建副本。
                </p>
              )}
              <button
                className={button}
                disabled={busy || restoring || !!applied}
                onClick={() => void perform(applyClaw)}
              >
                保留其他选择并应用此组合
              </button>
            </>
          )}
        </details>
      )}
      {applied && !invalid && !restoring && (
        <div className="space-y-3 rounded border border-primary/30 bg-primary/5 p-3">
          <p role="status" className="text-sm font-medium">已保存并应用到当前聊天，可以继续使用。</p>
          <div className="flex flex-wrap gap-2">
            {onReturnToChat && <button type="button" className={button} disabled={busy}
              onClick={onReturnToChat}>继续当前聊天</button>}
            <button
              className={button}
              disabled={busy || restoring}
              onClick={() => void perform(newChat)}
            >
              新聊天使用此助手
            </button>
          </div>
        </div>
      )}
      {created && (
        <p className="text-sm">
          已创建新会话：{created}。若后续步骤失败，该会话仍保留，未发送模型请求。
        </p>
      )}
    </section>
  )
}
