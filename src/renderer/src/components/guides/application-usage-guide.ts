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
      "点击左上角图标展开或收起侧边栏。聊天、项目和自定义助手都从这里进入。",
    selectors: ['[data-app-guide="navigation"]']
  },
  {
    id: "customize",
    title: "自定义助手入口",
    description:
      "打开自定义助手，可以制作功能、管理灵件和插件。已安装的插件可从插件页开始使用。",
    selectors: ['[data-app-guide="customize"]']
  },
  {
    id: "creator",
    title: "在这里切换创造者模式",
    description:
      "制作灵件、修改插件或组合项目流程时，切换到创造者模式。日常任务切回普通模式即可。",
    selectors: ['[data-app-guide="creator"]']
  },
  {
    id: "composer",
    title: "在聊天输入框描述需求",
    description:
      "说明你想实现的效果，以及要使用的插件或文件。例如：在项目流程前加入需求转换步骤，并检查前后产物。",
    selectors: ["textarea.composer-textarea"]
  },
  {
    id: "workspace",
    title: "打开实际创作工作区",
    description:
      "有创作候选后，这里会出现工作区入口。先试用、核对结果，再保存为插件。安装后点击“开始使用”，进入对应的聊天或项目入口。",
    selectors: ['[data-app-guide="workspace"]']
  },
  {
    id: "progress",
    title: "从任务进展核对状态与结果",
    description:
      "这里查看任务状态、待确认事项和结果。指引关闭后，可从聊天模式栏的“使用指引”再次打开。",
    selectors: ['[data-app-guide="progress"]']
  }
]
