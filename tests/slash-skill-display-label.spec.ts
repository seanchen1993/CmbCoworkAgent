/**
 * Regression tests for slash popover labelling + duplicate detection.
 *
 * Run:
 *   npx tsx tests/slash-skill-display-label.spec.ts
 */

import {
  computeDuplicateSkillNames,
  getDisambiguationLabel,
  getSourceLabel
} from "../src/renderer/src/features/slash-commands/skill-display-label.ts"
import type { SkillMetadata } from "../src/renderer/src/types.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function skill(partial: Partial<SkillMetadata> & Pick<SkillMetadata, "name">): SkillMetadata {
  return {
    description: "",
    path: `C:/skills/${partial.name}/SKILL.md`,
    source: "user",
    ...partial
  }
}

function testSourceLabel(): void {
  assert(
    getSourceLabel(skill({ name: "review", source: "project" })) === "系统",
    "project source labels as 系统"
  )
  assert(
    getSourceLabel(skill({ name: "review", source: "user" })) === "个人",
    "user source labels as 个人"
  )
  assert(
    getSourceLabel(skill({ name: "review", source: "user", pluginName: "Anthropic Code Review" })) ===
      "Anthropic Code Review",
    "pluginName wins over source"
  )
  assert(
    getSourceLabel(skill({ name: "review", source: "user", pluginId: "demo-plugin" })) === "demo-plugin",
    "pluginId used when pluginName missing"
  )
  console.log("PASS getSourceLabel covers project/user/plugin cases")
}

function testDisambiguationPlugin(): void {
  assert(
    getDisambiguationLabel(
      skill({
        name: "review",
        path: "",
        pluginName: "Anthropic Code Review",
        pluginId: "anthropic-review"
      })
    ) === "Anthropic Code Review (anthropic-review)",
    "plugin name + id combine when both present and different"
  )
  assert(
    getDisambiguationLabel(
      skill({ name: "review", path: "", pluginName: "shared", pluginId: "shared" })
    ) === "shared",
    "no duplication when plugin name equals id"
  )
  assert(
    getDisambiguationLabel(skill({ name: "review", path: "", pluginName: "Reviewer" })) ===
      "Reviewer",
    "pluginName alone is used as label"
  )
  assert(
    getDisambiguationLabel(skill({ name: "review", path: "", pluginId: "rev-plugin" })) ===
      "rev-plugin",
    "pluginId alone is used as label"
  )
  console.log("PASS getDisambiguationLabel handles plugin identity")
}

function testDisambiguationPath(): void {
  const fromAbsPath = getDisambiguationLabel(
    skill({ name: "review", path: "C:/Users/me/.claude/skills/review/SKILL.md" })
  )
  assert(
    fromAbsPath === "skills/review",
    `expected "skills/review", got ${JSON.stringify(fromAbsPath)}`
  )

  const fromRelPath = getDisambiguationLabel(
    skill({
      name: "review",
      path: "C:/unused/SKILL.md",
      relativePath: "personal/review/SKILL.md"
    })
  )
  assert(
    fromRelPath === "personal/review",
    `relativePath should win over path; got ${JSON.stringify(fromRelPath)}`
  )

  const backslashPath = getDisambiguationLabel(
    skill({ name: "review", path: "C:\\Users\\me\\skills\\review\\SKILL.md" })
  )
  assert(
    backslashPath === "skills/review",
    `backslashes should normalise; got ${JSON.stringify(backslashPath)}`
  )

  const caseInsensitive = getDisambiguationLabel(
    skill({ name: "review", path: "C:/skills/review/skill.md" })
  )
  assert(
    caseInsensitive === "skills/review",
    `lowercase skill.md should also be stripped; got ${JSON.stringify(caseInsensitive)}`
  )

  console.log("PASS getDisambiguationLabel derives readable path hints")
}

function testDisambiguationCombined(): void {
  // Two skills with identical plugin identity must still differ in subline if
  // the path tail differs.
  const combined = getDisambiguationLabel(
    skill({
      name: "review",
      pluginName: "Plugin A",
      pluginId: "plugin-a",
      relativePath: "category/review/SKILL.md"
    })
  )
  assert(
    combined === "Plugin A (plugin-a) · category/review",
    `expected combined plugin + path label, got ${JSON.stringify(combined)}`
  )

  // Plugin-only when no usable path remains.
  const pluginOnly = getDisambiguationLabel(
    skill({ name: "review", path: "", pluginName: "Plugin A", pluginId: "plugin-a" })
  )
  assert(
    pluginOnly === "Plugin A (plugin-a)",
    `expected plugin-only label, got ${JSON.stringify(pluginOnly)}`
  )

  console.log("PASS getDisambiguationLabel combines plugin identity with path tail")
}

function testDisambiguationFallback(): void {
  const empty = getDisambiguationLabel(
    skill({ name: "review", path: "", relativePath: undefined })
  )
  assert(empty === null, `no path info should return null; got ${JSON.stringify(empty)}`)

  const onlySkillMd = getDisambiguationLabel(
    skill({ name: "review", path: "SKILL.md", relativePath: undefined })
  )
  assert(
    onlySkillMd === null,
    `path containing only SKILL.md should return null; got ${JSON.stringify(onlySkillMd)}`
  )

  // `relativePath: ""` (empty string) is falsy, so the helper must fall
  // through to `path` instead of treating the empty string as the path-tail
  // source — otherwise the subline would silently disappear.
  const emptyRel = getDisambiguationLabel(
    skill({
      name: "review",
      relativePath: "",
      path: "C:/Users/me/.claude/skills/review/SKILL.md"
    })
  )
  assert(
    emptyRel === "skills/review",
    `empty-string relativePath must defer to path; got ${JSON.stringify(emptyRel)}`
  )

  console.log("PASS getDisambiguationLabel returns null when nothing useful remains")
}

function testComputeDuplicateSkillNames(): void {
  const list: SkillMetadata[] = [
    skill({ name: "Review", pluginId: "a" }),
    skill({ name: "review", pluginId: "b" }),
    skill({ name: "format" }),
    skill({ name: "  format  " }) // whitespace should not protect from dedup
  ]
  const dups = computeDuplicateSkillNames(list)
  assert(dups.has("review"), "case-insensitive collision must be flagged")
  assert(dups.has("format"), "whitespace-only difference must be flagged")
  assert(dups.size === 2, `expected 2 duplicate buckets, got ${dups.size}`)

  const unique = computeDuplicateSkillNames([
    skill({ name: "alpha" }),
    skill({ name: "beta" })
  ])
  assert(unique.size === 0, "no duplicates should produce empty set")

  const empty = computeDuplicateSkillNames([])
  assert(empty.size === 0, "empty list should produce empty set")

  console.log("PASS computeDuplicateSkillNames flags case/whitespace duplicates only")
}

testSourceLabel()
testDisambiguationPlugin()
testDisambiguationPath()
testDisambiguationCombined()
testDisambiguationFallback()
testComputeDuplicateSkillNames()
