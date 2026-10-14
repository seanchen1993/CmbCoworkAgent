import { BookOpen, Layers3, Play, Upload } from "lucide-react"
import { useAppStore } from "@/lib/store"

export function FlowUsageGuide({ onOpenMods }: { onOpenMods?: () => void } = {}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-flow-usage>
      <ol
        className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        aria-label="按步骤执行使用指南"
      >
        {[
          { icon: Upload, title: "选一个起点", text: "开启功能后，从代码检查等现成流程开始。" },
          {
            icon: Layers3,
            title: "写清每步要做什么",
            text: "例如先检查代码，再修改问题，最后由你确认。"
          },
          {
            icon: Play,
            title: "保存后开始任务",
            text: "点运行才会开始；到运行记录查看进度和结果。"
          }
        ].map(({ icon: Icon, title, text }, index) => (
          <li key={title} className="flex items-start gap-3 p-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-semibold">
                <span className="mr-1.5 text-muted-foreground">0{index + 1}</span>
                {title}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <details className="border-t text-sm">
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BookOpen className="mr-2 inline size-3.5 align-text-bottom" aria-hidden="true" />
          第一次怎么用？
        </summary>
        <div className="grid gap-5 border-t bg-muted/10 p-4 sm:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-medium">例子：检查代码，交给你确认</h3>
            <ol className="list-decimal space-y-2 pl-4 text-xs leading-relaxed text-muted-foreground">
              <li>
                <button
                  type="button"
                  className="text-primary underline underline-offset-4"
                  onClick={
                    onOpenMods ?? (() => useAppStore.getState().setShowCustomizeView(true, "mods"))
                  }
                >
                  打开添加功能
                </button>
                ，在“我已添加”中开启灵件功能，即可新建流程，无需先安装插件。
              </li>
              <li>打开已选择项目目录的聊天，或项目模式中的任务，点“新建代码检视流程”。</li>
              <li>先配置一个可用的模型，再写下要检查什么。点步骤卡片可修改要求和使用的模型。</li>
              <li>点“保存流程”，再点“运行已保存版本”，不需要输入命令。</li>
              <li>向下查看“运行与历史”。等待确认时阅读结果，再点“同意并继续”或“拒绝并停止”。</li>
            </ol>
          </div>
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <h3 className="text-sm font-medium text-foreground">想增加步骤或以后再用？</h3>
            <p>
              从步骤库选择要做的事，例如让助手检查代码、查询资料、运行测试，或等你确认。
              用箭头调整顺序，用开关决定是否执行；需要按结果走不同步骤时，再设置条件和失败后的去向。
            </p>
            <p>
              助手给出的检查意见不等于测试通过。要运行测试，添加检查步骤，并使用项目已有的测试命令。
              通用开发流程由应用运行，不会自动推进项目阶段。已保存的旧版 AutoBiz
              流程保留原授权与阶段配置； 需要迁移时新建通用流程并逐项核对。原项目检查仍须通过。
            </p>
            <p>
              例如：分析需求 → 查询资料 →
              整理结果。先在“助手组合”选择并应用需要的功能，再添加对应步骤。
            </p>
            <p>
              使用连接到外部服务的工具（MCP）时，先加载工具列表，再填写参数。加载列表会连接服务。
              需要传递前一步结果时，选择结果中的相应内容；不熟悉 JSON
              时使用表单。每轮任务只调用该工具一次，失败后先查看原因。
            </p>
            <p>
              点“保存流程”后可直接运行；也可在“助手组合”选择已保存流程，保存并应用组合，
              回到聊天切换到“按步骤执行”，再发送本次任务。“直接聊天”不会启动流程。
              关闭页面不等于停止任务，需要停止时请点击停止按钮。
            </p>
            <p>
              详情中的保存修订是流程的保存记录，不是插件版本。修改流程后，要让当前聊天使用新修订：到“助手组合”重新选择流程，保存并应用到当前对话。
              停止或重试不会撤销已经完成的文件修改或外部操作，请先查看上一轮结果。
            </p>
          </div>
        </div>
      </details>
    </div>
  )
}
