import { ArrowRight, GitBranch, Sparkles, WandSparkles } from "lucide-react"
import { SparksDocumentationLink } from "./SparksDocumentationLink"

type Destination = "claw" | "mods" | "flows" | "evaluation"

const tasks = [
  {
    destination: "claw",
    title: "保存常用搭配",
    description: "把几个功能搭配起来，取个名字保存。下次选这个助手，就能用同一套设置。",
    action: "管理助手组合",
    icon: Sparkles
  },
  {
    destination: "flows",
    title: "按固定步骤做事",
    description: "例如先检查代码，再修改，最后复查。把步骤保存下来，需要时再执行。",
    action: "管理执行步骤",
    icon: GitBranch
  }
] satisfies {
  destination: Destination
  title: string
  description: string
  action: string
  icon: typeof Sparkles
}[]

export function AssistantWorkbench({ onNavigate }: { onNavigate: (tab: Destination) => void }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto" aria-label="自定义助手总览">
      <div className="mx-auto max-w-4xl space-y-8 p-6 sm:p-10">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">自定义助手</h1>
            <SparksDocumentationLink />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            先选一个小功能试用。需要更多搭配或固定步骤时，再设置助手和流程。
          </p>
        </header>
        <section className="rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-7">
          <WandSparkles className="mb-3 size-6 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold">先挑一个灵件试试</h2>
          <p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">
            灵件是给助手添加的小功能，比如查看用量、回放文件修改。选一个，确认后就能在当前聊天使用。
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-3 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onNavigate("mods")}
          >
            挑选灵件
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
          <p className="mt-3 text-xs text-muted-foreground">
            没找到合适的？进入灵件后，选择“自己制作”，用一句话描述你想要什么。
          </p>
        </section>
        <div className="grid gap-4 sm:grid-cols-2">
          {tasks.map(({ destination, title, description, action, icon: Icon }) => (
            <section key={destination} className="flex flex-col rounded-xl border bg-card p-5">
              <Icon className="mb-4 size-5 text-primary" aria-hidden="true" />
              <h2 className="font-semibold">{title}</h2>
              <p className="mb-5 mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                {description}
              </p>
              <button
                type="button"
                className="inline-flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onNavigate(destination)}
              >
                {action}
                <ArrowRight className="size-4" aria-hidden="true" />
              </button>
            </section>
          ))}
        </div>
        <details className="rounded-xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">想检查助手的效果？</summary>
          <p className="my-3 leading-6 text-muted-foreground">
            用测试任务检查技能和流程的效果，再决定是否使用。
          </p>
          <button
            type="button"
            className="rounded-lg border px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onNavigate("evaluation")}
          >
            查看效果测试
          </button>
        </details>
      </div>
    </main>
  )
}
