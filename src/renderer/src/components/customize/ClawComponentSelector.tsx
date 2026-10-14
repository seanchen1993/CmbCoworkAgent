import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { FlowParameterEditor } from "./FlowParameterEditor"
import { parameterError, type ParameterDraft } from "@/lib/flow-parameter-form"
import type { ClawCapability } from "../../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { resolveClawComponents } from "../../../../shared/mods/claw-components"

export function ClawComponentSelector({
  source,
  value,
  disabled,
  onChange,
  onValidity,
  onDirty
}: {
  source: FunctionPluginStatus
  value: ClawCapability
  disabled: boolean
  onChange(value: ClawCapability): void
  onValidity(pluginId: string, valid: boolean): void
  onDirty?(pluginId: string, dirty: boolean): void
}) {
  const [drafts, setDrafts] = useState<Record<string, ParameterDraft>>({})
  const entries = source.components ?? []
  const selection = value.components ?? { mode: "all" as const, ids: [], config: {} }
  const selected = new Set(
    selection.mode === "all" ? entries.map((entry) => entry.id) : selection.ids
  )
  let error = ""
  try {
    if (source.digest !== value.digest) throw Error("来源版本已改变，请重新选择并核对组件配置。")
    resolveClawComponents(entries, value.components)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const invalid = Boolean(
    error ||
    entries.some(
      (entry) =>
        selected.has(entry.id) &&
        parameterError(selection.config[entry.id] ?? {}, entry.configSchema, drafts[entry.id])
    )
  )
  useEffect(() => onValidity(value.pluginId, !invalid), [invalid, onValidity, value.pluginId])
  const dirty = Object.values(drafts).some((draft) => draft.dirty)
  useEffect(() => onDirty?.(value.pluginId, dirty), [dirty, onDirty, value.pluginId])
  const updateIds = (ids: string[]) => {
    const removed = Object.keys(drafts).filter((id) => !ids.includes(id) && drafts[id]?.dirty)
    if (removed.length && !window.confirm("移除组件会丢弃它的未保存参数草稿，继续吗？")) return
    setDrafts((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => ids.includes(id)))
    )
    onChange({
      ...value,
      components: {
        mode: "selected",
        ids,
        config: Object.fromEntries(
          Object.entries(selection.config).filter(([id]) => ids.includes(id))
        )
      }
    })
  }
  const addDependencies = () => {
    const ids = new Set(selected)
    const add = (id: string) => {
      for (const dependency of entries.find((entry) => entry.id === id)?.dependsOn ?? []) {
        if (ids.has(dependency)) continue
        ids.add(dependency)
        add(dependency)
      }
    }
    for (const id of selected) add(id)
    updateIds(entries.filter((entry) => ids.has(entry.id)).map((entry) => entry.id))
  }
  return (
    <fieldset
      disabled={disabled || source.digest !== value.digest}
      className="min-w-0 space-y-3 rounded-xl border bg-muted/20 p-3"
      data-claw-components={value.pluginId}
    >
      <legend className="px-1 text-sm font-medium">{source.name} · 可选功能</legend>
      <p className="text-xs text-muted-foreground">
        选择要用的功能。缺少配套功能时，可点击“加入所需依赖”补齐。各功能共用插件权限；有必需检查时请选“全部功能”。
      </p>
      <label className="grid gap-1 text-xs">
        启用范围
        <select
          aria-label={`组件范围 ${source.name}`}
          className="rounded-lg border bg-background p-2 text-sm"
          value={selection.mode}
          onChange={(event) => {
            if (event.target.value === "all")
              onChange({ ...value, components: { ...selection, mode: "all", ids: [] } })
            else updateIds(entries.map((entry) => entry.id))
          }}
        >
          <option value="all">全部功能</option>
          <option value="selected">选择部分功能</option>
        </select>
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error === "CLAW_COMPONENT_DEPENDENCY_REQUIRED"
            ? "还缺少配套功能，请点击“加入所需依赖”后保存。"
            : error === "CLAW_COMPONENT_SELECTION_EMPTY"
              ? "请至少选择一个功能，或从组合中移除这个插件。"
              : error}
        </p>
      )}
      {error === "CLAW_COMPONENT_DEPENDENCY_REQUIRED" && (
        <Button type="button" size="sm" variant="outline" onClick={addDependencies}>
          加入所需依赖
        </Button>
      )}
      {selection.ids
        .filter((id) => !entries.some((entry) => entry.id === id))
        .map((id) => (
          <div key={id} className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span>组件 {id} 已移除，请明确决定是否从组合移除。</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => updateIds(selection.ids.filter((entry) => entry !== id))}
            >
              移除失效组件 {id}
            </Button>
          </div>
        ))}
      {entries.map((entry) => (
        <div
          key={entry.id}
          data-claw-component={entry.id}
          className="min-w-0 space-y-2 rounded-lg border bg-background/50 p-3"
        >
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              aria-label={`选择组件 ${source.name} · ${entry.name}`}
              checked={selected.has(entry.id)}
              disabled={selection.mode === "all"}
              onChange={(event) =>
                updateIds(
                  event.target.checked
                    ? [...selected, entry.id]
                    : [...selected].filter((id) => id !== entry.id)
                )
              }
            />
            <span className="min-w-0 break-words">
              <strong>{entry.name}</strong>
              {entry.description && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {entry.description}
                </span>
              )}
            </span>
          </label>
          {!!entry.dependsOn.length && (
            <p className="text-xs text-muted-foreground">
              依赖：
              {entry.dependsOn
                .map((id) => entries.find((candidate) => candidate.id === id)?.name ?? id)
                .join("、")}
            </p>
          )}
          {selected.has(entry.id) && (entry.configSchema || selection.config[entry.id]) && (
            <FlowParameterEditor
              title={`组件配置 ${source.name} · ${entry.name}`}
              value={selection.config[entry.id] ?? {}}
              schema={source.digest === value.digest ? entry.configSchema : undefined}
              sourceMissing={source.digest !== value.digest}
              draft={drafts[entry.id]}
              onDraftChange={(next) => setDrafts((previous) => ({ ...previous, [entry.id]: next }))}
              onChange={(config) =>
                onChange({
                  ...value,
                  components: { ...selection, config: { ...selection.config, [entry.id]: config } }
                })
              }
            />
          )}
        </div>
      ))}
    </fieldset>
  )
}
