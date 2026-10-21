import type { UiGuideConfig } from "../../../../shared/ui-guides"
import type { AnchoredGuideStep } from "../guides/AnchoredGuide"

export const creatorWorkspaceGuide: UiGuideConfig = {
  guideId: "mods-creator-workspace-stage-debug",
  revision: 1,
  maxShowCount: 1
}

export const creatorWorkspaceGuideSteps: readonly AnchoredGuideStep[] = [
  {
    id: "overview",
    title: "一个聊天，完成插件创作",
    description:
      "原创作聊天负责描述需求和对话修改，这个工作区负责试用、验收和保存。第一次打开会自动展示本指引；下一步会定位到实际操作区域。指引只展开和定位界面，不会运行任务、安装插件或确认权限。",
    selectors: ['[data-creator-guide="overview"]']
  },
  {
    id: "create",
    title: "回原聊天描述需求与修改",
    description:
      "在创造者模式描述想要的功能，也可以要求拆分已有插件或组合 Mods。用这里的返回按钮继续在原聊天修改，助手准备好候选后再回来试用；不需要为每次修改重新开聊天。未进入创造者模式时，先由你明确开启。",
    selectors: ['[data-creator-guide="chat"]', '[data-creator-guide="overview"]']
  },
  {
    id: "trial",
    title: "运行当前候选，而不是只创建目录",
    description:
      "这里显示当前项目候选、配置和原生试用入口。先核对参数与权限，再由你批准并启动。不同阶段的执行会话归属于同一轮试用。没有候选时，先回原聊天完成制作。指引不会点击创建、批准或运行。",
    selectors: ['[data-creator-section="trial"]', '[data-creator-section="create"]']
  },
  {
    id: "acceptance",
    title: "通过真实检查判断结果",
    description:
      "在这里统一查看阶段、必需产物、原校验和人工确认。模型说完成、一个会话结束或安装成功，都不等于整轮通过。失败或结果待核对时查看具体诊断，再回原聊天修改；未知操作不要直接重跑。",
    selectors: ['[data-creator-section="acceptance"]', '[data-creator-section="create"]']
  },
  {
    id: "debug",
    title: "从阶段快照隔离调试",
    description:
      "Host 项目先真实试用产生阶段进入快照，结束旧执行并核对结果，再修改目标或后续未共享的 Skill 正文，确认独立分支并重新批准运行。已冻结的配置与知识、已声明恢复协议的 Hooks 和上下文脚本可按条件保留。插件自有流程在试用卡检查“插件阶段恢复”，须有插件适配器并分别确认规划与应用；Git、活跃工作树和外部状态不会自动回退。没有项目或快照时先完成前置步骤。",
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
    description:
      "确认独立名称与版本后安装或导出 ZIP，原插件保留。响应异常先点“核对实际交付结果”，不要重复提交；安装后点“开始使用”补齐配置和知识并定位真实入口。可以保存未验收源码，但保存和单阶段通过都不代表整轮验收通过。",
    selectors: ['[data-creator-section="delivery"]', '[data-creator-section="create"]']
  },
  {
    id: "components",
    title: "继续组合 Mods，并随时重看指引",
    description:
      "这里管理当前聊天的 Mod 组件、聊天组合及高级设置；项目试用和交付在上方独立区域。需要调整功能时回到原聊天描述修改。完成、跳过或关闭本指引后，仍可从工作区的“使用指引”重新开始；聊天模式栏的“使用指引”介绍应用控件位置。",
    selectors: ['[data-creator-section="create"] > summary']
  }
]
