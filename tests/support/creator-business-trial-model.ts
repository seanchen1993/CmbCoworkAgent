/** Controlled model decisions only. Original native tools own all writes, checks and receipts. */
import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join, posix, relative, resolve, win32 } from "node:path"
import { modelText, shellQuote, toolJson } from "./autobiz-full-app-model"

type ObjectValue = Record<string, unknown>
type Message = { role: string; content: unknown; tool_call_id?: string }
type Reply = { ok: boolean; result: ObjectValue }
type Step = { key: string; name: string; args: ObjectValue }
const object = (value: unknown): ObjectValue => {
  assert(value && typeof value === "object" && !Array.isArray(value))
  return value as ObjectValue
}
const extensionId = "custom.trial-label"
const extensionPath = `mods/business/${extensionId}/register.ts`

/** Observation keys only. Keep raw paths for native permissions, IO and recorded evidence. */
export function creatorTrialWorkspaceIdentity(
  workspace: string,
  platform: NodeJS.Platform = process.platform
) {
  return platform === "win32" ? win32.resolve(workspace).toLowerCase() : posix.resolve(workspace)
}

function pages(replies: Reply[], kind: "example" | "read") {
  const values = replies.filter(
    (reply) =>
      reply.result.format === "json-pages" ||
      (kind === "example"
        ? reply.result.exampleId === "autobiz-knowledge"
        : reply.result.id === "trial-label" && reply.result.files !== undefined)
  )
  const tail = values.at(-1)?.result
  return {
    count: values.length,
    tail,
    value:
      tail && tail.nextCursor === undefined
        ? tail.format === "json-pages"
          ? object(JSON.parse(values.map((page) => page.result.jsonChunk).join("")))
          : tail
        : undefined
  }
}

function statusPrefix(replies: Reply[]) {
  if (!replies.length) return { count: 0 }
  if (replies[0].result.format !== "json-pages") return { count: 1, value: replies[0].result }
  const selected: Reply[] = []
  for (const reply of replies) {
    assert.equal(reply.result.format, "json-pages")
    selected.push(reply)
    if (reply.result.nextCursor === undefined)
      return {
        count: selected.length,
        value: object(JSON.parse(selected.map((item) => item.result.jsonChunk).join("")))
      }
  }
  return { count: selected.length, nextCursor: selected.at(-1)!.result.nextCursor }
}

export function creatorBusinessTrialAuthoringStep(
  replies: Reply[],
  baseId: string,
  revised: boolean
): ObjectValue | undefined {
  const bundle = pages(replies, revised ? "read" : "example")
  if (revised) {
    if (!bundle.value)
      return {
        action: "read",
        id: "trial-label",
        ...(bundle.tail ? { cursor: bundle.tail.nextCursor } : {})
      }
    if (replies.length === bundle.count) return { action: "inspect", pluginId: baseId }
  } else {
    if (!replies.length) return { action: "catalog" }
    if (replies.length === 1) return { action: "inspect", pluginId: baseId }
  }
  const base = replies[revised ? bundle.count : 1].result
  const sourceMods = (base.mods as unknown[]).map(object)
  const sourceKnowledge = sourceMods.find((mod) => mod.id === "autobiz.knowledge")
  if (sourceKnowledge) assert.equal(sourceKnowledge.kind, "function")
  if (!revised && !sourceKnowledge && !bundle.value)
    return {
      action: "example",
      exampleId: "autobiz-knowledge",
      ...(bundle.tail ? { cursor: bundle.tail.nextCursor } : {})
    }
  const offset = revised ? bundle.count + 1 : 2 + (sourceKnowledge ? 0 : bundle.count)
  if (replies.length === offset) {
    const label = revised ? "业务试用审阅标识：修订版" : "业务试用审阅标识：初版"
    const draft: ObjectValue = revised
      ? bundle.value!
      : sourceKnowledge
        ? { files: [], extensions: [] }
        : object(bundle.value!.draft)
    const files = draft.files as Array<{ path: string; text: string }>
    const extensions = revised
      ? (object(draft.catalog).extensions as unknown[])
      : (draft.extensions as unknown[])
    return {
      action: "save",
      id: "trial-label",
      name: "隔离试用与知识扩展",
      revision: revised ? draft.revision : 0,
      inspectionId: base.id,
      modules: [],
      extensions: revised
        ? extensions
        : [
            ...extensions,
            {
              id: extensionId,
              title: "试用审阅标识",
              kind: "function",
              usage: "project",
              entry: extensionPath,
              resources: [],
              dependencies: { required: [], advisory: [] }
            }
          ],
      files: revised
        ? files.map((file) =>
            file.path === extensionPath
              ? { ...file, text: file.text.replace("业务试用审阅标识：初版", label) }
              : file
          )
        : [
            ...files,
            {
              path: extensionPath,
              text: `export function register(on) {
  on("ui.render", {component:"AbovePrompt"}, async ($,event) => {
    const {Text}=$.ui.resolve(event)
    return Text({children:${JSON.stringify(label)}})
  })
}`
            }
          ]
    }
  }
  if (replies.length === offset + 1) {
    const draft = replies.at(-1)!.result
    return {
      action: "preview",
      name: "creator-isolated-business",
      version: revised ? "1.0.1" : "1.0.0",
      sources: [
        {
          inspectionId: base.id,
          modIds: sourceMods.map((mod) => mod.id)
        }
      ],
      drafts: [
        { id: draft.id, revision: draft.revision, modIds: draft.modIds }
      ]
    }
  }
  if (replies.length === offset + 2) {
    assert.equal(replies.at(-1)!.result.valid, true, JSON.stringify(replies.at(-1)))
    return {
      action: "request_trial",
      previewId: replies.at(-1)!.result.previewId,
      goal: revised
        ? "TRIAL_INTERRUPT 仅本地PRD试用；保持知识和原检查，等待用户确认。"
        : "TRIAL_PRD 用户明确选择backend_only，仅完成原PRD阶段后停止本轮试用；使用真实本地整数计算样本，无API/SQL/UI需求，保留知识和所有原Hooks，不进入Code，不声明企业业务验收。"
    }
  }
  assert.equal(replies.length, offset + 3, "No extra authoring tools or automatic installer")
  return undefined
}

export function creatorBusinessTrialModel(input: {
  baseId(): string
  knowledgeFile: string
  knowledgeRule: string
  privateTrialRoot: string
}) {
  const requests: ObjectValue[] = [],
    errors: string[] = []
  const commands = new Set<string>(),
    files = new Set<string>()
  const completed = new Map<string, Set<string>>()
  const issued = new Map<string, { workspace: string; step: Step }>()
  const authorIssued = new Map<string, ObjectValue>()
  const runtime = new Map<string, { source: string; feature: string; firstHttpAt: number }>()
  const held = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let raw = ""
      for await (const chunk of request) {
        raw += chunk
        assert(raw.length < 5_000_000)
      }
      assert(requests.length < 100, "Bounded original model requests")
      const body = object(JSON.parse(raw)),
        messages = body.messages as Message[]
      const userIndex = messages.findLastIndex((message) => message.role === "user")
      const prompt = modelText(messages[userIndex]?.content)
      const tools = (body.tools ?? []) as Array<{ function: { name: string } }>
      let name: string | undefined, args: ObjectValue | undefined, step: Step | undefined
      let workspace: string | undefined
      const skill = /<name>([^<]+)<\/name>/.exec(prompt)?.[1]
      if (!tools.length) {
        requests.push({ at: Date.now(), kind: "original-summary" })
      } else if (!skill) {
        assert(
          tools.some((tool) => tool.function.name === "mod_business"),
          "Original creator tool must be registered"
        )
        const replies = messages
          .slice(userIndex + 1)
          .filter((message) => message.role === "tool")
          .map((message) => toolJson(message.content) as unknown as Reply)
        for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply))
        const revised = prompt.includes("我的反馈") || prompt.includes("TRIAL_CREATOR_PATCH")
        assert(
          revised || prompt.includes("TRIAL_CREATOR_CREATE"),
          "Only the actual creator request/feedback turn"
        )
        const requestedTrial = messages
          .slice(userIndex + 1)
          .find(
            (message) =>
              message.role === "tool" &&
              authorIssued.get(message.tool_call_id ?? "")?.action === "request_trial"
          )
        if (requestedTrial) {
          const result = object(toolJson(requestedTrial.content).result)
          assert.equal(
            result.nextCursor,
            undefined,
            "A mutating request must return a bounded reference; never repeat it to read another page"
          )
          const native =
            result.format === "json-pages" ? object(JSON.parse(String(result.jsonChunk))) : result
          assert.equal(object(native.trial).phase, "needs-confirmation")
        } else if (revised) {
          const status = statusPrefix(replies)
          if (!status.value)
            args = {
              action: "status",
              ...(status.nextCursor !== undefined ? { cursor: status.nextCursor } : {})
            }
          else {
            const oldTrial = object(status.value.trial)
            assert.equal(
              oldTrial.phase,
              "cancelled",
              "Read the actual known physical end before revising"
            )
            assert(
              (oldTrial.feedback as Array<{ message: string }>).some((item) =>
                item.message.includes("TRIAL_CREATOR_PATCH")
              ),
              "The creator must consume the actual saved feedback before changing source"
            )
            assert(
              object(oldTrial.observation).threadId,
              "Actual original trial execution must be reachable"
            )
            args = creatorBusinessTrialAuthoringStep(replies.slice(status.count), input.baseId(), true)
          }
        } else args = creatorBusinessTrialAuthoringStep(replies, input.baseId(), false)
        if (args) name = "mod_business"
        requests.push({
          at: Date.now(),
          kind: revised ? "creator-revision" : "creator-create",
          action: args?.action ?? "done"
        })
      } else {
        assert(
          raw.includes("CREATOR_TRIAL_KNOWLEDGE_FULL_BODY"),
          "Original selected-knowledge index must reach the native model; the body still requires read_file"
        )
        workspace = /The workspace root is: ([^\r\n]+)/
          .exec(messages.map((message) => modelText(message.content)).join("\n"))?.[1]
          ?.trim()
          .replace(/^`|`$/g, "")
        const skillPath = /<path>([^<]+)<\/path>/.exec(prompt)?.[1]
        assert(workspace && skillPath)
        const source = skillPath.replace(/[\\/]skills[\\/].*$/, "")
        assert.notEqual(source, skillPath)
        const workspaceRelative = relative(
          realpathSync(input.privateTrialRoot),
          realpathSync(workspace)
        )
        const sourceRelative = relative(
          realpathSync(join(input.privateTrialRoot, "packages")),
          realpathSync(source)
        )
        assert(
          !workspaceRelative.startsWith("..") && !workspaceRelative.includes(":"),
          "Only host private trial workspace"
        )
        assert(
          !sourceRelative.startsWith("..") && !sourceRelative.includes(":"),
          "Actual Skill must come from the retained candidate, not mutable installation"
        )
        const state = object(
          JSON.parse(readFileSync(join(workspace, ".autobizdevops/state.json"), "utf8"))
        )
        const features = Object.keys(object(state.features))
        assert.equal(features.length, 1, "Host must create an independent trial feature")
        const feature = features[0],
          workspaceIdentity = creatorTrialWorkspaceIdentity(workspace),
          previous = runtime.get(workspaceIdentity)
        if (!previous) runtime.set(workspaceIdentity, { source, feature, firstHttpAt: Date.now() })
        assert(
          Date.now() - runtime.get(workspaceIdentity)!.firstHttpAt < 90_000,
          "Original per-session 90 second gate"
        )
        requests.push({
          at: Date.now(),
          kind: "original-business",
          workspace,
          source,
          feature,
          skill,
          selectedKnowledgeIndexed: true,
          actualRuleBodyPresent: raw.includes(input.knowledgeRule),
          interrupt: raw.includes("TRIAL_INTERRUPT")
        })
        if (raw.includes("TRIAL_INTERRUPT") || skill !== "autobiz-requirement-discuss") {
          held.add(response)
          response.on("close", () => held.delete(response))
          return
        }
        const done = completed.get(workspaceIdentity) ?? new Set<string>()
        completed.set(workspaceIdentity, done)
        for (const message of messages.filter((message) => message.role === "tool")) {
          const call = issued.get(message.tool_call_id ?? "")
          if (!call || creatorTrialWorkspaceIdentity(call.workspace) !== workspaceIdentity) continue
          const result = modelText(message.content)
          assert(!/MODS_EXECUTION_FAILED|Command failed with exit code [1-9]/.test(result), result)
          if (call.step.key === "chosen-knowledge")
            assert(
              result.includes(input.knowledgeRule),
              "Read actual rule body, not only collector index text"
            )
          if (call.step.name === "execute") toolJson(result)
          done.add(call.step.key)
        }
        if (done.has("chosen-knowledge"))
          assert(
            raw.includes(input.knowledgeRule),
            "Full actual read_file knowledge must remain available for every subsequent business tool decision"
          )
        const execute = (key: string, script: string, values: string[]): Step => {
          const command = [
            "python -I -B -X utf8",
            shellQuote(script),
            ...values.map(shellQuote)
          ].join(" ")
          commands.add(command)
          return { key, name: "execute", args: { command, cwd: workspace } }
        }
        const plan: Step[] = [
          { key: "chosen-knowledge", name: "read_file", args: { file_path: input.knowledgeFile } },
          { key: "original-skill", name: "read_file", args: { file_path: skillPath } },
          execute("author-prd-input", resolve("tests/support/autobiz-full-app-sample.py"), [
            "prd",
            "--plugin-root",
            source,
            "--workspace",
            workspace,
            "--feature",
            feature
          ]),
          execute("original-prd-checkpoint", join(source, "hooks/update_checkpoint.py"), [
            "--feature",
            feature,
            "--checkpoint",
            "prd_done",
            "--json"
          ])
        ]
        files.add(input.knowledgeFile)
        files.add(skillPath)
        step = plan.find((candidate) => !done.has(candidate.key))
        if (step) {
          name = step.name
          args = step.args
        }
      }
      const id = `creator-trial-${requests.length}`
      if (step && workspace) issued.set(id, { workspace, step })
      if (name === "mod_business" && args) authorIssued.set(id, args)
      if (name)
        assert(
          tools.some((tool) => tool.function.name === name),
          `Missing actual original tool ${name}`
        )
      const delta = name
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          }
        : {
            role: "assistant",
            content: "原生确认或原阶段检查仍须按实际记录处理；未安装候选，不声明业务验收通过。"
          }
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const item of [
        { delta, finish_reason: null },
        { delta: {}, finish_reason: name ? "tool_calls" : "stop" }
      ])
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, ...item }]
          })}\n\n`
        )
      response.end("data: [DONE]\n\n")
    } catch (cause) {
      errors.push(String(cause))
      if (!response.headersSent) response.writeHead(500)
      response.end("Controlled trial fixture rejected unexpected native execution")
    }
  })
  return {
    server,
    requests,
    errors,
    commands,
    files,
    runtime,
    completed,
    releaseHeld: () => {
      for (const response of held) response.destroy()
      held.clear()
    },
    actualRuleDigest: createHash("sha256").update(input.knowledgeRule).digest("hex")
  }
}
