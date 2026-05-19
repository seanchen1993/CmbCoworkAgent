/**
 * Unit tests for UI-only goal notice messages.
 *
 * Run:
 *   npx tsx tests/goal-notice-ui.spec.ts
 */

import {
  createGoalNoticeMessage,
  goalEventToDisplayMessages,
  goalEventToSystemMessage,
  isInternalGoalPromptMessage,
  mergeGoalNoticeMessagesForRestore,
  normalizeRestoredGoalPromptMessage,
  orderGoalNoticeMessagesForDisplay
} from "../src/renderer/src/lib/goal-notice-messages.ts"
import {
  stripGoalTransportSummary,
  stripLegacyGoalTransportSummary
} from "../src/renderer/src/lib/goal-transport-summary.ts"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../src/shared/goal-events.ts"
import type { Message } from "../src/renderer/src/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}

function testLiveGoalNoticeCreatesSystemMessage(): void {
  const createdAt = new Date("2026-05-17T10:00:00.000Z")
  const message = createGoalNoticeMessage("  Goal 已设置  ", {
    id: "goal-notice-test",
    createdAt
  })

  assertEqual(message.id, "goal-notice-test", "explicit id should be used")
  assertEqual(message.role, "system", "goal notices should render as system messages")
  assertEqual(message.content, "Goal 已设置", "goal notice content should be trimmed")
  assertEqual(message.created_at, createdAt, "created_at should use supplied date")
  assertEqual(message.start_at, createdAt, "start_at should match created_at")
  assertEqual(message.end_at, createdAt, "end_at should match created_at")
}

function testPersistedGoalEventRestoresSystemMessage(): void {
  const message = goalEventToSystemMessage({
    event_id: 42,
    message: "Goal 已完成",
    created_at: "2026-05-17T11:00:00.000Z"
  })

  assertEqual(message.id, "goal-event-42", "persisted event id should be stable")
  assertEqual(message.role, "system", "persisted goal event should restore as system message")
  assertEqual(message.content, "Goal 已完成", "persisted event message should be visible")
  assert(message.created_at instanceof Date, "created_at should be restored as Date")
  assertEqual(
    message.created_at.toISOString(),
    "2026-05-17T11:00:00.000Z",
    "created_at should preserve persisted event time"
  )
}

function message(
  id: string,
  role: Message["role"],
  content: string,
  createdAt = new Date("2026-05-17T12:00:00.000Z")
): Message {
  return { id, role, content, created_at: createdAt, start_at: createdAt, end_at: createdAt }
}

function testInternalGoalPromptsAreDisplayOnlyHidden(): void {
  assert(
    isInternalGoalPromptMessage(
      message(
        "g1",
        "user",
        "[Starting active goal]\n\n<untrusted_objective>\nobjective\n</untrusted_objective>"
      )
    ),
    "starting active goal prompts should be hidden from visible history"
  )
  assert(
    isInternalGoalPromptMessage(
      message(
        "g1-space",
        "user",
        "\n\n[Starting active goal]\n\n<completion_condition>\nobjective\n</completion_condition>"
      )
    ),
    "starting active goal prompts should still be hidden when provider restore adds leading whitespace"
  )
  assert(
    isInternalGoalPromptMessage(
      message(
        "g2",
        "user",
        "[Continuing active goal]\n\n<untrusted_objective>\nobjective\n</untrusted_objective>"
      )
    ),
    "continuing active goal prompts should be hidden from visible history"
  )
  assert(
    !isInternalGoalPromptMessage(message("u-marker", "user", "[Starting active goal]\n\nobjective")),
    "real user text that only mentions the marker should stay visible"
  )
  assert(
    !isInternalGoalPromptMessage(message("u1", "user", "/goal check README")),
    "real slash-command user messages should stay visible"
  )
  assert(
    !isInternalGoalPromptMessage(message("a1", "assistant", "[Starting active goal]")),
    "assistant text should not be filtered by the internal-goal prompt rule"
  )
}

function testStartingGoalPromptRestoresOriginalGoalCommand(): void {
  const restored = normalizeRestoredGoalPromptMessage(
    message(
      "internal-start",
      "user",
      [
        "[Starting active goal]",
        "",
        "<untrusted_objective>",
        "检查 README.md 是否存在 & 不修改文件",
        "</untrusted_objective>"
      ].join("\n"),
      new Date("2026-05-17T12:00:00.000Z")
    )
  )

  assert(restored, "starting goal prompt should restore as a visible user command")
  assertEqual(
    restored?.content,
    "/goal 检查 README.md 是否存在 & 不修改文件",
    "starting goal prompt should restore the original goal objective as /goal command"
  )
}

function testLeadingWhitespaceGoalPromptRestoresSafely(): void {
  const restoredStart = normalizeRestoredGoalPromptMessage(
    message(
      "internal-start-leading-space",
      "user",
      [
        "\n\n[Starting active goal]",
        "",
        "<untrusted_objective>",
        "检查 README.md 是否存在",
        "</untrusted_objective>"
      ].join("\n"),
      new Date("2026-05-17T12:00:00.000Z")
    )
  )
  assertEqual(
    restoredStart?.content,
    "/goal 检查 README.md 是否存在",
    "starting goal prompt with leading whitespace should restore original command"
  )

  const restoredContinue = normalizeRestoredGoalPromptMessage(
    message(
      "internal-continue-leading-space",
      "user",
      "\n\n[Continuing active goal]\n\n<untrusted_objective>\nobjective\n</untrusted_objective>"
    )
  )
  assertEqual(
    restoredContinue,
    null,
    "continuation prompt with leading whitespace should stay hidden"
  )
}

function testStartingGoalPromptWithHookContextStillRestoresCommand(): void {
  const restored = normalizeRestoredGoalPromptMessage(
    message(
      "internal-start-hook-context",
      "user",
      [
        "[Starting active goal]",
        "",
        "<untrusted_objective>",
        "检查 README.md 是否存在",
        "</untrusted_objective>",
        "",
        "Additional context from hooks (untrusted):",
        "hook-added context"
      ].join("\n"),
      new Date("2026-05-17T12:00:00.000Z")
    )
  )

  assert(restored, "starting goal prompt with hook context should restore")
  assertEqual(
    restored?.content,
    "/goal 检查 README.md 是否存在",
    "hook context after marker should not leak into restored goal command"
  )
}

function testContinuingGoalPromptIsHiddenFromRestoredHistory(): void {
  const restored = normalizeRestoredGoalPromptMessage(
    message(
      "internal-continue",
      "user",
      "[Continuing active goal]\n\n<untrusted_objective>\nobjective\n</untrusted_objective>"
    )
  )
  assertEqual(restored, null, "continuation prompts should not become visible user messages")
}

function testPersistedGoalUserEventRestoresSlashCommand(): void {
  const messages = goalEventToDisplayMessages({
    event_id: 10,
    message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal clear`,
    created_at: "2026-05-17T12:00:00.000Z"
  })

  assertEqual(messages.length, 1, "persisted goal user event should restore one message")
  assertEqual(messages[0].role, "user", "persisted goal user event should restore as user")
  assertEqual(
    messages[0].content,
    "/goal clear",
    "persisted goal user event should preserve command"
  )
}

function testLegacyGoalTransportSummaryRendersAsSkillChipData(): void {
  const stripped = stripLegacyGoalTransportSummary(
    "/goal 两分钟后提醒我吃饭\n启动上下文摘要：显式技能：scheduler-assistant"
  )

  assertEqual(
    stripped.text,
    "/goal 两分钟后提醒我吃饭",
    "legacy transport summary should be hidden from restored user bubble text"
  )
  assertEqual(
    stripped.skillName,
    "scheduler-assistant",
    "legacy explicit skill summary should remain available for chip rendering"
  )
}

function testLegacyGoalNoticeTransportSummaryIsHidden(): void {
  const stripped = stripGoalTransportSummary(
    [
      "Goal 进行中",
      "362s · 0/15 轮",
      "",
      "目标：帮我创建一个学习rust的技能 启动上下文摘要：显式技能：skill-creator",
      "",
      "/goal pause 暂停 · /goal clear 清除"
    ].join("\n")
  )

  assertEqual(
    stripped.text,
    [
      "Goal 进行中",
      "362s · 0/15 轮",
      "",
      "目标：帮我创建一个学习rust的技能",
      "",
      "/goal pause 暂停 · /goal clear 清除"
    ].join("\n"),
    "legacy goal notice should hide internal launch context summary without truncating later lines"
  )
  assertEqual(
    stripped.skillName,
    "skill-creator",
    "legacy goal notice summary should still expose skill name for compatibility"
  )
}

function testLegacyGoalStatusNoticeRestoresSlashStatusCommand(): void {
  const messages = goalEventToDisplayMessages({
    event_id: 11,
    message: "当前没有 active goal。用 /goal <目标/完成标准> 设置长期任务。",
    created_at: "2026-05-17T12:00:00.000Z"
  })

  assertEqual(messages.length, 2, "legacy /goal status notice should restore command and notice")
  assertEqual(messages[0].role, "user", "legacy /goal status should synthesize user command")
  assertEqual(messages[0].content, "/goal", "legacy /goal status should synthesize /goal")
  assertEqual(messages[1].role, "system", "legacy /goal status should keep visible notice")
}

function testLegacyPausedGoalStatusNoticeRestoresSlashStatusCommand(): void {
  const messages = goalEventToDisplayMessages({
    event_id: 111,
    message: [
      "Goal 已暂停",
      "12s · 1/15 轮",
      "",
      "目标：检查 README.md",
      "暂停原因：user-paused",
      "",
      "/goal resume 继续 · /goal clear 清除"
    ].join("\n"),
    created_at: "2026-05-17T12:00:00.000Z"
  })

  assertEqual(messages.length, 2, "paused /goal status notice should restore command and notice")
  assertEqual(messages[0].role, "user", "paused /goal status should synthesize user command")
  assertEqual(messages[0].content, "/goal", "paused status should synthesize /goal")
  assertEqual(messages[1].role, "system", "paused /goal status should keep visible notice")
}

function testLegacyGoalClearNoticeRestoresSlashClearCommand(): void {
  const messages = goalEventToDisplayMessages({
    event_id: 12,
    message: "Goal 已清除。",
    created_at: "2026-05-17T12:00:00.000Z"
  })

  assertEqual(messages.length, 2, "legacy /goal clear notice should restore command and notice")
  assertEqual(
    messages[0].content,
    "/goal clear",
    "legacy clear notice should synthesize /goal clear"
  )
}

function testRestoreMergeDedupesPersistedAndPromptGoalCommand(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message(
        "goal-start-prompt-internal",
        "user",
        "/goal 检查 README.md",
        new Date("2026-05-17T12:00:00.000Z")
      )
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 13,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 检查 README.md`,
        created_at: "2026-05-17T12:00:01.000Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.content).join(" | "),
    "/goal 检查 README.md",
    "restored prompt fallback and persisted goal user event should not duplicate the same slash command"
  )
}

function testRestoreMergeDedupesTransportSummaryAndSkillBlockGoalCommand(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message(
        "goal-start-prompt-skill",
        "user",
        "/goal 两分钟后提醒我吃饭\n启动上下文摘要：显式技能：scheduler-assistant",
        new Date("2026-05-17T12:00:00.000Z")
      )
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 113,
        message: [
          `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 两分钟后提醒我吃饭`,
          "<CMBDEVCLAW-SKILL-USE-V1>",
          "<name>scheduler-assistant</name>",
          "<path>/skills/scheduler-assistant/SKILL.md</path>",
          "</CMBDEVCLAW-SKILL-USE-V1>"
        ].join("\n"),
        created_at: "2026-05-17T12:00:00.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "goal-user-event-113",
    "transport summary and persisted skill block should restore as one visible /goal command"
  )
}

function testRestoreMergePrefersVisibleGoalCommandOverPersistedEvent(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [message("u1", "user", "/goal 检查 README.md", new Date("2026-05-17T12:00:00.000Z"))],
    [
      ...goalEventToDisplayMessages({
        event_id: 14,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 检查 README.md`,
        created_at: "2026-05-17T12:00:00.100Z"
      }),
      goalEventToSystemMessage({
        event_id: 15,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T12:00:00.200Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u1,goal-event-15",
    "persisted goal user events should not duplicate an already visible /goal command"
  )
}

function testRestoreMergeKeepsNearbySameTextPersistedCommandForDifferentGoal(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message("u1", "user", "/goal same", new Date("2026-05-17T12:00:00.000Z")),
      goalEventToSystemMessage({
        event_id: 40,
        goal_id: "goal-a",
        message: "Goal 已清除。",
        created_at: "2026-05-17T12:00:01.000Z"
      })
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 41,
        goal_id: "goal-b",
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal same`,
        created_at: "2026-05-17T12:00:04.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 42,
        goal_id: "goal-b",
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T12:00:04.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u1,goal-user-event-41,goal-event-40,goal-event-42",
    "same /goal text from a later persisted goal id should not be swallowed by an older visible command"
  )
}

function testRestoreMergeKeepsRepeatedGoalCommandsWhenTheyAreFarApart(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [],
    [
      ...goalEventToDisplayMessages({
        event_id: 16,
        message: "Goal 已清除。",
        created_at: "2026-05-17T12:00:00.000Z"
      }),
      ...goalEventToDisplayMessages({
        event_id: 17,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal clear`,
        created_at: "2026-05-17T13:00:00.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 18,
        message: "Goal 已清除。",
        created_at: "2026-05-17T13:00:00.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "goal-legacy-command-16,goal-event-16,goal-user-event-17,goal-event-18",
    "same /goal clear command used far apart should restore as two separate user actions"
  )
}

function testRestoreMergeDoesNotAnchorRepeatedGoalToOldSameTextCommand(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message("u-old", "user", "/goal 重复目标", new Date("2026-05-17T12:00:00.000Z")),
      message("a-old", "assistant", "第一次目标已处理", new Date("2026-05-17T12:00:10.000Z"))
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 19,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 重复目标`,
        created_at: "2026-05-17T13:00:00.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 20,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T13:00:00.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u-old,a-old,goal-user-event-19,goal-event-20",
    "a repeated /goal with the same text should be restored at its own timestamp, not after the first same-text command"
  )
}

function testRestoreMergeKeepsSameTextCommandsForDifferentGoalIds(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [],
    [
      ...goalEventToDisplayMessages({
        event_id: 23,
        goal_id: "goal-a",
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal same`,
        created_at: "2026-05-17T12:00:00.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 24,
        goal_id: "goal-a",
        message: "Goal 已清除。",
        created_at: "2026-05-17T12:00:01.000Z"
      }),
      ...goalEventToDisplayMessages({
        event_id: 25,
        goal_id: "goal-b",
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal same`,
        created_at: "2026-05-17T12:00:04.000Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "goal-user-event-23,goal-user-event-25,goal-event-24",
    "same /goal text from separate goal ids should not be deduped as one command"
  )
}

function testRestoreMergeRemovesPromptDuplicateButKeepsPersistedGoalCommand(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message("u0", "user", "/goal 检查 controller", new Date("2026-05-17T12:00:00.000Z")),
      message("a0", "assistant", "controller 检查完成", new Date("2026-05-17T12:00:20.000Z")),
      message(
        "goal-start-prompt-nosuch",
        "user",
        "/goal 只修改 NoSuchController.java",
        new Date("2026-05-17T12:00:30.000Z")
      ),
      message("a1", "assistant", "目标文件不存在", new Date("2026-05-17T12:00:40.000Z"))
    ],
    [
      goalEventToSystemMessage({
        event_id: 30,
        message: "✓ Goal 已完成 (32s · 1 轮)：controller 检查完成",
        created_at: "2026-05-17T12:00:20.100Z"
      }),
      ...goalEventToDisplayMessages({
        event_id: 31,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 只修改 NoSuchController.java`,
        created_at: "2026-05-17T12:00:30.100Z"
      }),
      goalEventToSystemMessage({
        event_id: 32,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T12:00:30.200Z"
      }),
      goalEventToSystemMessage({
        event_id: 33,
        message: "Goal 已暂停：目标文件 NoSuchController.java 不存在",
        created_at: "2026-05-17T12:00:40.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u0,a0,goal-event-30,goal-user-event-31,goal-event-32,a1,goal-event-33",
    "restore should remove duplicate start prompt commands and keep notices around the correct turns"
  )
}

function testGoalPauseNoticeDoesNotDriftAfterLaterNormalTurn(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message(
        "goal-start-prompt-nosuch",
        "user",
        "/goal 只修改 NoSuchController.java",
        new Date("2026-05-17T14:49:21.000Z")
      ),
      message(
        "a-nosuch",
        "assistant",
        "任务无法完成：目标文件不存在",
        new Date("2026-05-17T14:49:25.000Z")
      ),
      message(
        "u-later",
        "user",
        "列出 firstDemo 项目里的 controller 文件名，不要修改文件。",
        new Date("2026-05-17T14:52:22.000Z")
      ),
      message(
        "a-later",
        "assistant",
        "firstDemo 项目 Controller 文件列表",
        new Date("2026-05-17T14:52:23.000Z")
      )
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 40,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 只修改 NoSuchController.java`,
        created_at: "2026-05-17T14:49:20.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 41,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T14:49:20.100Z"
      }),
      goalEventToSystemMessage({
        event_id: 42,
        message: "Goal 已暂停：目标文件 NoSuchController.java 不存在",
        created_at: "2026-05-17T14:49:32.000Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "goal-user-event-40,goal-event-41,a-nosuch,goal-event-42,u-later,a-later",
    "goal pause notices must stay with the goal timeline and not drift below a later normal turn"
  )
}

function testPersistedGoalEventsRestoreByTimestamp(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message("u1", "user", "/goal check README", new Date("2026-05-17T12:00:00.000Z")),
      message("a1", "assistant", "验证结果：README.md 不存在", new Date("2026-05-17T12:00:03.000Z"))
    ],
    [
      goalEventToSystemMessage({
        event_id: 1,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T12:00:01.000Z"
      }),
      goalEventToSystemMessage({
        event_id: 2,
        message: "✓ Goal 已完成 (12s · 1 轮)：done",
        created_at: "2026-05-17T12:00:04.000Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u1,goal-event-1,a1,goal-event-2",
    "unpaired goal notices should restore by their own timeline position"
  )
}

function testGoalStatusRestoreDoesNotSplitPreviousAssistantTurn(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message("u1", "user", "你是什么模型", new Date("2026-05-17T12:00:00.000Z")),
      message(
        "a1",
        "assistant",
        "我是基于 Anthropic 的 Claude 模型。",
        new Date("2026-05-17T12:00:10.000Z")
      )
    ],
    [
      ...goalEventToDisplayMessages({
        event_id: 20,
        message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal`,
        created_at: "2026-05-17T12:00:05.000Z"
      }),
      ...goalEventToDisplayMessages({
        event_id: 21,
        message: "当前没有 active goal。用 /goal <目标/完成标准> 设置长期任务。",
        created_at: "2026-05-17T12:00:05.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "u1,goal-user-event-20,goal-event-21,a1",
    "/goal status restore should follow its persisted timeline position"
  )
}

function testGoalSetNoticeStaysWithRestoredGoalCommand(): void {
  const merged = mergeGoalNoticeMessagesForRestore(
    [
      message(
        "goal-start-prompt-internal",
        "user",
        "/goal 检查 README.md",
        new Date("2026-05-17T12:00:05.000Z")
      ),
      message("a1", "assistant", "我开始检查 README.md。", new Date("2026-05-17T12:00:10.000Z"))
    ],
    [
      goalEventToSystemMessage({
        event_id: 22,
        message: "Goal 已设置（最多 15 轮）。",
        created_at: "2026-05-17T12:00:05.100Z"
      })
    ]
  )

  assertEqual(
    merged.map((item) => item.id).join(","),
    "goal-start-prompt-internal,goal-event-22,a1",
    "goal set notice should stay directly after the restored /goal command"
  )
}

function testTerminalGoalNoticeDisplaysAfterCurrentResponse(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("u1", "user", "/goal check README"),
    message("n1", "system", "Goal 已设置（最多 15 轮）。"),
    message("n2", "system", "✓ Goal 已完成 (12s · 1 轮)：done"),
    message("a1", "assistant", "验证结果：README.md 不存在"),
    message("t1", "tool", "ls output")
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1,a1,t1,n2",
    "terminal goal notice should render after the assistant/tool response it summarizes"
  )
}

function testGoalSetNoticeKeepsOriginalPosition(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("u1", "user", "/goal check README"),
    message("n1", "system", "Goal 已设置（最多 15 轮）。"),
    message("a1", "assistant", "我开始检查")
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1,a1",
    "non-terminal goal notices should keep their original position"
  )
}

function testGoalCommandNoticeSwapsBackAfterSlashCommand(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("n1", "system", "当前没有 active goal。用 /goal <目标/完成标准> 设置长期任务。"),
    message("u1", "user", "/goal")
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1",
    "status notices restored immediately before /goal should display after the slash command"
  )
}

function testDuplicateAdjacentGoalCommandNoticesCollapse(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("u1", "user", "/goal clear"),
    message("n1", "system", "Goal 已清除。"),
    message("n2", "system", "Goal 已清除。")
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1",
    "duplicated restored command notices should not render as repeated identical cards"
  )
}

function testWaitingForUserInputDoesNotDuplicateAsPausedNotice(): void {
  const waiting = message(
    "n1",
    "system",
    "Goal 等待补充信息：Assistant is waiting for user input about skill requirements before creating the Rust learning skill。补充信息后请发送 /goal resume 继续处理；可用 /goal clear 停止。",
    new Date("2026-05-17T12:00:00.000Z")
  )
  waiting.goal_id = "goal-rust"
  const assistant = message(
    "a1",
    "assistant",
    "好的，我将按照 Rust 学习的最佳实践来创建这个技能。",
    new Date("2026-05-17T12:01:00.000Z")
  )
  const duplicatePause = message(
    "n2",
    "system",
    "Goal 已暂停：Assistant is waiting for user input about skill requirements before creating the Rust learning skill",
    new Date("2026-05-17T12:01:05.000Z")
  )
  duplicatePause.goal_id = "goal-rust"

  const ordered = orderGoalNoticeMessagesForDisplay([waiting, assistant, duplicatePause])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "a1,n1",
    "waiting-for-input notice should not render a second generic paused card with the same reason"
  )
}

function testRepeatedGoalCommandNoticesRemainWhenSeparatedByUserCommand(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("u1", "user", "/goal clear", new Date("2026-05-17T12:00:00.000Z")),
    message("n1", "system", "Goal 已清除。", new Date("2026-05-17T12:00:00.100Z")),
    message("u2", "user", "/goal clear", new Date("2026-05-17T13:00:00.000Z")),
    message("n2", "system", "Goal 已清除。", new Date("2026-05-17T13:00:00.100Z"))
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1,u2,n2",
    "legitimate repeated /goal commands should keep their own status notices"
  )
}

function testTerminalGoalNoticeDoesNotCrossNextUserMessage(): void {
  const ordered = orderGoalNoticeMessagesForDisplay([
    message("u1", "user", "/goal check README", new Date("2026-05-17T12:00:00.000Z")),
    message(
      "n1",
      "system",
      "✓ Goal 已完成 (12s · 1 轮)：done",
      new Date("2026-05-17T12:00:01.000Z")
    ),
    message("u2", "user", "下一条消息", new Date("2026-05-17T12:00:02.000Z")),
    message("a1", "assistant", "下一轮回复", new Date("2026-05-17T12:00:03.000Z"))
  ])

  assertEqual(
    ordered.map((item) => item.id).join(","),
    "u1,n1,u2,a1",
    "terminal goal notice should not move across the next user turn"
  )
}

function main(): void {
  const tests = [
    testLiveGoalNoticeCreatesSystemMessage,
    testPersistedGoalEventRestoresSystemMessage,
    testInternalGoalPromptsAreDisplayOnlyHidden,
    testStartingGoalPromptRestoresOriginalGoalCommand,
    testLeadingWhitespaceGoalPromptRestoresSafely,
    testStartingGoalPromptWithHookContextStillRestoresCommand,
    testContinuingGoalPromptIsHiddenFromRestoredHistory,
    testPersistedGoalUserEventRestoresSlashCommand,
    testLegacyGoalTransportSummaryRendersAsSkillChipData,
    testLegacyGoalNoticeTransportSummaryIsHidden,
    testLegacyGoalStatusNoticeRestoresSlashStatusCommand,
    testLegacyPausedGoalStatusNoticeRestoresSlashStatusCommand,
    testLegacyGoalClearNoticeRestoresSlashClearCommand,
    testRestoreMergeDedupesPersistedAndPromptGoalCommand,
    testRestoreMergeDedupesTransportSummaryAndSkillBlockGoalCommand,
    testRestoreMergePrefersVisibleGoalCommandOverPersistedEvent,
    testRestoreMergeKeepsNearbySameTextPersistedCommandForDifferentGoal,
    testRestoreMergeKeepsRepeatedGoalCommandsWhenTheyAreFarApart,
    testRestoreMergeDoesNotAnchorRepeatedGoalToOldSameTextCommand,
    testRestoreMergeKeepsSameTextCommandsForDifferentGoalIds,
    testRestoreMergeRemovesPromptDuplicateButKeepsPersistedGoalCommand,
    testGoalPauseNoticeDoesNotDriftAfterLaterNormalTurn,
    testPersistedGoalEventsRestoreByTimestamp,
    testGoalStatusRestoreDoesNotSplitPreviousAssistantTurn,
    testGoalSetNoticeStaysWithRestoredGoalCommand,
    testTerminalGoalNoticeDisplaysAfterCurrentResponse,
    testGoalSetNoticeKeepsOriginalPosition,
    testGoalCommandNoticeSwapsBackAfterSlashCommand,
    testDuplicateAdjacentGoalCommandNoticesCollapse,
    testWaitingForUserInputDoesNotDuplicateAsPausedNotice,
    testRepeatedGoalCommandNoticesRemainWhenSeparatedByUserCommand,
    testTerminalGoalNoticeDoesNotCrossNextUserMessage
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

main()
