import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import type { ProjectDraft } from "../../src/main/mods/devtools/project-authoring-session"

export const HARNESS_PACKAGE_ID = "authored-harness-lite"
export const HARNESS_DRAFT = "# HARNESS_ORIGINAL_DRAFT\n保留的原始草稿。\n"
export const HARNESS_REVIEWED = "# HARNESS_REVIEWED_COPY\n实际读取原稿后生成的复核版本。\n"
export const HARNESS_NODE_TITLE = "节点编译后的复核步骤"
export const HARNESS_SKILL_MARKER = "HARNESS_SKILL_ONLY_AUTHORING"
type Packet = { ok: boolean; result?: Record<string, unknown>; error?: string }
type Message = {
  role: string
  content: string | Array<{ type: string; text?: string }> | null
  tool_call_id?: string
}
const text = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")

/** Scripts only model tool choices; source and receipts always come from the production tools. */
export async function startProjectHarnessModel(
  options: {
    requestTrial?: boolean
    packageExtensions?: {
      files: Array<{ path: string; text: string }>
      metadata: Record<string, unknown>
    }
  } = {}
) {
  const observations: Array<{ action: string; packet: Packet }> = []
  const requests: Array<{ at: number; mode: string; stage?: string; tools: string[] }> = []
  const errors: string[] = []
  const issued = new Map<string, { name: string; action?: string; path?: string }>()
  const seen = new Set<string>()
  let draft: ProjectDraft | undefined
  let mode = "author"
  let workspace = ""
  let packed: string | undefined
  let sequence = 0
  function call(name: string, args: Record<string, unknown>, index = 0) {
    const id = `harness-tool-${++sequence}`
    issued.set(id, {
      name,
      action: args.action as string | undefined,
      path: args.file_path as string | undefined
    })
    return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } }
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/v1/chat/completions")
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        assert(bytes < 4 * 1024 * 1024)
        chunks.push(Buffer.from(chunk))
      }
      const body: {
        model: string
        messages: Message[]
        tools?: Array<{ function: { name: string } }>
      } = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert.equal(body.model, "harness-author-fixture")
      assert(requests.length < 30)
      const tools = (body.tools ?? []).map((tool) => tool.function.name)
      let calls: ReturnType<typeof call>[] = []
      let answer = ""
      if (mode === "pack") {
        requests.push({ at: Date.now(), mode, tools })
        assert(tools.includes("mod_authoring"))
        const result = body.messages.findLast(
          (message) =>
            message.role === "tool" &&
            issued.get(message.tool_call_id ?? "")?.action === "project_pack"
        )
        if (!result)
          calls = [
            call("mod_authoring", {
              action: "project_pack",
              id: HARNESS_PACKAGE_ID,
              revision: draft!.revision
            })
          ]
        else {
          const packet: Packet = JSON.parse(text(result))
          assert.equal(packet.ok, true, JSON.stringify(packet))
          assert.equal(typeof packet.result?.output, "string")
          packed = packet.result!.output as string
          answer = "HARNESS_PACKAGE_EXPORTED"
        }
      } else if (mode === "author") {
        requests.push({ at: Date.now(), mode, tools })
        assert(tools.includes("mod_authoring"))
        for (const message of body.messages) {
          const id = message.tool_call_id
          if (message.role !== "tool" || !id || seen.has(id)) continue
          const operation = issued.get(id)
          assert(operation?.action)
          const packet: Packet = JSON.parse(text(message))
          assert.equal(packet.ok, true, JSON.stringify(packet))
          assert(packet.result)
          observations.push({ action: operation.action, packet })
          seen.add(id)
          if (["project_scaffold", "project_save", "project_compile"].includes(operation.action)) {
            draft = packet.result as unknown as ProjectDraft
            assert(Number.isSafeInteger(draft.revision))
            assert(draft.source.files.some((file) => file.path === "devclaw.harness.json"))
          }
          if (operation.action === "project_doctor")
            assert.equal(
              packet.result.valid,
              observations.length !== 3,
              "Node edits need explicit compilation"
            )
          if (operation.action === "project_test") assert.equal(packet.result.valid, true)
        }
        const base = { id: HARNESS_PACKAGE_ID, name: "技能与节点实包制作" }
        const revision = draft?.revision
        let args: Record<string, unknown> | undefined
        switch (observations.length) {
          case 0:
            args = { action: "project_scaffold", ...base, template: "harness-lite" }
            break
          case 1: {
            assert(draft)
            const files = structuredClone(draft.source.files)
            const nodeFile = files.find((file) => file.path === "devclaw.harness.json")!
            const nodes = JSON.parse(nodeFile.text)
            assert.deepEqual(
              nodes.nodes[1].artifacts.map((artifact: { path: string }) => artifact.path),
              ["review.json", "reviewed.md"]
            )
            nodes.nodes[1].title = HARNESS_NODE_TITLE
            nodeFile.text = JSON.stringify(nodes)
            for (const file of files.filter((file) => file.path.endsWith("/SKILL.md")))
              file.text += `\n${HARNESS_SKILL_MARKER}\n`
            if (options.packageExtensions) {
              const metadata = files.find((file) => file.path === "plugin.json")!
              metadata.text = JSON.stringify({
                ...JSON.parse(metadata.text),
                ...options.packageExtensions.metadata
              })
              files.push(...options.packageExtensions.files)
            }
            // Never write the generated runtime/contract: production project_compile must do it.
            args = { action: "project_save", ...base, revision, files }
            break
          }
          case 2:
          case 4:
            args = { action: "project_doctor", id: base.id, revision }
            break
          case 3:
            args = { action: "project_compile", id: base.id, revision }
            break
          case 5:
            args = { action: "project_test", id: base.id, revision }
            break
          case 6:
            args = { action: "project_dev", id: base.id, revision }
            break
          case 7:
            if (options.requestTrial)
              args = {
                action: "project_request_trial",
                id: base.id,
                revision,
                goal: "保留原稿，生成独立复核版本和真实检查记录"
              }
            else answer = "HARNESS_AUTHOR_READY：节点已编译检查，隔离试用已准备；未安装、未运行。"
            break
          default:
            answer = "HARNESS_AUTHOR_READY：节点已编译检查，隔离试用已准备；未安装、未运行。"
        }
        if (args) calls = [call("mod_authoring", args)]
      } else {
        const input = body.messages.map(text).join("\n")
        const stage = input.includes('"stageId":"review"')
          ? "review"
          : input.includes('"stageId":"draft"')
            ? "draft"
            : "unknown"
        assert.notEqual(stage, "unknown")
        requests.push({ at: Date.now(), mode, stage, tools })
        const block = input.match(
          /<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<\/CMBDEVCLAW-SKILL-USE-V1>/
        )?.[0]
        assert(block)
        const encoded = block.match(/<path>([^<]+)<\/path>/)?.[1]
        assert(encoded)
        const skillPath = encoded.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
        const results = body.messages
          .filter((message) => message.role === "tool")
          .map((message) => {
            const source = issued.get(message.tool_call_id ?? "")
            assert(source)
            const result = text(message)
            if (source.name === "mcp__harness-package-observer__stamp")
              assert(
                result.includes("HARNESS_PINNED_MOD"),
                "A real package Mod must service the native tool"
              )
            else if (source.name.endsWith("echo"))
              assert(
                result.includes(`pinned:${stage}`),
                "The retained package MCP must actually answer"
              )
            else if (source.name === "write_file")
              assert.match(result, /^Successfully wrote to '.+'$/s)
            else if (source.path === skillPath) assert(result.includes(HARNESS_SKILL_MARKER))
            else
              assert(
                result.includes("HARNESS_ORIGINAL_DRAFT"),
                "Real draft read must precede review"
              )
            return source
          })
        const has = (name: string, path: string) =>
          results.some((result) => result.name === name && result.path === path)
        const stamp = "mcp__harness-package-observer__stamp"
        const echo = options.packageExtensions
          ? tools.find((name) => name.endsWith("echo"))
          : undefined
        if (options.packageExtensions) {
          assert(tools.includes(stamp), "Real package Mod must register its tool")
          assert(echo, "Same-package MCP must appear in the original model tools")
        }
        if (options.packageExtensions && !results.some((result) => result.name === stamp))
          calls = [call(stamp, {})]
        else if (echo && !results.some((result) => result.name === echo))
          calls = [call(echo, { text: stage })]
        else if (!has("read_file", skillPath)) calls = [call("read_file", { file_path: skillPath })]
        else if (stage === "review" && !has("read_file", join(workspace, "draft.md")))
          calls = [call("read_file", { file_path: join(workspace, "draft.md") })]
        else if (stage === "draft" && !has("write_file", join(workspace, "draft.md")))
          calls = [
            call("write_file", { file_path: join(workspace, "draft.md"), content: HARNESS_DRAFT })
          ]
        else if (stage === "review" && !has("write_file", join(workspace, "reviewed.md")))
          calls = [
            call("write_file", {
              file_path: join(workspace, "reviewed.md"),
              content: HARNESS_REVIEWED
            }),
            call(
              "write_file",
              {
                file_path: join(workspace, "review.json"),
                content: JSON.stringify({ summary: "真实读取原稿并保存复核副本", checked: true })
              },
              1
            )
          ]
        else answer = `HARNESS_STAGE_DONE_${stage}`
        for (const invocation of calls) assert(tools.includes(invocation.function.name))
      }
      const delta = calls.length
        ? { role: "assistant", tool_calls: calls }
        : { role: "assistant", content: answer }
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const [piece, finish] of [
        [delta, null],
        [{}, calls.length ? "tool_calls" : "stop"]
      ])
        response.write(
          `data: ${JSON.stringify({ id: `harness-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: piece, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Harness fixture assertion failed")
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
      assert(draft)
      return draft
    },
    pack() {
      mode = "pack"
    },
    get packed() {
      assert(packed)
      return packed
    },
    stage(path: string) {
      mode = "stage"
      workspace = path
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
