import { parse } from "parse5"
import { elements, attribute, type DesignTweaksState } from "./design-tweaks"

export interface DesignDraftPreview {
  runId: string
  revision: number
  html: string
  draftPath: string
  phase: "scaffold" | "sections" | "validating"
  status: "building" | "incomplete"
  sections: string[]
  completedSections: string[]
  totalSections: number
  tweaks: DesignTweaksState | null
  createdAt: number
  updatedAt: number
}
export interface DesignGenerationMetrics {
  startedAt?: number
  firstTokenAt?: number
  firstWriteAt?: number
  scaffoldVisibleAt?: number
  firstSectionVisibleAt?: number
  lastSectionVisibleAt?: number
  validationStartedAt?: number
  validationFinishedAt?: number
  finishedAt?: number
  previewBytes?: number
  previewCount?: number
}

export function inspectDesignDocument(html: string, expected: string[] = []) {
  const issues: string[] = []
  const complete = /(?:<!doctype\b|<html[\s>])/i.test(html) && /<\/html>\s*$/i.test(html.trim())
  if (!complete) issues.push("HTML 文档尚未完整闭合")
  if (/<[|｜][^>]*[|｜]>/u.test(html)) issues.push("包含模型控制 token")
  const all = elements(parse(html, { sourceCodeLocationInfo: true }))
  if (!all.find((el) => el.tagName === "html")?.sourceCodeLocation?.endTag)
    issues.push("HTML 根节点尚未完整闭合")
  const sections: string[] = [],
    completedSections: string[] = []
  for (const el of all.filter((node) => attribute(node, "data-design-section") !== undefined)) {
    const id = attribute(el, "data-design-section")!
    if (!/^[a-zA-Z][\w.-]{0,79}$/.test(id) || sections.includes(id))
      issues.push("区块 ID 为空、重复或无效")
    sections.push(id)
    if (!el.sourceCodeLocation?.endTag) issues.push(`区块 ${id} 尚未闭合`)
    if (attribute(el, "data-design-pending") === undefined) completedSections.push(id)
  }
  for (const id of expected) if (!sections.includes(id)) issues.push(`缺少预期区块 ${id}`)
  const pending = all.some((el) => attribute(el, "data-design-pending") !== undefined)
  const building = all.some((el) => attribute(el, "data-design-build") !== undefined)
  return {
    valid: !issues.length,
    finalizable: !issues.length && !pending && !building,
    issues,
    sections,
    completedSections,
    totalSections: sections.length
  }
}

export const isFinalizableDesignDraft = (html: string, expected: string[] = []): boolean =>
  inspectDesignDocument(html, expected).finalizable
