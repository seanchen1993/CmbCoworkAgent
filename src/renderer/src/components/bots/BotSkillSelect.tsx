import { useEffect, useId, useMemo, useState } from "react"
import { useAppStore } from "@/lib/store"
import {
  revalidateSkillCatalog,
  subscribeSkillCatalogInvalidation,
  type SkillCatalogSnapshot
} from "@/lib/app-catalog-cache"
import { isSkillDisabled } from "@/lib/skill-ids"

/** Names survive template export/import; installed sources and global enablement remain host-owned. */
export function BotSkillSelect({
  value,
  onChange,
  disabled,
  hostId
}: {
  value: string[] | null | undefined
  onChange(value: string[] | null): void
  disabled?: boolean
  hostId: string
}) {
  const id = useId()
  const selecting = value != null
  const pluginVersion = useAppStore((state) => state.pluginVersion)
  const [catalog, setCatalog] = useState<SkillCatalogSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  const [query, setQuery] = useState("")
  useEffect(() => subscribeSkillCatalogInvalidation(() => refresh((n) => n + 1)), [])
  useEffect(() => {
    if (hostId !== "local" || !selecting) return
    let current = true
    void revalidateSkillCatalog(pluginVersion).then(
      (snapshot) => {
        if (current) {
          setCatalog(snapshot)
          setError(null)
        }
      },
      () => {
        if (current) setError("技能列表加载失败，已保存的选择会保留。")
      }
    )
    return () => {
      current = false
    }
  }, [hostId, selecting, pluginVersion, revision])
  const options = useMemo(() => {
    const names = new Map<string, { available: boolean; description: string }>()
    for (const skill of catalog?.rightPanelSkills ?? []) {
      const available = !isSkillDisabled(skill, catalog!.disabledSkillIds)
      if (!names.get(skill.name)?.available)
        names.set(skill.name, { available, description: skill.description ?? "" })
    }
    for (const name of value ?? []) {
      if (!names.has(name)) names.set(name, { available: false, description: "" })
    }
    return [...names].sort(([a], [b]) => a.localeCompare(b))
  }, [catalog, value])
  const selected = new Set(value ?? [])
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">可用技能</legend>
      <label htmlFor={id} className="sr-only">
        技能范围
      </label>
      <select
        id={id}
        className="h-11 w-full rounded-xl border bg-background px-3 text-sm"
        disabled={hostId !== "local"}
        value={value == null ? "all" : "selected"}
        onChange={(event) => onChange(event.target.value === "all" ? null : [])}
      >
        <option value="all">全部已启用技能（默认）</option>
        <option value="selected">仅指定技能</option>
      </select>
      {value == null ? (
        <p className="text-xs text-muted-foreground">自动包含以后新增并启用的技能。</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            已选择 {value.length} 项；不选则不使用技能。保存后对后续任务生效。
          </p>
          {hostId !== "local" ? (
            <p className="text-xs text-muted-foreground">
              请在 Bot 所在主机管理技能。当前选择：{value.join("、") || "无"}
            </p>
          ) : (
            <>
              <input
                aria-label="搜索可用技能"
                placeholder="搜索技能名称"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
              />
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}{" "}
                  <button type="button" onClick={() => refresh((n) => n + 1)}>
                    重试
                  </button>
                </p>
              )}
              {!catalog && !error && (
                <p role="status" className="text-xs">
                  正在加载技能…
                </p>
              )}
              {catalog?.truncated && (
                <p role="status" className="text-xs text-muted-foreground">
                  技能列表不完整；未显示的已选项仍会保留。
                </p>
              )}
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
                {options
                  .filter(([name]) => name.toLowerCase().includes(query.trim().toLowerCase()))
                  .map(([name, skill]) => (
                    <label key={name} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(name)}
                        disabled={!skill.available && !selected.has(name)}
                        onChange={(event) =>
                          onChange(
                            event.target.checked
                              ? [...(value ?? []), name]
                              : value.filter((item) => item !== name)
                          )
                        }
                      />
                      <span className="min-w-0 break-words">
                        {name}
                        {!skill.available && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            （未安装或已禁用）
                          </span>
                        )}
                        {skill.description && (
                          <span className="block text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                {catalog && !options.length && (
                  <p className="text-xs text-muted-foreground">当前主机没有可选技能。</p>
                )}
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            按技能名称选择，同名来源沿用现有优先级；未安装或已禁用的技能不会自动启用。
          </p>
        </>
      )}
    </fieldset>
  )
}
