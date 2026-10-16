import { ArrowRight, WandSparkles } from "lucide-react"
import { SparksDocumentationLink } from "./SparksDocumentationLink"

type Destination = "claw" | "mods" | "flows" | "evaluation"

export function AssistantWorkbench({
  onNavigate,
  onStartCreator,
  creatorBusy = false,
  creatorUnavailable,
  creatorError
}: {
  onNavigate: (tab: Destination, section?: "examples" | "create") => void
  onStartCreator: () => void
  creatorBusy?: boolean
  creatorUnavailable?: string
  creatorError?: string
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto" aria-label="自定义助手总览">
      <div className="mx-auto max-w-4xl space-y-8 p-6 sm:p-10">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">用一句话定制助手</h1>
            <SparksDocumentationLink />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            普通模式处理日常任务；创造者模式根据你的描述，制作、修改或组合灵件，并应用到聊天。
          </p>
        </header>
        <section className="rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-7">
          <WandSparkles className="mb-3 size-6 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold">想让助手怎么做，直接说</h2>
          <p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">
            例如：“读取文件失败时自动重试一次”，或“把代码检查和修改提醒组合起来，应用到这段聊天”。助手会选择合适的方式完成。
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={creatorBusy || !!creatorUnavailable}
            onClick={onStartCreator}
          >
            {creatorBusy ? "正在进入创造者模式…" : "进入创造者模式"}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
          {creatorUnavailable && (
            <p className="mt-3 text-sm text-muted-foreground">{creatorUnavailable}</p>
          )}
          {creatorError && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {creatorError}
            </p>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            进入后回到所选聊天，直接输入需求。需要新权限时会说明并请你确认，应用进度在聊天中显示。
          </p>
        </section>
        <section className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">找一点灵感</h2>
          <p className="my-3 text-sm leading-6 text-muted-foreground">
            也可以先看看现成的灵件示例，再告诉助手你想做哪些调整。
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onNavigate("mods", "examples")}
          >
            浏览灵件示例 <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </section>
        <details className="rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">高级：手动管理与效果测试</summary>
          <p className="my-3 leading-6 text-muted-foreground">
            已有灵件、搭配和执行步骤仍可单独管理，也可以用测试任务检查效果。
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["mods", "管理灵件"],
                ["claw", "管理常用搭配"],
                ["flows", "管理执行步骤"],
                ["evaluation", "查看效果测试"]
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className="rounded-lg border px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onNavigate(tab)}
              >
                {label}
              </button>
            ))}
          </div>
        </details>
      </div>
    </main>
  )
}
