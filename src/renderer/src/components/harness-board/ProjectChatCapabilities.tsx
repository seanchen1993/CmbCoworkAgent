import { useEffect, useRef, useState } from "react"
import type { ProjectCompositionSource } from "../../../../shared/project-runtime/composition"
import type {
  ProjectCapabilityProfile,
  ProjectCapabilityPreview,
  ProjectCompositionApi,
  ProjectCompositionCatalog,
  ProjectCompositionScope
} from "../../../../shared/project-runtime/composition-api"
import { compositionErrorText, compositionSourceKey } from "@/lib/project-composition-ui"
import { ProjectCompositionProblem } from "./ProjectCompositionProblem"

export function ProjectChatCapabilities({
  scope,
  api,
  catalog
}: {
  scope: ProjectCompositionScope
  api: ProjectCompositionApi
  catalog: ProjectCompositionCatalog
}) {
  const [profile, setProfile] = useState<ProjectCapabilityProfile | null>(null)
  const [sources, setSources] = useState<ProjectCompositionSource[]>([])
  const [preview, setPreview] = useState<ProjectCapabilityPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const alive = useRef(false)
  const lock = useRef(false)
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog
  const message = compositionErrorText
  useEffect(() => {
    alive.current = true
    void api
      .readCapabilities(scope)
      .then((next) => {
        if (!alive.current) return
        if (next.contextKey !== catalogRef.current.contextKey)
          throw Error("CAPABILITY_CONTEXT_CHANGED")
        setProfile(next)
        setSources(next.sources)
      })
      .catch((cause) => {
        if (alive.current) setError(message(cause))
      })
    return () => {
      alive.current = false
    }
    // Mounted inside the parent editor keyed by project/thread/workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])
  useEffect(() => {
    setPreview(null)
  }, [catalog.revision, catalog.contextKey])
  const mutate = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  const entries = catalog.entries.filter((entry) => entry.kind === "capability")
  const find = (source: ProjectCompositionSource) =>
    entries.find((entry) => compositionSourceKey(entry.source) === compositionSourceKey(source))
  const label = (source: ProjectCompositionSource) => {
    const entry = find(source)
    return entry ? `${entry.title} · ${entry.sourceName}` : `已保存能力（${source.capabilityId}）`
  }
  const unavailable = sources.filter((source) => !find(source)?.available)
  const button = "rounded-md border px-3 py-2 text-sm disabled:opacity-50"
  return (
    <section aria-label="对话中使用" className="min-w-0 space-y-3 rounded-lg border p-3">
      <h3 className="font-medium">对话中使用</h3>
      <p className="text-sm text-muted-foreground">
        选择这个项目对话需要的独立能力，确认后生效。属于流程阶段的能力，请在下方选择完整流程。
      </p>
      {!profile && !error && <p role="status">正在读取已应用能力…</p>}
      {entries.map((entry) => {
        const selected = sources.some(
          (source) => compositionSourceKey(source) === compositionSourceKey(entry.source)
        )
        return (
          <div
            key={compositionSourceKey(entry.source)}
            className="flex min-w-0 items-start gap-2 rounded-md border p-2 text-sm"
          >
            <input
              id={`project-capability-${encodeURIComponent(compositionSourceKey(entry.source))}`}
              type="checkbox"
              className="mt-1"
              aria-label={`在对话中使用 ${entry.title} · ${entry.sourceName}`}
              checked={selected}
              disabled={busy || !profile || (!entry.available && !selected)}
              onChange={(event) => {
                setSources(
                  event.target.checked
                    ? [...sources, entry.source]
                    : sources.filter(
                        (source) =>
                          compositionSourceKey(source) !== compositionSourceKey(entry.source)
                      )
                )
                setPreview(null)
                setNotice("")
              }}
            />
            <div className="min-w-0 break-words">
              <label
                htmlFor={`project-capability-${encodeURIComponent(compositionSourceKey(entry.source))}`}
              >
                {entry.title} · {entry.sourceName}
              </label>
              {!entry.available && (
                <ProjectCompositionProblem
                  value={entry.reasons.join("；") || "暂未通过宿主验证"}
                  className="text-xs text-muted-foreground"
                />
              )}
            </div>
          </div>
        )
      })}
      {!entries.length && <p className="text-sm">暂无可在项目对话中使用的独立能力。</p>}
      {unavailable.map((source) => (
        <div key={compositionSourceKey(source)} className="space-y-1 text-sm">
          <p className="break-words">{label(source)}：来源已变化或暂不可用，原选择已保留。</p>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setSources(
                sources.filter(
                  (item) => compositionSourceKey(item) !== compositionSourceKey(source)
                )
              )
              setPreview(null)
            }}
          >
            移除不可用选择
          </button>
        </div>
      ))}
      {error && (
        <ProjectCompositionProblem
          role="alert"
          value={error}
          className="break-words text-sm text-destructive"
        />
      )}
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      )}
      <button
        type="button"
        className={button}
        disabled={busy || !profile || !!unavailable.length}
        onClick={() =>
          void mutate(async () => {
            const snapshot = catalogRef.current
            const next = await api.previewCapabilities({
              scope,
              catalogRevision: snapshot.revision,
              sources
            })
            if (!alive.current) return
            if (
              catalogRef.current.revision !== snapshot.revision ||
              next.contextKey !== catalogRef.current.contextKey
            )
              throw Error("CAPABILITY_CONTEXT_CHANGED")
            setPreview(next)
          })
        }
      >
        预览对话能力
      </button>
      {preview && (
        <section aria-label="对话能力预览" className="space-y-2 rounded-md border p-3">
          <h4 className="font-medium">确认应用到当前项目对话</h4>
          {!preview.sources.length && <p className="text-sm">移除当前对话的项目能力组合。</p>}
          <ul className="text-sm">
            {preview.sources.map((source) => (
              <li key={compositionSourceKey(source)} className="break-words">
                {label(source)}
                {preview.addedSources.some(
                  (added) => compositionSourceKey(added) === compositionSourceKey(source)
                ) && "（自动补齐的必要能力）"}
              </li>
            ))}
          </ul>
          {preview.issues.map((issue) => (
            <ProjectCompositionProblem role="alert" key={issue} value={issue} />
          ))}
          <button
            type="button"
            className={button}
            disabled={busy || !!preview.issues.length || !profile}
            onClick={() =>
              void mutate(async () => {
                const next = await api.applyCapabilities({
                  scope,
                  previewId: preview.id,
                  expectedRevision: profile!.revision
                })
                if (!alive.current) return
                if (next.contextKey !== catalogRef.current.contextKey)
                  throw Error("CAPABILITY_CONTEXT_CHANGED")
                setProfile(next)
                setSources(next.sources)
                setPreview(null)
                setNotice("项目对话能力已应用。后续消息将使用已确认的能力配置。")
              })
            }
          >
            确认应用对话能力
          </button>
        </section>
      )}
    </section>
  )
}
