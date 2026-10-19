/** Decisions only. Every inspection, candidate and request comes from the packaged native tool. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { modelText, toolJson } from "./autobiz-full-app-model"

export const creatorDeliverySourceFiles = [
  {
    path: "plugin.json",
    text: JSON.stringify({
      name: "creator-raw-delivery-source",
      version: "1.0.0",
      skills: "skills",
      hooks: "hooks/hooks.json"
    })
  },
  {
    path: "skills/prepare/SKILL.md",
    text: "---\nname: prepare\ndescription: Prepare an actual reviewed draft\n---\nRead knowledge/policy.md. Write draft.json with a nonempty title. Native checks own acceptance.\n"
  },
  {
    path: "knowledge/policy.md",
    text: "DELIVERY_POLICY_COMPLETE: retain original evidence and require human review.\n"
  },
  { path: "hooks/hooks.json", text: '{"hooks":{"PreToolUse":[]}}' }
]
export const creatorDeliveryAddedFiles = [
  {
    path: "tests/project-contract.json",
    text: JSON.stringify({
      apiVersion: "devclaw.project-contract/v1",
      cases: [
        { id: "missing", stageId: "prepare", files: [], expected: "failed" },
        {
          id: "valid",
          stageId: "prepare",
          files: [{ path: "draft.json", text: '{"title":"native contract fixture"}' }],
          expected: "passed"
        }
      ]
    })
  }
]
const catalog = {
  apiVersion: "devclaw.business-mods/v1",
  kind: "catalog",
  kernel: {
    id: "classic.delivery",
    version: "1.0.0",
    runtime: { adapter: "host-linear-v1" },
    pluginFields: { skills: "skills", hooks: "hooks/hooks.json" },
    resources: ["knowledge/policy.md", "hooks/hooks.json", "tests/project-contract.json"]
  },
  modules: [
    {
      id: "prepare",
      title: "Prepare reviewed draft",
      node: { id: "prepare", skill: "prepare", order: 0 },
      skill: { entry: "skills/prepare/SKILL.md", resources: [] },
      resources: [],
      dependencies: { required: [], advisory: [] },
      checks: { validators: [], guards: [] },
      host: {
        stage: {
          actionIds: [],
          artifactIds: ["draft"],
          checkIds: ["draft-schema"],
          approval: "human"
        },
        actions: [],
        artifacts: [{ id: "draft", path: "draft.json", required: true }],
        checks: [
          {
            id: "draft-schema",
            artifactId: "draft",
            kind: "json-schema",
            sideEffect: "read",
            schema: {
              type: "object",
              properties: { title: { type: "string", minLength: 1 } },
              required: ["title"]
            }
          }
        ],
        environment: []
      }
    }
  ]
}
type Message = { role: string; content: unknown; tool_call_id?: string }
type Action = { key: string; input: Record<string, unknown> }
export function creatorProjectDeliveryModel() {
  let sourceId = "",
    inspectionId = ""
  const issued = new Map<string, string>()
  const results = new Map<string, Record<string, unknown>>()
  const requests: unknown[] = [],
    errors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      assert.equal(request.url, "/v1/chat/completions")
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const part of request) {
        bytes += part.length
        assert(bytes < 3 * 1024 * 1024)
        chunks.push(Buffer.from(part))
      }
      assert(requests.length < 24, "No uncontrolled retries")
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const messages = body.messages as Message[]
      for (const message of messages) {
        const key = issued.get(message.tool_call_id ?? "")
        if (message.role !== "tool" || !key) continue
        const actual = toolJson(message.content)
        assert.equal(actual.ok, true, JSON.stringify(actual))
        assert(actual.result && typeof actual.result === "object")
        results.set(key, actual.result as Record<string, unknown>)
      }
      const tools = (body.tools ?? []).map(
        (value: { function: { name: string } }) => value.function.name
      )
      const user = modelText(messages.findLast((message) => message.role === "user")?.content)
      let action: Action | undefined
      let finished = "DELIVERY_SUMMARY_ONLY"
      if (tools.includes("mod_business") && user.includes("DELIVERY_RAW_AUTHOR")) {
        assert(sourceId)
        const raw = results.get("raw")
        if (!raw) action = { key: "raw", input: { action: "inspect_raw", pluginId: sourceId } }
        else if (!results.has("modularize")) {
          assert.equal(raw.status, "needs-authoring")
          assert.equal(raw.runtime, "unknown")
          assert.equal(raw.nextCursor, undefined, "Small source inventory must be complete")
          action = {
            key: "modularize",
            input: {
              action: "request_modularization",
              rawInspectionId: raw.rawInspectionId,
              sourceDigest: raw.sourceDigest,
              modularizationCatalog: catalog,
              modularizationFiles: creatorDeliveryAddedFiles
            }
          }
        }
        finished = "DELIVERY_RAW_READY_NATIVE_CONFIRMATION_REQUIRED"
      } else if (tools.includes("mod_business") && user.includes("DELIVERY_COMPOSE_TRIAL")) {
        assert(inspectionId)
        const preview = results.get("preview")
        if (!preview)
          action = {
            key: "preview",
            input: {
              action: "preview",
              name: "creator-raw-host-candidate",
              version: "1.0.0",
              sources: [{ inspectionId, modIds: ["prepare"] }]
            }
          }
        else if (!results.has("trial")) {
          assert.equal(preview.valid, true, JSON.stringify(preview))
          action = {
            key: "trial",
            input: {
              action: "request_trial",
              previewId: preview.previewId,
              goal: "Preserve original policy and hooks; prepare a checked project source for explicit delivery"
            }
          }
        }
        finished = "DELIVERY_HOST_REQUEST_PREPARED_NOT_EXECUTED"
      }
      const id = `creator-delivery-${requests.length}`
      if (action) issued.set(id, action.key)
      requests.push({ body, issued: action ?? null })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const delta = action
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: "mod_business", arguments: JSON.stringify(action.input) }
              }
            ]
          }
        : { role: "assistant", content: finished }
      for (const [value, finish] of [
        [delta, null],
        [{}, action ? "tool_calls" : "stop"]
      ])
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            model: body.model,
            choices: [{ index: 0, delta: value, finish_reason: finish }]
          })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      errors.push(String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end("Creator delivery fixture rejected actual native result")
    }
  })
  return {
    server,
    requests,
    errors,
    results,
    bindSource: (id: string) => {
      sourceId = id
    },
    bindInspection: (id: string) => {
      inspectionId = id
    }
  }
}
