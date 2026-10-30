/**
 * An internal notification turn's prompt is plumbing, not a message.
 *
 * Folding a completed background result into a thread runs a turn whose "user
 * message" is a system prompt: `[[CMB_COORDINATOR_WORKER_NOTIFICATION]]
 * [SYSTEM NOTIFICATION - NOT USER INPUT]…`. Transcript hydration has always
 * dropped it, keyed on `cmb_internal_coordinator_notification` in
 * additional_kwargs — but the live stream did not, so a desktop watching an
 * IM-driven Team thread saw the whole prompt appear as a user bubble and then
 * silently vanish when the transcript reloaded.
 *
 * Run:
 *   npx tsx tests/stream-converter-internal-turn.spec.ts
 */

import { StreamConverter } from "../src/main/agent/stream-converter"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const NOTIFICATION_PROMPT = [
  "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]",
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This trusted internal turn reports completed background coordinator workers."
].join("\n")

function human(id: string, content: string, additionalKwargs?: Record<string, unknown>): unknown {
  return {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: {
      id,
      content,
      ...(additionalKwargs ? { additional_kwargs: additionalKwargs } : {})
    }
  }
}

function ai(id: string, content: string): unknown {
  return {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id, content }
  }
}

function turnMessages(
  events: ReturnType<StreamConverter["processChunk"]>
): Array<{ id: string; role: string; content: string }> {
  return events.flatMap((event) =>
    event.type === "turn-messages" || event.type === "full-messages" ? event.messages : []
  )
}

function testTheNotificationPromptNeverBecomesAUserBubble(): void {
  const converter = new StreamConverter()
  const events = converter.processChunk(
    "values",
    {
      messages: [
        human("u1", "跑一个 Team 测试"),
        ai("a1", "已启动 worker。"),
        human("internal-1", NOTIFICATION_PROMPT, {
          cmb_internal_coordinator_notification: true
        }),
        ai("a2", "worker 已完成:docs 目录结构如下…")
      ]
    },
    { valuesSnapshotScope: "turn", valuesSnapshotKind: "append" }
  )

  const messages = turnMessages(events)
  assert(
    !messages.some((message) => message.content.includes("CMB_COORDINATOR_WORKER_NOTIFICATION")),
    `the internal prompt must not reach the renderer: ${JSON.stringify(messages.map((m) => m.content.slice(0, 40)))}`
  )
  assert(
    messages.some((message) => message.id === "u1"),
    "the reader's own message still comes through"
  )
  assert(
    messages.some((message) => message.id === "a2"),
    "and so does the answer the internal turn produced"
  )
}

function testTheOtherMessagesKeepTheirFallbackIds(): void {
  const converter = new StreamConverter()
  // No explicit ids, so every message falls back to `msg-<absolute index>`.
  // Dropping the internal one by filtering before mapping would renumber the
  // messages after it, and the renderer merges live rows onto history by id.
  const events = converter.processChunk(
    "values",
    {
      messages: [
        { id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content: "第一条" } },
        {
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: {
            content: NOTIFICATION_PROMPT,
            additional_kwargs: { cmb_internal_coordinator_notification: true }
          }
        },
        { id: ["langchain_core", "messages", "AIMessage"], kwargs: { content: "第三条" } }
      ]
    },
    { valuesSnapshotScope: "turn", valuesSnapshotKind: "append" }
  )

  const messages = turnMessages(events)
  const third = messages.find((message) => message.content === "第三条")
  assert(third !== undefined, "the message after the internal one must survive")
  assert(
    third.id === "msg-2",
    `it must keep the id of its own position, got ${third.id} — filtering before mapping renumbers it`
  )
}

function run(): void {
  testTheNotificationPromptNeverBecomesAUserBubble()
  console.log("PASS testTheNotificationPromptNeverBecomesAUserBubble")
  testTheOtherMessagesKeepTheirFallbackIds()
  console.log("PASS testTheOtherMessagesKeepTheirFallbackIds")
  console.log("stream-converter-internal-turn.spec.ts passed")
}

try {
  run()
} catch (error) {
  console.error(`FAIL ${(error as Error).message}`)
  process.exit(1)
}
