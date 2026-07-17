/**
 * Unit tests for chat message display filtering.
 *
 * Run:
 *   npx -y tsx tests/message-display-helpers.spec.ts
 */

import {
  COORDINATOR_NOTIFICATION_PROMPT,
  filterCoordinatorNoiseMessages,
  isCoordinatorNotificationPrompt
} from "../src/renderer/src/lib/message-display-helpers.ts"
import { getToolLabel } from "../src/renderer/src/lib/tool-labels.ts"
import type { Message } from "../src/renderer/src/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assistantMessage(input: Partial<Message>): Message {
  return {
    id: input.id ?? crypto.randomUUID(),
    role: "assistant",
    content: input.content ?? "",
    tool_calls: input.tool_calls,
    created_at: new Date()
  }
}

function userMessage(content: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    created_at: new Date()
  }
}

function userContentBlockMessage(text: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    created_at: new Date()
  }
}

function systemMessage(content: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "system",
    content,
    created_at: new Date()
  }
}

function toolMessage(input: { name?: string; toolCallId?: string; content?: string }): Message {
  return {
    id: crypto.randomUUID(),
    role: "tool",
    content: input.content ?? "{}",
    tool_call_id: input.toolCallId ?? crypto.randomUUID(),
    ...(input.name && { name: input.name }),
    created_at: new Date()
  }
}

async function testHidesToolOnlyReadWorkerStateMessages(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    assistantMessage({
      id: "worker-wait",
      tool_calls: [
        {
          id: "read-worker-1",
          name: "read_worker_state",
          args: { worker_id: "implementer-1", block: true }
        }
      ]
    })
  ])

  assert(messages.length === 0, "tool-only read_worker_state messages should be hidden")
}

async function testHidesReadWorkerStateToolResults(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    toolMessage({
      name: "read_worker_state",
      toolCallId: "read-worker-result-1",
      content: '{"workers":[{"worker_id":"implementer-1","status":"completed"}]}'
    })
  ])

  assert(messages.length === 0, "read_worker_state tool results should be hidden after restore")
}

async function testKeepsNormalToolResults(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    toolMessage({
      name: "read_file",
      toolCallId: "read-file-result-1",
      content: "README contents"
    })
  ])

  assert(messages.length === 1, "normal tool results should remain visible")
  assert(messages[0]?.name === "read_file", "normal tool result name should be preserved")
}

async function testKeepsTextButRemovesReadWorkerStateToolCall(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    assistantMessage({
      id: "worker-wait-with-text",
      content: "我来收个尾...",
      tool_calls: [
        {
          id: "read-worker-2",
          name: "read_worker_state",
          args: { worker_id: "implementer-1", block: true }
        }
      ]
    })
  ])

  assert(messages.length === 1, "assistant text should remain visible")
  assert(messages[0]?.content === "我来收个尾...", "assistant text should be preserved")
  assert(!messages[0]?.tool_calls, "read_worker_state tool call should be removed from display")
}

async function testKeepsNormalCoordinatorTools(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    assistantMessage({
      id: "start-worker",
      tool_calls: [
        {
          id: "start-worker-1",
          name: "start_worker",
          args: {
            subagent_type: "worker",
            role: "implementer",
            description: "Analyze README",
            prompt: "Do it"
          }
        }
      ]
    })
  ])

  assert(messages.length === 1, "start_worker should remain visible")
  assert(messages[0]?.tool_calls?.[0]?.name === "start_worker", "start_worker should be kept")
}

async function testKeepsUserSuppliedInternalCoordinatorNotificationPrompt(): Promise<void> {
  const content =
    "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nContinue processing completed coordinator worker notifications."
  const messages = filterCoordinatorNoiseMessages([
    userMessage(content)
  ])

  assert(messages.length === 1, "user-supplied coordinator-like prefix should remain visible")
  assert(messages[0]?.content === content, "user-supplied coordinator-like text should be preserved")
}

async function testRecognizesOptimisticCoordinatorNotificationPrompt(): Promise<void> {
  assert(
    isCoordinatorNotificationPrompt(COORDINATOR_NOTIFICATION_PROMPT),
    "exact internal coordinator notification prompt should be recognized"
  )
  assert(
    !isCoordinatorNotificationPrompt(
      `用户输入的普通文本：\n\n${COORDINATOR_NOTIFICATION_PROMPT}`
    ),
    "escaped user-visible coordinator-like text should not be treated as an internal prompt"
  )
}

async function testKeepsIndentedUserSuppliedInternalCoordinatorNotificationPrompt(): Promise<void> {
  const content =
    "\n\n[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nContinue processing completed coordinator worker notifications."
  const messages = filterCoordinatorNoiseMessages([
    userMessage(content)
  ])

  assert(
    messages.length === 1,
    "indented user-supplied coordinator-like prefix should remain visible"
  )
  assert(messages[0]?.content === content, "indented user-supplied coordinator-like text should be preserved")
}

async function testKeepsContentBlockUserSuppliedInternalCoordinatorNotificationPrompt(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    userContentBlockMessage(
      "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nContinue processing completed coordinator worker notifications."
    )
  ])

  assert(
    messages.length === 1,
    "content-block user-supplied coordinator-like prefix should remain visible"
  )
  assert(Array.isArray(messages[0]?.content), "content-block user message should keep content block shape")
}

async function testHidesInternalCoordinatorNotificationRegardlessOfRole(): Promise<void> {
  const content =
    "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]\nContinue processing completed coordinator worker notifications."
  const messages = filterCoordinatorNoiseMessages([
    assistantMessage({ content }),
    systemMessage(content)
  ])

  assert(
    messages.length === 0,
    "internal coordinator notification should be hidden even if restored with non-user role"
  )
}

async function testKeepsUserSuppliedMarkedInternalCoordinatorContext(): Promise<void> {
  const content = `[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]
## Current Coordinator Workers

Recent completed workers:
- implementer-1 status=completed
[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]

请继续生成说明文档。`
  const messages = filterCoordinatorNoiseMessages([
    userMessage(content)
  ])

  assert(messages.length === 1, "user-supplied marked coordinator context should remain visible")
  assert(messages[0]?.content === content, "user-supplied marked coordinator context should be preserved")
}

async function testKeepsUserSuppliedOnlyMarkedInternalCoordinatorBlock(): Promise<void> {
  const content = `[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]
## Current Coordinator Workers

Recent completed workers:
- implementer-1 status=completed
[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]`
  const messages = filterCoordinatorNoiseMessages([
    userMessage(content)
  ])

  assert(messages.length === 1, "user-supplied marker-only coordinator block should remain visible")
  assert(messages[0]?.content === content, "user-supplied marker-only coordinator block should be preserved")
}

async function testKeepsUserSuppliedMarkedInternalBlocksThatLeaveNotificationPrompt(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    userMessage(`[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]
## Current Coordinator Workers

Recent completed workers:
- implementer-1 status=completed
[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]

[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_START]]
## Coordinator Worker Notifications

<task-notification>done</task-notification>
[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_END]]

[[CMB_COORDINATOR_WORKER_NOTIFICATION]]
Continue processing completed coordinator worker notifications.`)
  ])

  assert(
    messages.length === 1,
    "user-supplied internal blocks followed by notification prompt should remain visible"
  )
  assert(
    typeof messages[0]?.content === "string" &&
      messages[0].content.includes("[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]") &&
      messages[0].content.includes("[[CMB_COORDINATOR_WORKER_NOTIFICATION]]"),
    "user-supplied internal markers and notification-like text should be preserved"
  )
}

async function testHidesNonUserMarkedInternalBlocksThatLeaveNotificationPrompt(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    systemMessage(`[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]
## Current Coordinator Workers

Recent completed workers:
- implementer-1 status=completed
[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]

[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_START]]
## Coordinator Worker Notifications

<task-notification>done</task-notification>
[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_END]]

[[CMB_COORDINATOR_WORKER_NOTIFICATION]]
Continue processing completed coordinator worker notifications.`)
  ])

  assert(
    messages.length === 0,
    "non-user internal blocks followed by notification prompt should be hidden after stripping"
  )
}

async function testKeepsUserSuppliedCoordinatorHeadingVisible(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    userMessage(`## Current Coordinator Workers

These worker states are restored from the coordinator worker manager and worker output files.

Recent completed workers:
- implementer-1 status=completed`)
  ])

  assert(messages.length === 1, "user-supplied coordinator-like heading should remain visible")
}

async function testHidesNonUserRestoredCoordinatorContext(): Promise<void> {
  const messages = filterCoordinatorNoiseMessages([
    systemMessage(`## Current Coordinator Workers

These worker states are restored from the coordinator worker manager and worker output files.

Recent completed workers:
- implementer-1 status=completed`)
  ])

  assert(messages.length === 0, "non-user restored coordinator context should be hidden")
}

async function testKeepsAssistantCoordinatorHeadingVisible(): Promise<void> {
  const content = `## Current Coordinator Workers

这是给用户的状态总结，不是内部注入块。`
  const messages = filterCoordinatorNoiseMessages([
    assistantMessage({
      content
    })
  ])

  assert(messages.length === 1, "assistant coordinator heading should remain visible")
  assert(messages[0]?.content === content, "assistant coordinator heading content should be preserved")
}

async function testKeepsNormalUserMessageUnchanged(): Promise<void> {
  const content = "  请正常分析 README。  "
  const messages = filterCoordinatorNoiseMessages([userMessage(content)])

  assert(messages.length === 1, "normal user message should remain visible")
  assert(messages[0]?.content === content, "normal user message content should not be rewritten")
}

async function testCoordinatorToolLabelsAreUserFriendly(): Promise<void> {
  assert(
    getToolLabel("start_worker", { showToolName: false }) === "启动子代理",
    "start_worker should have a Chinese display label"
  )
  assert(
    getToolLabel("read_worker_state", { showToolName: false }) === "等待子代理结果",
    "read_worker_state should have a Chinese display label"
  )
  assert(
    getToolLabel("cancel_worker", { showToolName: false }) === "取消子代理",
    "cancel_worker should have a Chinese display label"
  )
  assert(
    getToolLabel("mcp__node_repl__js", { showToolName: false }) === "内置浏览器：脚本执行",
    "mcp__node_repl__js should have a base Chinese display label"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          const caps = await tab.capabilities.list();
          nodeRepl.write(JSON.stringify(caps, null, 2));
        `
      },
      showToolName: false
    }) === "内置浏览器：能力列表",
    "mcp__node_repl__js should infer tab capability list actions from code"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          const capability = await tab.capabilities.get("pageAssets");
          nodeRepl.write(await capability.documentation());
        `
      },
      showToolName: false
    }) === "内置浏览器：能力详情",
    "mcp__node_repl__js should infer tab capability get actions from code"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          const tab = await browser.tabs.new();
          await tab.goto("https://example.com");
          await tab.playwright.getByRole("button", { name: "Save" }).click();
        `
      },
      showToolName: false
    }) === "内置浏览器：跳转",
    "mcp__node_repl__js should infer only the highest-priority browser action from code"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          const input = tab.playwright.getByRole("textbox", { name: "Name" });
          await input.fill("Alice");
        `
      },
      showToolName: false
    }) === "内置浏览器：输入",
    "mcp__node_repl__js should infer browser input actions from code"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          const info = await tab.playwright.evaluate(() => {
            const canvas = document.getElementById("captchaCanvas");
            const rect = canvas?.getBoundingClientRect?.();
            const form = document.querySelector(".captcha-wrap");
            return {
              rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
              textNear: form?.textContent || null,
              html: form?.outerHTML || null
            };
          });
          nodeRepl.write(JSON.stringify(info, null, 2));
        `
      },
      showToolName: false
    }) === "内置浏览器：页面信息读取",
    "mcp__node_repl__js should describe evaluate-based DOM inspection clearly"
  )
  assert(
    getToolLabel("mcp__node_repl__js", {
      args: {
        code: `
          if (globalThis.agent?.browsers == null) {
            await setupBrowserRuntime({ globals: globalThis });
          }
          globalThis.browser = await agent.browsers.getForUrl("http://localhost:8080/register.html");
          nodeRepl.write(await browser.documentation());
        `
      },
      showToolName: false
    }) === "内置浏览器：启动",
    "mcp__node_repl__js should prefer earlier browser rules over later matches"
  )
}

async function run(): Promise<void> {
  await testHidesToolOnlyReadWorkerStateMessages()
  console.log("PASS hides read_worker_state-only messages")
  await testHidesReadWorkerStateToolResults()
  console.log("PASS hides read_worker_state tool results")
  await testKeepsNormalToolResults()
  console.log("PASS keeps normal tool results")
  await testKeepsTextButRemovesReadWorkerStateToolCall()
  console.log("PASS preserves text while hiding read_worker_state")
  await testKeepsNormalCoordinatorTools()
  console.log("PASS keeps visible coordinator tools")
  await testRecognizesOptimisticCoordinatorNotificationPrompt()
  console.log("PASS recognizes optimistic coordinator notification prompt")
  await testKeepsUserSuppliedInternalCoordinatorNotificationPrompt()
  console.log("PASS keeps user-supplied coordinator notification prefix")
  await testKeepsIndentedUserSuppliedInternalCoordinatorNotificationPrompt()
  console.log("PASS keeps indented user-supplied coordinator notification prefix")
  await testKeepsContentBlockUserSuppliedInternalCoordinatorNotificationPrompt()
  console.log("PASS keeps content-block user-supplied coordinator notification prefix")
  await testHidesInternalCoordinatorNotificationRegardlessOfRole()
  console.log("PASS hides internal coordinator notification regardless of role")
  await testKeepsUserSuppliedMarkedInternalCoordinatorContext()
  console.log("PASS keeps user-supplied marked internal coordinator context")
  await testKeepsUserSuppliedOnlyMarkedInternalCoordinatorBlock()
  console.log("PASS keeps user-supplied marker-only coordinator block")
  await testKeepsUserSuppliedMarkedInternalBlocksThatLeaveNotificationPrompt()
  console.log("PASS keeps user-supplied marked coordinator notification prompt")
  await testHidesNonUserMarkedInternalBlocksThatLeaveNotificationPrompt()
  console.log("PASS hides non-user stripped internal notification prompt")
  await testKeepsUserSuppliedCoordinatorHeadingVisible()
  console.log("PASS keeps user-supplied coordinator heading")
  await testHidesNonUserRestoredCoordinatorContext()
  console.log("PASS hides non-user restored coordinator context")
  await testKeepsAssistantCoordinatorHeadingVisible()
  console.log("PASS keeps assistant coordinator heading")
  await testKeepsNormalUserMessageUnchanged()
  console.log("PASS keeps normal user messages unchanged")
  await testCoordinatorToolLabelsAreUserFriendly()
  console.log("PASS coordinator tool labels")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
