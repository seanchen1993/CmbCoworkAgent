import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  PERSONAL_EFFICIENCY_METRICS,
  defaultPersonalEfficiencyWeights,
  type PersonalEfficiencyWeights
} from "../../../../../shared/personal-efficiency"

export function PersonalEfficiencyWeightsDialog({
  weights,
  includeMonthly,
  onApply,
  onClose
}: {
  weights: PersonalEfficiencyWeights
  includeMonthly: boolean
  onApply: (weights: PersonalEfficiencyWeights) => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, String(value)]))
  )
  const [submitted, setSubmitted] = useState(false)
  const metrics = PERSONAL_EFFICIENCY_METRICS.filter((metric) => !metric.monthly || includeMonthly)
  const invalid = (key: string): boolean =>
    !draft[key]?.trim() ||
    !Number.isFinite(Number(draft[key])) ||
    Number(draft[key]) < -100 ||
    Number(draft[key]) > 100
  function apply(event: React.FormEvent): void {
    event.preventDefault()
    setSubmitted(true)
    if (metrics.some(({ key }) => invalid(key))) return
    onApply({
      ...weights,
      ...Object.fromEntries(metrics.map(({ key }) => [key, Number(draft[key])]))
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-xl">
        <DialogHeader>
          <DialogTitle>排名权重</DialogTitle>
          <DialogDescription className="sr-only">设置各指标的排名权重</DialogDescription>
        </DialogHeader>
        <form onSubmit={apply} noValidate className="flex min-h-0 flex-col gap-4 overflow-hidden">
          <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-2">
            {[
              { title: "项目与代码指标", monthly: false },
              { title: "自然月指标", monthly: true }
            ]
              .filter((group) => !group.monthly || includeMonthly)
              .map((group) => (
                <div key={group.title}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>
                  <div className="divide-y divide-border/60">
                    {metrics
                      .filter((metric) => Boolean(metric.monthly) === group.monthly)
                      .map(({ key, label }) => (
                        <label
                          key={key}
                          className="flex items-center justify-between gap-4 py-2 text-sm"
                        >
                          <span>{label}</span>
                          <Input
                            type="number"
                            min={-100}
                            max={100}
                            step="any"
                            value={draft[key]}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, [key]: event.target.value }))
                            }
                            aria-label={`${label}权重`}
                            aria-invalid={submitted && invalid(key)}
                            className="h-8 w-24 shrink-0 text-right tabular-nums aria-invalid:border-destructive"
                          />
                        </label>
                      ))}
                  </div>
                </div>
              ))}
          </div>
          {submitted && metrics.some(({ key }) => invalid(key)) ? (
            <p role="alert" className="text-xs text-destructive">
              每项权重须为 -100 到 100 之间的数字
            </p>
          ) : null}
          <DialogFooter className="items-center border-t border-border pt-3 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const defaults = defaultPersonalEfficiencyWeights()
                setDraft((current) => ({
                  ...current,
                  ...Object.fromEntries(metrics.map(({ key }) => [key, String(defaults[key])]))
                }))
                setSubmitted(false)
              }}
            >
              恢复默认
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" size="sm">
                应用并重新排名
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
