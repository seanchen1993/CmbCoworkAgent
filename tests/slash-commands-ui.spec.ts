/**
 * Unit tests for renderer slash-command filtering.
 *
 * Run:
 *   npx tsx tests/slash-commands-ui.spec.ts
 */

import { buildSlashPopoverMode } from "../src/renderer/src/features/slash-commands/useSlashCommands.ts"
import type { SkillMetadata } from "../src/renderer/src/types.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

function assertArrayEqual<T>(actual: T[], expected: T[], message: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText)
    throw new Error(`${message}: expected ${expectedText}, got ${actualText}`)
}

const skills: SkillMetadata[] = [
  {
    name: "Browser",
    description: "Open and control the in-app browser",
    path: "/skills/browser/SKILL.md",
    source: "user"
  },
  {
    name: "Documents",
    description: "Create and edit document files",
    path: "/skills/documents/SKILL.md",
    source: "project"
  }
]

function testRootSlashShowsGoalAboveSkills(): void {
  const mode = buildSlashPopoverMode({ input: "/", skills, skillSelected: false })

  assertEqual(mode.kind, "slash", "root slash should open popover")
  if (mode.kind !== "slash") return

  assertEqual(mode.commands[0]?.id, "goal", "goal should be the first general command")
  assertEqual(mode.skills.length, 2, "skills should still be shown")
}

function testPlainTextKeepsPopoverClosed(): void {
  const mode = buildSlashPopoverMode({ input: "hello /", skills, skillSelected: false })
  assertEqual(mode.kind, "closed", "plain text should not open slash popover")
}

function testGoalFilterShowsGoalCommand(): void {
  const mode = buildSlashPopoverMode({ input: "/go", skills, skillSelected: false })

  assertEqual(mode.kind, "slash", "goal filter should keep popover open")
  if (mode.kind !== "slash") return

  assertEqual(mode.commands.length, 1, "goal filter should match goal command")
  assertEqual(mode.commands[0]?.usage, "/goal <目标/完成标准>", "goal command should show usage")
  assertEqual(mode.commands[0]?.insertText, "/goal ", "goal command should insert editable text")
}

function testSkillNameFilteringStillWorks(): void {
  const mode = buildSlashPopoverMode({ input: "/bro", skills, skillSelected: false })

  assertEqual(mode.kind, "slash", "skill filter should keep popover open")
  if (mode.kind !== "slash") return

  assertEqual(mode.commands.length, 0, "skill-only filter should not show unrelated commands")
  assertArrayEqual(
    mode.skills.map((skill) => skill.name),
    ["Browser"],
    "skill name filter should preserve previous behavior"
  )
}

function testSkillDescriptionFilteringStillWorks(): void {
  const mode = buildSlashPopoverMode({ input: "/document files", skills, skillSelected: false })
  assertEqual(mode.kind, "closed", "filters with whitespace should close before matching")

  const oneWordMode = buildSlashPopoverMode({ input: "/document", skills, skillSelected: false })
  assertEqual(oneWordMode.kind, "slash", "one-word description filter should stay open")
  if (oneWordMode.kind !== "slash") return

  assertArrayEqual(
    oneWordMode.skills.map((skill) => skill.name),
    ["Documents"],
    "skill description/name filter should preserve previous behavior"
  )
}

function testSkillFilteringIsCaseInsensitive(): void {
  const mode = buildSlashPopoverMode({ input: "/BROW", skills, skillSelected: false })

  assertEqual(mode.kind, "slash", "uppercase filter should keep popover open")
  if (mode.kind !== "slash") return

  assertArrayEqual(
    mode.skills.map((skill) => skill.name),
    ["Browser"],
    "skill filter should remain case-insensitive"
  )
}

function testWhitespaceClosesPopoverForCommandSubmission(): void {
  const mode = buildSlashPopoverMode({ input: "/goal ", skills, skillSelected: false })
  assertEqual(mode.kind, "closed", "space after slash command should close popover")
}

function testUnknownSlashKeepsOpenWithNoMatches(): void {
  const mode = buildSlashPopoverMode({ input: "/does-not-exist", skills, skillSelected: false })

  assertEqual(mode.kind, "slash", "unknown slash filter should keep popover open")
  if (mode.kind !== "slash") return

  assertEqual(mode.commands.length, 0, "unknown slash should not match commands")
  assertEqual(mode.skills.length, 0, "unknown slash should not match skills")
}

function testSelectedSkillKeepsPopoverClosed(): void {
  const mode = buildSlashPopoverMode({ input: "/", skills, skillSelected: true })
  assertEqual(mode.kind, "closed", "selected skill chip should keep popover closed")
}

function main(): void {
  const tests = [
    testRootSlashShowsGoalAboveSkills,
    testPlainTextKeepsPopoverClosed,
    testGoalFilterShowsGoalCommand,
    testSkillNameFilteringStillWorks,
    testSkillDescriptionFilteringStillWorks,
    testSkillFilteringIsCaseInsensitive,
    testWhitespaceClosesPopoverForCommandSubmission,
    testUnknownSlashKeepsOpenWithNoMatches,
    testSelectedSkillKeepsPopoverClosed
  ]

  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

main()
