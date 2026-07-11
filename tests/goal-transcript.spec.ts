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
  getInternalGoalPromptIdentity,
  goalNoticeEventsToGoalUiEvents,
  hasGoalResumeUserEvent,
  isGoalResumeCommandContent,
  isGoalTranscriptArtifact,
  isVisibleCheckpointTranscriptMessage,
  mergeGoalUserEventsIntoTranscript
} from "../src/renderer/src/lib/goal-transcript.ts"
import { buildGoalContinuationPrompt, buildGoalStartPrompt } from "../src/main/agent/goals/goal-manager.ts"
import {
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT,
  WORKFLOW_NOTIFICATION_TURN_TRIGGER
} from "../src/shared/checkpoint-transcript.ts"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../src/shared/goal-events.ts"
import type { Message, GoalSnapshot } from "../src/renderer/src/types.ts"

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

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    threadId: "thread-1",
    goalId: "goal-1",
    activeWindowId: "window-1",
    objective: "讲解项目功能",
    completionCondition: "讲解项目功能",
    context: {},
    status: "active",
    turnsUsed: 0,
    maxTurns: 15,
    lastVerdict: null,
    lastReason: null,
    pausedReason: null,
    consecutiveParseFailures: 0,
    ledger: {
      progress: [],
      evidence: [],
      blockers: []
    },
    createdAt: Date.parse("2026-05-22T10:00:00.000Z"),
    updatedAt: Date.parse("2026-05-22T10:00:00.000Z"),
    ...overrides
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
    isGoalTranscriptArtifact(message("legacy-no-resume", "system", "没有可继续的 goal。")),
    "legacy no-resume notices should be filtered if they remain in checkpoint transcript"
  )
  assert(
    isGoalTranscriptArtifact(
      message(
        "legacy-control-transport",
        "system",
        "附件和显式技能不会用于 /goal 控制命令。请先移除附件/技能。"
      )
    ),
    "legacy control transport notices should be filtered if they remain in checkpoint transcript"
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

function testGoalStartUserMessageUsesCheckpointPositionAndEventTime(): void {
  const promptGoal = goalSnapshot({
    goalId: "goal-1",
    activeWindowId: "window-1",
    objective: "讲解项目功能",
    completionCondition: "讲解项目功能"
  })
  const rawCheckpointMessages = [
    message(
      "internal-start",
      "user",
      buildGoalStartPrompt(promptGoal),
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
      active_window_id: "window-1",
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
    "2026-05-22T10:00:05.000Z",
    "restored /goal command should preserve the persisted user event time"
  )
}

function testGoalStartUserMessageWithGeneratedMetadataDoesNotDuplicate(): void {
  const promptGoal = goalSnapshot({
    goalId: "goal-1",
    activeWindowId: "window-1",
    objective: "根据附件检查实现",
    completionCondition: "根据附件检查实现"
  })
  const rawCheckpointMessages = [
    message(
      "internal-start",
      "user",
      buildGoalStartPrompt(promptGoal),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-intro", "assistant", "我先读取附件和代码。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 11,
      goal_id: "goal-1",
      active_window_id: "window-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 根据附件检查实现\n启动附件：spec.md\n显式技能：docs`,
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
    ["goal-user-event-11", "assistant-intro"],
    "generated attachment/skill metadata should not make the same /goal command restore twice"
  )
  assertEqual(
    visible[0]?.content,
    "/goal 根据附件检查实现\n启动附件：spec.md\n显式技能：docs",
    "restored command should keep generated metadata for chip rendering"
  )
  assertEqual(
    visible[0]?.created_at.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "metadata-rich /goal command should still preserve the persisted user event time"
  )
}

function testMatchedGoalPromptDoesNotOverwriteEventTimeWithFallbackNow(): void {
  const promptGoal = goalSnapshot({
    goalId: "goal-time",
    activeWindowId: "window-time",
    objective: "讲解项目功能",
    completionCondition: "讲解项目功能"
  })
  const rawCheckpointMessages = [
    message(
      "internal-start-current-time",
      "user",
      buildGoalStartPrompt(promptGoal),
      new Date("2026-05-24T12:00:00.000Z")
    ),
    message(
      "assistant-after",
      "assistant",
      "我来检查。",
      new Date("2026-05-24T12:00:01.000Z")
    )
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 12,
      goal_id: "goal-time",
      active_window_id: "window-time",
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
    ["goal-user-event-12", "assistant-after"],
    "matched persisted goal event should still replace the internal prompt"
  )
  assertEqual(
    visible[0]?.created_at.toISOString(),
    "2026-05-22T10:00:05.000Z",
    "fallback raw prompt time must not overwrite persisted goal user event time"
  )
}

function testGoalStartPromptDoesNotMatchWrongPersistedGoalEvent(): void {
  const rawCheckpointMessages = [
    message(
      "internal-start",
      "user",
      buildGoalStartPrompt(
        goalSnapshot({
          goalId: "goal-A",
          activeWindowId: "window-A",
          objective: "分析项目 A",
          completionCondition: "分析项目 A"
        })
      ),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-intro", "assistant", "我先查看项目 A。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 10,
      goal_id: "goal-B",
      active_window_id: "window-B",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 分析项目 B`,
      created_at: "2026-05-22T10:00:00.500Z"
    }
  ])

  const visible = buildRestoredCheckpointTranscript(
    rawCheckpointMessages,
    visibleCheckpointMessages,
    events
  )

  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-start-prompt-internal-start", "goal-user-event-10", "assistant-intro"],
    "internal start prompt must stay distinct from a persisted event from a different goal"
  )
  assertEqual(
    visible[0]?.content,
    "/goal 分析项目 A",
    "fallback prompt should preserve the checkpoint objective when persisted event goal_id mismatches"
  )
}

function testGoalResumeUserMessageUsesCheckpointPositionAndEventTime(): void {
  const promptGoal = goalSnapshot({
    goalId: "goal-1",
    activeWindowId: "window-resume-1",
    objective: "讲解项目功能",
    completionCondition: "讲解项目功能",
    turnsUsed: 1,
    lastVerdict: "continue",
    lastReason: "还需要继续检查。"
  })
  const rawCheckpointMessages = [
    message(
      "internal-continue",
      "user",
      buildGoalContinuationPrompt(promptGoal),
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
      active_window_id: "window-resume-1",
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

function testGoalResumeVisibleAliasFallbackWithoutEvent(): void {
  const rawCheckpointMessages = [
    message("visible-resume", "user", "/goal resume", new Date("2026-05-22T10:00:00.000Z")),
    message("assistant-resumed", "assistant", "继续检查。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)

  const visible = buildRestoredCheckpointTranscript(rawCheckpointMessages, visibleCheckpointMessages, [])

  assertArrayEqual(
    visible.map((item) => item.id),
    ["visible-resume", "assistant-resumed"],
    "explicit visible /goal resume aliases should survive restore when goal events are unavailable"
  )
  assertEqual(visible[0]?.content, "/goal resume", "visible fallback should keep the user command")
}

function testGoalResumeEventDetection(): void {
  const resumeEvents = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 30,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T10:00:00.000Z"
    }
  ])
  const nonResumeEvents = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 31,
      goal_id: "goal-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal status`,
      created_at: "2026-05-22T10:00:00.000Z"
    }
  ])

  assert(isGoalResumeCommandContent("/goal resume"), "plain resume command should be detected")
  assert(
    !isGoalResumeCommandContent("/goal resume now"),
    "non-exact resume commands should not be treated as the restore alias"
  )
  assert(hasGoalResumeUserEvent(resumeEvents), "persisted resume user events should be detected")
  assert(
    hasGoalResumeUserEvent(resumeEvents, { goalId: "goal-1" }),
    "matching goal resume user events should be detected"
  )
  assert(
    !hasGoalResumeUserEvent(resumeEvents, { goalId: "other-goal" }),
    "resume user events from another goal should not match a scoped prompt"
  )
  assert(
    !hasGoalResumeUserEvent(nonResumeEvents),
    "non-resume goal user events should not block visible resume fallback"
  )
}

function testGoalResumeVisibleAliasFallbackIgnoresUnrelatedOldEvent(): void {
  const currentPrompt = buildGoalContinuationPrompt(
    goalSnapshot({
      goalId: "new-goal",
      activeWindowId: "new-window",
      objective: "继续新目标",
      completionCondition: "继续新目标",
      turnsUsed: 1,
      lastVerdict: "continue",
      lastReason: "继续。"
    })
  )
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 32,
      goal_id: "old-goal",
      active_window_id: "old-window",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T09:00:00.000Z"
    }
  ])

  assert(
    !hasGoalResumeUserEvent(events, getInternalGoalPromptIdentity(currentPrompt)),
    "old goal resume events should not suppress the current checkpoint visible alias"
  )
}

function testGoalResumePromptDoesNotMatchWrongPersistedGoalEvent(): void {
  const rawCheckpointMessages = [
    message(
      "internal-continue",
      "user",
      buildGoalContinuationPrompt(
        goalSnapshot({
          goalId: "goal-A",
          activeWindowId: "window-A2",
          objective: "继续分析项目 A",
          completionCondition: "继续分析项目 A",
          turnsUsed: 1,
          lastVerdict: "continue",
          lastReason: "还需要继续。"
        })
      ),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-resumed", "assistant", "继续分析 A。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 20,
      goal_id: "goal-B",
      active_window_id: "window-B2",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T10:00:00.500Z"
    }
  ])

  const visible = buildRestoredCheckpointTranscript(
    rawCheckpointMessages,
    visibleCheckpointMessages,
    events
  )

  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-user-event-20", "assistant-resumed"],
    "internal continuation prompt must not synthesize /goal resume when the persisted event belongs to a different goal"
  )
}

function testGoalResumePromptDoesNotMatchWrongActiveWindowEvent(): void {
  const rawCheckpointMessages = [
    message(
      "internal-continue",
      "user",
      buildGoalContinuationPrompt(
        goalSnapshot({
          goalId: "goal-A",
          activeWindowId: "window-current",
          objective: "继续分析项目 A",
          completionCondition: "继续分析项目 A",
          turnsUsed: 1,
          lastVerdict: "continue",
          lastReason: "还需要继续。"
        })
      ),
      new Date("2026-05-22T10:00:10.000Z")
    ),
    message("assistant-resumed", "assistant", "继续分析 A。", new Date("2026-05-22T10:00:11.000Z"))
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 21,
      goal_id: "goal-A",
      active_window_id: "window-old",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      created_at: "2026-05-22T10:00:10.100Z"
    }
  ])

  const visible = buildRestoredCheckpointTranscript(
    rawCheckpointMessages,
    visibleCheckpointMessages,
    events
  )

  assertArrayEqual(
    visible.map((item) => item.id),
    ["goal-user-event-21", "assistant-resumed"],
    "same goal_id resume events from a different active window must not replace the checkpoint prompt or synthesize a fake resume"
  )
}

function testUnmatchedGoalContinuationPromptStaysHidden(): void {
  const rawCheckpointMessages = [
    message(
      "internal-continue",
      "user",
      buildGoalContinuationPrompt(
        goalSnapshot({
          goalId: "goal-auto",
          activeWindowId: "window-auto",
          objective: "自动续跑目标",
          completionCondition: "自动续跑目标",
          turnsUsed: 1,
          lastVerdict: "continue",
          lastReason: "还需要自动继续。"
        })
      ),
      new Date("2026-05-22T10:00:00.000Z")
    ),
    message("assistant-auto", "assistant", "继续自动处理。", new Date("2026-05-22T10:00:01.000Z")),
    message("tool-auto", "tool", "result", new Date("2026-05-22T10:00:02.000Z"), {
      tool_call_id: "call-auto"
    })
  ]
  const visibleCheckpointMessages = buildCheckpointTranscriptForDisplay(rawCheckpointMessages)

  const visible = buildRestoredCheckpointTranscript(rawCheckpointMessages, visibleCheckpointMessages, [])

  assertArrayEqual(
    visible.map((item) => item.id),
    ["assistant-auto", "tool-auto"],
    "automatic goal continuation prompts must stay hidden instead of fabricating a /goal resume user message"
  )
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

function testGoalUserEventDedupesWhenCheckpointMessageLacksActiveWindow(): void {
  const commandTime = new Date("2026-05-22T10:00:00.000Z")
  const baseMessages = [
    message("persisted-goal-user", "user", "/goal 分析项目", commandTime),
    message("assistant", "assistant", "收到。", new Date("2026-05-22T10:00:01.000Z"))
  ]
  const events = goalNoticeEventsToGoalUiEvents("thread-1", [
    {
      event_id: 1,
      goal_id: "goal-1",
      active_window_id: "window-1",
      message: `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal 分析项目`,
      created_at: commandTime
    }
  ])

  const visible = mergeGoalUserEventsIntoTranscript(baseMessages, events)
  assertArrayEqual(
    visible.map((item) => item.id),
    ["persisted-goal-user", "assistant"],
    "goal user event should dedupe a persisted command even if active_window_id was not stored"
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

function testWorkflowPlumbingStaysOutOfCheckpointTranscript(): void {
  const rows = [
    message("workflow-trigger", "user", WORKFLOW_NOTIFICATION_TURN_PROMPT),
    message(
      "workflow-marker",
      "user",
      `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}workflow-run-1]] <task-notification />`
    ),
    message("pasted-trigger-prefix", "user", `${WORKFLOW_NOTIFICATION_TURN_TRIGGER} pasted log`),
    message("assistant", "assistant", "正常 assistant")
  ]

  assertArrayEqual(
    rows.filter(isVisibleCheckpointTranscriptMessage).map((item) => item.id),
    ["pasted-trigger-prefix", "assistant"],
    "workflow notification plumbing should stay hidden while user-pasted marker-like text remains visible"
  )
  assertArrayEqual(
    buildCheckpointTranscriptForDisplay(rows).map((item) => item.id),
    ["pasted-trigger-prefix", "assistant"],
    "checkpoint display builder should share the workflow plumbing filter"
  )
}

function testWorkflowPlumbingDoesNotDuplicateFollowingAssistantOnRestore(): void {
  const rawCheckpointMessages = [
    message("user-1", "user", "用动态工作流实现！"),
    message("assistant-launch", "assistant", "已启动工作流，结果稍后通知。"),
    message(
      "workflow-marker",
      "user",
      `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}workflow-run-1]] <task-notification />`
    ),
    message("assistant-result", "assistant", "工作流已完成，结果是：只出现一次。")
  ]
  const visibleCheckpointMessages = rawCheckpointMessages.filter(isVisibleCheckpointTranscriptMessage)

  assertArrayEqual(
    buildRestoredCheckpointTranscript(rawCheckpointMessages, visibleCheckpointMessages, []).map(
      (item) => item.id
    ),
    ["user-1", "assistant-launch", "assistant-result"],
    "restore builder must not consume the assistant after hidden workflow plumbing twice"
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
    testGoalStartUserMessageUsesCheckpointPositionAndEventTime,
    testGoalStartUserMessageWithGeneratedMetadataDoesNotDuplicate,
    testMatchedGoalPromptDoesNotOverwriteEventTimeWithFallbackNow,
    testGoalStartPromptDoesNotMatchWrongPersistedGoalEvent,
    testGoalResumeUserMessageUsesCheckpointPositionAndEventTime,
    testGoalResumeVisibleAliasFallbackWithoutEvent,
    testGoalResumeEventDetection,
    testGoalResumeVisibleAliasFallbackIgnoresUnrelatedOldEvent,
    testGoalResumePromptDoesNotMatchWrongPersistedGoalEvent,
    testGoalResumePromptDoesNotMatchWrongActiveWindowEvent,
    testUnmatchedGoalContinuationPromptStaysHidden,
    testPersistedGoalControlEventsStayOutOfMainTranscript,
    testPersistedGoalUserEventsDoNotDuplicateCheckpointUserMessages,
    testGoalUserEventDedupesWhenCheckpointMessageLacksActiveWindow,
    testGoalEventsStayInGoalUiState,
    testVisibilityPredicateMatchesTranscriptBuilder,
    testWorkflowPlumbingStaysOutOfCheckpointTranscript,
    testWorkflowPlumbingDoesNotDuplicateFollowingAssistantOnRestore
  ]

  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
}

run()
