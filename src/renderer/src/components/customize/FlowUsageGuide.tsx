import { BookOpen } from "lucide-react"
import { useAppStore } from "@/lib/store"

export function FlowUsageGuide({ onOpenMods }: { onOpenMods?: () => void } = {}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-flow-usage>
      <details className="text-sm">
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BookOpen className="mr-2 inline size-3.5 align-text-bottom" aria-hidden="true" />
          如何开始任务？
        </summary>
        <div className="grid gap-5 border-t bg-muted/10 p-4 sm:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-medium">日常使用：直接在聊天中描述需求</h3>
            <ol className="list-decimal space-y-2 pl-4 text-xs leading-relaxed text-muted-foreground">
              <li>在普通聊天中写下要完成的事，点击“发送消息”，无需先配置任务方案。</li>
              <li>在聊天回复和“任务进展”中查看当前情况、下一步提示与结果。</li>
              <li>需要你确认时，先阅读内容，再决定继续或停止；工具操作仍按原有审批规则处理。</li>
              <li>想改变助手功能时，切到创造者模式描述需求，核对实际版本与权限后确认应用。</li>
            </ol>
          </div>
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <details>
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                高级：使用手动保存的任务方案
              </summary>
              <div className="mt-3 space-y-3">
                <p>
                  这里的手动编辑器用于明确安排先后顺序。保存方案不会启动任务，普通发送也不会自动执行已保存方案。
                </p>
                <ol className="list-decimal space-y-2 pl-4">
                  <li>在编辑器中选择模板，核对每项要求、所用模型与实际权限，再保存。</li>
                  <li>
                    回到聊天，打开“任务进展 → 高级设置 →
                    高级：为下一条消息使用预设任务”，选用已保存方案。
                  </li>
                  <li>
                    在聊天的同一个输入框填写目标，点击“发送消息”。选用只用于下一条消息，成功启动后恢复普通发送；也可点击“改为普通发送”。
                  </li>
                  <li>
                    在原任务卡或“任务进展”核对成果。详细步骤和运行记录在“排查详情：执行记录”中展开。
                  </li>
                </ol>
                <button
                  type="button"
                  className="text-primary underline underline-offset-4"
                  onClick={
                    onOpenMods ?? (() => useAppStore.getState().setShowCustomizeView(true, "mods"))
                  }
                >
                  管理任务方案需要的插件与权限
                </button>
                <p>
                  助手给出的检查意见不等于测试通过。要运行测试，添加检查步骤，并使用项目已有的测试命令。
                  通用开发流程由应用运行，不会自动推进项目阶段。已保存的旧版 AutoBiz
                  流程保留原授权与阶段配置； 需要迁移时新建通用流程并逐项核对。原项目检查仍须通过。
                </p>
                <p>
                  可在高级编辑器中安排分析需求、查询资料、整理结果等步骤，并核对所需功能是否已启用和授权。
                </p>
                <p>
                  使用连接到外部服务的工具（MCP）时，先加载工具列表，再填写参数。加载列表会连接服务。
                  需要传递前一步结果时，选择结果中的相应内容；不熟悉 JSON
                  时使用表单。每轮任务只调用该工具一次，失败后先查看原因。
                </p>
                <p>
                  也可在高级“常用搭配”中绑定已保存方案。绑定不会改变普通发送，仍需按上述路径明确选用。
                  关闭页面不等于停止任务，需要停止时请点击停止按钮。
                </p>
                <p>
                  详情中的保存修订是步骤的保存记录，不是插件版本。若常用搭配绑定了旧版步骤，请在常用搭配中重新选择、保存并应用；独立选择步骤时，重新加载并选择已保存的新版本。
                  停止或重试不会撤销已经完成的文件修改或外部操作，请先查看上一轮结果。
                </p>
              </div>
            </details>
          </div>
        </div>
      </details>
    </div>
  )
}
