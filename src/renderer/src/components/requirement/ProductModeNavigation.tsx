import { cn } from "@/lib/utils"
import { Check, ChevronDown, Search, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useRequirementStore } from "./requirement-store"
import { REQUIREMENT_QUICK_START_EVENT } from "./RequirementQuickStartDialog"
import {
  getRequirementPersonaWelcome,
  readStoredRequirementPersona,
  REQUIREMENT_PERSONA_CHANGED_EVENT
} from "./requirement-persona"

export function ProductModeNavigation({
  activeTab,
  onTabChange
}: {
  activeTab: "requirements" | "design"
  onTabChange: (tab: "requirements" | "design") => void
}): React.JSX.Element {
  const listSystemFilterId = useRequirementStore((state) => state.listSystemFilterId)
  const requirementSystemOptions = useRequirementStore((state) => state.requirementSystemOptions)
  const setListSystemFilterId = useRequirementStore((state) => state.setListSystemFilterId)
  const [systemSelectOpen, setSystemSelectOpen] = useState(false)
  const [systemQuery, setSystemQuery] = useState("")
  const [personaWelcome, setPersonaWelcome] = useState(() =>
    getRequirementPersonaWelcome(readStoredRequirementPersona())
  )

  useEffect(() => {
    const updateWelcome = (): void => {
      setPersonaWelcome(getRequirementPersonaWelcome(readStoredRequirementPersona()))
    }
    window.addEventListener(REQUIREMENT_PERSONA_CHANGED_EVENT, updateWelcome)
    return () => window.removeEventListener(REQUIREMENT_PERSONA_CHANGED_EVENT, updateWelcome)
  }, [])

  useEffect(() => {
    if (activeTab === "requirements") setListSystemFilterId(null)
  }, [activeTab, setListSystemFilterId])

  const selectedSystemName =
    requirementSystemOptions.find((system) => system.id === listSystemFilterId)?.name ?? "全部系统"
  const normalizedSystemQuery = systemQuery.trim().toLocaleLowerCase()
  const filteredSystemOptions = requirementSystemOptions.filter((system) =>
    system.name.toLocaleLowerCase().includes(normalizedSystemQuery)
  )

  const selectSystem = (systemId: string | null): void => {
    setListSystemFilterId(systemId)
    setSystemSelectOpen(false)
    setSystemQuery("")
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-3 lg:px-7">
      <div className="flex h-8 items-stretch gap-5 border-b border-border/70">
        {[
          { value: "requirements" as const, label: "需求特性" },
          { value: "design" as const, label: "原型设计" }
        ].map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={activeTab === tab.value}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "relative -mb-px flex h-8 items-center border-b-2 px-0.5 text-xs font-semibold transition-colors",
              activeTab === tab.value
                ? "border-[#c99366] text-[#b97843]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "requirements" && (
        <Popover
          open={systemSelectOpen}
          onOpenChange={(open) => {
            setSystemSelectOpen(open)
            if (!open) setSystemQuery("")
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              role="combobox"
              aria-expanded={systemSelectOpen}
              aria-controls="requirement-system-options"
              aria-label="需求列表系统筛选"
              className="ml-4 flex h-8 min-w-[116px] items-center justify-between gap-2 rounded-md border border-border bg-background-elevated px-2.5 text-xs font-medium shadow-none transition-colors hover:border-[#c99366] focus:border-[#c99366] focus:outline-none"
            >
              <span className="max-w-[180px] truncate">{selectedSystemName}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[240px] p-1.5">
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                type="search"
                value={systemQuery}
                onChange={(event) => setSystemQuery(event.target.value)}
                placeholder="搜索系统"
                aria-label="搜索需求系统"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-xs outline-none focus:border-[#c99366]"
              />
            </div>
            <div
              id="requirement-system-options"
              role="listbox"
              className="max-h-64 overflow-y-auto"
            >
              {!normalizedSystemQuery && (
                <SystemOption
                  label="全部系统"
                  selected={listSystemFilterId === null}
                  onSelect={() => selectSystem(null)}
                />
              )}
              {filteredSystemOptions.map((system) => (
                <SystemOption
                  key={system.id}
                  label={system.name}
                  selected={listSystemFilterId === system.id}
                  onSelect={() => selectSystem(system.id)}
                />
              ))}
              {filteredSystemOptions.length === 0 && normalizedSystemQuery && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  没有匹配的系统
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {activeTab === "requirements" ? (
        <div className="ml-auto flex items-center gap-3">
          {personaWelcome ? (
            <span className="text-xs font-medium text-muted-foreground">{personaWelcome}</span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.dispatchEvent(new Event(REQUIREMENT_QUICK_START_EVENT))}
            className="group h-8 rounded-lg border-[#e4c8ad] bg-[#fdf8f3] px-3.5 text-xs text-[#a96736] shadow-sm hover:border-[#c99366] hover:bg-[#f8eee4] hover:text-[#92562b]"
          >
            <Sparkles className="requirement-quick-start-icon size-3.5" />
            快速开始一个新任务
          </Button>
        </div>
      ) : null}
    </div>
  )
}
function SystemOption({
  label,
  selected,
  onSelect
}: {
  label: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus:bg-accent"
    >
      <span className="truncate">{label}</span>
      {selected ? <Check className="size-3.5 shrink-0" /> : null}
    </button>
  )
}

import { useEffect, useState } from "react"
