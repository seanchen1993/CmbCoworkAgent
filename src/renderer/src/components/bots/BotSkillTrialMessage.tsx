import { ChevronRight, Play } from "lucide-react"
import type { BotSkillTrialMessage as SkillTrial } from "../../../../shared/bot-skill-trial"

export function BotSkillTrialMessage({ trial, text }: { trial: SkillTrial; text: string }) {
  return (
    <section className="space-y-3" aria-label="技能试跑">
      <div className="flex items-center gap-2">
        <Play className="size-3.5 shrink-0 text-inherit" aria-hidden />
        <h3 className="min-w-0 flex-1 break-words text-sm font-medium">试跑 · {trial.name}</h3>
        <span className="shrink-0 rounded-md border border-current/25 px-1.5 py-0.5 text-[11px] text-inherit">
          v{trial.version}
        </span>
      </div>
      <dl className="space-y-2.5 text-sm">
        <div>
          <dt className="mb-1 text-xs text-inherit">任务输入</dt>
          <dd className="whitespace-pre-wrap break-words">{trial.inputs}</dd>
        </div>
        <div>
          <dt className="mb-1 text-xs text-inherit">验收条件</dt>
          <dd className="whitespace-pre-wrap break-words">{trial.criteria}</dd>
        </div>
      </dl>
      <details className="group border-t border-current/25 pt-2.5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-inherit outline-none hover:text-inherit focus-visible:ring-2 focus-visible:ring-current [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          查看完整执行说明
        </summary>
        <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-inherit">
          {text}
        </p>
      </details>
    </section>
  )
}
