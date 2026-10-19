import { useState } from "react"

const examples = {
  chat: {
    label: "搭配两项对话能力",
    steps: [
      {
        title: "选择帮手",
        text: "在“对话中使用”勾选资料摘要和代码检查。只选择这次需要的能力。",
        cards: ["资料摘要 · 文档插件", "代码检查 · 检视插件"]
      },
      {
        title: "预览并确认",
        text: "点“预览对话能力”，核对选择和自动补齐的必要能力，再点“确认应用对话能力”。",
        cards: ["已选：资料摘要、代码检查", "应用到当前项目；尚未发送任务"]
      },
      {
        title: "回项目对话提需求",
        text: "返回当前项目对话，发送下面的任务。应用能力不会自动开始工作。",
        cards: [
          "你：先总结购物车需求，再检查代码有没有漏掉空购物车。",
          "助手：先读项目资料，再用已选择的能力检查代码。"
        ]
      },
      {
        title: "核对实际结果",
        text: "阅读回复中的文件和检查意见，再按项目原有要求测试、确认。能力给出意见不等于项目已经验收。",
        cards: ["示例发现：空列表时访问了第一项", "下一步：修复后执行项目测试"]
      }
    ]
  },
  flow: {
    label: "先开发，再生成验收报告",
    steps: [
      {
        title: "选择两套完整流程",
        text: "在“按顺序执行”添加开发流程和验收报告流程，将开发排在前面。原有阶段和检查会完整保留。",
        cards: ["① 开发流程示例", "② 验收报告流程示例"]
      },
      {
        title: "写任务，连接产物",
        text: "填写“这次要做什么”。第二套流程的输入选择第一套流程的对应结果，不需要手动复制文件。",
        cards: ["任务：补齐空购物车处理，并生成验收报告。", "① 的开发结果 → ② 的待验收资料"]
      },
      {
        title: "预览后启动",
        text: "点“检查并预览组合”，核对顺序和资料来源后启动。遇到原流程的人工确认时，先审阅，再明确批准或拒绝。",
        cards: ["① 开发中 · 等待人工确认", "② 等待前一套流程完成"]
      },
      {
        title: "失败时先修复",
        text: "如果第一套流程检查失败，第二套不会开始。打开“运行过程”查看原因，按提示修复；失败记录会保留。",
        cards: ["① 检查失败：空购物车测试未通过", "② 未执行 · 不使用未通过的结果"]
      },
      {
        title: "重新验证并看结果",
        text: "先核对已有改动；结果不明时核对恢复，不要另开任务重做。确认需要重新执行时，再预览并启动新一轮；原检查通过后才交给第二套流程。完成后点“查看结果”阅读报告。",
        cards: ["新一轮：① 原检查通过 → ② 报告生成完成", "查看结果：需求、修改内容、测试结论"]
      }
    ]
  }
} as const

/** Local teaching state only: navigating the example cannot install, apply, approve or run. */
export function ProjectCompositionGuide() {
  const [mode, setMode] = useState<keyof typeof examples>("chat")
  const [step, setStep] = useState(0)
  const example = examples[mode]
  const current = example.steps[step]
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">第一次使用？看一个完整例子</summary>
      <div className="mt-3 space-y-3" aria-label="项目组合操作演示">
        <p className="text-xs text-muted-foreground">
          这是操作演示，不会运行任务。实际可选内容以“项目能力”中的可用状态为准。
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(examples) as (keyof typeof examples)[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              className="rounded-md border px-3 py-2 text-sm aria-pressed:bg-primary/10"
              onClick={() => {
                setMode(id)
                setStep(0)
              }}
            >
              {examples[id].label}
            </button>
          ))}
        </div>
        <div aria-live="polite" className="space-y-2">
          <h3 className="text-sm font-medium">
            {step + 1} / {example.steps.length} · {current.title}
          </h3>
          <p className="text-sm leading-6">{current.text}</p>
          <ol className="space-y-2 rounded-lg bg-muted/30 p-3" aria-label="示例界面">
            {current.cards.map((card) => (
              <li key={card} className="break-words rounded-md border bg-background p-3 text-sm">
                {card}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={step === 0}
            className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setStep(step - 1)}
          >
            上一个演示步骤
          </button>
          <button
            type="button"
            disabled={step === example.steps.length - 1}
            className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setStep(step + 1)}
          >
            下一个演示步骤
          </button>
        </div>
      </div>
    </details>
  )
}
