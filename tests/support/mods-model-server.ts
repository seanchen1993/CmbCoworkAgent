import { createServer } from "node:http"

/** Local protocol fixture; the application still uses production model settings and client. */
export async function startModsModelServer() {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>
    [key: string]: unknown
  }> = []
  let closedStalls = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    const prompt = String(body.messages?.at(-1)?.content)
    if (prompt.includes("[error]")) {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "synthetic provider failure" } }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const event = (choices: unknown[], usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({
          id: "mods-model-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "mods-model-fixture",
          choices,
          ...(usage ? { usage } : {})
        })}\n\n`
      )
    event([
      { index: 0, delta: { role: "assistant", content: "SDK_MODEL_OK " }, finish_reason: null }
    ])
    if (prompt.includes("[stall]")) {
      response.on("close", () => {
        closedStalls++
      })
      return
    }
    event([{ index: 0, delta: { content: "sk-private-fixture-123456789" }, finish_reason: "stop" }])
    event([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("Missing model fixture endpoint")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    closedStalls: () => closedStalls,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  }
}
