import {
  designSystemKey,
  isTemplateVisible,
  normalizeTemplateSystemKey,
  type DesignTemplateReference
} from "../../../shared/design-template"
import type { DesignSystemInfo } from "../../../shared/design-system"
import type { DesignTemplatePackages } from "./template-packages"

export function resolveTemplateAssociation(
  value: unknown,
  systems: DesignSystemInfo[]
): string | null {
  const key = normalizeTemplateSystemKey(value)
  if (key && !systems.some((system) => designSystemKey(system) === key))
    throw new Error("关联的设计系统不存在，请刷新后重新选择")
  return key
}

/** Resolve current catalog metadata rather than trusting the renderer's association. */
export function validateTemplateSelection(
  selection:
    | {
        mode: "select" | "upload" | "none"
        package?: DesignTemplateReference
        builtinPath?: string
        name?: string | null
        html?: string | null
      }
    | null
    | undefined,
  currentSystem: DesignSystemInfo | null | undefined,
  packages: DesignTemplatePackages,
  builtins: Array<{
    path: string
    name: string
    previewHtml: string
    designSystemKey?: string | null
    package?: DesignTemplateReference
  }>
): void {
  if (!selection || selection.mode === "none") return
  const template =
    selection.mode === "upload" && selection.package
      ? packages.read(selection.package)
      : selection.mode === "select"
        ? builtins.find((item) =>
            selection.builtinPath
              ? item.path === selection.builtinPath
              : item.name === selection.name && item.previewHtml === selection.html
          )
        : undefined
  if (selection.builtinPath && !template) throw new Error("模板不存在，请刷新后重新选择")
  if (template && !isTemplateVisible(template, designSystemKey(currentSystem)))
    throw new Error("模板不属于当前设计系统，请刷新后重新选择")
  if (selection.mode === "select" && template && "previewHtml" in template) {
    // Use the host's package identity, never a renderer-supplied reference or preview base URL.
    selection.package = template.package ? { ...template.package } : undefined
    selection.html = template.previewHtml
  }
}
