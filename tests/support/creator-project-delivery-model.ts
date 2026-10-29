/** Decisions only. Every inspection, candidate and request comes from the packaged native tool. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import { modelText, toolJson } from "./autobiz-full-app-model"
import { KNOWLEDGE_MARKER } from "./project-library-packaged-journey"
import type { CreatorDeliveryCombination } from "./creator-delivery-combinations"

export const DELIVERY_POLICY =
  "DELIVERY_POLICY_COMPLETE: retain original evidence and require human review."
export const DELIVERY_DRAFT_TITLE = "Creator converted package native draft"
export const creatorDeliverySourceFiles = (hookUrl: string) => [
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
    text: "---\nname: prepare\ndescription: Prepare an actual reviewed draft\n---\nRead the retained package knowledge/policy.md. Write draft.json with a nonempty title. Native checks and explicit human progression own acceptance.\n"
  },
  {
    path: "skills/review/SKILL.md",
    text: "---\nname: review\ndescription: Review the actual preceding draft\n---\nRead the retained package knowledge/policy.md and the workspace draft.json. Use saved project knowledge as reference only. Write review.json with checked=true and the exact sourceTitle read from draft.json. Native checks and explicit human progression own acceptance.\n"
  },
  {
    path: "knowledge/policy.md",
    text: `${DELIVERY_POLICY}\n`
  },
  {
    path: "hooks/hooks.json",
    text: JSON.stringify(
      ["PreSkillUse", "PostSkillUse"].map((event) => ({
        id: `retained-delivery-${event}`,
        event,
        matcher: "prepare|review",
        type: "http",
        url: `${hookUrl}/${event}`,
        timeoutMs: 10000
      }))
    )
  }
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
        },
        { id: "review-missing", stageId: "review", files: [], expected: "failed" },
        {
          id: "review-valid",
          stageId: "review",
          files: [
            { path: "draft.json", text: '{"title":"native contract fixture"}' },
            {
              path: "review.json",
              text: '{"checked":true,"sourceTitle":"native contract fixture"}'
            }
          ],
          expected: "passed"
        }
      ]
    })
  }
]
export const creatorDeliveryCatalog = {
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
    },
    {
      id: "review",
      title: "Review preceding draft",
      node: { id: "review", skill: "review", order: 1 },
      skill: { entry: "skills/review/SKILL.md", resources: [] },
      resources: [],
      dependencies: { required: ["prepare"], advisory: [] },
      checks: { validators: [], guards: [] },
      host: {
        stage: {
          actionIds: [],
          artifactIds: ["draft", "review"],
          checkIds: ["draft-schema", "review-schema"],
          approval: "human"
        },
        actions: [],
        artifacts: [
          { id: "draft", path: "draft.json", required: true },
          { id: "review", path: "review.json", required: true }
        ],
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
          },
          {
            id: "review-schema",
            artifactId: "review",
            kind: "json-schema",
            sideEffect: "read",
            schema: {
              type: "object",
              properties: {
                checked: { const: true },
                sourceTitle: { type: "string", minLength: 1 }
              },
              required: ["checked", "sourceTitle"]
            }
          }
        ],
        environment: []
      }
    }
  ]
}
type Message = {
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}
type Action = { key: string; input: Record<string, unknown>; name?: string }
export type CreatorDeliveryRuntimePhase =
  | "missing"
  | "prepare"
  | "review"
  | "convert"
  | "refine"
  | "intake"
  | "deliver"
export function creatorProjectDeliveryModel(combination?: CreatorDeliveryCombination) {
  let sourceId = "",
    inspectionId = ""
  let runtime: { phase: CreatorDeliveryRuntimePhase; workspace: string } | undefined
  const issued = new Map<string, string>()
  const results = new Map<string, Record<string, unknown>>()
  const requests: unknown[] = [],
    errors: string[] = []
  const hooks: Array<{
    event: string
    phase: CreatorDeliveryRuntimePhase
    payload: Record<string, unknown>
  }> = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST")
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const part of request) {
        bytes += part.length
        assert(bytes < 3 * 1024 * 1024)
        chunks.push(Buffer.from(part))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (request.url?.startsWith("/retained-hook/")) {
        assert(runtime, "Retained hooks execute only during the actual project stages")
        const event = request.url.slice("/retained-hook/".length)
        assert(["PreSkillUse", "PostSkillUse"].includes(event))
        assert.equal(body.hook_event_name, event)
        const stage = combination?.stages.find(
          (value) =>
            value.id === (runtime!.phase === "missing" ? combination.stages[0].id : runtime!.phase)
        )
        assert.equal(
          body.skill_name,
          stage?.skill ?? (runtime.phase === "review" ? "review" : "prepare")
        )
        assert(typeof body.plugin_root === "string" && typeof body.session_id === "string")
        // Native plugin Hooks run relative to their frozen source; their workspace aliases
        // separately identify the ordinary project's writable working directory.
        assert.equal(body.cwd, body.plugin_root)
        assert.equal(body.hook_source_type, "plugin")
        assert.equal(body.hook_source_root, body.plugin_root)
        assert.equal(body.hook_source_path, join(body.plugin_root, "hooks/hooks.json"))
        assert.equal(body.workspace, runtime.workspace)
        assert.equal(body.workspace_path, runtime.workspace)
        assert.equal(body.skill_path, join(body.plugin_root, "skills", body.skill_name, "SKILL.md"))
        hooks.push({ event, phase: runtime.phase, payload: body })
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
        return
      }
      assert.equal(request.url, "/v1/chat/completions")
      assert(requests.length < (combination ? 96 : 32), "No uncontrolled retries")
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
              modularizationCatalog: combination?.catalog ?? creatorDeliveryCatalog,
              modularizationFiles: combination?.addedFiles ?? creatorDeliveryAddedFiles
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
              sources: [
                {
                  inspectionId,
                  modIds: combination?.stages.map((stage) => stage.id) ?? ["prepare", "review"]
                }
              ]
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
      } else if (runtime && combination) {
        const index =
          runtime.phase === "missing"
            ? 0
            : combination.stages.findIndex((stage) => stage.id === runtime!.phase)
        assert(index >= 0)
        const stage = combination.stages[index]
        const text = messages.map((message) => modelText(message.content)).join("\n")
        assert(
          text.includes(`"stageId":"${stage.id}"`),
          "Actual combination stage reaches provider"
        )
        const started = hooks.findLast(
          (hook) => hook.phase === runtime!.phase && hook.event === "PreSkillUse"
        )
        assert(started, "Original package Hook must precede inference")
        const policyPath = join(String(started.payload.plugin_root), "knowledge/policy.md")
        const skillPath = String(started.payload.skill_path)
        const reads = [
          { path: skillPath, marker: stage.marker },
          { path: policyPath, marker: DELIVERY_POLICY },
          ...combination.stages.slice(0, index).map((previous) => ({
            path: join(runtime!.workspace, previous.path),
            marker: previous.marker
          }))
        ]
        const calls = messages.flatMap((message) => message.tool_calls ?? [])
        for (const call of calls) {
          assert(["read_file", "write_file"].includes(call.function.name))
          const reply = messages.find(
            (message) => message.role === "tool" && message.tool_call_id === call.id
          )
          assert.equal(typeof reply?.content, "string")
          if (call.function.name === "write_file")
            assert.match(reply!.content as string, /^Successfully wrote to '.+'$/s)
          else {
            const expected = reads.find(
              (read) => read.path === JSON.parse(call.function.arguments).file_path
            )
            assert(
              expected && (reply!.content as string).includes(expected.marker),
              "Actual selected Skill/policy/upstream artifact is read"
            )
          }
        }
        if (runtime.phase !== "missing") {
          if (index) {
            assert(
              text.includes(KNOWLEDGE_MARKER),
              "Checked knowledge reaches every downstream stage"
            )
            assert(
              text.includes("untrusted task data"),
              "Native knowledge remains untrusted task data"
            )
          }
          const missing = reads.find(
            (read) =>
              !calls.some(
                (call) =>
                  call.function.name === "read_file" &&
                  JSON.parse(call.function.arguments).file_path === read.path
              )
          )
          if (missing)
            action = {
              key: `read-${stage.id}`,
              name: "read_file",
              input: { file_path: missing.path }
            }
          else if (!calls.some((call) => call.function.name === "write_file"))
            action = {
              key: `write-${stage.id}`,
              name: "write_file",
              input: {
                file_path: join(runtime.workspace, stage.path),
                content: JSON.stringify(combination.output(index))
              }
            }
        }
        finished = `DELIVERY_RUNTIME_${runtime.phase.toUpperCase()}`
      } else if (runtime) {
        const stage = runtime.phase === "review" ? "review" : "prepare"
        const text = messages.map((message) => modelText(message.content)).join("\n")
        assert(text.includes(`"stageId":"${stage}"`), "Actual stage context reaches provider")
        const started = hooks.findLast(
          (hook) => hook.phase === runtime!.phase && hook.event === "PreSkillUse"
        )
        assert(started, "The retained package PreSkillUse must run before model inference")
        const policyPath = join(String(started.payload.plugin_root), "knowledge/policy.md")
        const calls = messages.flatMap((message) => message.tool_calls ?? [])
        for (const call of calls) {
          assert(["read_file", "write_file"].includes(call.function.name))
          const result = messages.find(
            (message) => message.role === "tool" && message.tool_call_id === call.id
          )
          assert.equal(typeof result?.content, "string", "Actual native tool response required")
          if (call.function.name === "write_file")
            assert.match(result!.content as string, /^Successfully wrote to '.+'$/s)
          else {
            const args = JSON.parse(call.function.arguments)
            assert(
              (result!.content as string).includes(
                args.file_path === policyPath ? DELIVERY_POLICY : DELIVERY_DRAFT_TITLE
              ),
              "Read actual policy/preceding draft"
            )
          }
        }
        const hasRead = (path: string) =>
          calls.some(
            (call) =>
              call.function.name === "read_file" &&
              JSON.parse(call.function.arguments).file_path === path
          )
        if (runtime.phase !== "missing") {
          if (stage === "review") {
            assert(text.includes(KNOWLEDGE_MARKER), "Saved project knowledge reaches later stage")
            assert(text.includes("untrusted task data"))
          }
          if (!hasRead(policyPath))
            action = { key: "read-policy", name: "read_file", input: { file_path: policyPath } }
          else if (stage === "review" && !hasRead(join(runtime.workspace, "draft.json")))
            action = {
              key: "read-preceding-draft",
              name: "read_file",
              input: { file_path: join(runtime.workspace, "draft.json") }
            }
          else if (!calls.some((call) => call.function.name === "write_file")) {
            assert(tools.includes("write_file"))
            action = {
              key: `write-${stage}`,
              name: "write_file",
              input: {
                file_path: join(
                  runtime.workspace,
                  stage === "prepare" ? "draft.json" : "review.json"
                ),
                content: JSON.stringify(
                  stage === "prepare"
                    ? { title: DELIVERY_DRAFT_TITLE, policy: DELIVERY_POLICY }
                    : {
                        checked: true,
                        sourceTitle: DELIVERY_DRAFT_TITLE,
                        policy: DELIVERY_POLICY,
                        knowledge: KNOWLEDGE_MARKER
                      }
                )
              }
            }
          }
        }
        finished = `DELIVERY_RUNTIME_${runtime.phase.toUpperCase()}`
      }
      const id = `creator-delivery-${requests.length}`
      if (action && !action.name) issued.set(id, action.key)
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
                function: {
                  name: action.name ?? "mod_business",
                  arguments: JSON.stringify(action.input)
                }
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
    hooks,
    setRuntime: (phase: CreatorDeliveryRuntimePhase, workspace: string) => {
      runtime = { phase, workspace }
    },
    bindSource: (id: string) => {
      sourceId = id
    },
    bindInspection: (id: string) => {
      inspectionId = id
    }
  }
}
