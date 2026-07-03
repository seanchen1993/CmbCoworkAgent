import assert from "node:assert/strict"

import {
  ensureTextBundleEvolverMarker,
  nextSkillVersion,
  readSkillBundleVersion,
  readSkillVersion,
  type TextBundleFile
} from "../src/renderer/src/lib/skill-bundle-diff"

function skill(version: string | null, body = "# s\n\nbody\n"): string {
  const versionLine = version === null ? "" : `version: ${version}\n`
  return `---\nname: s\ndescription: d\n${versionLine}---\n\n${body}`
}

function versionOf(files: TextBundleFile[]): string | null {
  const md = files.find((f) => f.path === "SKILL.md")
  return md ? readSkillVersion(md.content) : null
}

// 1) nextSkillVersion 与后端 _next_version 对齐。
function testNextVersion(): void {
  assert.equal(nextSkillVersion("v1.0.3"), "v1.0.4")
  assert.equal(nextSkillVersion("1.0.3"), "v1.0.4", "无 v 前缀也能 bump")
  assert.equal(nextSkillVersion("v2.5.9"), "v2.5.10")
  assert.equal(nextSkillVersion(null), "v1.0.1", "缺省 -> v1.0.1")
  assert.equal(nextSkillVersion(""), "v1.0.1")
  assert.equal(nextSkillVersion("1.0"), "v1.0.1", "非标准 -> v1.0.1")
}

// 2) readSkillBundleVersion 读取 base 源版本。
function testReadBaseVersion(): void {
  const base: TextBundleFile[] = [{ path: "SKILL.md", content: skill("v1.0.3") }]
  assert.equal(readSkillBundleVersion(base), "v1.0.3")
  assert.equal(readSkillBundleVersion([{ path: "SKILL.md", content: skill(null) }]), null)
}

// 3) 关键：从 source(base) +1，候选已是 source+1 也不会变成 source+2。
function testBumpFromSourceNotCandidate(): void {
  const sourceVersion = "v1.0.3"
  // 候选 SKILL.md 已经是 source+1 = v1.0.4（后端创建时 bump 过）
  const mergedAcceptAll: TextBundleFile[] = [{ path: "SKILL.md", content: skill("v1.0.4") }]
  const out = ensureTextBundleEvolverMarker(mergedAcceptAll, sourceVersion)
  assert.equal(versionOf(out), "v1.0.4", "从 source bump 应稳定为 v1.0.4，而非 v1.0.5")
}

// 4) 关键：审批人拒绝了 frontmatter 块（版本回退到 source），仍被强制 bump 回 source+1。
function testRejectedFrontmatterStillBumped(): void {
  const sourceVersion = "v1.0.3"
  const mergedRejected: TextBundleFile[] = [{ path: "SKILL.md", content: skill("v1.0.3") }] // 退回 source
  const out = ensureTextBundleEvolverMarker(mergedRejected, sourceVersion)
  assert.equal(versionOf(out), "v1.0.4", "拒绝版本块也要强制 source+1，杜绝版本停滞")
}

// 5) 幂等：多次保存仍是 source+1，不会持续累加。
function testIdempotent(): void {
  const sourceVersion = "v1.0.3"
  let files: TextBundleFile[] = [{ path: "SKILL.md", content: skill("v9.9.9") }]
  for (let i = 0; i < 3; i++) files = ensureTextBundleEvolverMarker(files, sourceVersion)
  assert.equal(versionOf(files), "v1.0.4", "反复保存恒为 source+1")
}

// 6) 始终写入 evolved-by 标识。
function testEvolverMarker(): void {
  const out = ensureTextBundleEvolverMarker([{ path: "SKILL.md", content: skill("v1.0.3") }], "v1.0.3")
  assert.ok(out[0].content.includes("evolved-by: CMBDevClaw Trace Evolver"), "应写入 evolved-by")
}

// 7) 未提供源版本时不动 version（EvolutionPanel 空 base 场景）。
function testNoSourceLeavesVersion(): void {
  const out = ensureTextBundleEvolverMarker([{ path: "SKILL.md", content: skill("v2.0.0") }], null)
  assert.equal(versionOf(out), "v2.0.0", "无源版本时保留候选版本")
  const out2 = ensureTextBundleEvolverMarker([{ path: "SKILL.md", content: skill("v2.0.0") }])
  assert.equal(versionOf(out2), "v2.0.0", "不传参时保留候选版本（向后兼容）")
}

const tests: Array<[string, () => void]> = [
  ["nextSkillVersion 与后端对齐", testNextVersion],
  ["读取 base 源版本", testReadBaseVersion],
  ["从 source 而非候选 bump（不累加）", testBumpFromSourceNotCandidate],
  ["拒绝 frontmatter 块仍强制 bump", testRejectedFrontmatterStillBumped],
  ["多次保存幂等", testIdempotent],
  ["写入 evolved-by 标识", testEvolverMarker],
  ["无源版本时保留版本", testNoSourceLeavesVersion]
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
