import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { ALL_REQUIREMENT_SYSTEMS_VALUE, useRequirementStore } from "./requirement-store"

type RequirementBreadcrumbItem = {
  label: string
  onClick?: () => void
}

function RequirementControls(): React.JSX.Element {
  const systemList = useRequirementStore((state) => state.systemList)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)
  const setSelectedSystemId = useRequirementStore((state) => state.setSelectedSystemId)

  return (
    <div className="flex h-8 items-center gap-1.5">
      <label
        htmlFor="requirement-system-select"
        className="whitespace-nowrap text-[12px] font-semibold text-[#756a5f]"
      >
        需求系统
      </label>
      <Select
        value={selectedSystemId ?? ALL_REQUIREMENT_SYSTEMS_VALUE}
        onValueChange={(value) =>
          setSelectedSystemId(value === ALL_REQUIREMENT_SYSTEMS_VALUE ? null : value)
        }
      >
        <SelectTrigger
          id="requirement-system-select"
          className="h-8 w-[132px] rounded-[7px] border-[#e3d9ce] bg-white px-2.5 text-[12px] font-semibold text-[#5d554d] shadow-none"
        >
          <SelectValue placeholder="全部" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_REQUIREMENT_SYSTEMS_VALUE} className="text-sm">
            全部
          </SelectItem>
          {systemList.map((system) => (
            <SelectItem key={system.id} value={system.id} className="text-sm">
              {system.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function RequirementBreadcrumbHeader({
  items,
  ariaLabel = "需求页面路径",
  showRequirementControls = false
}: {
  items: RequirementBreadcrumbItem[]
  ariaLabel?: string
  showRequirementControls?: boolean
}): React.JSX.Element {
  return (
    <header className="flex min-h-[52px] shrink-0 items-center border-b border-[#dcd2c6] bg-[#fdfbf8] px-6 shadow-[0_2px_8px_rgba(77,56,38,0.035)] lg:px-8">
      <nav
        aria-label={ariaLabel}
        className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground"
      >
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1
          const itemClassName = [
            "min-w-0 truncate rounded px-1.5 py-1 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            isCurrent
              ? "font-semibold text-foreground"
              : "font-semibold text-primary hover:bg-primary/5 hover:text-primary",
            item.onClick && !isCurrent ? "cursor-pointer" : ""
          ]
            .filter(Boolean)
            .join(" ")

          return (
            <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="shrink-0 text-[#cfc4b8]">
                  /
                </span>
              )}
              {item.onClick && !isCurrent ? (
                <button type="button" className={itemClassName} onClick={item.onClick}>
                  {item.label}
                </button>
              ) : (
                <span className={itemClassName}>{item.label}</span>
              )}
            </span>
          )
        })}
      </nav>
      {showRequirementControls ? (
        <div className="ml-4 flex shrink-0 items-center border-l border-[#dcd2c6] pl-4">
          <RequirementControls />
        </div>
      ) : null}
    </header>
  )
}
