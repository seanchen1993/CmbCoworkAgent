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
  const [name, setName] = useState("我的编辑提醒")
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
                <input type="radio" checked={step > 0} readOnly aria-label="示例功能 编辑提醒" />
                <strong>编辑提醒</strong>
                <span className="ml-auto text-xs">独立小功能</span>
              </div>
              <details
                className="mt-3 grid gap-1 border-l pl-3 font-mono text-xs"
                aria-label="来源文件"
              >
                <summary className="cursor-pointer font-sans text-muted-foreground">
                  高级：源码结构示意
                </summary>
                <span>📄 plugin.json</span>
                <span>📁 hooks / 编辑完成提醒</span>
                <span>📄 显式操作 / 获准后写入示例文件</span>
              </details>
            </div>
            {step === 1 && (
              <label className="grid gap-2 text-sm">
                新插件名称
                <input
                  className="devclaw-input w-full min-w-0"
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {step === 2 && (
              <div className="rounded-xl border border-primary/30 bg-background p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{name.trim() || "我的编辑提醒"}</strong>
                  <span className="rounded bg-green-500/10 px-2 py-1 text-xs">示例：需求草稿</span>
                </div>
                <label className="mt-3 grid gap-1 text-xs">
                  告诉我你想怎么改
                  <textarea
                    readOnly
                    value="文件编辑完成后提醒我文件名；写入示例文件必须由我点击并确认。"
                    className="devclaw-input min-h-16 w-full"
                  />
                </label>
                <p className="mt-2 text-xs">
                  实际制作先核对用途与目标，显示真实试用所需权限。收到编辑通知不会自动写文件。
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded border px-2 py-1">① 描述需求 → 看效果与范围</span>
                  <span className="rounded border px-2 py-1">② 核对权限与版本 → 确认应用</span>
                </div>
              </div>
            )}
          </>
        )}
        {task.task === "combine" && (
          <>
            <div className="rounded-xl border bg-background p-4 text-sm">
              <p className="text-xs text-muted-foreground">创造者模式 · 一句话需求</p>
              <p className="mt-2">
                这段聊天保留文件读取和代码检查，其他功能先移除，不改变模型和任务方案。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {["文件读取", "代码检查"].map((label) => (
                <div key={label} className="rounded-xl border bg-background p-4">
                  <strong className="text-sm">{label}</strong>
                  <p className="mt-1 text-xs">
                    {step === 0 ? "示例：当前已有功能" : "示例：本次保留"}
                  </p>
                </div>
              ))}
            </div>
            {step > 0 && (
              <div
                className="rounded-xl border bg-background p-3 text-sm"
                aria-label="组合调整范围示例"
              >
                <p>示例范围：只调整这段聊天的功能选择。</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  原有模型与任务方案保持不变。已有授权仍需核对；新增权限由你确认。
                </p>
              </div>
            )}
            {step === 2 && (
              <div className="rounded-xl border bg-background p-3 text-sm">
                <span className="rounded bg-primary/10 px-2 py-1 text-xs">
                  示例：组合已应用 · 尚未开始任务
                </span>
                <p className="mt-3 rounded border p-2">检查这个文件是否存在空列表访问问题。</p>
                <p className="mt-2 text-xs">
                  普通任务直接描述并发送。已保存的固定任务方案仍需在高级设置中明确选用。
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
                <p className="font-medium text-sm">任务进展</p>
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
                task.task === "create" ? name.trim() || "我的编辑提醒" : undefined
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
