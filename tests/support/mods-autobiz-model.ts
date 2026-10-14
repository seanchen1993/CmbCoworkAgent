import { createServer } from "node:http"
import { join } from "node:path"

/** A deterministic protocol peer. Real runtime tools read/edit the isolated upstream source. */
export async function startAutobizModel(workspace: string) {
  const requests: Record<string, unknown>[] = []
  const calls: { name: string; repair: boolean }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    if (!Array.isArray(body.tools)) {
      const content =
        "AUTOBIZ_REAL_EVIDENCE_REPORT：已收到宿主本次检视与测试结果，未推进 checkpoint。"
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(
          `data: ${JSON.stringify({ id: `autobiz-report-${requests.length}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\n`
        )
        response.end("data: [DONE]\n\n")
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: `autobiz-report-${requests.length}`,
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }
        })
      )
      return
    }
    const messages = body.messages as {
      role: string
      content: unknown
      tool_calls?: { function: { name: string } }[]
    }[]
    const repair = JSON.stringify(messages).includes("先读取前面真实测试的失败输出")
    const invoked = messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function.name)
    let name = "structured_output"
    let args: Record<string, unknown> = {
      passed: true,
      summary: "已读取真实 inspect_state.py；测试结论以原生回执为准，未推进 checkpoint。"
    }
    if (!invoked.includes("read_file")) {
      name = "read_file"
      args = { file_path: join(workspace, "inspect_state.py") }
    } else if (repair && !invoked.includes("edit_file")) {
      name = "edit_file"
      args = {
        file_path: join(workspace, "inspect_state.py"),
        old_string: '"currentNodeId": "fault-injected",',
        new_string: '"currentNodeId": "unknown",'
      }
    }
    calls.push({ name, repair })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: `autobiz-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `autobiz-call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    calls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}
