import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { warehouseExportProgram, type WarehouseExportStep } from "./warehouse-export-model"

type Message = { role: string; content: unknown; tool_call_id?: string }
const text = (value: unknown): string => typeof value === "string" ? value :
  Array.isArray(value) ? value.map(part => text(part?.text)).join("\n") : ""
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
function report(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { return report(JSON.parse(value)) } catch { return undefined }
  }
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.bundleDigest === "string" && Array.isArray(item.artifacts) && item.producer) return item
  for (const entry of Object.values(item)) {
    const found = report(entry)
    if (found) return found
  }
  return undefined
}

export function warehouseExportLoopback() {
  const requests: unknown[] = [], errors: string[] = [], commands = new Set<string>()
  const files = new Set<string>(), complete = new Set<string>(), started = new Map<string, number>()
  const issued = new Map<string, { workspace: string; stage: string; step: WarehouseExportStep }>()
  let producerWorkspace = "", consumerWorkspace = "", consumed: Record<string, unknown> | undefined
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let raw = ""
      for await (const chunk of request) { raw += chunk; assert(raw.length < 4_000_000) }
      const body = JSON.parse(raw), messages = body.messages as Message[]
      assert(requests.length < 140)
      const prompt = messages.map(message => text(message.content)).join("\n")
      if (body.tools === undefined && /Create (?:a )?compact continuation handoff/i.test(prompt)) {
        requests.push({ at: Date.now(), kind: "original-runtime-summary", body })
        const content = "The explicit task is the local five-order CNY warehouse flow followed by JSON artifact consumption. " +
          "Required consumer IDs are warehouse_sql_results and warehouse_quality. Completed actual tool keys: " +
          [...complete].join(", ") + ". Continue only from the current original stage/state. " +
          "No tool grant, approval, checkpoint or artifact is created by this summary. Business acceptance remains needs_review."
        response.writeHead(200, { "content-type": "text/event-stream" })
        const packet = (delta: unknown, finish_reason: string | null) => ({ id: `summary-${requests.length}`,
          object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
        response.write(`data: ${JSON.stringify(packet({ role: "assistant", content }, null))}\n\n`)
        response.write(`data: ${JSON.stringify(packet({}, "stop"))}\n\n`)
        response.end("data: [DONE]\n\n")
        return
      }
      const workspace = /The workspace root is: ([^\r\n]+)/.exec(prompt)?.[1]?.trim().replace(/^`|`$/g, "")
      const user = text(messages.findLast(message => message.role === "user")?.content)
      const skill = /<name>([^<]+)<\/name>/.exec(user)?.[1]
      const skillPath = /<path>([^<]+)<\/path>/.exec(user)?.[1]
      assert(workspace && skill && skillPath, "Original canonical workspace and explicit Skill must reach HTTP")
      const key = `${workspace}:${skill}`
      if (!started.has(key)) started.set(key, Date.now())
      assert(Date.now() - started.get(key)! < 90000, "Original 90 second stage limit")
      let name: string | undefined, args: Record<string, unknown> = {}, step: WarehouseExportStep | undefined
      if (skill === "verified-json-report") {
        consumerWorkspace = workspace
        assert(producerWorkspace && producerWorkspace !== workspace)
        const content = readFileSync(join(workspace, "inputs/verified-context.json"), "utf8")
        const current = messages.filter(message => message.role === "tool")
        const actualReport = current.map(message => report(message.content)).find(Boolean)
        const bundle = JSON.parse(content)
        const read = current.some(message => {
          const value = text(message.content)
          return value.includes("warehouse_sql_results") && value.includes("warehouse_quality") &&
            bundle.files.every((file: { digest: string }) => value.includes(file.digest))
        })
        if (!read) {
          name = "read_file"; args = { file_path: join(workspace, "inputs/verified-context.json") }
        } else if (!actualReport) {
          name = "mcp__verified-artifact-consumer__inspect"
          args = { requiredIds: ["warehouse_sql_results", "warehouse_quality"] }
          files.add(join(workspace, "consumed-report.json"))
        } else {
          assert.equal(actualReport.bundleDigest, hash(content), "Actual Guest must hash the bound bytes")
          const artifacts = actualReport.artifacts as Array<{ id: string; value: Record<string, unknown> }>
          const quality = artifacts.find(item => item.id === "warehouse_quality")!.value
          assert.equal((quality.summary as { validAmountCents: number }).validAmountCents, 43575)
          assert.equal(quality.businessAcceptance, "needs_review")
          assert.equal(quality.productionAcceptance, "not_evaluated")
          consumed = actualReport
          const target = join(workspace, "consumed-report.json")
          assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), actualReport,
            "Original Guest tool must have written its real deterministic report through the native file SDK")
        }
      } else {
        if (producerWorkspace) assert.equal(producerWorkspace, workspace)
        producerWorkspace = workspace
        assert(raw.includes("A12_KNOWLEDGE_RULE"), "Native chosen knowledge must reach every producer HTTP request")
        for (const message of messages.filter(message => message.role === "tool")) {
          const call = issued.get(message.tool_call_id ?? "")
          if (!call || call.workspace !== workspace || call.stage !== skill) continue
          const result = text(message.content)
          assert(!/MODS_EXECUTION_FAILED|Command failed with exit code [1-9]/.test(result), result)
          if (call.step.name === "project_checkpoint") assert(/"status"\s*:\s*"committed"/.test(result), result)
          if (call.step.key === "read-chosen-knowledge") assert(result.includes(
            "A12_KNOWLEDGE_RULE: explicitly authorized CNY integer cents; local five orders; businessAcceptance needs_review."
          ), "The actual read_file result must contain the complete chosen business rule, not only its indexed description")
          if (call.step.key === "consume-sql-results") assert(result.includes("43575"))
          complete.add(`${key}:${call.step.key}`)
        }
        const source = skillPath.replace(/[\\/]skills[\\/].*$/, "")
        assert.notEqual(source, skillPath)
        const knowledgePath = /path: ([^\r\n]+[\\/]DW[\\/]orders\.md)/.exec(prompt)?.[1]?.trim()
        assert(knowledgePath, "Original context must index the actual chosen rule file")
        files.add(knowledgePath)
        step = !complete.has(`${key}:read-chosen-knowledge`)
          ? { key: "read-chosen-knowledge", name: "read_file", args: { file_path: knowledgePath } }
          : warehouseExportProgram({ source, workspace, feature: "composition-warehouse", skill, skillPath, commands })
            .find(item => !complete.has(`${key}:${item.key}`))
        if (step) { name = step.name; args = step.args }
      }
      let delta: Record<string, unknown> = { role: "assistant", content: "Actual checked content consumed; business acceptance remains needs_review." }
      if (name) {
        assert((body.tools ?? []).some((tool: { function: { name: string } }) => tool.function.name === name), `Missing real tool ${name}`)
        const id = `export-${requests.length}`
        if (step) issued.set(id, { workspace, stage: skill, step })
        delta = { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      }
      requests.push({ at: Date.now(), workspace, skill, tool: name, step, body })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const packet = (delta: unknown, finish_reason: string | null) => ({ id: `export-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
      response.write(`data: ${JSON.stringify({ ...packet({}, name ? "tool_calls" : "stop"), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Controlled model rejected unexpected original execution facts")
    }
  })
  return { server, errors, requests, commands, files, started, complete,
    observed: () => ({ producerWorkspace, consumerWorkspace, consumed }) }
}
