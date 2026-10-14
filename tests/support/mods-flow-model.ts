import { createServer } from "node:http"

export const fixedOrderExport = `exports.exportOrders = (orders, status) => {
  const escape = value => /[,"\\r\\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value)
  return "id,customer,status\\n" + orders.filter(o => o.status === status).slice().sort((a,b) => a.id-b.id)
    .map(o => [o.id,o.customer,o.status].map(escape).join(",") + "\\n").join("")
}
`

/** Deterministic provider only. Production Agent/tool execution and native tests remain real. */
export async function startFlowModel(project: string) {
  const requests: Array<{
    model: string
    marker: string
    tool: string
    prompt: string
    previousTool?: string
  }> = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const user = JSON.stringify(
        body.messages?.find((m: { role: string }) => m.role === "user")?.content
      )
      const marker = /\[FLOW-([A-Z]+)\]/.exec(user)?.[1] ?? "UNKNOWN"
      const hasCall = (name: string) =>
        body.messages?.some(
          (m: { role: string; tool_calls?: Array<{ function: { name: string } }> }) =>
            m.role === "assistant" && m.tool_calls?.some((t) => t.function.name === name)
        )
      const tool =
        marker !== "REPAIR"
          ? "structured_output"
          : !hasCall("read_file")
            ? "read_file"
            : !hasCall("edit_file")
              ? "edit_file"
              : "structured_output"
      const args =
        tool === "edit_file"
          ? {
              file_path: project.replace(/\\/g, "/") + "/order-export.cjs",
              old_string:
                'exports.exportOrders = orders => orders.map(o => [o.id,o.customer,o.status].join(",")).join("\\n")',
              new_string: fixedOrderExport
            }
          : tool === "read_file"
            ? { file_path: project.replace(/\\/g, "/") + "/order-export.cjs" }
            : {
                passed: true,
                summary: `Controlled provider ${marker}; native business tests decide acceptance`
              }
      requests.push({
        model: body.model,
        prompt: user,
        marker,
        tool,
        previousTool:
          body.messages?.at(-1)?.role === "tool"
            ? JSON.stringify(body.messages.at(-1).content).slice(0, 2500)
            : undefined
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const data = (choices: unknown[], usage?: unknown) =>
        response.write(
          `data: ${JSON.stringify({
            id: `flow-provider-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices,
            ...(usage ? { usage } : {})
          })}\n\n`
        )
      if (marker === "UNKNOWN") {
        const latestUser = JSON.stringify(body.messages?.filter((message: { role: string }) => message.role === "user").at(-1)?.content)
        const label = latestUser.includes("说明 A 模式") ? " CLAW-A-READY" : latestUser.includes("说明 B 模式") ? " CLAW-B-READY" : ""
        data([
          {
            index: 0,
            delta: { role: "assistant", content: "普通聊天答复：已读取本次问题与运行摘要。" + label },
            finish_reason: "stop"
          }
        ])
        data([], { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
        response.end("data: [DONE]\n\n")
        return
      }
      data([
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `flow-tool-${requests.length}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ])
      data([], { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
