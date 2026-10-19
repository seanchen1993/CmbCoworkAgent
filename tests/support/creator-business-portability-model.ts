/** Test model decisions only. Original native tools and Hooks produce every business fact. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { isSameWorkspacePath } from "../../src/shared/workspace-path"
import { modelText, shellQuote, toolJson } from "./autobiz-full-app-model"

type Message = { role: string; content: unknown; tool_call_id?: string }
type Step = {
  key: string
  name: "read_file" | "execute" | "project_checkpoint"
  args: Record<string, unknown>
}
export function creatorBusinessPortabilityModel(input: {
  knowledgeFile: string
  knowledgeRule: string
}) {
  let binding: { workspace: string; source: string; feature: string } | undefined
  const requests: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const commands = new Set<string>(),
    files = new Set<string>(),
    complete = new Set<string>()
  const issued = new Map<string, { step: Step; skill: string }>()
  const checkpointResults: Array<{
    skill: string
    args: Record<string, unknown>
    result: Record<string, unknown>
  }> = []
  const held = new Set<ServerResponse>()
  const heldSkills: string[] = []
  let heldByNativeClose = 0,
    releasing = false
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const part of request) {
        const chunk = Buffer.from(part)
        bytes += chunk.length
        assert(bytes <= 4 * 1024 * 1024, "Bounded model request")
        chunks.push(chunk)
      }
      assert(requests.length < 40, "No unbounded model retry")
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string
        messages: Message[]
        tools?: Array<{ function: { name: string } }>
      }
      const raw = body.messages.map((message) => modelText(message.content)).join("\n")
      const user = modelText(body.messages.findLast((message) => message.role === "user")?.content)
      const skill = /<name>([^<]+)<\/name>/.exec(user)?.[1]
      const skillPath = /<path>([^<]+)<\/path>/.exec(user)?.[1]
      let step: Step | undefined
      if (body.tools?.length) {
        assert(binding && skill && skillPath, "Real native Skill and configured binding required")
        const workspace = /The workspace root is: ([^\r\n]+)/
          .exec(raw)?.[1]
          ?.trim()
          .replace(/^`|`$/g, "")
        assert(workspace && isSameWorkspacePath(realpathSync(workspace), binding.workspace))
        const source = skillPath.replace(/[\\/]skills[\\/].*$/, "")
        assert.notEqual(source, skillPath)
        assert(
          isSameWorkspacePath(realpathSync(source), binding.source),
          "Only this exact native retained package may supply the original Skill"
        )
        assert(raw.includes("A04_EXACT_EXPORT_KNOWLEDGE"), "Native collector index required")
        requests.push({
          at: Date.now(),
          skill,
          workspace,
          source,
          publishedTools: body.tools.map((tool) => tool.function.name),
          ruleBodyPresent: raw.includes(input.knowledgeRule)
        })
        for (const message of body.messages.filter((message) => message.role === "tool")) {
          const issuedCall = issued.get(message.tool_call_id ?? "")
          if (!issuedCall || issuedCall.skill !== skill) continue
          const call = issuedCall.step
          const text = modelText(message.content)
          assert(!/MODS_EXECUTION_FAILED|Command failed with exit code [1-9]/.test(text), text)
          if (call.key.startsWith("read-chosen-knowledge")) {
            assert(text.includes(input.knowledgeRule))
            complete.add(`knowledge:${skill}`)
            complete.add("read-chosen-knowledge")
          }
          if (call.name === "execute") toolJson(text)
          if (call.name === "project_checkpoint") {
            assert(/"status"\s*:\s*"committed"/.test(text), text)
            if (!complete.has(call.key))
              checkpointResults.push({ skill, args: call.args, result: toolJson(text) })
          }
          complete.add(call.key)
        }
        if (complete.has(`knowledge:${skill}`)) assert(raw.includes(input.knowledgeRule))
        const stateBytes = readFileSync(join(workspace, ".autobizdevops/state.json"))
        const state = JSON.parse(stateBytes.toString("utf8"))
        assert.deepEqual(Object.keys(state.features), [binding.feature])
        const command = [
          "python -I -B -X utf8",
          shellQuote(resolve("tests/support/autobiz-full-app-sample.py")),
          "prd",
          "--plugin-root",
          shellQuote(source),
          "--workspace",
          shellQuote(workspace),
          "--feature",
          shellQuote(binding.feature)
        ].join(" ")
        commands.add(command)
        files.add(input.knowledgeFile)
        files.add(skillPath)
        const plan: Step[] =
          skill === "autobiz-requirement-discuss"
            ? [
                {
                  key: "read-chosen-knowledge",
                  name: "read_file",
                  args: { file_path: input.knowledgeFile }
                },
                { key: "read-original-skill", name: "read_file", args: { file_path: skillPath } },
                { key: "author-prd-input", name: "execute", args: { command, cwd: workspace } },
                {
                  key: "checkpoint-prd_done",
                  name: "project_checkpoint",
                  args: {
                    checkpoint: "prd_done",
                    expectedStateDigest: createHash("sha256").update(stateBytes).digest("hex")
                  }
                }
              ]
            : skill === "autodev-specs"
              ? [
                  {
                    key: "read-chosen-knowledge-specs",
                    name: "read_file",
                    args: { file_path: input.knowledgeFile }
                  },
                  {
                    key: "checkpoint-specs_in_progress",
                    name: "project_checkpoint",
                    args: {
                      checkpoint: "specs_in_progress",
                      expectedStateDigest: createHash("sha256").update(stateBytes).digest("hex")
                    }
                  }
                ]
              : []
        // No generic transition or fixture state write: project_checkpoint owns its CAS/checks.
        step = plan.find((item) => !complete.has(item.key))
        if (skill !== "autobiz-requirement-discuss" && !step) {
          // Original biz-prd-validate runs while leaving prd_done, not on its done commit.
          // Only the real Specs entry checkpoint is allowed; no Specs authorship/checkpoint-done.
          // The subsequent actual HTTP is cancelled by the user through the original owner.
          held.add(response)
          heldSkills.push(skill)
          response.once("close", () => {
            if (!releasing) heldByNativeClose++
            held.delete(response)
          })
          return
        }
        if (skill === "autodev-specs" && step?.name === "project_checkpoint") {
          assert.equal(
            state.features[binding.feature].checkpoint,
            "prd_done",
            "Never replay an already-entered Specs checkpoint"
          )
        }
        if (step)
          assert(
            body.tools.some((tool) => tool.function.name === step!.name),
            `Original tool not published: ${step.name}`
          )
      } else requests.push({ at: Date.now(), kind: "native-summary", tools: 0 })
      const id = `a04-portability-${requests.length}`
      requests[requests.length - 1].issued = step
        ? { key: step.key, name: step.name, args: step.args }
        : null
      if (step) {
        assert(skill)
        issued.set(id, { step, skill })
      }
      const delta = step
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: step.name, arguments: JSON.stringify(step.args) }
              }
            ]
          }
        : {
            role: "assistant",
            content:
              "受控PRD输入已提交原检查；不声明整个项目完成，业务needs_review，生产not_evaluated。"
          }
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const choice of [
        { delta, finish_reason: null },
        { delta: {}, finish_reason: step ? "tool_calls" : "stop" }
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, ...choice }]
          })}\n\n`
        )
      }
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Controlled portability model rejected unexpected native facts")
    }
  })
  return {
    server,
    requests,
    errors,
    commands,
    files,
    complete,
    checkpointResults,
    bind(value: { workspace: string; source: string; feature: string }) {
      assert(!binding, "Bind once from the native confirmed source")
      binding = {
        ...value,
        workspace: realpathSync(value.workspace),
        source: realpathSync(value.source)
      }
    },
    observation: () => ({ held: held.size, heldByNativeClose, heldSkills: [...heldSkills] }),
    releaseHeldForCleanupOnly() {
      releasing = true
      for (const response of held) response.destroy()
      held.clear()
    }
  }
}
