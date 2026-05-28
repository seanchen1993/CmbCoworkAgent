import React, { useEffect, useRef } from "react"
import { Package2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SkillMetadata } from "@/types"
import type { PopoverMode } from "./useSlashCommands"

interface Props {
  mode: PopoverMode
  selectedIdx: number
  onHoverIdx: (idx: number) => void
  onSelectSkill: (s: SkillMetadata) => void
  /** First-load flag — distinguishes "skills still loading" from "no matches". */
  skillsLoading?: boolean
}

function SourceBadge({ source }: { source: SkillMetadata["source"] }): React.ReactElement {
  const label = source === "project" ? "系统" : "个人"
  return <span className="text-xs text-muted-foreground/60 shrink-0">{label}</span>
}

function PluginBadge(): React.ReactElement {
  return (
    <span className="shrink-0 rounded-sm border border-sky-200 bg-sky-50 px-1 py-px text-[9px] font-medium leading-3 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
      Plugin
    </span>
  )
}

export function SlashCommandPopover({
  mode,
  selectedIdx,
  onHoverIdx,
  onSelectSkill,
  skillsLoading = false
}: Props): React.ReactElement | null {
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  // Depending only on the discriminator + selectedIdx (not the whole `mode`)
  // avoids re-scrolling on every filter keystroke.
  const modeKind = mode.kind

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIdx, modeKind])

  if (mode.kind === "closed") return null

  return (
    <div
      role="listbox"
      className={cn(
        "absolute left-0 right-0 bottom-full mb-2 z-20",
        "rounded-2xl border border-border bg-popover shadow-lg",
        "max-h-80 overflow-y-auto"
      )}
    >
      <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground/70">技能</div>
      {mode.skills.length === 0 ? (
        <div className="px-4 py-4 text-sm text-muted-foreground">
          {skillsLoading ? "加载中…" : "没有匹配的技能"}
        </div>
      ) : (
        <div className="py-1">
          {mode.skills.map((s, idx) => {
            const isSelected = idx === selectedIdx
            const isPluginSkill = Boolean(s.pluginName || s.pluginId)
            return (
              <button
                key={s.path}
                ref={isSelected ? selectedRef : null}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onHoverIdx(idx)}
                onClick={() => onSelectSkill(s)}
                className={cn(
                  "w-full text-left px-4 py-2 flex items-center gap-3 transition-colors",
                  isSelected ? "bg-muted" : "hover:bg-muted/60"
                )}
              >
                <Package2 className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium text-foreground shrink-0">{s.name}</span>
                <span className="text-sm text-muted-foreground truncate flex-1">
                  {s.description}
                </span>
                {isPluginSkill && <PluginBadge />}
                <SourceBadge source={s.source} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
