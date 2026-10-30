import { parse } from "parse5"
import { attribute, elements } from "./design-tweaks"

interface DesignVariantState {
  singleVariant?: boolean
  selectedDesignSystemId?: string | null
  artifactMetadata?: { designSystemId?: string | null } | null
}

export function isSingleDesignVariant(
  state: DesignVariantState,
  meta?: { designSystemId?: string | null }
): boolean {
  return !!(
    state.singleVariant ||
    state.selectedDesignSystemId ||
    state.artifactMetadata?.designSystemId ||
    meta?.designSystemId
  )
}

export const SINGLE_DESIGN_VARIANT_PROMPT =
  "This conversation is permanently single-variant because it uses DESIGN.md. Always produce exactly ONE canonical artifact, including redesigns, retries and repairs. Never create A/B/C alternatives or variation-a/variation-b/variation-c wrappers, even if an earlier instruction asks for them. Change the current page in place; a visual style change still produces one page."

export function designVariantPolicyIssue(html: string, singleVariant: boolean): string | undefined {
  if (!singleVariant) return undefined
  if (elements(parse(html)).some((node) => /^variation-[abc]$/i.test(attribute(node, "id") ?? "")))
    return "当前对话使用 DESIGN.md，只允许单一方案。请保留一个完整页面，移除 A/B/C 方案及 variation-a/b/c 容器，保留页面功能和样式。"
  return undefined
}
