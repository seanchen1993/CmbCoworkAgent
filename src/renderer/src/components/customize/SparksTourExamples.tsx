import { useLayoutEffect, useRef, useState } from "react"
import type { SimpleAuthoringPracticeIntent } from "@/lib/simple-authoring-intent"

import { simpleTourTasks } from "./simple-tour-tasks"

/** One task, one visible goal, one primary action. Examples never call a host API. */
export function SparksTourExamples({
  chapter,
  onPractice
}: {
  chapter: number
  onPractice(task?: SimpleAuthoringPracticeIntent["task"], suggestedName?: string): void
}) {
  const task = simpleTourTasks[chapter] ?? simpleTourTasks[0]
  const [step, setStep] = useState(0)
  const [name, setName] = useState("我的 AutoBiz")
  const [filePath, setFilePath] = useState("src/report-old.ts")
  const root = useRef<HTMLDivElement>(null)
  const goal = task.steps[step]
  useLayoutEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" })
  }, [step])
  return (
    <div ref={root} className="mt-4 space-y-4" aria-label="实例演练">
      <div aria-live="polite">
        <p className="text-xs text-muted-foreground">操作演示 · 第 {step + 1} / 3 步</p>
        <h3 className="mt-1 font-semibold">{goal.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          下面是操作示例，不会安装插件或运行任务。最后一步会带你到实际页面。
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{goal.text}</p>
      </div>
      <div
        className="min-h-40 space-y-3 rounded-xl border bg-muted/20 p-4"
        aria-label="示例界面预览"
        data-tour-preview-chapter={chapter}
        data-tour-preview-stage={step}
      >
        {task.task === "create" && (
          <>
            <div className="rounded-xl border bg-background p-4">
              <div className="flex items-center gap-2">
                <input type="radio" checked={step > 0} readOnly aria-label="示例来源 AutoBiz" />
                <strong>AutoBiz</strong>
                <span className="ml-auto text-xs">来源插件</span>
              </div>
              <div
                className="mt-3 grid gap-1 border-l pl-3 font-mono text-xs"
                aria-label="来源文件"
              >
                <span>📄 plugin.json</span>
                <span>📁 skills / 业务步骤</span>
                <span>📁 hooks / 检查规则</span>
              </div>
            </div>
            {step === 1 && (
              <label className="grid gap-2 text-sm">
                新插件名称
                <input
                  className="w-full min-w-0 rounded-lg border bg-background p-2"
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {step === 2 && (
              <div className="rounded-xl border border-primary/30 bg-background p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{name.trim() || "我的 AutoBiz"}</strong>
                  <span className="rounded bg-green-500/10 px-2 py-1 text-xs">
                    示例：新插件副本
                  </span>
                </div>
                <label className="mt-3 grid gap-1 text-xs">
                  告诉我你想怎么改
                  <textarea
                    readOnly
                    value="保留检查步骤，增加 SQL 和数据质量报告要求。"
                    className="min-h-16 w-full rounded border bg-background p-2"
                  />
                </label>
                <p className="mt-2 text-xs">
                  示例：给助手补充数据质量要求。实际页面会显示哪些文件将改变，确认后才保存。
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded border px-2 py-1">① 生成并预览修改</span>
                  <span className="rounded border px-2 py-1">② 确认保存 → 检查并安装</span>
                </div>
              </div>
            )}
          </>
        )}
        {task.task === "combine" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {["AutoBiz · 读取文件", "Review · 检查代码"].map((label) => (
                <div key={label} className="rounded-xl border bg-background p-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={step > 0}
                      readOnly
                      aria-label={`示例选择 ${label}`}
                    />
                    <strong className="text-sm">{label}</strong>
                  </label>
                  <p className="mt-1 text-xs">{step === 0 ? "选择此插件" : "已选择"}</p>
                </div>
              ))}
            </div>
            {step > 0 && (
              <div className="grid gap-2" aria-label="两步连接示例">
                <div className="rounded-lg border bg-background p-3 text-sm">
                  <strong>① 读取文件</strong>
                  <label className="mt-2 grid gap-1 text-xs">
                    文件路径
                    <input
                      readOnly
                      value="src/report.ts"
                      className="min-w-0 w-full rounded border bg-background p-2 font-mono"
                    />
                  </label>
                  <p className="mt-2 text-xs">输出：文件内容</p>
                </div>
                <div className="flex items-center justify-center gap-2 text-xs text-primary">
                  <svg width="20" height="28" viewBox="0 0 20 28" aria-hidden="true">
                    <path
                      d="M10 1v23m-6-6 6 6 6-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                  文件内容传给下一步
                </div>
                <div className="rounded-lg border bg-background p-3 text-sm">
                  <strong>② 检查空列表访问</strong>
                  <p className="mt-2 rounded border bg-muted/40 p-2 text-xs">输入：① 的文件内容</p>
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="rounded-xl border bg-background p-3 text-sm">
                <span className="rounded bg-primary/10 px-2 py-1 text-xs">
                  按步骤执行 · 已选两步组合
                </span>
                <p className="mt-3 rounded border p-2">检查这个文件是否存在空列表访问问题。</p>
                <p className="mt-2 text-xs">
                  实际使用时，先核对文件和任务，再发送；发送后才开始执行。
                </p>
              </div>
            )}
          </>
        )}
        {task.task === "inspect" && (
          <>
            <div className="rounded-xl border bg-background p-3">
              <p className="text-xs text-muted-foreground">聊天输入</p>
              <code className="mt-1 block text-sm">/diff</code>
            </div>
            <div
              className="overflow-hidden rounded-xl border bg-background text-sm"
              aria-label="文件差异示例"
            >
              <p className="border-b p-2 font-mono text-xs">
                src/report.ts <span className="float-right">+1 −1</span>
              </p>
              <pre className="overflow-x-auto p-2 text-xs leading-6">
                <span className="block bg-red-500/10 text-red-700 dark:text-red-300">
                  − return rows[0].name
                </span>
                <span className="block bg-green-500/10 text-green-700 dark:text-green-300">
                  + return rows[0]?.name ?? &quot;&quot;
                </span>
              </pre>
            </div>
            {step > 0 && (
              <div
                className="space-y-2 rounded-xl border bg-background p-3"
                aria-label="运行记录示例"
              >
                <p className="font-medium text-sm">运行过程</p>
                <div className="rounded border border-red-500/30 p-2 text-xs">
                  × 读取文件失败 · src/report-old.ts 不存在
                </div>
                {step === 1 ? (
                  <label className="grid gap-1 text-xs">
                    检查文件路径
                    <input
                      aria-label="示例文件路径"
                      value={filePath}
                      onChange={(event) => setFilePath(event.target.value)}
                      className="min-w-0 w-full rounded border bg-background p-2 font-mono"
                    />
                    <span>项目中的文件是 src/report.ts</span>
                  </label>
                ) : (
                  <>
                    <div className="rounded border p-2 text-xs">
                      ↻ 已改为 src/report.ts，重新检查
                    </div>
                    <div className="rounded border border-green-500/30 bg-green-500/10 p-2 text-xs">
                      ✓ 读取完成 → 检查通过
                      <br />
                      示例依据：没有数据时返回空文本，避免读取不存在的第一项。
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="w-full rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() =>
          step < 2
            ? setStep(step + 1)
            : onPractice(
                task.task,
                task.task === "create" ? name.trim() || "我的 AutoBiz" : undefined
              )
        }
      >
        {goal.action}
      </button>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {step > 0 && (
          <button
            type="button"
            className="rounded p-1 hover:bg-muted"
            onClick={() => setStep(step - 1)}
          >
            上一步
          </button>
        )}
        {step > 0 && (
          <button type="button" className="rounded p-1 hover:bg-muted" onClick={() => setStep(0)}>
            从头看这个示例
          </button>
        )}
      </div>
    </div>
  )
}
