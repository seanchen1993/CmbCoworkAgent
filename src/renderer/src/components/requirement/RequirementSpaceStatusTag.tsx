import { cn } from "@/lib/utils"

function requirementSpaceStatusClass(status: string): string {
  if (status === "审批通过")
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
  if (status === "审批中")
    return "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
  if (status === "开发中") return "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300"
  if (status === "实施中")
    return "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
}

export function RequirementSpaceStatusTag({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold",
        requirementSpaceStatusClass(status)
      )}
    >
      {status}
    </span>
  )
}
