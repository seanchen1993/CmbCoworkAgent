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
    title: "从导航图标找到应用入口",
    description:
      "左上角图标可以展开或收起侧边栏。下一步会定位到侧边栏的实际入口；指引只展开和定位界面，不会创建任务或改变授权。",
    selectors: ['[data-app-guide="navigation"]']
  },
  {
    id: "customize",
    title: "自定义助手入口",
    description:
      "这个星光图标打开自定义助手，可以浏览灵件、搭配和聊天任务模板。已有业务示例仍在“任务示例演练”中。先继续认识聊天里的常用位置。",
    selectors: ['[data-app-guide="customize"]']
  },
  {
    id: "creator",
    title: "在这里切换创造者模式",
    description:
      "想制作、修改或组合功能时，由你点击这个魔法棒控件进入创造者模式，再描述需求。普通模式用于日常任务。指引不会替你切换模式或开启功能。",
    selectors: ['[data-app-guide="creator"]']
  },
  {
    id: "composer",
    title: "在聊天输入框描述需求",
    description:
      "在这个输入框说明目标、需要处理的文件和允许的操作，再由你点击发送。原草稿会保留，指引不会填写内容或发送消息。",
    selectors: ["textarea.composer-textarea"]
  },
  {
    id: "workspace",
    title: "打开实际创作工作区",
    description:
      "这个控件打开当前聊天的创作工作区，负责候选试用、验收、阶段调试和保存。工作区里有专门的分步指引。先完成需求创作，再由你打开并核对候选。",
    selectors: ['[data-app-guide="workspace"]']
  },
  {
    id: "progress",
    title: "从任务进展核对状态与结果",
    description:
      "这个星光控件打开当前任务、待确认事项与结果；需要时展开排查详情。查看进展不会启动任务。完成、跳过或关闭后，都可以从聊天模式栏的“使用指引”重新打开。",
    selectors: ['[data-app-guide="progress"]']
  }
]
