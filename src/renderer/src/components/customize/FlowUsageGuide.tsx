import { BookOpen } from "lucide-react"
import { useAppStore } from "@/lib/store"

export function FlowUsageGuide({ onOpenMods }: { onOpenMods?: () => void } = {}) {
  return (
    <details className="rounded-xl border bg-card text-sm" data-flow-usage>
      <summary className="cursor-pointer px-4 py-3 font-medium">
        <BookOpen className="mr-2 inline size-3.5" aria-hidden="true" />
        聊天任务模板怎么用？
      </summary>
      <div className="space-y-3 border-t p-4 leading-relaxed text-muted-foreground">
        <p>
          本次只想先检视修改、再运行项目测试时，可以选用任务模板，无需制作或安装新插件。
          模板也可以调用已授权插件的技能或动作。
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>打开带项目目录的普通聊天，选择“只读检视”“检视并测试”或“失败修复复测”。</li>
          <li>点击“选用并返回聊天”。系统保存模板并选为下一条消息使用的步骤，不会立即执行。</li>
          <li>
            在原聊天输入目标并发送，例如“检查当前修改是否正确”。在原任务卡或“任务进展”查看进展、真实测试结果和待确认事项。
          </li>
          <li>
            仅对下一条任务生效；选错时取消本次选择，恢复普通聊天。保存与选择不会授予工具权限。
          </li>
        </ol>
        <p>
          插件用于安装和分发完整能力，可以包含技能、脚本、配置、知识和项目流程。
          模板与项目流程共用执行底座；AutoBiz 等项目另有长期阶段状态与产物检查，
          不需要在这里重复配置。普通聊天仍可直接发送。
        </p>
        <p>
          测试模板调用项目已有测试入口。缺少入口时系统会提示具体配置文件；助手检视意见不能代替真实测试通过。
        </p>
        <p>
          高级编辑与执行记录保留旧模板、手工组合、审批、取消和恢复能力。修改模板不改变已运行任务；停止不会撤销已发生的文件修改或外部操作。
        </p>
        <details>
          <summary className="cursor-pointer font-medium text-foreground">
            高级：使用手动保存的任务方案
          </summary>
          <div className="mt-3 space-y-3">
            <p>手动编辑器用于明确安排先后顺序。普通发送也不会自动执行已保存方案。</p>
            <p>
              在高级编辑器保存后，可直接点击“去这段聊天使用”；也可在任务进展 →
              高级设置中明确选择已保存版本。在聊天的同一个输入框填写目标并点击“发送消息”，成功启动后恢复普通发送；未发送前可点击“改为普通发送”。
            </p>
            <p>
              使用连接到外部服务的工具（MCP）时，先加载工具列表，再填写参数；加载列表会连接服务。需要传递前一步结果时，选择对应的输出字段。每轮任务只调用该工具一次，失败后先核对结果。
            </p>
            <p>
              高级常用搭配可以绑定已保存方案，绑定不会改变普通发送，仍须明确选用。保存修订属于步骤记录，不是插件版本；修改后须重新保存并选择新版本。
            </p>
            <p>
              停止或重试不会撤销已经完成的文件修改或外部操作。原有业务检查、人工确认和恢复条件继续生效。
            </p>
          </div>
        </details>
        <button
          type="button"
          className="text-primary underline underline-offset-4"
          onClick={onOpenMods ?? (() => useAppStore.getState().setShowCustomizeView(true, "mods"))}
        >
          管理模板所需功能与权限
        </button>
      </div>
    </details>
  )
}
