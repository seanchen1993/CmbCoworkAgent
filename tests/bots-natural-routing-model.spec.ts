/**
 * Opt-in semantic check against a user-selected existing custom model.
 * No real work, files, messages or project changes are executed. Tools return
 * synthetic receipts. Credentials stay in memory; only case names/results print.
 * BOT_ROUTING_MODEL_PROFILE=/path/to/profile BOT_ROUTING_MODEL_ID=custom-id node --import tsx ...
 */
import assert from "node:assert/strict"
import { selectedBotRoutingModel } from "./support/bot-routing-model"
import { convertToOpenAITool } from "@langchain/core/utils/function_calling"
import { buildBotPrompt } from "../src/main/bots/prompt"
import { createBotWorkTools } from "../src/main/bots/work-tools"
import type { BotDefinition, BotTask } from "../src/shared/bots/contracts"

async function main() {
  const config = await selectedBotRoutingModel()
  const endpoint = config.baseUrl.replace(/\/+$/, "") + "/chat/completions"
  const tools = createBotWorkTools(
    { id: "source" },
    () => {
      throw new Error("Semantic check never executes real tools")
    },
    new AbortController().signal
  ).map((t) => convertToOpenAITool(t))
  const bot: BotDefinition = {
    id: "bot",
    name: "小R",
    instructions: "",
    threadId: "main",
    hostId: "local",
    color: "#123456",
    shape: "circle",
    archived: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    modelRef: null
  }
  const task: BotTask = {
    id: "source",
    botId: "bot",
    threadId: "main",
    requestId: "source",
    message: "",
    state: "running",
    error: null,
    createdAt: 1,
    updatedAt: 1,
    origin: { kind: "user" }
  }
  const work = {
    id: "work-1",
    botId: "bot",
    threadId: "work-thread",
    title: "周日读书会计划",
    goal: "周日下午三点在社区阅览室举办读书会，各带一本书。",
    state: "active",
    version: 3,
    workspace: { kind: "directory", path: "/synthetic/original" }
  }
  const prior = (completed = false) => [
    { role: "user", content: "帮我设计一个周日的读书会计划" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "earlier",
          type: "function",
          function: {
            name: "bot_work_create",
            arguments: JSON.stringify({
              requestKey: "original",
              title: work.title,
              goal: "周日读书会计划",
              contextMessageIds: []
            })
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "earlier",
      content: JSON.stringify({
        kind: "bot-work-receipt",
        operation: "bot_work_create",
        receipt: { work: { ...work, ...(completed ? { state: "completed" } : {}) } }
      })
    },
    {
      role: "assistant",
      content: completed
        ? "右侧「周日读书会计划」已由你确认完成，安排是下午三点在社区阅览室，各带一本书。"
        : "已交办到右侧「周日读书会计划」，安排是下午三点在社区阅览室，各带一本书，可在该任务里继续查看和修改。"
    }
  ]
  const cases = [
    { name: "ordinary-question", message: "读书会一般安排多久合适？", expected: [] },
    {
      name: "natural-assignment-default",
      message: "帮我设计一个周日的读书会计划",
      expected: ["bot_work_create"],
      allowDirect: true
    },
    {
      name: "text-only-assignment",
      message:
        "帮我在 /synthetic/reading-project 目录写一份周日读书会的简短计划。下午三点，社区阅览室，各带一本书。这些信息都是虚构的，只需要文字，不需要文件、浏览器或外部操作。",
      expected: ["bot_work_create"],
      allowDirect: true,
      directory: "/synthetic/reading-project"
    },
    {
      name: "explicit-independent-default",
      message: "请单独建一个任务，帮我设计周日读书会的计划，后面会在那个任务里继续修改。",
      expected: ["bot_work_create"]
    },
    {
      name: "explicit-directory",
      message:
        "请单独建一个任务，以 /synthetic/reading-project 为工作目录，帮我整理一份周日读书会计划。",
      expected: ["bot_work_create"],
      directory: "/synthetic/reading-project"
    },
    {
      name: "named-project",
      message: "请为演示项目单独建一个任务，用项目目录作为工作区，编写一份读书会计划。",
      expected: ["bot_work_projects", "bot_work_create"],
      project: "project-1"
    },
    {
      name: "main-follow-up",
      message: "把刚才的计划改到下午四点，加上十分钟的签到。",
      expected: ["bot_work_send"],
      history: prior()
    },
    {
      name: "completed-follow-up",
      message: "刚才完成的读书会计划再改一下，时间改为下午四点。",
      expected: ["bot_work_continue", "bot_work_send"],
      history: prior(true)
    },
    {
      name: "inside-work-revision",
      message: "把读书会改到下午四点，只回复调整后的计划。",
      expected: [],
      inWork: true
    },
    {
      name: "explicit-stay-in-main",
      message: "帮我写一句活动通知，只在主对话回答，不要创建独立任务。",
      expected: []
    },
    {
      name: "ambiguous-work",
      message: "修改一下读书会的计划。",
      expected: [],
      history: [
        { role: "user", content: "我已交办周六和周日两个读书会计划。" },
        { role: "assistant", content: "两个独立任务都已存在。" }
      ],
      ambiguous: true
    }
  ]
  let requests = 0
  const selectedCases = process.env.BOT_ROUTING_CASE
    ? cases.filter((test) => test.name === process.env.BOT_ROUTING_CASE)
    : cases
  assert.ok(selectedCases.length, "Unknown semantic check case")
  for (const test of selectedCases) {
    const messages: any[] = [
      {
        role: "system",
        content: buildBotPrompt(
          bot,
          { ...task, ...(test.inWork ? { workId: work.id, threadId: work.threadId } : {}) },
          test.inWork ? work.workspace.path : "/synthetic/default"
        )
      },
      ...(test.history ?? []),
      { role: "user", content: test.message }
    ]
    const actions: string[] = []
    let finalText = ""
    for (let step = 0; step < 5; step++) {
      requests++
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools,
          stream: false,
          max_tokens: 3072,
          temperature: config.temperature ?? 0,
          thinking: { type: config.enableThinking === true ? "enabled" : "disabled" }
        }),
        signal: AbortSignal.timeout(60000)
      })
      assert.equal(response.ok, true, test.name + ": model HTTP " + response.status)
      const answer: any = await response.json()
      const message = answer.choices?.[0]?.message
      assert.ok(message, test.name + ": missing model message")
      messages.push(message)
      if (!message.tool_calls?.length) {
        finalText = message.content ?? ""
        break
      }
      for (const call of message.tool_calls) {
        const name = call.function.name,
          args = JSON.parse(call.function.arguments)
        if (name !== "bot_work_list") actions.push(name)
        let receipt: unknown = { work }
        if (name === "bot_work_projects")
          receipt = {
            items: [
              {
                projectId: "project-1",
                name: "演示项目",
                path: "/synthetic/project",
                archived: false
              }
            ],
            nextCursor: null
          }
        if (name === "bot_work_list")
          receipt = {
            items: test.ambiguous
              ? [work, { ...work, id: "work-2", title: "周六读书会计划" }]
              : [{ ...work, state: test.name === "completed-follow-up" ? "completed" : "active" }],
            nextCursor: null
          }
        if (name === "bot_work_create") {
          receipt = {
            work: {
              ...work,
              title: args.title,
              goal: args.goal,
              workspace: args.workspace ?? { kind: "default", path: "/synthetic/default" }
            },
            task: {
              id: "queued-execution",
              workId: work.id,
              threadId: work.threadId,
              state: "queued",
              message: args.goal
            }
          }
          if (test.directory)
            assert.deepEqual(args.workspace, { kind: "directory", path: test.directory }, test.name)
          else if (test.project)
            assert.deepEqual(
              args.workspace,
              { kind: "project", projectId: test.project },
              test.name
            )
          else assert.equal(args.workspace, undefined, test.name + ": must use default")
        }
        if (name === "bot_work_send" || name === "bot_work_continue") {
          assert.equal(args.workId, work.id, test.name + ": must use original work")
          assert.equal(args.workspace, undefined)
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ kind: "bot-work-receipt", operation: name, receipt })
        })
      }
    }
    assert.ok(finalText.trim(), test.name + ": must finish with a user-visible response")
    assert.deepEqual(
      actions,
      test.allowDirect && !actions.length ? [] : test.expected,
      test.name + ": synthetic reply: " + finalText.slice(0, 600)
    )
    console.log(
      "PASS semantic route:",
      test.name,
      actions.length ? actions.join(" → ") : "main reply"
    )
  }
  console.log("PASS real-model routing:", {
    model: config.model,
    cases: selectedCases.length,
    requests,
    realActions: 0
  })
}
main().catch((error) => {
  // Never print provider responses, request headers, environment or model config.
  console.error(error instanceof Error ? error.message : "Routing check failed")
  process.exitCode = 1
})
