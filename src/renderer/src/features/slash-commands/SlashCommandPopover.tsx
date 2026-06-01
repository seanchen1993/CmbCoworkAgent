import React, { useEffect, useMemo, useRef } from "react"
import { Flag, Package2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeSkillId } from "@/lib/skill-ids"
import type { SkillMetadata } from "@/types"
import type { PopoverMode, SlashCommandItem } from "./useSlashCommands"
import {
  computeDuplicateSkillNames,
  getDisambiguationLabel,
  getSourceLabel
} from "./skill-display-label"

interface Props {
  mode: PopoverMode
  selectedIdx: number
  onHoverIdx: (idx: number) => void
  onSelectCommand: (command: SlashCommandItem) => void
  onSelectSkill: (s: SkillMetadata) => void
  /** First-load flag — distinguishes "skills still loading" from "no matches". */
  skillsLoading?: boolean
}

function SourceBadge({ skill }: { skill: SkillMetadata }): React.ReactElement {
  const label = getSourceLabel(skill)
  return (
    <span
      className="text-xs text-muted-foreground/60 shrink-0 max-w-[10rem] truncate"
      title={label}
    >
      {label}
    </span>
  )
}

export function SlashCommandPopover({
  mode,
  selectedIdx,
  onHoverIdx,
  onSelectCommand,
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

  // Names that appear more than once in the current filtered list — those rows
  // get an extra disambiguation subline. Depend on the skills array (and only
  // the array) so unrelated `mode` re-creations don't re-run the scan.
  const skillsForDup = mode.kind === "slash" ? mode.skills : null
  const duplicateNames = useMemo<ReadonlySet<string>>(
    () => (skillsForDup ? computeDuplicateSkillNames(skillsForDup) : new Set<string>()),
    [skillsForDup]
  )

  if (mode.kind === "closed") return null

  const commandCount = mode.commands.length
  const shouldShowSkillsSection = mode.skills.length > 0 || skillsLoading || commandCount === 0

  return (
    <div
      role="listbox"
      className={cn(
        "absolute left-0 right-0 bottom-full mb-2 z-20",
        "rounded-2xl border border-border bg-popover shadow-lg",
        "max-h-80 overflow-y-auto"
      )}
    >
      {commandCount > 0 && (
        <>
          <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground/70">功能</div>
          <div className="py-1">
            {mode.commands.map((command, idx) => {
              const isSelected = idx === selectedIdx
              return (
                <button
                  key={command.id}
                  ref={isSelected ? selectedRef : null}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => onHoverIdx(idx)}
                  onClick={() => onSelectCommand(command)}
                  className={cn(
                    "w-full text-left px-4 py-2 flex items-center gap-3 transition-colors",
                    isSelected ? "bg-muted" : "hover:bg-muted/60"
                  )}
                >
                  <Flag className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground shrink-0">
                    {command.title}
                  </span>
                  <span className="text-sm text-muted-foreground truncate flex-1">
                    {command.description}
                  </span>
                  <span className="text-xs text-muted-foreground/60 shrink-0">
                    {command.usage ?? command.command}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}

      {shouldShowSkillsSection && (
        <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground/70">技能</div>
      )}
      {shouldShowSkillsSection && mode.skills.length === 0 ? (
        <div className="px-4 py-4 text-sm text-muted-foreground">
          {skillsLoading ? "加载中…" : "没有匹配的命令或技能"}
        </div>
      ) : mode.skills.length > 0 ? (
        <div className="py-1">
          {mode.skills.map((s, idx) => {
            const itemIdx = commandCount + idx
            const isSelected = itemIdx === selectedIdx
            const isDuplicate = duplicateNames.has(normalizeSkillId(s.name))
            const subline = isDuplicate ? getDisambiguationLabel(s) : null
            return (
              <button
                key={s.path}
                ref={isSelected ? selectedRef : null}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => onHoverIdx(itemIdx)}
                onClick={() => onSelectSkill(s)}
                className={cn(
                  "w-full text-left px-4 py-2 flex items-start gap-3 transition-colors",
                  isSelected ? "bg-muted" : "hover:bg-muted/60"
                )}
              >
                <Package2 className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 flex flex-col">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-foreground shrink-0">
                      {s.name}
                    </span>
                    <span className="text-sm text-muted-foreground truncate flex-1">
                      {s.description}
                    </span>
                    <SourceBadge skill={s} />
                  </div>
                  {subline && (
                    <span
                      className="text-xs text-muted-foreground/70 truncate mt-0.5"
                      title={subline}
                    >
                      {subline}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
