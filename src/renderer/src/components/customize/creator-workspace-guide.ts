import type { UiGuideConfig } from "../../../../shared/ui-guides"
import type { AnchoredGuideStep } from "../guides/AnchoredGuide"

export const creatorWorkspaceGuide: UiGuideConfig = {
  guideId: "mods-creator-workspace-stage-debug",
  revision: 3,
  maxShowCount: 1
}

export const creatorWorkspaceGuideSteps: readonly AnchoredGuideStep[] = [
  {
    id: "overview",
    title: "一个聊天，完成插件创作",
    description: "在聊天中描述需求，在这里试用，满意后保存为插件。",
    selectors: ['[data-creator-guide="overview"]']
  },
  {
    id: "create",
    title: "回原聊天描述需求与修改",
    description: "例如：做一个每周汇总资料的插件，先列出缺失信息，再生成带来源的报告。修改时直接说“保留现有输入和检查，只把报告改成表格”。返回原对话编辑后再发送，无需重新描述整个插件。",
    selectors: ['[data-creator-guide="chat"]', '[data-creator-guide="overview"]']
  },
  {
    id: "trial",
    title: "试用插件",
    description: "项目插件：填写一个实际目标，点击“准备试用环境”，补齐配置和权限后“开始执行”。聊天功能：核对用途与权限，点击“确认并开始聊天试用”，回聊天验证效果。",
    selectors: ['[data-creator-section="trial"]', '[data-creator-trials]', '[data-creator-guide="next-step"]']
  },
  {
    id: "acceptance",
    title: "通过真实检查判断结果",
    description: "核对输出是否符合你的需求，以及实际检查是否通过。已启用、环境已准备、任务已结束，都不等于通过。失败时带着问题回原对话修改；结果待核对时先查记录，不重复运行。",
    selectors: ['[data-creator-section="trial"]', '[data-creator-trials]', '[data-creator-guide="next-step"]']
  },
  {
    id: "delivery",
    title: "保存成独立的新插件",
    description: "满意后使用默认名称保存新插件。未完成试用的版本会明确标注。保存后“开始使用”：项目插件进入原项目页面，聊天功能回到聊天；导出 ZIP 仅用于分发。",
    selectors: ['[data-creator-section="delivery"]', '[data-creator-section="create"]']
  }
]

export function creatorWorkspaceSteps(nextStep?: { title: string; detail: string }): readonly AnchoredGuideStep[] {
  return creatorWorkspaceGuideSteps.map(step => step.id === "overview" && nextStep
    ? { ...step, description: `当前：${nextStep.title}。${nextStep.detail}` }
    : step)
}
