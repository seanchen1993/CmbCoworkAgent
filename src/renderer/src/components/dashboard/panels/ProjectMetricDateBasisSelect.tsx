import { Info } from "lucide-react"
import { Select, SelectValue } from "@/components/ui/select"
import {
  EfficiencySelectContent,
  EfficiencySelectItem,
  EfficiencySelectTrigger
} from "../EfficiencyFilterSelect"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ProjectMetricFilters } from "../../../../../shared/project-metrics"

export function ProjectMetricDateBasisSelect({
  value,
  onChange
}: {
  value: NonNullable<ProjectMetricFilters["dateBasis"]>
  onChange: (value: NonNullable<ProjectMetricFilters["dateBasis"]>) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              aria-label="查看日期筛选说明"
            >
              <Info className="size-3.5" />
              日期筛选
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[420px] text-xs leading-relaxed">
            {value === "created"
              ? "项目立项日期落在所选周期内。"
              : "开发完成日期落在所选周期内。开发完成日期定义：首次 ST 发起日期；没有 ST、但有 UAT 流程时，取首次 UAT 发起日期。"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Select value={value} onValueChange={onChange}>
        <EfficiencySelectTrigger aria-label="项目日期口径" className="w-40">
          <SelectValue />
        </EfficiencySelectTrigger>
        <EfficiencySelectContent>
          <EfficiencySelectItem value="developmentCompleted">开发完成日期</EfficiencySelectItem>
          <EfficiencySelectItem value="created">立项日期</EfficiencySelectItem>
        </EfficiencySelectContent>
      </Select>
    </div>
  )
}
