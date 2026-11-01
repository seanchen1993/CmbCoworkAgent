import type { AnchoredGuideStep } from "./AnchoredGuide"

const openEvent = "cmb:open-application-usage-guide"

/** Only requests a view walkthrough; never enters creator mode or submits a task. */
export function openApplicationUsageGuide() {
  window.dispatchEvent(new Event(openEvent))
}

export function subscribeApplicationUsageGuide(listener: () => void) {
  window.addEventListener(openEvent, listener)
  return () => window.removeEventListener(openEvent, listener)
}

export const applicationUsageGuideSteps: readonly AnchoredGuideStep[] = [
  {
    id: "navigation",
    title: "先明确：执行任务，还是制作功能",
    description:
      "日常任务用普通聊天；要制作界面、工具、自动规则或项目流程，使用创造者模式。左上角导航可进入聊天、原项目模式和已安装插件。",
    expectation: "知道这次要使用哪条路径，无需先手工组装插件。",
    selectors: ['[data-app-guide="navigation"]']
  },
  {
    id: "customize",
    title: "自定义助手入口",
    description:
      "已有 ZIP 时，到“插件”上传，展开主插件查看用途后点击“开始使用”。项目插件进入原项目创建流程；依赖组件用于支撑主插件，不需要逐个启动。",
    expectation: "从主插件进入正确的聊天或项目入口。打开管理页本身不会授权或执行。",
    selectors: ['[data-app-guide="customize"]']
  },
  {
    id: "creator",
    title: "在这里切换创造者模式",
    description:
      "选择一个本地工作目录，切换为创造者模式。在同一对话中描述需求和后续修改；无需另找提示词编辑器。",
    expectation: "助手准备一个可检查的版本，工作区显示当前状态和下一步。",
    selectors: ['[data-app-guide="creator"]']
  },
  {
    id: "composer",
    title: "在聊天输入框描述需求",
    description:
      "说清使用场景、触发时机、界面或输出，以及怎样判断成功。可复制示例再修改；复制不会覆盖草稿或自动发送。",
    example: {
      label: "从一个小功能开始",
      prompt:
        "创建一个文件读取统计 Mod：在侧栏显示本聊天成功读取文件的次数，每次实际读取成功后更新；未读取时显示 0。用真实事件统计，不允许编造次数，并提供清零按钮。"
    },
    expectation: "检查助手给出的行为和界面，再让它准备试用版本。",
    selectors: ["textarea.composer-textarea"]
  },
  {
    id: "workspace",
    title: "打开实际创作工作区",
    description:
      "打开工作区，按当前下一步开始试用；缺配置时先补齐，核对所列权限再确认。项目试用先准备隔离环境，再点击开始执行。修改需求请返回原对话。",
    expectation: "看到真实执行、检查或待确认状态。创建环境和保存插件都不等于已经运行通过。",
    selectors: ['[data-app-guide="workspace"]']
  },
  {
    id: "progress",
    title: "从任务进展核对状态与结果",
    description:
      "“当前任务”看执行和待确认事项；“输出与面板”看记录和插件交互界面。试用满意后回工作区保存，再点击“开始使用”；项目插件继续沿原项目/需求流程使用。",
    expectation: "能区分插件面板、执行结果和试用检查，并知道保存后从哪里再次使用。",
    selectors: ['[data-app-guide="progress"]']
  }
]
