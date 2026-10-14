import { createServer } from "node:http"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"

export const HOST_SKILL_NAME = "host-flow-review"
export const HOST_SKILL_DOCUMENT = `---
name: ${HOST_SKILL_NAME}
description: Read host-flow instructions and verify the selected project.
---
# HOST_FLOW_REAL_SKILL_DOCUMENT
Read the selected file with read_file, then return a structured result with passed true.
`

export function hostSkillZip() {
  const zip = new AdmZip()
  zip.addFile(`${HOST_SKILL_NAME}/SKILL.md`, Buffer.from(HOST_SKILL_DOCUMENT))
  return [...zip.toBuffer()]
}

export function readJournal(path: string): Record<string, unknown>[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

export function createHostCheckProject(workspace: string, journal: string) {
  writeFileSync(join(workspace, "host-value.json"), JSON.stringify({ ready: true, answer: 42 }))
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      scripts: { test: "node host-check.cjs unit", "test:e2e": "node host-check.cjs e2e" }
    })
  )
  writeFileSync(
    join(workspace, "host-check.cjs"),
    `const fs = require("node:fs")
const assert = require("node:assert/strict")
const path = require("node:path")
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname,"host-value.json"),"utf8")), {ready:true,answer:42})
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify({kind:process.argv[2],pid:process.pid,passed:true})+"\\n")
console.log("HOST_FLOW_REAL_CHECK_PASSED:"+process.argv[2])
`
  )
}

export async function startHostFlowModel() {
  const requests: Record<string, unknown>[] = []
  const hooks: string[] = []
  let skillPath = ""
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (request.url?.startsWith("/skill-hook/")) {
      hooks.push(request.url)
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
      return
    }
    requests.push(body)
    const messages = body.messages as { role: string; content: unknown }[]
    const needsSkill =
      JSON.stringify(messages).includes("[HOST-SKILL]") &&
      !messages.some((message) => message.role === "tool")
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: `host-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `host-call-${requests.length}`, type: "function", function: { name: needsSkill ? "read_file" : "structured_output", arguments: JSON.stringify(needsSkill ? { file_path: skillPath } : { passed: true, summary: "HOST_FLOW_REAL_MODEL_PASSED" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    hooks,
    setSkillPath: (path: string) => {
      skillPath = path
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      )
    }
  }
}
