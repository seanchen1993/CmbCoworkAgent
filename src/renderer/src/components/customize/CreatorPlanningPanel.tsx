import { useEffect, useState } from "react"
import type { DevelopmentApi } from "../../../../shared/mods/development"
import type { CreatorPlanningCatalog } from "../../../../shared/mods/creator-planning"

/** Optional native selection. Errors stay local so stop/recovery/installation cards remain usable. */
export function CreatorPlanningPanel({
  api,
  threadId,
  workspace
}: {
  api: DevelopmentApi
  threadId: string
  workspace: string
}) {
  const [catalog, setCatalog] = useState<CreatorPlanningCatalog | null>(null)
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    const read = () => {
      if (api.planningCatalog)
        void api
          .planningCatalog({ threadId, expectedWorkspace: workspace })
          .then((value) => {
            if (!live) return
            setCatalog(value)
            setSelected(value.status.selected ? JSON.stringify(value.status.selected) : "")
          })
          .catch(() => {
            if (live) setError("策略列表暂不可用，原生创造者及恢复入口仍可使用。")
          })
    }
    read()
    const unsubscribe = api.onChanged((event) => {
      if (event.threadId === threadId) read()
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [api, threadId, workspace, refresh])
  if (!api.planningCatalog || !api.selectPlanning) return null
  const save = async (value: string) => {
    if (!catalog || busy || !api.selectPlanning) return
    setBusy(true)
    setError("")
    try {
      const result = await api.selectPlanning({
        threadId,
        expectedWorkspace: workspace,
        expectedRevision: catalog.status.revision,
        selected: value ? JSON.parse(value) : null
      })
      setCatalog(result)
      setSelected(result.status.selected ? JSON.stringify(result.status.selected) : "")
    } catch {
      setError("规划策略验证或保存未完成，保留原选择。可撤回策略继续使用原生创造者。")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-3 space-y-2" aria-label="创造者规划策略">
      <p>仅提供规划建议，不改变工具、权限、检查或安装结果。未选或失效时使用原生创造者。</p>
      <p>
        以下是已安装的功能来源，尚未验证为规划策略；仅实现 creator.planning 接点的 Mod
        才能通过验证。
      </p>
      {catalog?.status.diagnostic && <p role="status">{catalog.status.diagnostic}</p>}
      <label className="block">
        可选规划 Mod
        <select
          aria-label="可选规划 Mod"
          className="devclaw-input mt-1 w-full"
          value={selected}
          disabled={busy || !catalog}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">原生规划</option>
          {catalog?.status.selected &&
            !catalog.candidates.some(
              (candidate) =>
                candidate.pluginId === catalog.status.selected?.pluginId &&
                candidate.digest === catalog.status.selected.digest
            ) && (
              <option value={JSON.stringify(catalog.status.selected)} disabled>
                {catalog.status.selected.name}（已失效）
              </option>
            )}
          {catalog?.candidates.map(({ state, ...reference }) => (
            <option
              key={reference.pluginId + reference.digest}
              value={JSON.stringify(reference)}
              disabled={state !== "ready"}
            >
              {reference.name} · {reference.digest.slice(0, 8)}
              {state === "ready" ? "（使用前验证规划接点）" : "（不可用）"}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新策略列表
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2"
          disabled={busy || !catalog}
          onClick={() => void save(selected)}
        >
          {busy ? "正在验证…" : "验证并使用所选规划"}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2"
          disabled={busy || !catalog}
          onClick={() => void save("")}
        >
          撤回策略，使用原生规划
        </button>
      </div>
      {error && <p role="status">{error}</p>}
    </section>
  )
}
