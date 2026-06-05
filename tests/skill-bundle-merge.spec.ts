import assert from "node:assert/strict"

import {
  buildFileMergePlans,
  buildMergedFiles,
  defaultDecisions,
  hasConflictMarkers,
  reconstructFile,
  segmentFile,
  summarizeFile,
  threeWayMergeFile,
  type HunkSide
} from "../src/renderer/src/lib/skill-bundle-merge"

function changeIds(base: string, candidate: string): string[] {
  return segmentFile(base, candidate)
    .filter((region) => region.type === "change")
    .map((region) => (region.type === "change" ? region.id : ""))
}

function pickAll(base: string, candidate: string, side: HunkSide): Record<string, HunkSide> {
  const decisions: Record<string, HunkSide> = {}
  for (const id of changeIds(base, candidate)) decisions[id] = side
  return decisions
}

// 1) 往返不变量：全选一侧必须精确还原该侧（含行尾换行）。
function testRoundTrip(): void {
  const base = "---\nname: s\nversion: 1.0.0\n---\n\n# s\n\n- one\n"
  const candidate = "---\nname: s\nversion: 1.0.1\nevolved-by: X\n---\n\n# s\n\n- one\n- two\n"
  const regions = segmentFile(base, candidate)
  assert.equal(reconstructFile(regions, pickAll(base, candidate, "base")), base, "全选 base 应还原 base")
  assert.equal(
    reconstructFile(regions, pickAll(base, candidate, "candidate")),
    candidate,
    "全选 candidate 应还原 candidate"
  )
}

// 2) 旧版 bug 核心：纯插入(空旧版)、且插入行在别处已存在 -> 采纳必须真的插入。
//    旧实现的 "findLineSequence 命中即 return" guard 会把这种采纳吞掉。
function testEmptyOldInsertionWithDuplicateLine(): void {
  const base = "## Notes\n\n- Always verify.\n"
  // 候选在已有 "- Always verify." 之前再插一条同样的提醒
  const candidate = "## Notes\n\n- Always verify.\n- Always verify.\n"
  const regions = segmentFile(base, candidate)
  const accepted = reconstructFile(regions, pickAll(base, candidate, "candidate"))
  assert.equal(accepted, candidate, "重复行的纯插入采纳后必须出现两行")
  const occurrences = accepted.split("\n").filter((line) => line === "- Always verify.").length
  assert.equal(occurrences, 2, "采纳后应有 2 条 '- Always verify.'")
}

// 3) 插入一个空行也要生效（旧实现里空行会被 guard 当成已存在而吞掉）。
function testInsertBlankLine(): void {
  const base = "# a\n# b\n"
  const candidate = "# a\n\n# b\n"
  const regions = segmentFile(base, candidate)
  assert.equal(
    reconstructFile(regions, pickAll(base, candidate, "candidate")),
    candidate,
    "采纳插入空行应生效"
  )
}

// 4) 多区块、混合决策：与点击顺序无关，结果确定。
function testMixedDecisionsOrderIndependent(): void {
  const base = "a\nb\nc\nd\ne\n"
  const candidate = "a\nB\nc\nD\ne\n" // 两个变更区块：b->B, d->D
  const ids = changeIds(base, candidate)
  assert.equal(ids.length, 2, "应识别出 2 个变更区块")
  const regions = segmentFile(base, candidate)
  // 只采纳第二个区块(d->D)，第一个保留 base
  const decisions: Record<string, HunkSide> = { [ids[0]]: "base", [ids[1]]: "candidate" }
  const result = reconstructFile(regions, decisions)
  assert.equal(result, "a\nb\nc\nD\ne\n", "只采纳第二块时结果确定")
  // 反过来填充顺序无关（纯函数）：等价 decisions 必得同结果
  const decisions2: Record<string, HunkSide> = {}
  decisions2[ids[1]] = "candidate"
  decisions2[ids[0]] = "base"
  assert.equal(reconstructFile(regions, decisions2), result, "决策填充顺序不影响结果")
}

// 5) 默认决策为全采纳。
function testDefaultDecisionsAcceptAll(): void {
  const base = "a\nb\n"
  const candidate = "a\nB\n"
  const regions = segmentFile(base, candidate)
  const decisions = defaultDecisions(regions)
  assert.equal(reconstructFile(regions, decisions), candidate, "默认应全采纳候选")
}

// 6) 三方合并：非重叠改动 -> 干净合并，无冲突。
function testThreeWayClean(): void {
  const base = "name: s\nversion: 1.0.0\n\n- one\n"
  const theirs = "name: s\nversion: 1.0.1\n\n- one\n" // 候选改版本号
  const ours = "name: s\nversion: 1.0.0\n\n- one\n- mine\n" // 审批人加了一行
  const { content, conflict } = threeWayMergeFile(ours, base, theirs)
  assert.equal(conflict, false, "非重叠改动不应冲突")
  assert.ok(content.includes("version: 1.0.1"), "应吸收候选的版本改动")
  assert.ok(content.includes("- mine"), "应保留审批人的手改")
  assert.ok(!hasConflictMarkers(content), "干净合并不应有冲突标记")
}

// 7) 三方合并：双方改同一行 -> 冲突 + git 标记。
function testThreeWayConflict(): void {
  const base = "description: old\nversion: 1.0.0\n"
  const theirs = "description: from-candidate\nversion: 1.0.1\n"
  const ours = "description: from-reviewer\nversion: 1.0.0\n"
  const { content, conflict } = threeWayMergeFile(ours, base, theirs)
  assert.equal(conflict, true, "双方改同一行应冲突")
  assert.ok(hasConflictMarkers(content), "冲突应带 git 风格标记")
  assert.ok(content.includes("from-reviewer") && content.includes("from-candidate"), "应保留双方原文")
}

// 8) 文件级：新增文件被拒 -> 剔除；删除文件默认采纳 -> 剔除；修改文件保留。
function testBuildMergedFilesFileLevel(): void {
  const base = [
    { path: "SKILL.md", content: "# s\nbody\n" },
    { path: "references/keep.md", content: "old\n" }
  ]
  const candidate = [
    { path: "SKILL.md", content: "# s\nbody\nmore\n" }, // 修改
    { path: "references/new.md", content: "fresh\n" } // 新增（base 无）
    // references/keep.md 在候选中缺失 => 视为删除
  ]
  const plans = buildFileMergePlans(base, candidate)

  // 默认决策（全采纳）：新增被采纳、删除被采纳、修改被采纳
  const decisionsAcceptAll: Record<string, Record<string, HunkSide>> = {}
  for (const plan of plans) decisionsAcceptAll[plan.path] = defaultDecisions(plan.regions)
  const acceptAll = buildMergedFiles(plans, decisionsAcceptAll, {})
  const pathsAccept = acceptAll.map((f) => f.path).sort()
  assert.deepEqual(pathsAccept, ["SKILL.md", "references/new.md"], "全采纳：新增进、删除掉")
  assert.ok(acceptAll.find((f) => f.path === "SKILL.md")?.content.includes("more"), "修改被采纳")

  // 拒绝新增文件 + 保留待删除文件
  const decisions: Record<string, Record<string, HunkSide>> = {}
  for (const plan of plans) {
    const map: Record<string, HunkSide> = {}
    for (const region of plan.regions) {
      if (region.type === "change") {
        // new.md / keep.md 的变更块选 base（拒绝新增 / 拒绝删除），SKILL.md 采纳
        map[region.id] = plan.path === "SKILL.md" ? "candidate" : "base"
      }
    }
    decisions[plan.path] = map
  }
  const custom = buildMergedFiles(plans, decisions, {})
  const paths = custom.map((f) => f.path).sort()
  assert.deepEqual(paths, ["SKILL.md", "references/keep.md"], "拒绝新增、保留待删文件")
}

// 9) 手动编辑覆盖优先。
function testEditedOverride(): void {
  const base = [{ path: "SKILL.md", content: "# s\n" }]
  const candidate = [{ path: "SKILL.md", content: "# s\nx\n" }]
  const plans = buildFileMergePlans(base, candidate)
  const out = buildMergedFiles(plans, {}, { "SKILL.md": "# manual\n" })
  assert.equal(out[0].content, "# manual\n", "手动覆盖应优先于区块重建")
}

// 10) summarizeFile 统计正确。
function testSummarize(): void {
  const base = "a\nb\nc\n"
  const candidate = "a\nB\nC\n"
  const plans = buildFileMergePlans(
    [{ path: "f", content: base }],
    [{ path: "f", content: candidate }]
  )
  const plan = plans[0]
  const all = summarizeFile(plan, defaultDecisions(plan.regions), false)
  assert.equal(all.total, all.accepted, "默认全采纳：accepted==total")
  assert.ok(all.total >= 1, "应有变更块")
  const none = summarizeFile(plan, {}, false)
  // 空决策默认按候选 => accepted==total（与 reconstruct 默认一致）
  assert.equal(none.accepted, none.total, "空决策视为默认全采纳")
}

const tests: Array<[string, () => void]> = [
  ["round-trip 全选一侧精确还原", testRoundTrip],
  ["空旧版+重复行的纯插入采纳生效", testEmptyOldInsertionWithDuplicateLine],
  ["采纳插入空行生效", testInsertBlankLine],
  ["多区块混合决策与顺序无关", testMixedDecisionsOrderIndependent],
  ["默认决策全采纳", testDefaultDecisionsAcceptAll],
  ["三方合并-非重叠干净合并", testThreeWayClean],
  ["三方合并-冲突带标记", testThreeWayConflict],
  ["文件级新增/删除/修改", testBuildMergedFilesFileLevel],
  ["手动编辑覆盖优先", testEditedOverride],
  ["summarizeFile 统计", testSummarize]
]

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`PASS | ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL | ${name}`)
    console.error("  " + (error instanceof Error ? error.message : String(error)))
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exit(1)
