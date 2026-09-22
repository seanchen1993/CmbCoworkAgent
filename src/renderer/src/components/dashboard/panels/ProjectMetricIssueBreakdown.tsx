import type {
  ProjectMetricIssueCategoryCount,
  ProjectMetricSummaryGroup
} from "../../../../../shared/project-metrics"

export const PROJECT_METRIC_TOOLTIP_CLASS =
  "rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"

export function ProjectMetricIssueBreakdown({
  groups
}: {
  groups: ProjectMetricSummaryGroup[]
}): React.JSX.Element {
  const categories = Array.from(
    new Set(groups.flatMap((group) => group.kenanIssueCategories.map((item) => item.category)))
  ).sort((left, right) => left.localeCompare(right, "zh-CN"))

  if (categories.length === 0) {
    return <div className="text-[11px] text-muted-foreground">无非功能问题类别</div>
  }

  return (
    <div className="max-h-56 overflow-y-auto overscroll-contain">
      <table className="text-[11px]">
        <thead className="sticky top-0 bg-popover">
          <tr>
            <th className="whitespace-nowrap pb-2 pr-3 text-left font-medium">
              非功能问题细分类别
            </th>
            {groups.map((group) => (
              <th
                key={group.developmentMode}
                className="whitespace-nowrap pb-2 pl-3 text-right font-medium"
              >
                {group.developmentMode === "devclaw" ? "CMBDevClaw" : "非 CMBDevClaw"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category}>
              <td className="py-1 pr-3">{category}</td>
              {groups.map((group) => {
                const count =
                  group.kenanIssueCategories.find((item) => item.category === category)?.count ?? 0
                return (
                  <td key={group.developmentMode} className="py-1 pl-3 text-right tabular-nums">
                    {count > 0 ? `${(count / group.projectCount).toFixed(2)} 个` : "—"}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ProjectMetricProjectIssueBreakdown({
  categories
}: {
  categories: ProjectMetricIssueCategoryCount[]
}): React.JSX.Element {
  if (categories.length === 0) {
    return <div className="text-[11px] text-muted-foreground">无非功能问题类别</div>
  }

  return (
    <div className="max-h-56 overflow-y-auto overscroll-contain">
      <table className="text-[11px]">
        <thead className="sticky top-0 bg-popover">
          <tr>
            <th className="whitespace-nowrap pb-2 pr-3 text-left font-medium">
              非功能问题细分类别
            </th>
            <th className="whitespace-nowrap pb-2 pl-3 text-right font-medium">问题数</th>
          </tr>
        </thead>
        <tbody>
          {[...categories]
            .sort((left, right) => left.category.localeCompare(right.category, "zh-CN"))
            .map((item) => (
              <tr key={item.category}>
                <td className="py-1 pr-3">{item.category}</td>
                <td className="py-1 pl-3 text-right tabular-nums">
                  {item.count.toLocaleString("zh-CN")} 个
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
