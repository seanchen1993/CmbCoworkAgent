export const SPARKS_DOCUMENTS = [
  { file: "README.md", title: "概览" },
  { file: "project-platform.md", title: "内置功能与项目任务" },
  { file: "project-plugin-cookbook.md", title: "制作项目模板" },
  { file: "create.md", title: "创建与修改" },
  { file: "interface.md", title: "绘制界面" },
  { file: "events-and-api.md", title: "事件与 API" },
  { file: "reuse.md", title: "安装与复用" },
  { file: "migration.md", title: "适配已有插件" },
  { file: "plugin-cookbook.md", title: "插件开发入门" },
  { file: "troubleshooting.md", title: "排障与限制" },
  { file: "reference.md", title: "开发参考" },
  { file: "creator-plugin-workflow.md", title: "插件创造与使用" },
  { file: "business-mod-assembly.md", title: "业务 Mods 组装" },
  { file: "platform-authoring-lifecycle.md", title: "试用与版本恢复" },
  { file: "stage-debug-mod-extension.md", title: "阶段调试扩展" },
  { file: "autobiz-composition-example.md", title: "AutoBiz 组合示例" }
] as const

export type SparksDocumentFile = (typeof SPARKS_DOCUMENTS)[number]["file"]

export function sparksDocumentLink(href: string):
  | { kind: "chapter"; file: SparksDocumentFile }
  | { kind: "external"; url: string }
  | { kind: "reference" } {
  const file = href.replace(/^\.\//, "")
  const chapter = SPARKS_DOCUMENTS.find((item) => item.file === file)
  if (chapter) return { kind: "chapter", file: chapter.file }
  try {
    const url = new URL(href)
    if (url.protocol === "https:" && !url.username && !url.password)
      return { kind: "external", url: url.href }
  } catch {
    // Repository references are labels, never arbitrary filesystem or app navigation.
  }
  return { kind: "reference" }
}
