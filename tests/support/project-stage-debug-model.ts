import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ProjectDraft } from "../../src/main/mods/devtools/project-authoring-session"
import { HARNESS_PACKAGE_ID, startProjectHarnessModel } from "./project-harness-model-fixture"

export const STAGE_DEBUG_REVIEW_MARKER = "S6_REVISED_REVIEW_SKILL_NATIVE_READ"
type Message = { role: string; content: unknown; tool_call_id?: string }
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text ?? "").join("\n")
      : ""

/** Only model choices are controlled. Production authoring tools and the normal runner own files,
 * revisions, approvals, snapshots and receipts. Original stage behavior reuses the proven fixture. */
export async function startStageDebugModel() {
  const original = await startProjectHarnessModel({ requestTrial: true })
  let revising = false
  let revisionDone = false
  let revised: ProjectDraft | undefined
  let sequence = 0
  const issued = new Map<string, string>()
  const results = new Map<string, Record<string, unknown>>()
  const errors: string[] = []
  const traces: Array<{
    mode: string
    tools: string[]
    revisedSkillRead: boolean
    originalDraftRead: boolean
  }> = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/v1/chat/completions")
      const parts: Buffer[] = []
      let bytes = 0
      for await (const part of request) {
        bytes += part.length
        assert(bytes < 4 * 1024 * 1024)
        parts.push(Buffer.from(part))
      }
      assert(traces.length < 60, "No uncontrolled model retries")
      const raw = Buffer.concat(parts)
      const body = JSON.parse(raw.toString("utf8")) as {
        model: string
        messages: Message[]
        tools?: Array<{ function: { name: string } }>
      }
      const tools = (body.tools ?? []).map((tool) => tool.function.name)
      const returned = body.messages.filter((message) => message.role === "tool")
      traces.push({
        mode: revising ? "revision" : "original-runner",
        tools,
        revisedSkillRead: returned.some((message) =>
          text(message.content).includes(STAGE_DEBUG_REVIEW_MARKER)
        ),
        originalDraftRead: returned.some((message) =>
          text(message.content).includes("HARNESS_ORIGINAL_DRAFT")
        )
      })
      if (!revising) {
        const result = await fetch(`${original.url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw.toString("utf8")
        })
        response.writeHead(result.status, {
          "content-type": result.headers.get("content-type") ?? "text/plain"
        })
        response.end(await result.text())
        return
      }
      assert(tools.includes("mod_authoring"))
      for (const message of returned) {
        const action = issued.get(message.tool_call_id ?? "")
        if (!action || results.has(action)) continue
        const packet = JSON.parse(text(message.content))
        assert.equal(packet.ok, true, JSON.stringify(packet))
        assert(packet.result && typeof packet.result === "object")
        results.set(action, packet.result)
        if (action === "project_read" || action === "project_save")
          revised = packet.result as ProjectDraft
      }
      let args: Record<string, unknown> | undefined
      if (!results.has("project_read")) args = { action: "project_read", id: HARNESS_PACKAGE_ID }
      else if (!results.has("project_save")) {
        assert(revised)
        args = {
          action: "project_save",
          id: revised.id,
          name: revised.name,
          revision: revised.revision,
          files: revised.source.files.map((file) =>
            file.path === "skills/review/SKILL.md"
              ? {
                  ...file,
                  text: `${file.text}\n${STAGE_DEBUG_REVIEW_MARKER}\nRead the restored draft and write only the declared review outputs.\n`
                }
              : file
          )
        }
      } else if (!results.has("project_doctor"))
        args = { action: "project_doctor", id: revised!.id, revision: revised!.revision }
      else if (!results.has("project_test"))
        args = { action: "project_test", id: revised!.id, revision: revised!.revision }
      else {
        assert.equal(results.get("project_doctor")!.valid, true)
        assert.equal(results.get("project_test")!.valid, true)
        revisionDone = true
      }
      const id = `stage-debug-revision-${++sequence}`
      if (args) issued.set(id, String(args.action))
      const delta = args
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: "mod_authoring", arguments: JSON.stringify(args) }
              }
            ]
          }
        : {
            role: "assistant",
            content: "S6_REVIEW_REVISION_READY：仅修改review技能，未批准、未运行新分支。"
          }
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const [piece, reason] of [
        [delta, null],
        [{}, args ? "tool_calls" : "stop"]
      ])
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: piece, finish_reason: reason }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
          })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Stage debug fixture assertion failed")
    }
  })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", done)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    original,
    traces,
    errors,
    revise() {
      revising = true
    },
    get revisionDone() {
      return revisionDone
    },
    get revised() {
      assert(revised)
      return revised
    },
    stage(workspace: string) {
      revising = false
      original.stage(workspace)
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done()))
      )
      await original.close()
    }
  }
}
