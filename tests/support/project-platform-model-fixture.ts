import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"

export type ProjectModelPhase = "missing" | "draft" | "review"

/** Loopback provider only. The application must run its real SDK, tools and Skill Hooks. */
export async function startProjectPlatformModel(workspace: string) {
  let phase: ProjectModelPhase = "missing"
  let advisorMode = false
  let advisorScenario: "completed" | "missing" = "completed"
  const advisorRequests: unknown[] = []
  const requests: Array<{
    phase: ProjectModelPhase
    model: string
    stage: string
    toolNames: string[]
    wrote: boolean
    skillVisible: boolean
  }> = []
  const hooks: Array<{ event: string; phase: ProjectModelPhase }> = []
  const errors: string[] = []
  const received: unknown[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        length += chunk.length
        assert(length < 2 * 1024 * 1024, "Bound fixture request size")
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (request.url?.startsWith("/skill-hook/")) {
        hooks.push({ event: request.url.slice("/skill-hook/".length), phase })
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
        return
      }
      assert.equal(request.url, "/v1/chat/completions")
      if (received.length < 16) received.push(body)
      assert.equal(body.model, "project-platform-fixture")
      assert(Array.isArray(body.messages))
      if (advisorMode) {
        assert.equal(advisorRequests.length, 0, "No automatic retry or repeated advisor inference")
        assert.equal((body.tools ?? []).length, 0, "Advisor must advertise no tools")
        assert.equal(body.messages.length, 2, "No conversation/history messages")
        assert.equal(body.messages[0].role, "system")
        assert.equal(body.messages[1].role, "user")
        const facts = JSON.parse(body.messages[1].content)
        assert.deepEqual(
          Object.keys(facts).sort(),
          [
            "scope",
            "retainedCalls",
            "succeeded",
            "failed",
            "running",
            "unknown",
            "outputBlocked",
            "truncatedHistory",
            "instructionObservation",
            "project"
          ].sort()
        )
        assert.deepEqual(
          Object.keys(facts.project).sort(),
          [
            "state",
            "stageNumber",
            "totalStages",
            "currentStageNumber",
            "projectStatus",
            "operationStatus",
            "approval",
            "checks",
            "declaredArtifacts",
            "receiptsMatchCurrentVersion",
            "recordedAttempts",
            "historyMayBeLimited"
          ].sort()
        )
        assert.equal(facts.project.state, "observed")
        if (advisorScenario === "completed") {
          assert.equal(facts.project.projectStatus, "completed")
          assert.equal(facts.project.stageNumber, 2)
          assert.equal(
            facts.project.receiptsMatchCurrentVersion,
            false,
            "Prior receipts must remain historical after advance"
          )
          assert(facts.project.checks.passed >= 2)
        } else {
          assert.equal(facts.project.projectStatus, "active")
          assert.equal(facts.project.stageNumber, 1)
          assert.equal(facts.project.operationStatus, "failed")
          assert(facts.project.checks.failed + facts.project.checks.blocked > 0)
        }
        const payload = JSON.stringify(body.messages)
        for (const forbidden of [
          workspace,
          "draft.md",
          "review.json",
          "隔离项目真实工具产物",
          "实际读取固定阶段说明",
          "在当前阶段生成文档产物",
          "project-docs-lite-draft"
        ])
          assert(!payload.includes(forbidden), `Advisor leaked source/path/goal: ${forbidden}`)
        assert((body.max_tokens ?? body.max_completion_tokens) <= 512)
        advisorRequests.push({ facts, tools: body.tools ?? [], messageCount: body.messages.length })
        response.writeHead(200, { "content-type": "text/event-stream" })
        const advice =
          advisorScenario === "missing"
            ? "PROJECT_ADVISOR_RESULT：本阶段有成果检查未通过；请先查看失败原因，补齐成果后再运行，不能直接推进。"
            : "PROJECT_ADVISOR_RESULT：这是历史检查记录；查看当前产物后再决定下一步。"
        response.write(
          `data: ${JSON.stringify({ id: "advisor-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: advice }, finish_reason: null }] })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({ id: "advisor-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
        )
        response.end("data: [DONE]\n\n")
        return
      }
      assert(requests.length < 16, "Unexpected repeated model inference")
      const text = body.messages
        .map((message: { content: unknown }) =>
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map((block) => (block?.type === "text" ? block.text : ""))
                  .join("\n")
              : ""
        )
        .join("\n")
      const stage = text.includes('"stageId":"review"')
        ? "review"
        : text.includes('"stageId":"draft"')
          ? "draft"
          : "unknown"
      assert.equal(
        stage,
        phase === "review" ? "review" : "draft",
        "Real stage context must reach the provider"
      )
      const skillVisible = text.includes("project-docs-lite-draft") && text.includes("review.json")
      assert(skillVisible, "The original Skill instructions must reach the provider")
      const wrote = body.messages.some(
        (message: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
          message.tool_calls?.some((call) => call.function?.name === "write_file")
      )
      const toolNames = (body.tools ?? []).map(
        (tool: { function?: { name?: string } }) => tool.function?.name ?? ""
      )
      requests.push({ phase, model: body.model, stage, toolNames, wrote, skillVisible })
      const write = phase !== "missing" && !wrote
      const edited = body.messages.some(
        (message: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
          message.tool_calls?.some((call) => call.function?.name === "edit_file")
      )
      const revise = phase === "review" && wrote && !edited
      // A tool call alone is not success: native file tools return plain-string refusals too.
      for (const message of body.messages) {
        for (const call of message.tool_calls ?? []) {
          const name = call.function?.name
          if (!["write_file", "read_file", "edit_file"].includes(name)) continue
          const result = body.messages.find(
            (entry: { role?: string; tool_call_id?: string }) =>
              entry.role === "tool" && entry.tool_call_id === call.id
          )
          assert.equal(typeof result?.content, "string", `Missing actual ${name} result`)
          if (name === "write_file") assert.match(result.content, /^Successfully wrote to '.+'$/s)
          else if (name === "edit_file")
            assert.match(result.content, /^Successfully replaced 1 occurrence\(s\) in '.+'$/s)
          else assert(result.content.includes("由本机模型通过原 write_file 工具写入。"))
        }
      }
      if (revise)
        assert(
          body.messages.some((message: { tool_calls?: Array<{ function?: { name?: string } }> }) =>
            message.tool_calls?.some((call) => call.function?.name === "read_file")
          ),
          "Read the existing draft successfully before editing"
        )
      if (phase === "review")
        for (const name of ["read_file", "edit_file"])
          assert(toolNames.includes(name), `Use the actual advertised native ${name} tool`)
      if (write)
        assert(toolNames.includes("write_file"), "Use the actual advertised native write tool")
      const marker = `PROJECT_PLATFORM_FINAL_${phase.toUpperCase()}`
      const content =
        phase === "review"
          ? JSON.stringify({ summary: "实际读取固定阶段说明并完成隔离文档复核", checked: true })
          : "# 隔离项目真实工具产物\n由本机模型通过原 write_file 工具写入。\n"
      const delta = write
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `project-write-${requests.length}`,
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    file_path: join(workspace, phase === "review" ? "review.json" : "draft.md"),
                    content
                  })
                }
              },
              ...(phase === "review"
                ? [
                    {
                      index: 1,
                      id: `project-read-draft-${requests.length}`,
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({
                          file_path: join(workspace, "draft.md")
                        })
                      }
                    }
                  ]
                : [])
            ]
          }
        : revise
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `project-revise-draft-${requests.length}`,
                  type: "function",
                  function: {
                    name: "edit_file",
                    arguments: JSON.stringify({
                      file_path: join(workspace, "draft.md"),
                      old_string: "由本机模型通过原 write_file 工具写入。",
                      new_string: "复核阶段已实际修正文档：PROJECT_REVIEW_REVISED_DRAFT"
                    })
                  }
                }
              ]
            }
          : { role: "assistant", content: marker }
      const id = `project-provider-${requests.length}`
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }]
        })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            { index: 0, delta: {}, finish_reason: write || revise ? "tool_calls" : "stop" }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
        })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Isolated project provider assertion failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    hooks,
    errors,
    received,
    advisorRequests,
    setAdvisorMode(scenario: "completed" | "missing" = "completed") {
      advisorMode = true
      advisorScenario = scenario
    },
    setPhase(value: ProjectModelPhase) {
      phase = value
      advisorMode = false
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
