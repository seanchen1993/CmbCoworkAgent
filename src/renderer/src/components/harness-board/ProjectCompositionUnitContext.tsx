import { useEffect, useRef, useState } from "react"
import type {
  CompositionRun, CompositionUnitContextOptions, ProjectCompositionApi, ProjectCompositionScope
} from "../../../../shared/project-runtime/composition-api"
import { compositionUnitConfigurationKey } from "../../../../shared/project-runtime/composition-api"

export function ProjectCompositionUnitContext(props: {
  api: ProjectCompositionApi
  scope: ProjectCompositionScope
  run: CompositionRun
  unitId: string
  configurationReady: boolean
  onReady(ready: boolean): void
  onSaved(run: CompositionRun): void
}) {
  const [options, setOptions] = useState<CompositionUnitContextOptions>()
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState("")
  const lifecycle = useRef(0)
  const callbacks = useRef(props)
  callbacks.current = props
  const identity = compositionUnitConfigurationKey({ scope: props.scope, runId: props.run.id,
    unitId: props.unitId, expectedVersion: props.run.version })
  useEffect(() => {
    lifecycle.current++
    let disposed = false
    callbacks.current.onReady(false)
    if (!props.configurationReady) {
      setOptions(undefined)
      setBusy(false)
      setError("")
      return () => { lifecycle.current++ }
    }
    const scope = JSON.parse(identity) as Parameters<ProjectCompositionApi["readUnitContext"]>[0]
    setBusy(true)
    setError("")
    void props.api.readUnitContext(scope).then(view => {
      if (disposed) return
      setOptions(view)
      setSelected(view.selected)
      const saved = callbacks.current.run.unitContexts?.[scope.unitId]
      callbacks.current.onReady(!view.supported || !!saved &&
        saved.contextFingerprint === view.contextFingerprint &&
        (!view.required || saved.deployUnitIds.length > 0) &&
        saved.deployUnitIds.every(id => view.candidates.includes(id)))
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true; lifecycle.current++ }
  }, [props.api, identity, props.configurationReady, refresh])
  if (options && !options.supported) return null
  const candidates = [...new Set([...(options?.candidates ?? []), ...selected])]
  const matches = candidates.filter(id => id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const save = async () => {
    if (!options?.contextFingerprint || busy) return
    const captured = identity
    const generation = lifecycle.current
    setBusy(true)
    setError("")
    callbacks.current.onReady(false)
    try {
      const next = await props.api.saveUnitContext({ ...JSON.parse(captured),
        deployUnitIds: selected, contextFingerprint: options.contextFingerprint })
      if (generation === lifecycle.current && compositionUnitConfigurationKey({ scope: callbacks.current.scope,
        runId: callbacks.current.run.id, unitId: callbacks.current.unitId,
        expectedVersion: callbacks.current.run.version }) === captured)
        callbacks.current.onSaved(next)
    } catch (cause) {
      if (generation === lifecycle.current && compositionUnitConfigurationKey({ scope: callbacks.current.scope,
        runId: callbacks.current.run.id, unitId: callbacks.current.unitId,
        expectedVersion: callbacks.current.run.version }) === captured)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (generation === lifecycle.current) setBusy(false) }
  }
  return <section aria-label="选择业务上下文" className="mt-3 space-y-2 rounded border p-3 text-sm">
    <h5 className="font-medium">选择业务上下文</h5>
    <p>先保存参数并授权此步骤，再从实际知识来源中选择业务上下文。选择不会增加目录权限。</p>
    {error && <p role="alert" className="break-words">{error}</p>}
    <button type="button" className="rounded border px-2 py-1" disabled={busy || !props.configurationReady}
      onClick={() => setRefresh(value => value + 1)}>重新读取业务上下文</button>
    {options?.supported && <>
      {options.candidates.length === 0 && <p>当前知识来源未返回可用业务上下文，请检查参数和知识内容。</p>}
      <input aria-label="查找业务上下文" value={query} onChange={event => setQuery(event.target.value)}
        className="w-full rounded border bg-background p-2" placeholder="输入名称查找" />
      {matches.length > 100 && <p>匹配 {matches.length} 项，当前显示前 100 项；请输入更多字符缩小范围。</p>}
      <div className="max-h-56 space-y-1 overflow-auto">
        {matches.slice(0, 100).map(id => <label key={id} className="flex items-center gap-2">
          <input type="checkbox" checked={selected.includes(id)} disabled={busy}
            onChange={event => {
              callbacks.current.onReady(false)
              setSelected(previous => event.target.checked ? [...previous, id] : previous.filter(item => item !== id))
            }} />
          <span>{id}{!options.candidates.includes(id) ? "（来源已不可用，请取消选择）" : ""}</span>
        </label>)}
      </div>
      <button type="button" className="rounded border px-2 py-1 disabled:opacity-50"
        disabled={busy || (options.required && selected.length === 0) || selected.some(id => !options.candidates.includes(id))}
        onClick={() => void save()}>确认业务上下文</button>
    </>}
  </section>
}
