/**
 * Unit tests for the separated Goal UI / checkpoint transcript contract.
 *
 * Run:
 *   npx tsx tests/goal-transcript.spec.ts
 */

import {
  buildRestoredCheckpointTranscript,
  buildCheckpointTranscriptForDisplay,
  formatGoalEventMessage,
  goalNoticeEventsToGoalUiEvents,
  isGoalTranscriptArtifact,
  isVisibleCheckpointTranscriptMessage,
  mergeGoalUserEventsIntoTranscript
} from "../src/renderer/src/lib/goal-transcript.ts"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../src/shared/goal-events.ts"
import type { Message } from "../src/renderer/src/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertArrayEqual<T>(actual: T[], expected: T[], message: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${message}: expected ${expectedText}, got ${actualText}`)
  }
}

function message(
  id: string,
  role: Message["role"],
  content: string,
  createdAt = new Date("2026-05-22T10:00:00.000Z"),
  extra: Partial<Message> = {}
): Message {
  return {
    id,
    role,
    content,
    created_at: createdAt,
    start_at: createdAt,
    end_at: createdAt,
    ...extra
  }
}

function testGoalArtifactsAreNotCheckpointTranscript(): void {
  assert(
    !isGoalTranscriptArtifact(message("goal-user", "user", "/goal status")),
    "goal slash commands are user actions and should remain visible when present in checkpoint transcript"
  )
  assert(
    isGoalTranscriptArtifact(message("goal-notice", "system", "Goal 已完成：done")),
    "goal notices should be handled by Goal UI, not checkpoint transcript"
  )
  assert(
    isGoalTranscriptArtifact(message("legacy-goal-notice", "system", "✓ Goal 已完成：done")),
    "legacy rendered goal notices should be filtered if they remain in memory"
  )
  assert(
    !isGoalTranscriptArtifact(message("normal-user", "user", "请解释 /goal status 的含义")),
    "ordinary user text that mentions /goal should remain visible"
  )
  assert(
    !isGoalTranscriptArtifact(message("normal-system", "system", "Hook 已执行")),
    "non-goal system messages should remain visible"
  )
}

function testInternalGoalPromptsAndGoalArtifactsAreFilteredTogether(): void {
  const messages: Message[] = [
    message(
      "internal-start",
      "user",
      "[Starting active goal]\n\n<untrusted_objective>\nscan\n</untrusted_objective>"
    ),
    message("visible-user", "user", "你好"),
    message("goal-status-user", "user", "/goal"),
    message("goal-status-notice", "system", "Goal 状态：进行中"),
    message("assistant", "assistant", "你好，我可以帮你。")
  ]

  const visible = buildCheckpointTranscriptForDisplay(messages)
  assertArrayEqual(
    visible.map((item) => item.id),
    ["visible-user", "goal-status-user", "assistant"],
    "transcript builder should keep real user checkpoint messages while filtering goal notices"
  )
  assert(
    messages.every((item) => typeof item.id === "string"),
    "filtering should not mutate original messages"
  )
}

function testAllGoalCommandsStayInCheckpointTranscript(): void {
  const rows = [
    message("status", "user", "/goal"),
    message("explicit-status", "user", "/goal status"),
    message("pause", "user", "/goal pause"),
    message("resume", "user", "/goal resume"),
    message("clear", "user", "/goal clear"),
    message("new-goal", "user", "/goal 检查日志"),
    message("normal", "user", "请解释 /goal clear 这几个字")
  ]

  assertArrayEqual(
    buildCheckpointTranscriptForDisplay(rows).map((item) => item.id),
    ["status", "explicit-status", "pause", "resume", "clear", "new-goal", "normal"],
    "literal /goal commands are user actions and should remain visible in the transcript"
  )
}

function testKnownGoalNoticeVariantsStayOutOfCheckpointTranscript(): void {
  const rows = [
    message("set", "system", "Goal 已设置（最多 15 轮）。完成前会自动继续。"),
    message("running", "system", "● Goal 进行中\n\n目标：检查日志"),
    message("complete", "system", "✓ Goal 已完成：done"),
    message("paused", "system", "Goal 已暂停：用户暂停"),
    message("roman-paused", "system", "Ⅱ Goal 已暂停：用户暂停"),
    message("no-goal", "system", "当前没有 active goal。用 /goal <目标/完成标准> 设置长期任务。"),
    message(
      "preempted",
      "system",
      "你发送了新消息，active goal 已暂停。需要继续时发送 /goal resume。"
    ),
    message("normal-system", "system", "Hook 已执行：检查通过")
  ]

  assertArrayEqual(
    buildCheckpointTranscriptForDisplay(rows).map((item) => item.id),
    ["normal-system"],
    "known goal notice variants should be owned by Goal UI while normal system messages remain visible"
  )
}

function testAssistantToolAdjacencyAndPayloadArePreserved(): void {
  const assistantToolCall: Message = message("assistant-tools", "assistant", "", undefined, {
    tool_calls: [{ id: "call-1", name: "read_file", args: { path: "README.md" } }]
  })
  const toolResult: Message = message("tool-result", "tool", "README content", undefined, {
    tool_call_id: "call-1",
    name: "read_file"
  })
  const finalAssistant = message("assistant-final", "assistant", "已经读完。")

  const visible = buildCheckpointTranscriptForDisplay([
    message("goal-user", "user", "/goal 读取 README"),
    message("goal-set", "system", "Goal 已设置"),
    assistantToolCall,
    toolResult,
    message("goal-terminal", "system", "Goal 已完成：done"),
    finalAssistant
  ])

  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-user", "assistant-tools", "tool-result", "assistant-final"],
    "goal notices must not split or reorder assistant/tool checkpoint messages"
  )
  assertEqual(
    visible[1]?.tool_calls?.[0]?.id,
    "call-1",
    "assistant tool_calls must survive transcript filtering"
  )
  assertEqual(
    visible[2]?.tool_call_id,
    "call-1",
    "tool result must keep its tool_call_id for MessageBubble aggregation"
  )
}

function testPersistedGoalUserEventsRestoreAsUserMessages(): void {
  const baseMessages = [
    message("assistant-before", "assistant", "准备好了。", new Date("2026-05-22T10:00:00.000Z")),
    message("assistant-after", "assistant", "开始分析。", new Date("2026-05-22T10:00:02.000Z"))
  ]
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 分析项目`,
      created_at: "2026-05-22T10:00:01.000Z"
    },
    {
      event_id: 2,
      goal_id: "goal-1",
      message: "Goal 已设置",
      created_at: "2026-05-22T10:00:01.100Z"
    }
  ])

  const visible = mergeGoalUserEventsIntoTranscript(baseMessages, events)
  assertArrayEqual(
    visible.map((item) => item.id),
    ["assistant-before", "goal-user-event-1", "assistant-after"],
    "persisted goal user commands should be inserted by event time without rendering goal notices"
  )
  assertEqual(visible[1]?.content, "/goal 分析项目", "goal user event should restore the original command")
}

function testGoalStartUserMessageUsesCheckpointPromptPosition(): void {
  const rawCheckpointMessages = [
    message(
      "internal-start",
      "user",
      [
        "[Starting active goal]",
        "<goal_id>goal-1</goal_id>",
        "<untrusted_objective>",
        "讲解项目功能",
        "</untrusted_objective>"
      ].join("\n"),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-intro", "assistant", "我先查看项目结构。", new Date("2026-05-22T10:00:01.000Z")),
    message("tool-list", "tool", "firstDemo", new Date("2026-05-22T10:00:02.000Z"), {
      tool_call_id: "call-1"
    })
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 讲解项目功能`,
      created_at: "2026-05-22T10:00:05.000Z"
    }
  ])

  const visible = buildRestoredCheckpointTranscript(
    rawCheckpointMessages,
    visibleCheckpointMessages,
    events
  )
  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-user-event-1", "assistant-intro", "tool-list"],
    "persisted /goal should replace the internal start prompt at checkpoint position, not event time"
  )
  assertEqual(visible[0]?.content, "/goal 讲解项目功能", "start prompt should show the user command")
  assertEqual(
    visible[0]?.created_at.toISOString(),
    "2026-05-22T10:00:00.000Z",
    "restored /goal command should inherit the checkpoint prompt time"
  )
}

function testGoalResumeUserMessageUsesCheckpointPromptPosition(): void {
  const rawCheckpointMessages = [
    message(
      "internal-continue",
      "user",
      [
        "[Continuing active goal]",
        "<goal_id>goal-1</goal_id>",
        "<untrusted_objective>",
        "讲解项目功能",
        "</untrusted_objective>"
      ].join("\n"),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-resumed", "assistant", "继续检查。", new Date("2026-05-22T10:00:01.000Z")),
    message("tool-read", "tool", "pom.xml", new Date("2026-05-22T10:00:02.000Z"), {
      tool_call_id: "call-2"
    })
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 2,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T10:00:05.000Z"
    }
  ])

  const visible = buildRestoredCheckpointTranscript(
    rawCheckpointMessages,
    visibleCheckpointMessages,
    events
  )
  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-user-event-2", "assistant-resumed", "tool-read"],
    "persisted /goal resume should replace the internal continuation prompt at checkpoint position"
  )
  assertEqual(visible[0]?.content, "/goal resume", "continuation prompt should show /goal resume")
}

function testPersistedGoalControlEventsStayOutOfMainTranscript(): void {
  const baseMessages = [
    message("assistant", "assistant", "当前状态已在 Goal 面板展示。", new Date("2026-05-22T10:00:10.000Z"))
  ]
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal`,
      created_at: "2026-05-22T10:00:01.000Z"
    },
    {
      event_id: 2,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal status`,
      created_at: "2026-05-22T10:00:02.000Z"
    },
    {
      event_id: 3,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal pause`,
      created_at: "2026-05-22T10:00:03.000Z"
    },
    {
      event_id: 4,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal clear`,
      created_at: "2026-05-22T10:00:04.000Z"
    },
    {
      event_id: 5,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T10:00:05.000Z"
    },
    {
      event_id: 6,
      goal_id: "goal-2",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 新目标`,
      created_at: "2026-05-22T10:00:06.000Z"
    }
  ])

  const visible = mergeGoalUserEventsIntoTranscript(baseMessages, events)
  assertArrayEqual(
    visible.map((item) => item.content as string),
    ["/goal resume", "/goal 新目标", "当前状态已在 Goal 面板展示。"],
    "restored side-channel goal controls should stay out of the main transcript"
  )
}

function testPersistedGoalUserEventsDoNotDuplicateCheckpointUserMessages(): void {
  const commandTime = new Date("2026-05-22T10:00:00.000Z")
  const baseMessages = [
    message("checkpoint-goal-user", "user", "/goal 分析项目", commandTime, { goal_id: "goal-1" }),
    message("assistant", "assistant", "收到。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 分析项目`,
      created_at: commandTime
    }
  ])

  const visible = mergeGoalUserEventsIntoTranscript(baseMessages, events)
  assertArrayEqual(
    visible.map((item) => item.id),
    ["checkpoint-goal-user", "assistant"],
    "persisted goal user events should not duplicate an existing checkpoint user command"
  )
}

function testGoalEventsStayInGoalUiState(): void {
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal scan`,
      created_at: "2026-05-22T10:00:00.000Z"
    },
    {
      event_id: 2,
      goal_id: "goal-1",
      message: "Goal 已完成：done",
      created_at: "2026-05-22T10:00:10.000Z"
    }
  ])

  assertEqual(events.length, 2, "goal events should stay available for the Goal panel")
  assertEqual(events[0]?.thread_id, "thread-1", "fallback goal events should carry thread id")
  assertEqual(
    formatGoalEventMessage(events[0]!.message),
    "/goal scan",
    "Goal panel should hide the internal persisted-user prefix"
  )
  assertEqual(
    formatGoalEventMessage(events[1]!.message),
    "Goal 已完成：done",
    "normal goal notice text should stay intact"
  )
}

function testVisibilityPredicateMatchesTranscriptBuilder(): void {
  const rows = [
    message("u1", "user", "正常用户消息"),
    message("g1", "user", "/goal status"),
    message("a1", "assistant", "正常 assistant"),
    message("n1", "system", "Goal 已暂停：用户暂停")
  ]

  assertArrayEqual(
    rows.filter(isVisibleCheckpointTranscriptMessage).map((item) => item.id),
    buildCheckpointTranscriptForDisplay(rows).map((item) => item.id),
    "single-message predicate and transcript builder should agree"
  )
}

function run(): void {
  const tests = [
    testGoalArtifactsAreNotCheckpointTranscript,
    testInternalGoalPromptsAndGoalArtifactsAreFilteredTogether,
    testAllGoalCommandsStayInCheckpointTranscript,
    testKnownGoalNoticeVariantsStayOutOfCheckpointTranscript,
    testAssistantToolAdjacencyAndPayloadArePreserved,
    testPersistedGoalUserEventsRestoreAsUserMessages,
    testGoalStartUserMessageUsesCheckpointPromptPosition,
    testGoalResumeUserMessageUsesCheckpointPromptPosition,
    testPersistedGoalControlEventsStayOutOfMainTranscript,
    testPersistedGoalUserEventsDoNotDuplicateCheckpointUserMessages,
    testGoalEventsStayInGoalUiState,
    testVisibilityPredicateMatchesTranscriptBuilder
  ]

  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

run()
