import { useId } from "react"
import { cn } from "@/lib/utils"

/** Creation consent only. Existing Bot policies stay in the existing approval settings. */
export function BotCreationReview({
  enabled,
  onChange,
  disabled = false
}: {
  enabled: boolean
  onChange(enabled: boolean): void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <fieldset disabled={disabled} className="space-y-2.5">
      <legend className="text-sm font-medium">操作审核</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          {
            value: true,
            title: "智能审核",
            detail: "模型审核任务内的操作，明确获准后自动执行；需要你决定或无法判断时暂停确认。"
          },
          {
            value: false,
            title: "逐项确认",
            detail: "需要审批的操作逐项交由你确认；已保存的明确授权继续生效。"
          }
        ].map((choice) => (
          <label
            key={String(choice.value)}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring",
              enabled === choice.value
                ? "border-foreground/30 bg-muted/50"
                : "border-border hover:bg-muted/30",
              disabled && "cursor-not-allowed opacity-50"
            )}
          >
            <input
              className="mt-0.5 accent-current"
              type="radio"
              name={id}
              value={String(choice.value)}
              checked={enabled === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                {choice.title}
                {choice.value && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">推荐</span>
                )}
              </span>
              <span className="block text-xs leading-5 text-muted-foreground">{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        智能审核使用此 Bot 配置的模型，会增加模型调用。创建后可在审批规则中修改。
      </p>
    </fieldset>
  )
}
