import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import type { ProjectDraft } from "../../src/main/mods/devtools/project-authoring-session"
import type { ClawActionDescriptor } from "../../src/shared/mods/claw-actions"

type Files = Array<{ path: string; text: string }>
type Packet = { ok: boolean; result?: unknown; error?: string }
interface ModelMessage {
  role: string
  content: string | Array<{ type: string; text?: string }> | null
  tool_call_id?: string
  tool_calls?: Array<{ function?: { name?: string } }>
}
interface ModelRequest {
  model: string
  tools?: Array<{ function?: { name?: string } }>
  messages: ModelMessage[]
}
interface SchemaFixture {
  checks: Array<{ id: string; schema?: { properties: { summary: { pattern?: string } } } }>
}
function resultObject(packet: Packet): Record<string, unknown> {
  assert(packet.result && typeof packet.result === "object" && !Array.isArray(packet.result))
  return packet.result as Record<string, unknown>
}
export const AUTHOR_PACKAGE_ID = "authored-project-docs"

/** Deterministic provider scripts tool choices, never their results or host implementation. */
export async function startProjectAuthoringModel() {
  const observations: Array<{ action: string; packet: Packet }> = []
  const requests: Array<{ mode: string; toolNames: string[] }> = []
  const errors: string[] = []
  const seen = new Set<string>()
  const sent = new Map<string, string>()
  const skillReads = new Map<string, { phase: string; stage: string; path: string }>()
  let original: Files = []
  let draft: ProjectDraft | undefined
  let descriptor: ClawActionDescriptor | undefined
  let mode: "author" | "stage" | "advisor" = "author"
  let workspace = ""
  let phase = ""
  let updateRequested = false
  const base = { id: AUTHOR_PACKAGE_ID, name: "自然语言文档项目" }
  function choose(): Record<string, unknown> | undefined {
    const at = observations.length
    const revision = draft?.revision
    const repaired = () => structuredClone(original)
    if (updateRequested && at === 13) {
      assert(draft)
      const files: Files = structuredClone(draft.source.files)
      const skill = files.find((file) => file.path === "skills/draft/SKILL.md")!
      skill.text += "\nAUTHOR_PREVIEW_V2\n"
      return { action: "project_save", ...base, revision, files }
    }
    const provider = descriptor && {
      pluginId: descriptor.pluginId,
      plugin: descriptor.plugin,
      digest: descriptor.digest,
      actionId: descriptor.actionId
    }
    if (at === 0) return { action: "project_scaffold", ...base }
    if (at === 1) {
      const files = repaired()
      const file = files.find((file) => file.path === "devclaw.project-runtime.json")!
      const manifest: SchemaFixture = JSON.parse(file.text)
      const check = manifest.checks.find((check) => check.id === "review-schema")
      assert(check?.schema)
      check.schema.properties.summary.pattern = ".*"
      file.text = JSON.stringify(manifest)
      return { action: "project_save", ...base, revision, files }
    }
    if (at === 2 || at === 4 || at === 9) return { action: "project_doctor", id: base.id, revision }
    if (at === 3) return { action: "project_save", ...base, revision, files: repaired() }
    if (at === 5 || at === 10) return { action: "project_test", id: base.id, revision }
    if (at === 6) return { action: "project_actions" }
    if (at === 7)
      return {
        action: "project_bind_action",
        id: base.id,
        revision,
        stageId: "review",
        localActionId: "format-note",
        provider,
        actionInput: { text: "AUTHORING_PUBLIC_ACTION_INPUT" }
      }
    if (at === 8)
      return {
        action: "project_bind_action",
        id: base.id,
        revision,
        stageId: "review",
        localActionId: "format-again",
        provider,
        actionInput: {},
        inputFrom: { kind: "action", actionId: "format-note", pointer: "" }
      }
    if (at === 11) return { action: "project_dev", id: base.id, revision }
    if (at === 12) return { action: "project_pack", id: base.id, revision }
    return undefined
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/v1/chat/completions")
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        assert(size < 4 * 1024 * 1024)
        chunks.push(Buffer.from(chunk))
      }
      const body: ModelRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "")
      assert.equal(body.model, "project-author-fixture")
      assert(Array.isArray(body.messages))
      assert(requests.length < 45, "Repeated inference limit")
      requests.push({ mode, toolNames: tools })
      let delta: Record<string, unknown>
      let calls = false
      if (mode === "author") {
        assert(tools.includes("mod_authoring"), "Real creator-session tool is required")
        for (const message of body.messages) {
          const id = message.tool_call_id
          if (message.role !== "tool" || !id || !sent.has(id) || seen.has(id)) continue
          const text =
            typeof message.content === "string"
              ? message.content
              : (message.content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
          const packet: Packet = JSON.parse(text)
          assert.equal(packet.ok, true, JSON.stringify(packet))
          const action = sent.get(id)!
          observations.push({ action, packet })
          seen.add(id)
          if (["project_scaffold", "project_save", "project_bind_action"].includes(action)) {
            const result = resultObject(packet)
            assert(Number.isSafeInteger(result.revision))
            draft = result as unknown as ProjectDraft
            assert(Array.isArray(draft.source.files))
          }
          if (action === "project_scaffold") {
            assert(draft)
            original = structuredClone(draft.source.files)
          }
          if (action === "project_doctor") {
            const expected = observations.length !== 3
            assert.equal(
              resultObject(packet).valid,
              expected,
              "Doctor must expose unsupported schema before repair"
            )
          }
          if (action === "project_test") assert.equal(resultObject(packet).valid, true)
          if (action === "project_actions") {
            const actions = resultObject(packet).actions
            assert(Array.isArray(actions))
            descriptor = (actions as ClawActionDescriptor[]).find(
              (item) =>
                item.plugin === "project-public-action-provider" && item.actionId === "format"
            )
            assert(descriptor, "Use only the host-returned authorized real installation identity")
          }
        }
        const args = choose()
        if (args) {
          const id = `author-call-${observations.length}`
          sent.set(id, String(args.action))
          calls = true
          delta = {
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
        } else
          delta = {
            role: "assistant",
            content:
              "PROJECT_AUTHORING_READY：已检查、修复并打包；隔离试用目录已准备，尚未运行或安装。"
          }
      } else if (mode === "advisor") {
        assert.equal(tools.length, 0, "Optional advisor cannot receive execution tools")
        const text = JSON.stringify(body.messages)
        assert(!text.includes("AUTHORING_FILE_BODY_SENTINEL"), "Advisor must not send file body")
        delta = {
          role: "assistant",
          content: "请查看已有失败记录并核对检查范围。这是建议，不是执行结果。"
        }
      } else {
        const text = body.messages
          .map((item) =>
            typeof item.content === "string"
              ? item.content
              : Array.isArray(item.content)
                ? item.content
                    .map((block: { type?: string; text?: string }) =>
                      block.type === "text" ? (block.text ?? "") : ""
                    )
                    .join("\n")
                : ""
          )
          .join("\n")
        const stage = text.includes('"stageId":"review"')
          ? "review"
          : text.includes('"stageId":"draft"')
            ? "draft"
            : "unknown"
        assert.notEqual(stage, "unknown", "Actual stage context must reach the provider")
        assert(text.includes(`${AUTHOR_PACKAGE_ID}-draft`), "Run the actual authored Skill")
        // Explicit Skills are lazy: the trusted block identifies the immutable file,
        // and the original read_file tool must supply its body before version assertions.
        const skillBlock = text.match(
          /<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<\/CMBDEVCLAW-SKILL-USE-V1>/
        )?.[0]
        assert(skillBlock, "The original explicit Skill block must reach the provider")
        const encodedPath = skillBlock.match(/<path>([^<]+)<\/path>/)?.[1]
        assert(encodedPath, "The trusted Skill block must identify its actual SKILL.md")
        const skillPath = encodedPath
          .replace(/&gt;/g, ">")
          .replace(/&lt;/g, "<")
          .replace(/&amp;/g, "&")
        const readResult = body.messages.find((message) => {
          const read = message.tool_call_id && skillReads.get(message.tool_call_id)
          return (
            message.role === "tool" &&
            read &&
            read.phase === phase &&
            read.stage === stage &&
            read.path === skillPath
          )
        })
        const wrote = body.messages.some((item) =>
          item.tool_calls?.some((call) => call.function?.name === "write_file")
        )
        calls = !readResult || !wrote
        if (!readResult) {
          assert(tools.includes("read_file"), "The actual Skill reader must be available")
          const id = `skill-read-${requests.length}`
          skillReads.set(id, { phase, stage, path: skillPath })
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ file_path: skillPath })
                }
              }
            ]
          }
        } else {
          const skillBody =
            typeof readResult.content === "string"
              ? readResult.content
              : (readResult.content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text ?? "")
                  .join("\n")
          assert(
            skillBody.includes(`${AUTHOR_PACKAGE_ID}-draft`),
            "A real successful read must return the authored Skill body"
          )
          assert.equal(
            skillBody.includes("AUTHOR_PREVIEW_V2"),
            phase === "preview-next",
            "Existing preview and formal packages retain their original Skill snapshot"
          )
          if (!wrote) {
            assert(tools.includes("write_file"))
            delta = {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `stage-${requests.length}`,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      file_path: join(workspace, stage === "draft" ? "draft.md" : "review.json"),
                      content:
                        stage === "draft"
                          ? "AUTHORING_FILE_BODY_SENTINEL\n真实模型工具产物"
                          : JSON.stringify({ summary: "真实宿主文件检查", checked: true })
                    })
                  }
                }
              ]
            }
          } else delta = { role: "assistant", content: `AUTHOR_STAGE_DONE_${phase}_${stage}` }
        }
      }
      const id = `author-provider-${requests.length}`
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
          choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
        })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Owned author fixture failed")
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
    observations,
    requests,
    errors,
    get draft() {
      assert(draft, "The author must return a real draft before it is used")
      return draft
    },
    stage(path: string, label: string) {
      mode = "stage"
      workspace = path
      phase = label
    },
    update() {
      mode = "author"
      updateRequested = true
    },
    advisor() {
      mode = "advisor"
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
