import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { openPluginSettings } from "@/lib/plugin-settings-intent"
import { openDerivedProject } from "@/lib/derived-project-intent"
import { useAppStore } from "@/lib/store"
import {
  nativePluginCapabilities,
  type NativePluginCapability
} from "@/lib/native-plugin-capabilities"
import { NativeNodeComposer } from "./NativeNodeComposer"
import { NativePluginCompatibility } from "./NativePluginCompatibility"

export function NativePluginCapabilities({
  threadId,
  workspace,
  functionPluginIds,
  onAssemble
}: {
  threadId: string
  workspace: string
  functionPluginIds: string[]
  onAssemble?: (pluginId: string) => void
}) {
  const pluginVersion = useAppStore((state) => state.pluginVersion)
  const [rows, setRows] = useState<NativePluginCapability[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const sequence = useRef(0)
  const identities = JSON.stringify([...functionPluginIds].sort())
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setBusy(true)
    setError("")
    try {
      const [plugins, skills] = await Promise.all([
        window.api.plugins.list(),
        window.api.skills.listPlugins()
      ])
      if (sequence.current !== request) return
      const next = nativePluginCapabilities(plugins, skills, JSON.parse(identities))
      setRows(next)
      setSelected((id) =>
        next.some((row) => row.pluginId === id && row.enabled && row.projectMode) ? id : null
      )
    } catch (cause) {
      if (sequence.current === request) {
        setRows([])
        setSelected(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (sequence.current === request) setBusy(false)
    }
  }, [identities])
  useEffect(() => {
    const requests = sequence
    void refresh()
    return () => {
      requests.current++
    }
  }, [refresh, pluginVersion])
  return (
    <section aria-label="已安装的原生插件" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">AutoBiz 和其他已安装插件</h3>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          刷新插件目录
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        项目流程用于一次需求；业务 Mods 用于制作新插件。聊天搭配的功能和工具在下方选择，项目步骤不会作为聊天动作显示。
      </p>
      {busy && (
        <p role="status" className="text-sm">
          正在读取插件目录…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          插件目录读取失败：{error}。请重试刷新。
        </p>
      )}
      {!busy && !error && !rows.length && (
        <p className="text-sm text-muted-foreground">
          还没有这类插件。可直接搭配的小功能列在下方。
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <article
            key={row.pluginId}
            aria-label={row.name}
            className="min-w-0 space-y-2 rounded-lg border p-3 text-sm"
          >
            <h4 className="break-words font-medium">{row.name}</h4>
            <p>
              {row.enabled ? "已启用" : "已停用"} · {row.projectMode ? "项目插件" : "技能与工具"} ·
              版本 {row.version}
            </p>
            {row.hasFunctionCapabilities && (
              <p className="text-muted-foreground">此插件另有功能扩展，可在下方核对适用范围和权限。</p>
            )}
            {(row.businessModCount > 0 || row.businessExtensionCount > 0) && (
              <p className="text-muted-foreground">
                可供组装：{row.businessModCount} 个业务 Mod · {row.businessExtensionCount} 个常驻扩展
              </p>
            )}
            <p>
              {row.enabled
                ? `${row.skills.length} 项技能`
                : `上次安装包含 ${row.installedSkillCount} 项技能`}
            </p>
            {row.projectMode && (
              <p className="text-muted-foreground">
                选择使用此版本的项目，原有检查和人工确认会保留。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* Native entry eligibility is separate from project Skill isolation. */}
              {row.projectMode && (
                <Button
                  size="sm"
                  disabled={busy || !row.enabled}
                  onClick={() => setSelected(row.pluginId)}
                >
                  查看项目流程
                </Button>
              )}
              {row.projectMode && (
                <Button size="sm" variant="outline" disabled={busy || !row.enabled}
                  onClick={() => openDerivedProject(row.pluginId, row.name,
                    { threadId, expectedWorkspace: workspace })}>
                  新建此插件项目
                </Button>
              )}
              {onAssemble && (row.businessModCount > 0 || row.businessExtensionCount > 0) && (
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => onAssemble(row.pluginId)}>
                  用这些 Mods 组装新插件
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => openPluginSettings(row.pluginId)}
              >
                {row.enabled ? "管理插件" : "管理并启用插件"}
              </Button>
            </div>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer text-sm">查看插件内容</summary>
              <div className="mt-2 space-y-2">
                {row.description && <p className="break-words">{row.description}</p>}
                {row.enabled ? (
                  row.skills.length ? (
                    <ul className="list-inside list-disc break-words">
                      {row.skills.map((skill) => (
                        <li key={skill.id}>{skill.name}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>未发现可用技能。可在“管理插件”中查看配置。</p>
                  )
                ) : (
                  <p>启用后可查看最新技能列表。</p>
                )}
              </div>
            </details>
            <NativePluginCompatibility threadId={threadId} workspace={workspace}
              pluginId={row.pluginId} version={row.version} enabled={row.enabled}
              revision={pluginVersion} active={!busy} />
          </article>
        ))}
      </div>
      {selected && !busy && (
        <NativeNodeComposer
          key={selected}
          threadId={threadId}
          workspace={workspace}
          pluginId={selected}
          initialOpen
        />
      )}
    </section>
  )
}
