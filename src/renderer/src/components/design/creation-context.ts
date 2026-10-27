import type { DesignCreationSelection } from "./types"

/** Keep creation references out of the chat input while carrying them into the first run. */
export function buildDesignCreationContext(selection?: DesignCreationSelection | null): string {
  if (!selection) return ""
  const { template, requirement } = selection
  const references: string[] = []
  if (template.mode !== "none" && template.package) {
    references.push(
      `页面模板包：${template.name || "上传模板"}；入口：${template.package.entryPath}。宿主会准备本地依赖并提供入口文件位置，请保留模板框架、组件库与主题，按用户需求修改页面。`
    )
  } else if (template.mode !== "none" && template.html) {
    references.push(
      `页面模板：${template.name || "上传模板"}。参考其页面结构和信息层级，按用户需求替换示例内容。\n${template.html}`
    )
  }
  if (requirement.mode === "select" && requirement.requirement) {
    references.push(
      `命名空间：${requirement.pathName}（${requirement.namespaceId}）`,
      `需求特性：${requirement.requirement.title}（${requirement.requirement.code}）`,
      ...requirement.implementationDetails.map(
        (detail) => `实施详情：${detail.title}（${detail.code}）`
      )
    )
  }
  return references.length ? `\n\n---\n[创建设计时选择的参考资料]\n${references.join("\n\n")}` : ""
}
