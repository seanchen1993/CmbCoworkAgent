/**
 * Unit tests for renderer slash-command filtering.
 *
 * Run:
 *   npx tsx tests/slash-commands-ui.spec.ts
 */

import {
  buildSlashPopoverMode,
  isBareGoalSlashCommandInput,
  isGoalSlashCommandInput,
  isGoalSlashControlCommandInput,
  isGoalSlashResumeCommandInput,
  isGoalSlashTransportSensitiveControlCommandInput,
  isGoalTerminatingControlCommandInput,
  resolveGoalRuntimeComposerState
} from "../src/renderer/src/features/slash-commands/useSlashCommands.ts"
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

function testGoalSlashInputDetectionForRuntimeControls(): void {
  assertEqual(isGoalSlashCommandInput("/goal"), true, "bare /goal should be recognized")
  assertEqual(
    isGoalSlashCommandInput("  /goal pause  "),
    true,
    "/goal pause should be recognized"
  )
  assertEqual(
    isGoalSlashCommandInput("/goal clear"),
    true,
    "/goal clear should be recognized"
  )
  assertEqual(isGoalSlashCommandInput("/go"), false, "partial command should not be recognized")
  assertEqual(
    isGoalSlashCommandInput("/goalish"),
    false,
    "prefixed non-goal slash should not be recognized"
  )
}

function testGoalSlashControlCommandDetectionForValidationBypass(): void {
  assertEqual(isBareGoalSlashCommandInput("/goal"), true, "bare /goal should be detected")
  assertEqual(
    isBareGoalSlashCommandInput("/goal status"),
    false,
    "/goal status should not be treated as the bare command"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal"),
    true,
    "bare /goal should bypass model/workspace validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal status"),
    true,
    "/goal status should bypass model/workspace validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal pause"),
    true,
    "/goal pause should bypass model/workspace validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal clear"),
    true,
    "/goal clear should bypass model/workspace validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal cancel"),
    true,
    "/goal cancel alias should bypass model/workspace validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput(
      '/goal\n\n<attachment filename="notes.txt" type="text/plain" size="4">data</attachment>'
    ),
    false,
    "bare /goal with transport payload sets a goal and should not bypass validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput(
      '/goal pause\n\n<attachment filename="notes.txt" type="text/plain" size="4">data</attachment>'
    ),
    false,
    "/goal control commands with transport payload should not bypass validation"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal resume"),
    false,
    "/goal resume still requires a runnable thread context"
  )
  assertEqual(
    isGoalSlashResumeCommandInput("/goal resume"),
    true,
    "/goal resume should be recognized before legacy approval state is cleared"
  )
  assertEqual(
    isGoalSlashResumeCommandInput("/goal pause"),
    false,
    "/goal pause should not be treated as a resume command"
  )
  assertEqual(
    isGoalSlashResumeCommandInput(
      '/goal resume\n\n<attachment filename="notes.txt" type="text/plain" size="4">data</attachment>'
    ),
    false,
    "/goal resume with transport payload should not be treated as a plain resume command"
  )
  assertEqual(
    isGoalSlashTransportSensitiveControlCommandInput("/goal resume"),
    true,
    "/goal resume should still reject pending attachments or skills"
  )
  assertEqual(
    isGoalSlashTransportSensitiveControlCommandInput("/goal 检查 README"),
    false,
    "setting a new goal may carry pending attachments or skills"
  )
  assertEqual(
    isGoalSlashControlCommandInput("/goal 检查 README"),
    false,
    "setting a new goal should not bypass model/workspace validation"
  )

  assertEqual(
    isGoalTerminatingControlCommandInput("/goal pause"),
    true,
    "/goal pause should be treated as terminating the current run"
  )
  assertEqual(
    isGoalTerminatingControlCommandInput("/goal clear"),
    true,
    "/goal clear should be treated as terminating the current run"
  )
  assertEqual(
    isGoalTerminatingControlCommandInput("/goal cancel"),
    true,
    "/goal cancel alias should be treated as terminating the current run"
  )
  assertEqual(
    isGoalTerminatingControlCommandInput(
      '/goal clear\n\n<attachment filename="notes.txt" type="text/plain" size="4">data</attachment>'
    ),
    false,
    "terminating goal controls with transport payload should not discard the payload"
  )
  assertEqual(
    isGoalTerminatingControlCommandInput("/goal"),
    false,
    "status shorthand should not clear pending approval"
  )
  assertEqual(
    isGoalTerminatingControlCommandInput("/goal status"),
    false,
    "status command should not clear pending approval"
  )
}

function testRuntimeComposerStateBlocksPlainTextWhileLoading(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "hello world",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed"
  })

  assertEqual(state.inputDisabled, false, "loading alone should not disable typing")
  assertEqual(
    state.composerControlsDisabled,
    true,
    "loading should still disable attachments and non-goal controls"
  )
  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    false,
    "plain text should not be sendable while loading"
  )
  assertEqual(
    state.showGoalSendButtonWhileLoading,
    false,
    "plain text should not show the extra goal send button"
  )
}

function testRuntimeComposerStateAllowsGoalCommandsWhileLoading(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "  /goal pause  ",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true
  })

  assertEqual(state.inputDisabled, false, "goal commands should keep the textarea editable")
  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    true,
    "/goal control commands should be sendable while loading"
  )
  assertEqual(
    state.showGoalSendButtonWhileLoading,
    true,
    "/goal control commands should surface the send button while loading"
  )
  assertEqual(
    state.goalSendButtonDisabledWhileLoading,
    false,
    "goal send button should stay enabled when the slash popover is closed"
  )
}

function testRuntimeComposerStateBlocksGoalCommandsDuringOrdinaryLoading(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "/goal status",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: false
  })

  assertEqual(state.inputDisabled, false, "ordinary loading should still allow draft editing")
  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    false,
    "ordinary non-goal runs should not expose mid-run goal controls"
  )
  assertEqual(
    state.showGoalSendButtonWhileLoading,
    false,
    "ordinary non-goal runs should not show the goal send button"
  )
}

function testRuntimeComposerStateOnlyAllowsGoalControlCommandsWhileLoading(): void {
  const resumeState = resolveGoalRuntimeComposerState({
    input: "/goal resume",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true
  })
  assertEqual(
    resumeState.canSubmitGoalCommandWhileLoading,
    false,
    "/goal resume should not be submitted through the mid-run control side-channel"
  )

  const resumeWithTransportState = resolveGoalRuntimeComposerState({
    input: "/goal resume",
    isLoading: false,
    historyLoading: false,
    slashModeKind: "closed",
    hasPendingTransportPayload: true
  })
  assertEqual(
    resumeWithTransportState.canSubmitGoalCommandWhileLoading,
    false,
    "/goal resume with pending transport should be recognized as transport-sensitive"
  )

  const setState = resolveGoalRuntimeComposerState({
    input: "/goal 检查 README",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true
  })
  assertEqual(
    setState.canSubmitGoalCommandWhileLoading,
    false,
    "setting a new goal should wait until the current run finishes"
  )

  const bareGoalWithTransportState = resolveGoalRuntimeComposerState({
    input: "/goal",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true,
    hasPendingTransportPayload: true
  })
  assertEqual(
    bareGoalWithTransportState.canSubmitGoalCommandWhileLoading,
    false,
    "bare /goal with pending attachment or skill payload should not use the control side-channel"
  )

  const pauseWithTransportState = resolveGoalRuntimeComposerState({
    input: "/goal pause",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true,
    hasPendingTransportPayload: true
  })
  assertEqual(
    pauseWithTransportState.canSubmitGoalCommandWhileLoading,
    false,
    "/goal pause with pending attachment or skill payload should not use the control side-channel"
  )
}

function testRuntimeComposerStateBlocksGoalControlsForNonAgentLoading(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "/goal pause",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "closed",
    hasActiveGoal: true,
    goalControlAllowedWhileLoading: false
  })

  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    false,
    "scheduled/heartbeat/ChatX loading should not route /goal pause through agent goalControl"
  )
  assertEqual(
    state.showGoalSendButtonWhileLoading,
    false,
    "scheduled/heartbeat/ChatX loading should keep goal send hidden"
  )
}

function testRuntimeComposerStateDisablesGoalSendWhilePopoverOpen(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "/go",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "slash",
    hasActiveGoal: true
  })

  assertEqual(
    state.goalSendButtonDisabledWhileLoading,
    true,
    "open slash popover should still block accidental literal /xxx submission"
  )
  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    false,
    "partial /go filter should not be treated as a runnable goal command"
  )
}

function testRuntimeComposerStateAllowsBareGoalWhilePopoverOpen(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "/goal",
    isLoading: true,
    historyLoading: false,
    slashModeKind: "slash",
    hasActiveGoal: true
  })

  assertEqual(
    state.canSubmitGoalCommandWhileLoading,
    true,
    "bare /goal should remain a runnable status command while loading"
  )
  assertEqual(
    state.goalSendButtonDisabledWhileLoading,
    false,
    "bare /goal should not be disabled just because the slash popover is open"
  )
}

function testRuntimeComposerStateKeepsHistoryLoadingLocked(): void {
  const state = resolveGoalRuntimeComposerState({
    input: "/goal status",
    isLoading: true,
    historyLoading: true,
    slashModeKind: "closed",
    hasActiveGoal: true
  })

  assertEqual(state.inputDisabled, true, "history loading should still lock the textarea")
  assertEqual(
    state.composerControlsDisabled,
    true,
    "history loading should keep the composer controls disabled"
  )
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
    testSelectedSkillKeepsPopoverClosed,
    testGoalSlashInputDetectionForRuntimeControls,
    testGoalSlashControlCommandDetectionForValidationBypass,
    testRuntimeComposerStateBlocksPlainTextWhileLoading,
    testRuntimeComposerStateAllowsGoalCommandsWhileLoading,
    testRuntimeComposerStateBlocksGoalCommandsDuringOrdinaryLoading,
    testRuntimeComposerStateOnlyAllowsGoalControlCommandsWhileLoading,
    testRuntimeComposerStateBlocksGoalControlsForNonAgentLoading,
    testRuntimeComposerStateDisablesGoalSendWhilePopoverOpen,
    testRuntimeComposerStateAllowsBareGoalWhilePopoverOpen,
    testRuntimeComposerStateKeepsHistoryLoadingLocked
  ]

  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

main()
