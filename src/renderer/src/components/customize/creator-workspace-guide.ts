import type { UiGuideConfig } from "../../../../shared/ui-guides"
import type { AnchoredGuideStep } from "../guides/AnchoredGuide"

export const creatorWorkspaceGuide: UiGuideConfig = {
  guideId: "mods-creator-workspace-stage-debug",
  revision: 2,
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
    description: "点击“返回聊天修改”，直接说明想调整什么，沿用本次创作。",
    selectors: ['[data-creator-guide="chat"]', '[data-creator-guide="overview"]']
  },
  {
    id: "trial",
    title: "试用插件",
    description: "填写试用目标，点击“开始试用”。按提示补齐必需配置后，点击“开始执行”。",
    selectors: ['[data-creator-section="trial"]', '[data-creator-section="create"]']
  },
  {
    id: "acceptance",
    title: "通过真实检查判断结果",
    description: "试用结果自动汇总到本页。未通过时查看具体步骤，回到聊天提出修改。",
    selectors: ['[data-creator-section="trial"]', '[data-creator-section="acceptance"]']
  },
  {
    id: "debug",
    title: "从阶段快照隔离调试",
    description: "需要只调试某个步骤时，展开此处选择已有阶段快照。可用范围由插件的恢复能力决定。",
    selectors: [
      '[data-creator-guide="stage-debug"] > summary',
      '[data-creator-guide="project-preview"] > summary',
      '[data-creator-section="trial"]',
      '[data-creator-section="create"]'
    ]
  },
  {
    id: "delivery",
    title: "保存成独立的新插件",
    description: "填写新插件标识，点击“保存插件”。保存后点击“开始使用”，或导出 ZIP 分享。",
    selectors: ['[data-creator-section="delivery"]', '[data-creator-section="create"]']
  },
  {
    id: "components",
    title: "继续组合 Mods，并随时重看指引",
    description: "组件和高级设置收在这里。关闭或跳过指引后，仍可点击“使用指引”重新打开。",
    selectors: ['[data-creator-section="create"] > summary']
  }
]
