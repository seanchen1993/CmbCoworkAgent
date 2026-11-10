import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ALL_REQUIREMENT_SYSTEMS_VALUE, useRequirementStore } from "./requirement-store"
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
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)
  const systemList = useRequirementStore((state) => state.systemList)
  const setSelectedSystemId = useRequirementStore((state) => state.setSelectedSystemId)
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
        <Select
          value={selectedSystemId ?? ALL_REQUIREMENT_SYSTEMS_VALUE}
          onValueChange={(value) =>
            setSelectedSystemId(value === ALL_REQUIREMENT_SYSTEMS_VALUE ? null : value)
          }
        >
          <SelectTrigger
            aria-label="需求列表系统筛选"
            className="h-8 w-auto ml-4 min-w-[116px] rounded-md border border-border bg-background-elevated px-2.5 text-xs font-medium shadow-none transition-colors hover:border-[#c99366] focus:border-[#c99366] focus:ring-0"
          >
            <SelectValue placeholder="全部系统" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_REQUIREMENT_SYSTEMS_VALUE}>全部系统</SelectItem>
            {systemList.map((system) => (
              <SelectItem key={system.id} value={system.id}>
                {system.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            className="h-8 rounded-lg border-[#e4c8ad] bg-[#fdf8f3] px-3.5 text-xs text-[#a96736] shadow-sm hover:border-[#c99366] hover:bg-[#f8eee4] hover:text-[#92562b]"
          >
            <Sparkles className="size-3.5" />
            快速开始一个新任务
          </Button>
        </div>
      ) : null}
    </div>
  )
}
import { useEffect, useState } from "react"
