import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { ALL_REQUIREMENT_SYSTEMS_VALUE, useRequirementStore } from "./requirement-store"

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
      <Select
        value={selectedSystemId ?? ALL_REQUIREMENT_SYSTEMS_VALUE}
        onValueChange={(value) =>
          setSelectedSystemId(value === ALL_REQUIREMENT_SYSTEMS_VALUE ? null : value)
        }
      >
        <SelectTrigger className="h-8 w-auto ml-4 min-w-[116px] rounded-md border border-border bg-background-elevated px-2.5 text-xs font-medium shadow-none transition-colors hover:border-[#c99366] focus:border-[#c99366] focus:ring-0">
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
    </div>
  )
}
