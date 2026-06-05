/**
 * Skill bundle 三方合并的纯逻辑层（无 React，可单测）。
 *
 * 设计要点（替代旧版基于字符串搜索的 applyBlockChoice/getBlockState）：
 *
 * 1. 逐块采纳走 base↔candidate 的 2-way 分段（node-diff3 `diffComm`）。
 *    每个变更区块带稳定 id 和 base/candidate 两侧原文，"采纳/保留" 只是切换该
 *    区块选用哪一侧。最终内容通过 **按区块顺序重建** 得到，绝不在文本里搜索定位。
 *    => 幂等、与点击顺序无关，彻底规避"空旧版/重复行导致采纳失效或插错位置"。
 *
 * 2. 真三方合并走 node-diff3 `mergeDiff3(ours, base, theirs)`，用于把候选的新改动
 *    合并进审批人已经手改过的草稿，自动消解非冲突改动并标出真正的冲突。
 */
import { diffComm, mergeDiff3 } from "node-diff3"

import type { TextBundleFile } from "./skill-bundle-diff"

export type HunkSide = "base" | "candidate"

export type MergeRegion =
  | { type: "context"; lines: string[] }
  | { type: "change"; id: string; baseLines: string[]; candidateLines: string[] }

export interface FileMergePlan {
  path: string
  presentInBase: boolean
  presentInCandidate: boolean
  /** base↔candidate 的有序分段（context / change）。 */
  regions: MergeRegion[]
  /** 该文件相对 base 是否有任何候选变更。 */
  hasChange: boolean
}

export interface ThreeWayMergeResult {
  content: string
  conflict: boolean
}

export interface FileMergeSummary {
  /** 变更区块总数。 */
  total: number
  /** 选用候选侧的区块数。 */
  accepted: number
  /** 是否被手动编辑（override 模式）。 */
  edited: boolean
}

/**
 * 拆分为行。保留行尾换行信息：内容以 "\n" 结尾时，数组末尾会保留一个空串元素，
 * 这样 splitLines/joinLines 能精确往返（round-trip）。
 */
export function splitLines(content: string): string[] {
  if (content === "") return []
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
}

export function joinLines(lines: string[]): string {
  return lines.join("\n")
}

/**
 * 用 node-diff3 `diffComm` 把 base 与 candidate 拆成有序区块：
 * - common  -> context 区块（两侧一致）
 * - 差异块  -> change 区块（buffer1=base 侧，buffer2=candidate 侧，可能一侧为空）
 *
 * 不变量：
 *   reconstruct(regions, 全选 base)      === base
 *   reconstruct(regions, 全选 candidate) === candidate
 */
export function segmentFile(base: string, candidate: string): MergeRegion[] {
  const parts = diffComm(splitLines(base), splitLines(candidate))
  const regions: MergeRegion[] = []
  let changeIndex = 0
  for (const part of parts) {
    if (part.common) {
      regions.push({ type: "context", lines: part.common })
    } else {
      changeIndex += 1
      regions.push({
        type: "change",
        id: String(changeIndex),
        baseLines: part.buffer1 ?? [],
        candidateLines: part.buffer2 ?? []
      })
    }
  }
  return regions
}

/**
 * 按区块顺序重建文件内容。change 区块缺省取 candidate 侧（采纳）。
 * 纯函数、按索引、无搜索 —— 与点击顺序无关且幂等。
 */
export function reconstructFile(
  regions: MergeRegion[],
  decisions: Record<string, HunkSide>
): string {
  const out: string[] = []
  for (const region of regions) {
    if (region.type === "context") {
      out.push(...region.lines)
      continue
    }
    const side = decisions[region.id] ?? "candidate"
    out.push(...(side === "candidate" ? region.candidateLines : region.baseLines))
  }
  return joinLines(out)
}

/** change 区块的默认决策：全部采纳候选侧。 */
export function defaultDecisions(regions: MergeRegion[]): Record<string, HunkSide> {
  const decisions: Record<string, HunkSide> = {}
  for (const region of regions) {
    if (region.type === "change") decisions[region.id] = "candidate"
  }
  return decisions
}

function toContentMap(files: TextBundleFile[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of files) map.set(file.path, file.content)
  return map
}

/** 为 base / candidate 的所有文件构建合并计划。 */
export function buildFileMergePlans(
  baseFiles: TextBundleFile[],
  candidateFiles: TextBundleFile[]
): FileMergePlan[] {
  const baseMap = toContentMap(baseFiles)
  const candidateMap = toContentMap(candidateFiles)
  const paths = Array.from(new Set([...baseMap.keys(), ...candidateMap.keys()])).sort((a, b) =>
    a.localeCompare(b)
  )
  return paths.map((path) => {
    const presentInBase = baseMap.has(path)
    const presentInCandidate = candidateMap.has(path)
    const baseContent = baseMap.get(path) ?? ""
    const candidateContent = candidateMap.get(path) ?? ""
    const regions = segmentFile(baseContent, candidateContent)
    return {
      path,
      presentInBase,
      presentInCandidate,
      regions,
      hasChange: regions.some((region) => region.type === "change")
    }
  })
}

/**
 * 根据每文件的决策 / 手动覆盖，产出最终的 bundle 文件列表。
 * - editedContent 优先（手动编辑模式）。
 * - 否则按区块决策重建。
 * - 重建后为空的文件视为"未新增/已删除"，从产物中剔除。
 */
export function buildMergedFiles(
  plans: FileMergePlan[],
  decisions: Record<string, Record<string, HunkSide>>,
  editedContent: Record<string, string>
): TextBundleFile[] {
  const files: TextBundleFile[] = []
  for (const plan of plans) {
    const override = editedContent[plan.path]
    const content =
      override !== undefined
        ? override
        : reconstructFile(plan.regions, decisions[plan.path] ?? defaultDecisions(plan.regions))
    if (content === "") continue
    files.push({ path: plan.path, content })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** change 区块的采纳情况统计，用于文件徽标。 */
export function summarizeFile(
  plan: FileMergePlan,
  decisions: Record<string, HunkSide> | undefined,
  edited: boolean
): FileMergeSummary {
  const changeRegions = plan.regions.filter(
    (region): region is Extract<MergeRegion, { type: "change" }> => region.type === "change"
  )
  const resolved = decisions ?? defaultDecisions(plan.regions)
  const accepted = changeRegions.filter((region) => (resolved[region.id] ?? "candidate") === "candidate")
    .length
  return { total: changeRegions.length, accepted, edited }
}

/**
 * 真三方合并：把候选 (theirs) 的改动合并进当前草稿 (ours)，以 base 为共同祖先。
 * 自动消解非冲突改动；冲突处以 git 风格标记保留三方原文供人工裁决。
 */
export function threeWayMergeFile(
  ours: string,
  base: string,
  theirs: string,
  labels: { ours: string; base: string; theirs: string } = {
    ours: "草稿(我的修改)",
    base: "原版",
    theirs: "候选"
  }
): ThreeWayMergeResult {
  const merged = mergeDiff3(splitLines(ours), splitLines(base), splitLines(theirs), {
    label: { a: labels.ours, o: labels.base, b: labels.theirs },
    excludeFalseConflicts: true
  })
  return { content: joinLines(merged.result), conflict: merged.conflict }
}

/** git 风格冲突标记检测（供 UI 判断某文件是否仍有未解决冲突）。 */
export function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<< /m.test(content) && /^>>>>>>> /m.test(content)
}
