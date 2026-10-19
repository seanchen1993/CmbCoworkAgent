import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { InstalledPluginProjectEntry } from "./InstalledPluginProjectEntry"
import { DerivedPluginEditor } from "./DerivedPluginEditor"
import { DerivedPluginProposal } from "./DerivedPluginProposal"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { useConfigurationDraft } from "@/lib/configuration-target"
import type {
  PluginDerivationCopy,
  PluginDerivationInspection,
  PluginDerivationUpstream,
  PluginDerivationSource
} from "../../../../shared/plugin-derivation"

export function PluginDerivationPanel(props: {
  threadId: string | null
  workspace?: string | null
  active: boolean
  practice?: SimpleAuthoringPracticeIntent
  sourceRequest?: { id: string; pluginId: string; name: string } | null
}) {
  if (!props.threadId || !props.workspace)
    return (
      <p className="rounded-lg border p-4 text-sm">
        {props.sourceRequest && <>已选择 {props.sourceRequest.name}。</>}
        请先打开聊天并选择项目文件夹，然后在这里制作自己的插件。
      </p>
    )
  return (
    <ScopedDerivation
      key={JSON.stringify([props.threadId, props.workspace])}
      threadId={props.threadId}
      workspace={props.workspace}
      active={props.active}
      practice={props.practice}
      sourceRequest={props.sourceRequest}
    />
  )
}

function ScopedDerivation({
  threadId,
  workspace,
  active,
  practice,
  sourceRequest
}: {
  threadId: string
  workspace: string
  active: boolean
  practice?: SimpleAuthoringPracticeIntent
  sourceRequest?: { id: string; pluginId: string; name: string } | null
}) {
  const scope = { threadId, expectedWorkspace: workspace }
  const [enabledPluginId, setEnabledPluginId] = useState<string | null>(null)
  const [acceptedSourceRequest, setAcceptedSourceRequest] = useState<string | null>(null)
  const [acceptedPractice, setAcceptedPractice] = useState<string | null>(null)
  const [practiceName, setPracticeName] = useState<string | null>(null)
  const pendingPractice =
    practice &&
    practice.id !== acceptedPractice &&
    sameSimpleAuthoringScope(practice.scope, { threadId, workspace })
      ? practice
      : null
  const [sources, setSources] = useState<PluginDerivationSource[]>([])
  const [copies, setCopies] = useState<PluginDerivationCopy[]>([])
  const [inspection, setInspection] = useState<PluginDerivationInspection | null>(null)
  const [copy, setCopy] = useState<PluginDerivationCopy | null>(null)
  const [upstream, setUpstream] = useState<PluginDerivationUpstream | null>(null)
  const [name, setName] = useState("")
  const [editing, setEditing] = useState(false)
  const [fileDirty, setFileDirty] = useState(false)
  const [proposalPending, setProposalPending] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const live = useRef(true)
  const visibility = useRef({ active })
  if (visibility.current.active !== active) visibility.current = { active }
  const lock = useRef(false)
  const createRequest = useRef(crypto.randomUUID())
  const revisionRequest = useRef(crypto.randomUUID())
  const upstreamRequest = useRef(crypto.randomUUID())
  const dirty = proposalPending
  useConfigurationDraft({ threadId, workspace }, dirty || fileDirty ||
    (!!inspection && name !== (practiceName ?? inspection.suggestedName)), busy)
  useEffect(() => {
    setUpstream(null)
    revisionRequest.current = crypto.randomUUID()
    upstreamRequest.current = crypto.randomUUID()
    // Source hashing is explicit; opening a copy never scans its upstream package.
  }, [active, copy?.copyId])
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (!active) return
    let current = true
    void Promise.all([
      window.api.pluginDerivation.sources(scope),
      window.api.pluginDerivation.list(scope)
    ])
      .then(([available, saved]) => {
        if (current) {
          setSources(available)
          setCopies(saved)
        }
      })
      .catch((cause) => {
        if (current) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      current = false
    }
    // The component is keyed by the entire scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, threadId, workspace])
  const remember = (value: PluginDerivationCopy) => {
    setCopy(value)
    setCopies((previous) => [value, ...previous.filter((item) => item.copyId !== value.copyId)])
  }
  async function run(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await work()
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  const inspect = (pluginId?: string) =>
    void run(async () => {
      const value = await window.api.pluginDerivation.inspect({ ...scope, pluginId })
      if (!live.current || !value) return
      setInspection(value)
      setName(practiceName ?? value.suggestedName)
      setCopy(null)
      setEditing(false)
      createRequest.current = crypto.randomUUID()
    })
  const pendingSource =
    sourceRequest && sourceRequest.id !== acceptedSourceRequest ? sourceRequest : null
  useEffect(() => {
    if (!active || !pendingSource || copy || inspection || busy || dirty || fileDirty) return
    setAcceptedSourceRequest(pendingSource.id)
    inspect(pendingSource.pluginId)
    // Source requests never replace an open copy, inspection or unsaved work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pendingSource, copy, inspection, busy, dirty, fileDirty])
  return (
    <section aria-label="从已有插件创建" className="space-y-4 rounded-xl border p-4">
      <div>
        <h2 className="font-semibold">从已有插件创建</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          从 AutoBiz 或其他插件复制一份，按你的需要修改，再安装使用。原插件和已有项目不受影响。
        </p>
      </div>
      {pendingSource && (copy || inspection) && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
          <p>已选择 {pendingSource.name}。当前内容会保留在副本列表中；请先保存正在编辑的内容。</p>
          <Button
            disabled={busy || dirty || fileDirty}
            onClick={() => {
              setAcceptedSourceRequest(pendingSource.id)
              inspect(pendingSource.pluginId)
            }}
          >
            从 {pendingSource.name} 创建新副本
          </Button>
        </div>
      )}
      {pendingPractice && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
          <p>
            继续演练：创建“{pendingPractice.suggestedName ?? "我的 AutoBiz"}
            ”。请选择要参考的插件；已保存的内容会保留。
          </p>
          <Button
            disabled={busy || dirty || fileDirty}
            onClick={() => {
              setAcceptedPractice(pendingPractice.id)
              setPracticeName(pendingPractice.suggestedName ?? "我的 AutoBiz")
              setCopy(null)
              setInspection(null)
              setEditing(false)
            }}
          >
            按演练要求新建插件
          </Button>
          <Button variant="ghost" onClick={() => setAcceptedPractice(pendingPractice.id)}>
            继续当前草稿
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在处理，请稍候…
        </p>
      )}
      {!copy && (
        <>
          <label className="block space-y-2 text-sm">
            <span>1. 选择要参考的插件</span>
            <select
              className="block w-full rounded-md border bg-background p-2"
              aria-label="选择原插件"
              disabled={busy}
              value=""
              onChange={(event) => {
                if (event.target.value) inspect(event.target.value)
              }}
            >
              <option value="">选择已安装插件</option>
              {sources.map((source) => (
                <option key={source.pluginId} value={source.pluginId}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline" disabled={busy} onClick={() => inspect()}>
            选择本地插件文件夹
          </Button>
          {inspection && (
            <div className="space-y-3 rounded-lg bg-muted/30 p-3">
              <p className="text-sm">
                已选择 {inspection.sourceName}，会复制其中的技能说明、脚本和原有检查规则。
              </p>
              <label className="block space-y-2 text-sm">
                <span>2. 给新插件起个名字</span>
                <input
                  className="block w-full rounded border bg-background p-2"
                  value={name}
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.target.value)
                    createRequest.current = crypto.randomUUID()
                  }}
                />
              </label>
              <Button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () => {
                    const value = await window.api.pluginDerivation.create({
                      ...scope,
                      inspectionId: inspection.inspectionId,
                      name: name.trim(),
                      requestId: createRequest.current
                    })
                    if (live.current) {
                      remember(value)
                      setEditing(true)
                    }
                  })
                }
              >
                创建我的插件
              </Button>
              <details className="text-xs">
                <summary>查看复制内容</summary>
                <p className="mt-2">{inspection.fileCount} 个文件</p>
                {inspection.warnings.map((text) => (
                  <p key={text}>{text}</p>
                ))}
                {!!inspection.excluded.length && <p>不复制：{inspection.excluded.join("、")}</p>}
              </details>
            </div>
          )}
        </>
      )}
      {copy && (
        <div className="space-y-3">
          <h3 className="font-medium">{copy.name} 已创建</h3>
          <ol className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <li>① 新插件已保存</li>
            <li>
              ②{" "}
              {copy.status === "checked" || copy.status === "installed"
                ? "安装检查已通过"
                : "补充要求，再检查能否安装"}
            </li>
            <li>
              ③{" "}
              {copy.status === "installed" ? "已安装，等待启用和项目设置" : "安装插件，再新建项目"}
            </li>
          </ol>
          {copy.parentCopyId && (
            <p className="text-sm text-muted-foreground">
              这是独立的新版本草稿。检查并发布后，为新版本新建项目；已有项目继续使用旧版本，Hooks
              仍需原有审批。
            </p>
          )}
          {copy.status === "installed" ? (
            <Button
              disabled={busy || dirty || fileDirty}
              onClick={() =>
                void run(async () => {
                  const value = await window.api.pluginDerivation.revise({
                    ...scope,
                    copyId: copy.copyId,
                    requestId: revisionRequest.current
                  })
                  if (live.current) {
                    remember(value)
                    setEditing(true)
                    setAdvanced(false)
                  }
                })
              }
            >
              修改这个插件（创建新版本草稿）
            </Button>
          ) : (
            !editing && <Button onClick={() => setEditing(true)}>修改这个插件</Button>
          )}
          {upstream?.state === "changed" && (
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <p>
                来源插件内容已变化。可从最新来源制作新草稿；当前修改会保留，不会自动合并到新草稿。
              </p>
              <Button
                variant="outline"
                disabled={busy || dirty || fileDirty}
                onClick={() =>
                  void run(async () => {
                    const activation = visibility.current
                    const latest = await window.api.pluginDerivation.inspectUpstream({
                      ...scope,
                      copyId: copy.copyId,
                      prepare: true
                    })
                    if (!live.current || !activation.active || visibility.current !== activation)
                      return
                    if (!latest.inspection) throw new Error("来源不可用，请重新选择来源")
                    const value = await window.api.pluginDerivation.create({
                      ...scope,
                      inspectionId: latest.inspection.inspectionId,
                      name: latest.inspection.suggestedName,
                      requestId: upstreamRequest.current
                    })
                    if (live.current) {
                      remember(value)
                      setEditing(true)
                      setAdvanced(false)
                    }
                  })
                }
              >
                从最新来源制作
              </Button>
            </div>
          )}
          <div className="space-y-2 text-sm">
            <Button
              variant="outline"
              disabled={busy || dirty || fileDirty}
              onClick={() =>
                void run(async () => {
                  const activation = visibility.current
                  const result = await window.api.pluginDerivation.inspectUpstream({
                    ...scope,
                    copyId: copy.copyId
                  })
                  if (live.current && activation.active && visibility.current === activation)
                    setUpstream(result)
                })
              }
            >
              检查来源更新
            </Button>
            <p className="text-muted-foreground">
              {!upstream
                ? "尚未检查来源更新。点击后读取来源文件，较大插件可能需要稍候。"
                : upstream.state === "unchanged"
                  ? "来源内容未变化。"
                  : upstream.state === "changed"
                    ? "检测到来源更新。"
                    : "来源暂不可用，请恢复原来源或重新选择来源。"}
            </p>
          </div>
          {editing && copy.status !== "installed" && (
            <>
              <DerivedPluginProposal
                key={`proposal:${copy.copyId}`}
                scope={scope}
                copy={copy}
                active={active}
                disabled={busy || fileDirty}
                onSaved={remember}
                onPending={setProposalPending}
              />
              <details
                onToggle={(event) => {
                  if (event.currentTarget.open) setAdvanced(true)
                }}
                className="rounded-lg border p-3 text-sm"
              >
                <summary className="cursor-pointer">手动修改文件（适合熟悉代码的用户）</summary>
                {advanced && (
                  <DerivedPluginEditor
                    key={copy.copyId}
                    scope={scope}
                    copy={copy}
                    disabled={busy || dirty}
                    onSaved={remember}
                    onDirty={setFileDirty}
                  />
                )}
              </details>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  window.api.pluginDerivation.openSource({ ...scope, copyId: copy.copyId })
                )
              }
            >
              打开插件文件夹
            </Button>
            {copy.status !== "installed" && (
              <Button
                disabled={busy || dirty || fileDirty}
                onClick={() =>
                  void run(async () => {
                    const value = await window.api.pluginDerivation.check({
                      ...scope,
                      copyId: copy.copyId
                    })
                    if (live.current) remember(value)
                  })
                }
              >
                检查能否安装
              </Button>
            )}
            {copy.status === "checked" && (
              <Button
                disabled={busy || dirty || fileDirty}
                onClick={() =>
                  void run(async () => {
                    const value = await window.api.pluginDerivation.install({
                      ...scope,
                      copyId: copy.copyId,
                      expectedDigest: copy.digest
                    })
                    if (live.current) {
                      remember(value)
                      useAppStore.getState().bumpPluginVersion()
                    }
                  })
                }
              >
                {copy.parentCopyId ? "发布并安装新版本" : "安装新插件"}
              </Button>
            )}
          </div>
          {copy.status === "installed" && (
            <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm">
              <p>
                安装完成。先启用新插件，再为它新建独立项目。
                已准备完整流程组合的副本，也可到目标项目的“项目能力”查看可用流程。
                原项目继续使用原插件。
              </p>
              <Button
                variant="outline"
                disabled={busy || !copy.pluginId || enabledPluginId === copy.pluginId}
                onClick={() =>
                  void run(async () => {
                    const result = await window.api.plugins.setEnabled(copy.pluginId!, true)
                    if (result?.success === false)
                      throw new Error(result.error || "启用状态未能保存，请重试。")
                    if (live.current) {
                      setEnabledPluginId(copy.pluginId!)
                      useAppStore.getState().bumpPluginVersion()
                    }
                  })
                }
              >
                {enabledPluginId === copy.pluginId ? "新插件已启用" : "启用新插件"}
              </Button>
              {copy.pluginId && <InstalledPluginProjectEntry key={copy.pluginId}
                pluginId={copy.pluginId} scope={scope} active={active} disabled={busy}
                refreshKey={enabledPluginId === copy.pluginId} />}
            </div>
          )}
          <details className="text-xs">
            <summary>查看来源和检查结果</summary>
            <p className="mt-2">
              来自 {copy.sourceName}，{copy.fileCount} 个文件。
            </p>
            <p>来源快照：{copy.sourceDigest.slice(0, 12)}</p>
            {copy.warnings.map((text) => (
              <p key={text}>{text}</p>
            ))}
            <p>安装检查通过后，还需在新项目中按原有规则检查业务结果并完成确认。</p>
          </details>
          <Button
            variant="ghost"
            disabled={busy || dirty || fileDirty}
            onClick={() => {
              setCopy(null)
              setInspection(null)
              setEditing(false)
            }}
          >
            再创建一个插件
          </Button>
        </div>
      )}
      {!!copies.length && (
        <details className="text-sm">
          <summary>继续修改已创建的插件（{copies.length}）</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {copies.map((value) => (
              <Button
                key={value.copyId}
                variant="outline"
                disabled={busy || dirty || fileDirty}
                onClick={() =>
                  void run(async () => {
                    const result = await window.api.pluginDerivation.get({
                      ...scope,
                      copyId: value.copyId
                    })
                    if (live.current) {
                      remember(result)
                      setEditing(true)
                    }
                  })
                }
              >
                {value.name}
              </Button>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
