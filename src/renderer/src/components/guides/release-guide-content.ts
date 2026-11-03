import type { AnchoredGuideStep } from "./AnchoredGuide"

/** Bump the content revision when a release teaches new behavior, including same-version builds. */
export const releaseGuideRevision = 20261103
export function releaseGuideConfig(version: string) {
  return {
    guideId: `release-introduction:${version}`,
    revision: releaseGuideRevision,
    maxShowCount: 1
  }
}

export const releaseExamples = [
  {
    id: "status",
    title: "让聊天框显示我关心的信息",
    prompt:
      "我想在聊天框上面实时显示天气、时间和 Token 消耗。天气按我选择的城市显示，时间每秒更新，Token 使用本聊天的实际统计；数据不可用时明确提示，不要编造。先给我可试用的版本。",
    result:
      "聊天框上方出现自己的信息条。之后仍可在同一对话说“把天气改成上海”“去掉时钟”，继续调整。",
    steps: [
      "选择聊天和工作目录，进入创造者模式。",
      "发送这段需求，按提示补充城市等信息。",
      "核对准备好的功能和所需权限，确认应用后查看信息条。"
    ],
    note: "图中天气、时间和 Token 为演示数据。实际天气需要可用的数据来源；Token 以平台提供的统计口径为准，不等于费用。"
  },
  {
    id: "project",
    title: "给已有项目插件加一个步骤",
    prompt:
      "基于我选择的新项目插件派生一个副本，在现有流程最前面加“需求3.0转换”。先核对需求3.0的输入格式和转换规则，不清楚的问我。转换结果交给原来的需求阶段，保留后续阶段、检查和项目使用方式，并补齐用户指引。",
    result:
      "新插件的流程从“需求3.0转换”开始。保存后仍在原项目模式选择插件、创建项目和特性，再填写需求并启动。",
    steps: [
      "在创造者模式选择已有插件，说明要增加的步骤和规则。",
      "核对新阶段的输入、输出和后续衔接；在隔离试用中检查。",
      "保存为新插件，从原项目模式选择它，创建特性并启动。"
    ],
    note: "这是流程配置示例，展示新增阶段后的界面，不代表业务已执行。已有特性继续使用原绑定版本。"
  }
] as const

export type ReleaseGuideDestination =
  | "mods"
  | "creator"
  | "composer"
  | "workspace"
  | "plugins"
  | "project"
  | "market"
  | "tools"
  | "progress"
export const releaseGuideSteps: readonly (AnchoredGuideStep & { id: ReleaseGuideDestination })[] = [
  {
    id: "mods",
    title: "自定义 → 灵件：从这里开始",
    description: "灵件是给助手增加的功能。在这里可以对话创作、挑选现成功能，或管理已经添加的内容。",
    selectors: ['[data-release-guide="mods"]'],
    expectation: "日常使用先看这三个入口，不必进入高级源码编辑。"
  },
  {
    id: "creator",
    title: "进入创造者模式",
    description:
      "选择要使用的聊天和本地工作目录，再点击这个入口。告诉助手想增加或修改什么，后续调整继续在同一对话里说。",
    selectors: ['[data-release-guide="creator-entry"]'],
    expectation: "由你明确进入创作；看指引不会改变模式、安装插件或发送消息。"
  },
  {
    id: "composer",
    title: "像聊天一样说出需求",
    description:
      "说清放在哪里、何时更新、读取什么，以及怎样算完成。例如让聊天框上方显示天气、时间和 Token。",
    selectors: ["textarea.composer-textarea"],
    example: { label: "可以直接复制的需求", prompt: releaseExamples[0].prompt },
    missingHint: "先新建或选择一段本地聊天，再选择工作目录。这里不会代你创建聊天或覆盖已有草稿。"
  },
  {
    id: "workspace",
    title: "试用、检查，再保存",
    description:
      "生成候选后，在插件创作工作区查看下一步。补齐配置、核对权限后试用；满意后保存，再点击“开始使用”。修改继续回原对话说明。",
    selectors: ['[data-app-guide="workspace"]'],
    missingHint:
      "先进入创造者模式并生成候选，聊天上方才会出现“插件创作工作区”。没有候选时无需操作高级设置。"
  },
  {
    id: "progress",
    title: "查看当前任务和输出",
    description:
      "普通聊天中的任务进展用于查看执行状态和输出面板。项目模式仍使用自己的特性详情、成果和阶段执行记录。",
    selectors: ['[data-app-guide="progress"]'],
    missingHint: "选择有任务的普通聊天后可查看任务进展；项目阶段请到原特性详情查看。"
  },
  {
    id: "plugins",
    title: "一个 ZIP，从主插件开始使用",
    description:
      "上传插件 ZIP 后，从主插件点击“开始使用”。随包依赖收在依赖组件里，按同一份配置与权限清单核对，不需要逐个启动。",
    selectors: ['[data-release-guide="plugins"]'],
    expectation: "聊天插件用于聊天；项目插件进入原项目模式。"
  },
  {
    id: "project",
    title: "项目插件沿用原项目流程",
    description:
      "新建项目时选择插件并确认配置与权限；创建特性后填写完整需求并启动。新增会话用于讨论，不会自动启动阶段。",
    selectors: ['[data-release-guide="project"]'],
    expectation: "阶段使用指引显示在新会话中；运行状态和成果在原特性详情查看。"
  },
  {
    id: "market",
    title: "复用别人做好的工作台",
    description:
      "在应用市场浏览适合自己的功能，先看用途、使用说明和依赖，再决定安装。自己的成熟插件也可以按发布入口提供的步骤分享。",
    selectors: ['[data-release-guide="market"]'],
    expectation: "下载或浏览不等于已经应用；按对应插件的“开始使用”入口继续。"
  },
  {
    id: "tools",
    title: "需要外部能力时连接工具",
    description:
      "在连接工具中管理 MCP 服务。创造者可以把界面、技能、工具和子任务组合成自己的功能；缺少连接或配置时会明确提示。",
    selectors: ['[data-release-guide="tools"]'],
    expectation: "指引只定位设置页，不会替你添加连接或授予权限。"
  }
]

export const releaseGuideTopics = [
  { id: "mods", title: "认识灵件", text: "找到创作、挑选和管理入口。" },
  { id: "creator", title: "用对话创造功能", text: "从一句话需求开始，继续对话调整。" },
  { id: "workspace", title: "试用与保存", text: "看懂下一步，知道何时可以开始使用。" },
  { id: "plugins", title: "导入现成插件", text: "从主插件使用，统一核对依赖和权限。" },
  { id: "project", title: "调整项目流程", text: "创建或派生插件，沿用原项目操作。" },
  { id: "market", title: "分享与复用", text: "找到适合自己的成熟功能和工作台。" },
  { id: "tools", title: "连接外部工具", text: "按需要连接服务，扩展助手能做的事。" },
  { id: "progress", title: "查看执行结果", text: "分清聊天面板与项目阶段的成果。" }
] as const
