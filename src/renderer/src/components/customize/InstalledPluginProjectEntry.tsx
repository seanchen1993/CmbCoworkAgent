import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { captureConfigurationScope } from "@/lib/configuration-target"
import {
  dismissDerivedProject,
  openDerivedProject,
  useDerivedProjectIntent
} from "@/lib/derived-project-intent"
import { useFeatureGate } from "@/lib/feature-gates"
import { useAppStore } from "@/lib/store"
import {
  readInstalledPluginProjectEntry,
  type InstalledPluginProjectEntry as Entry
} from "@/lib/installed-plugin-project-entry"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { PluginDerivationScope } from "../../../../shared/plugin-derivation"

export function InstalledPluginProjectEntry(props: {
  pluginId: string
  scope: PluginDerivationScope
  active: boolean
  disabled?: boolean
  refreshKey?: boolean
}) {
  const projectMode = useFeatureGate(FEATURE_GATES.projectMode)
  const pluginVersion = useAppStore((state) => state.pluginVersion)
  const pendingIntent = useDerivedProjectIntent()
  const pending = useRef(pendingIntent)
  pending.current = pendingIntent
  const scopeKey = JSON.stringify([props.pluginId, props.scope, props.active, projectMode.enabled])
  const currentKey = useRef(scopeKey)
  currentKey.current = scopeKey
  const generation = useRef(0)
  const mounted = useRef(false)
  const busy = useRef<number | null>(null)
  const [entry, setEntry] = useState<Entry | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  const read = (token: number) => {
    const sameScope = captureConfigurationScope({
      threadId: props.scope.threadId,
      workspace: props.scope.expectedWorkspace
    })
    return readInstalledPluginProjectEntry(
      props.pluginId,
      {
        plugins: () => window.api.plugins.list(),
        templates: () => window.api.harnessBoard.localProjects.templates()
      },
      () =>
        mounted.current &&
        currentKey.current === scopeKey &&
        generation.current === token &&
        sameScope()
    )
  }
  useEffect(() => {
    const token = ++generation.current
    busy.current = null
    setEntry(null)
    setError("")
    if (!props.active || !projectMode.enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    void read(token)
      .then((value) => {
        if (generation.current === token && mounted.current) setEntry(value)
      })
      .catch(() => {
        if (generation.current === token && mounted.current)
          setError("暂时无法确认项目入口，请重新检查。")
      })
      .finally(() => {
        if (generation.current === token && mounted.current) setLoading(false)
      })
    return () => {
      generation.current++
    }
    // Every input that can change the installed route invalidates pending discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, pluginVersion, props.refreshKey, refresh])
  const open = async () => {
    if (busy.current !== null || props.disabled || !props.active || !projectMode.enabled) return
    const token = ++generation.current
    busy.current = token
    setLoading(true)
    setError("")
    try {
      const actual = await read(token)
      if (!mounted.current || generation.current !== token || currentKey.current !== scopeKey)
        return
      setEntry(actual)
      if (actual.kind === "unavailable") return
      if (actual.kind === "legacy") openDerivedProject(actual.pluginId, actual.name, props.scope)
      else {
        if (pending.current) dismissDerivedProject(pending.current.id)
        toast.info(`在“本地项目任务”点击“新建本地任务”，选择“${actual.name}”即可。`)
        useAppStore.getState().setShowCustomizeView(false)
        useAppStore.getState().setShowHarnessBoardView(true)
      }
    } catch {
      if (mounted.current && generation.current === token)
        setError("项目入口已变化或暂不可用，请重新检查。")
    } finally {
      if (busy.current === token) busy.current = null
      if (mounted.current && generation.current === token) setLoading(false)
    }
  }
  if (!props.active) return null
  if (!projectMode.loading && !projectMode.enabled)
    return <p className="text-sm">插件已保存。当前应用暂未开放项目模式。</p>
  return (
    <div className="space-y-2 text-sm" aria-label="已安装插件项目入口">
      {entry && entry.kind !== "unavailable" && (
        <Button
          disabled={loading || props.disabled || projectMode.loading}
          onClick={() => void open()}
        >
          {entry.kind === "host" ? "打开本地项目任务" : "新建项目"}
        </Button>
      )}
      {entry?.kind === "host" && (
        <p className="text-muted-foreground">进入后点击“新建本地任务”，选择“{entry.name}”。</p>
      )}
      {loading && <p role="status">正在确认已安装插件的项目入口…</p>}
      {entry?.kind === "unavailable" && <p role="status">{entry.reason}</p>}
      {error && <p role="alert">{error}</p>}
      {(error || entry?.kind === "unavailable") && (
        <Button
          variant="outline"
          disabled={loading || props.disabled}
          onClick={() => setRefresh((value) => value + 1)}
        >
          重新检查项目入口
        </Button>
      )}
    </div>
  )
}
