import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { BotStore } from "./store"
import { BotSkillHooks } from "./skill-hooks"
import { BotSkillLifecycle } from "./skill-lifecycle"
import { BotSkillPrompts } from "./skill-prompts"
import { prepareBotUserPrompt } from "./prompt-preparation"
import { BotSkillFailure } from "./skill-failure"
import { HumanMessage } from "@langchain/core/messages"
import { readBotSkillCatalog } from "./skill-catalog-reader"
import { assertSkillResources } from "./skill-resource-files"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import type { BotRuntimeRequest } from "./host"
import type { HookConfig } from "../hooks/types"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { BotWorkflowStore } from "./workflow-store"
import { executeBotWorktreeOperation } from "./worktree-operations"
import { botWorktreeAcquired, botWorktreeSource } from "./worktree-contract"
import * as modelFactory from "../models/model-factory"
import { BotDomainError } from "../../shared/bot-types"
import { APIError } from "openai"
import { serializeBotFailure } from "./error-diagnostic"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})

async function fixture(
  options: Partial<HookConfig> = {},
  modelBaseUrl?: string,
  hookOutput: unknown = { updatedInput: { text: "REVIEWED" } },
  isolated?: "full" | "read_only",
  assertHarnessCurrent?: () => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-hook-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const directory of ["builtin", "custom/review", "project", "host"])
    await mkdir(join(root, directory), { recursive: true })
  const source = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    globalRevision: 0,
    disabledSkillsRevision: 0
  }
  await writeFile(source.pluginsStorePath, "[]")
  await writeFile(source.disabledSkillsPath, "[]")
  await writeFile(join(root, "custom/review/SKILL.md"), "---\nname: review\n---\nReview the task.")
  await writeFile(
    join(root, "custom/review/hooks.json"),
    JSON.stringify([
      {
        id: "gate",
        enabled: true,
        event: "PreToolUse",
        matcher: "remember",
        command: "node gate.cjs",
        ...options
      }
    ])
  )
  await writeFile(
    join(root, "custom/review/gate.cjs"),
    `
    let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
      const fs=require('fs'), path=require('path');
      fs.appendFileSync(path.join(process.env.WORKSPACE_PATH,'invocations'),'x');
      fs.writeFileSync(path.join(process.env.WORKSPACE_PATH,'hook-context.json'),JSON.stringify({cwd:process.cwd(),env:process.env,stdin:JSON.parse(input)}));
      console.log(JSON.stringify(${JSON.stringify(hookOutput)}));
    });
  `
  )
  const catalog = await readBotSkillCatalog(source)
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: modelBaseUrl ? "custom:fixture" : null,
    models: modelBaseUrl
      ? [
          {
            id: "fixture",
            ref: "custom:fixture",
            name: "Fixture",
            model: "gpt-test",
            baseUrl: modelBaseUrl,
            apiKey: "fixture-key"
          }
        ]
      : [],
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  }
  const modelFile = join(root, "host/models.private")
  await writeBotModelSnapshot(modelFile, snapshot)
  let store = new BotStore(join(root, "host/state.sqlite"))
  cleanup.push(() => store.close())
  const bind = () => {
    store.externalSkills.apply(catalog)
    store.externalSkills.bindGuard((skill) => {
      if (skill) assertSkillResources(skill)
    })
  }
  bind()
  const owner = store.createBot({
    nonce: "owner",
    name: "Reviewer",
    workspacePath: join(root, "project")
  })
  store.send({
    nonce: "task",
    conversationId: owner.conversationId,
    text: "Review",
    skills: [{ botId: owner.bot.id, id: catalog.skills[0].id, version: 1 }]
  })
  let claimed = store.claim("test-host")!
  const controller = new AbortController()
  let worktree: BotRuntimeRequest["worktree"]
  let runtimeBot = owner.bot
  if (isolated) {
    const git = (...args: string[]) =>
      promisify(execFile)("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        owner.bot.workspacePath!,
        ...args
      ])
    await git("init", "-b", "main")
    await writeFile(join(owner.bot.workspacePath!, "app.txt"), "source")
    await git("add", "app.txt")
    await git("commit", "-m", "source")
    const workflow = BotWorkflowStore.open(store, claimed.lease, "fixture", {
      script: 'export const meta={name:"Hook",description:"Isolated Hook"};return "ok"',
      defaultModelId: "fixture",
      maxConcurrency: 1,
      agentProfiles: [],
      authority: {}
    })
    const child = store.workflowChildren.claim(workflow, claimed.lease, {
      prompt: "Use selected skill",
      label: "Hook test",
      phase: null,
      agentIndex: 1,
      isolation: "worktree",
      shellAccess: isolated,
      toolStreamKey: `${"a".repeat(64)}_c1`,
      durableCallKey: `${"a".repeat(64)}_n1`
    })
    claimed = { run: child.run, lease: child.lease! }
    const common = { workspacePath: owner.bot.workspacePath!, appDataRoot: join(root, "worktrees") }
    const source = botWorktreeSource.parse(
      await executeBotWorktreeOperation({ ...common, op: "prepare" }, controller.signal)
    )
    const acquired = botWorktreeAcquired.parse(
      await executeBotWorktreeOperation(
        {
          ...common,
          op: "acquire",
          source,
          runId: workflow.id,
          childId: child.run.id
        },
        controller.signal
      )
    )
    worktree = { sourceWorkspacePath: owner.bot.workspacePath!, boundary: acquired.boundary }
    runtimeBot = { ...owner.bot, workspacePath: acquired.boundary.workspaceRoot }
  }
  let approvals = 0
  const request = (): BotRuntimeRequest => ({
    ...claimed,
    store,
    bot: runtimeBot,
    worktree,
    messages: [],
    signal: controller.signal
  })
  const shell = await createTrustedBotShellTestRunner(cleanup)
  const adapter = () => {
    return new BotSkillHooks(
      request(),
      modelFile,
      snapshot,
      shell,
      () => {
        controller.signal.throwIfAborted()
        store.assertLease(claimed.lease)
        store.skillReferences.assertCurrent(store.skillReferences.forRun(claimed.run.id))
      },
      async (id, action, operation, beforeStart) => {
        approvals++
        const interaction = store.requestInteraction(claimed.lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: "approve"
        })
        await beforeStart?.()
        store.beginEffect(claimed.lease, { id, action, approvalId: interaction.id })
        try {
          const output = await operation()
          store.settleEffect(claimed.lease, id, "succeeded", output)
          return output
        } catch (error) {
          store.settleEffect(claimed.lease, id, "unknown", String(error))
          throw error
        }
      },
      undefined,
      null,
      assertHarnessCurrent
    )
  }
  const lifecycle = () => new BotSkillLifecycle(request(), adapter())
  if (!["PreSkillUse", "PostSkillUse", "UserPromptSubmit"].includes(options.event ?? ""))
    await lifecycle().activate(catalog.skills[0].id, 1, "fixture-activation")
  return {
    root,
    snapshot,
    modelFile,
    workspace: runtimeBot.workspacePath!,
    adapter,
    lifecycle,
    prompts: () => new BotSkillPrompts(request(), adapter()),
    failure: () =>
      new BotSkillFailure(request(), adapter(), () => {
        controller.signal.throwIfAborted()
        store.assertDispatch(claimed.lease)
      }),
    skillId: catalog.skills[0].id,
    store: () => store,
    run: claimed.run,
    lease: claimed.lease,
    approvals: () => approvals,
    controller,
    reopen: () => {
      store.close()
      store = new BotStore(join(root, "host/state.sqlite"))
      bind()
    }
  }
}

it("keeps configured workspace command Hooks inside the child's real Git worktree", async () => {
  const f = await fixture({}, undefined, {}, "full")
  const settings = join(f.root, "configured"),
    project = join(f.root, "project")
  await mkdir(settings)
  await mkdir(join(project, ".cmbdevclaw/hooks"), { recursive: true })
  await writeFile(join(settings, "hooks.json"), "[]")
  await writeFile(join(settings, "plugins.json"), "[]")
  await writeFile(
    join(project, ".cmbdevclaw/hooks/check.json"),
    JSON.stringify({
      event: "PreToolUse",
      matcher: "project_probe",
      command: `node -e "require('fs').writeFileSync('configured-context.json',JSON.stringify({cwd:process.cwd(),source:process.env.HOOK_SOURCE_ROOT,workspace:process.env.WORKSPACE_PATH}));console.log('{}')"`,
      enabled: true
    })
  )
  f.snapshot.hookSources = { root: settings }
  await writeBotModelSnapshot(f.modelFile, f.snapshot)
  await f.adapter().run("PreToolUse", { toolName: "project_probe" }, "project-configured")
  const context = JSON.parse(await readFile(join(f.workspace, "configured-context.json"), "utf8"))
  expect(context).toEqual({ cwd: f.workspace, source: f.workspace, workspace: f.workspace })
  await expect(readFile(join(project, "configured-context.json"))).rejects.toMatchObject({
    code: "ENOENT"
  })
}, 20_000)

it("recovers a recorded StopFailure without retrying successful cleanup and keeps the original failure", async () => {
  const f = await fixture({ event: "StopFailure", matcher: "authentication_failed" }, undefined, {
    decision: "approve",
    continue: true
  })
  const error = Object.assign(new Error("401 TEST_MODEL_REJECTED"), { status: 401 })
  const failure = await f.failure().capture(error)
  expect(failure).toMatchObject({ message: error.message, errorType: "authentication_failed" })
  f.reopen() // Interrupted after recording failure, before dispatching its handler.
  expect(f.failure().read()).toEqual(failure)
  await expect(f.failure().finish(failure!)).rejects.toThrow(error.message)
  expect(await readFile(join(f.workspace, "invocations"), "utf8")).toBe("x")
  const context = JSON.parse(await readFile(join(f.workspace, "hook-context.json"), "utf8"))
  expect(context.stdin).toMatchObject({
    hook_event_name: "StopFailure",
    tool_response: { error: error.message, error_type: "authentication_failed" }
  })
  f.reopen() // Also covers interruption after successful handler, before terminal run settlement.
  await expect(f.failure().finish(f.failure().read()!)).rejects.toThrow(error.message)
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.workspace, "invocations"), "utf8")).toBe("x")
  f.controller.abort(new Error("cancelled"))
  await expect(f.failure().finish(failure!)).rejects.toThrow("cancelled")
  expect(f.approvals()).toBe(1)
}, 20_000)

it("does not record failure processing for skills without an active failure handler", async () => {
  const f = await fixture()
  expect(await f.failure().capture(new Error("model failed"))).toBeUndefined()
  expect(f.failure().read()).toBeUndefined()
  expect(f.approvals()).toBe(0)
})

it("keeps the original failure receipt but never assigns its provider ID to a later failing cleanup tool", async () => {
  const f = await fixture({ event: "StopFailure", matcher: "rate_limit" })
  const original = APIError.generate(
    429,
    { message: "quota" },
    "quota",
    new Headers({ "x-request-id": "original-provider" })
  )
  const failure = await f.failure().capture(original)
  expect(failure?.diagnostic?.requestId).toBe("original-provider")
  vi.spyOn(BotSkillHooks.prototype, "run").mockRejectedValueOnce(
    Object.assign(new Error("EACCES"), { code: "EACCES" })
  )
  const cleanupError = await f
    .failure()
    .finish(failure!)
    .catch((error: unknown) => error)
  expect(serializeBotFailure(cleanupError).diagnostic).not.toHaveProperty("requestId")
  expect(f.failure().read()?.diagnostic?.requestId).toBe("original-provider")
})

it.each([false, true])(
  "replays durable Hook decisions after reopening SQLite and preserves once=%s",
  async (once) => {
    const f = await fixture({ once })
    const context = { toolName: "remember", toolArgs: { text: "original" }, toolCallId: "call-a" }
    expect(await f.adapter().run("PreToolUse", context, "call-a")).toMatchObject({
      updatedInput: { text: "REVIEWED" }
    })

    f.reopen()
    expect(await f.adapter().run("PreToolUse", context, "call-a")).toMatchObject({
      updatedInput: { text: "REVIEWED" }
    })
    expect(f.approvals()).toBe(1)
    expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
    const next = await f.adapter().run("PreToolUse", { ...context, toolCallId: "call-b" }, "call-b")
    if (once) expect(next).toBeNull()
    else expect(next).toMatchObject({ updatedInput: { text: "REVIEWED" } })
    expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe(once ? "x" : "xx")
  },
  20_000
)

it("refuses changed input under the same Hook invocation and refuses uncertain receipts", async () => {
  const f = await fixture(),
    context = { toolName: "remember", toolArgs: { text: "first" }, toolCallId: "call-a" }
  await f.adapter().run("PreToolUse", context, "call-a")
  await expect(
    f.adapter().run("PreToolUse", { ...context, toolArgs: { text: "different" } }, "call-a")
  ).rejects.toThrow("同一")
  f.store().db.run("UPDATE bot_effects SET status='unknown' WHERE run_id=?", [f.run.id])
  f.reopen()
  await expect(f.adapter().run("PreToolUse", context, "call-a")).rejects.toThrow("不确定")
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
}, 20_000)

it("runs approved worktree Hooks from a pinned private skill copy and replays without executing again", async () => {
  const f = await fixture({}, undefined, { additionalContext: "CHECKED" }, "full")
  const context = { toolName: "remember", toolArgs: { text: "check" }, toolCallId: "isolated" }
  expect(await f.adapter().run("PreToolUse", context, "isolated")).toMatchObject({
    additionalContext: "CHECKED"
  })
  const captured = JSON.parse(await readFile(join(f.workspace, "hook-context.json"), "utf8"))
  expect(captured.cwd).toContain(join(f.workspace, ".cmbdevclaw", "bot-skill-hooks"))
  expect(captured.stdin.cwd).toBe(captured.cwd)
  expect(captured.stdin.workspace_path).toBe(f.workspace)
  expect(captured.env.HOOK_SOURCE_ROOT).toBe(captured.cwd)
  expect(captured.env.SKILL_ROOT).toBe(captured.cwd)
  expect(captured.env.WORKSPACE_PATH).toBe(f.workspace)
  await expect(readFile(join(f.root, "project/invocations"))).rejects.toThrow()
  await expect(readFile(join(f.root, "custom/review/hook-context.json"))).rejects.toThrow()
  const action = JSON.parse(
    f
      .store()
      .getInteraction(
        String(
          f.store().db.exec("SELECT id FROM bot_interactions WHERE run_id=?", [f.run.id])[0]
            .values[0][0]
        )
      ).prompt
  )
  expect(action.hook.cwd).toBe(captured.cwd)
  f.reopen()
  expect(await f.adapter().run("PreToolUse", context, "isolated")).toMatchObject({
    additionalContext: "CHECKED"
  })
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.workspace, "invocations"), "utf8")).toBe("x")
  await writeFile(join(captured.cwd, "gate.cjs"), "throw new Error('not approved')")
  await expect(
    f.adapter().run("PreToolUse", { ...context, toolCallId: "altered-copy" }, "altered-copy")
  ).rejects.toThrow("副本内容已变化")
  expect(await readFile(join(f.workspace, "invocations"), "utf8")).toBe("x")
}, 25_000)

it("keeps a read-only child from expanding authority through command or HTTP Hooks", async () => {
  for (const options of [
    {},
    { type: "http" as const, url: "http://127.0.0.1:1/never-dispatched" }
  ]) {
    const f = await fixture(options, undefined, {}, "read_only")
    await expect(
      f.adapter().run("PreToolUse", { toolName: "remember", toolCallId: "denied" }, "denied")
    ).rejects.toThrow("受限子任务")
    expect(f.approvals()).toBe(0)
    await expect(readFile(join(f.workspace, "invocations"))).rejects.toThrow()
  }
}, 20_000)

it("rejects a linked skill-copy directory without writing into the original skill", async () => {
  const f = await fixture({}, undefined, {}, "full")
  await symlink(join(f.root, "custom/review"), join(f.workspace, ".cmbdevclaw"), "junction")
  const before = await readFile(join(f.root, "custom/review/gate.cjs"), "utf8")
  await expect(
    f.adapter().run("PreToolUse", { toolName: "remember", toolCallId: "linked" }, "linked")
  ).rejects.toThrow("目录不能是符号链接")
  expect(await readFile(join(f.root, "custom/review/gate.cjs"), "utf8")).toBe(before)
  await expect(readFile(join(f.workspace, "invocations"))).rejects.toThrow()
}, 20_000)

it("sends the isolated workspace in an approved HTTP Hook and preserves its single delivery", async () => {
  const received: Record<string, unknown>[] = []
  const url = await server((request, response) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      received.push(JSON.parse(body))
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ additionalContext: "HTTP_CHECKED" }))
    })
  })
  const f = await fixture({ type: "http", url }, undefined, {}, "full")
  const context = { toolName: "remember", toolCallId: "http-worktree" }
  expect(await f.adapter().run("PreToolUse", context, "http-worktree")).toMatchObject({
    additionalContext: "HTTP_CHECKED"
  })
  f.reopen()
  await f.adapter().run("PreToolUse", context, "http-worktree")
  expect(received).toHaveLength(1)
  expect(received[0].workspace_path).toBe(f.workspace)
}, 20_000)

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const value = createServer(handler)
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        value.closeAllConnections()
        value.close(() => resolve())
      })
  )
  const address = value.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  return `http://127.0.0.1:${address.port}`
}

it("uses the real HTTP Hook protocol and replays the persisted response without a second POST", async () => {
  const received: string[] = []
  const url = await server((request, response) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      received.push(body)
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ decision: "block", reason: "HTTP_POLICY_DENIED" }))
    })
  })
  const f = await fixture({ type: "http", url }),
    context = { toolName: "remember", toolArgs: { text: "candidate" }, toolCallId: "http-call" }
  expect(await f.adapter().run("PreToolUse", context, "http-call")).toMatchObject({
    blocked: true,
    reason: "HTTP_POLICY_DENIED"
  })
  f.reopen()
  expect(await f.adapter().run("PreToolUse", context, "http-call")).toMatchObject({
    blocked: true
  })
  expect(received).toHaveLength(1)
  expect(JSON.parse(received[0])).toMatchObject({
    hook_event_name: "PreToolUse",
    tool_input: { text: "candidate" }
  })
  expect(f.approvals()).toBe(1)
})

it("does not forward an approved HTTP payload to a redirect destination", async () => {
  let forwarded = 0
  const destination = await server((_request, response) => {
    forwarded++
    response.end("{}")
  })
  const url = await server((_request, response) => {
    response.writeHead(307, { Location: destination })
    response.end()
  })
  const f = await fixture({ type: "http", url })
  await expect(
    f.adapter().run("PreToolUse", { toolName: "remember", toolCallId: "redirect" }, "redirect")
  ).rejects.toThrow("未取得确定结果")
  expect(forwarded).toBe(0)
  expect(f.store().effects(f.run.id)).toMatchObject([{ status: "unknown" }])
})

it("awaits current Harness at the actual prompt model fetch after a previously authorized Hook was prepared", async () => {
  let received = 0
  const base = await server((_request, response) => {
    received++
    response.setHeader("Content-Type", "text/event-stream")
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: '{"decision":"allow"}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    )
  })
  let revoked = false
  const guard = vi.fn(async () => {
    await Promise.resolve()
    if (revoked) throw new BotDomainError("harness_context_changed", "Project authority revoked")
  })
  const f = await fixture(
    { type: "prompt", prompt: "Require project authority", model: "custom:fixture" },
    `${base}/v1`,
    undefined,
    undefined,
    guard
  )
  const create = modelFactory.createConfiguredCmbModel
  vi.spyOn(modelFactory, "createConfiguredCmbModel").mockImplementation((config, options) => {
    const model = create(config, options)
    revoked = true
    return model
  })
  await expect(
    f.adapter().run("PreToolUse", { toolName: "remember", toolCallId: "authority" }, "authority")
  ).rejects.toThrow()
  expect(guard).toHaveBeenCalled()
  expect(received).toBe(0)
  expect(f.store().db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0].values[0][0]).toBe(0)
})

it.each(["block", "malformed"])(
  "evaluates configured model Hooks without allowing an invalid decision (%s)",
  async (decision) => {
    const received: unknown[] = []
    const base = await server((request, response) => {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk
      })
      request.on("end", () => {
        received.push(JSON.parse(body))
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        const content =
          decision === "block"
            ? '{"decision":"block","reason":"MODEL_POLICY_DENIED"}'
            : '{"decision":"unknown"}'
        response.end(
          `data: ${JSON.stringify({
            id: "hook-policy",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-test",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }]
          })}\n\ndata: [DONE]\n\n`
        )
      })
    })
    const f = await fixture(
      { type: "prompt", prompt: "Do not store unverified facts.", model: "custom:fixture" },
      `${base}/v1`
    )
    const evaluation = f.adapter().run(
      "PreToolUse",
      {
        toolName: "remember",
        toolArgs: { text: "unverified" },
        toolCallId: "policy"
      },
      "policy"
    )
    if (decision === "block") {
      await expect(evaluation).resolves.toMatchObject({
        blocked: true,
        reason: "MODEL_POLICY_DENIED"
      })
    } else {
      await expect(evaluation).rejects.toThrow("未取得有效判定")
      expect(f.store().effects(f.run.id)).toMatchObject([{ status: "unknown" }])
    }
    expect(received).toHaveLength(1)
    expect(JSON.stringify(received)).toContain("Do not store unverified facts.")
  }
)

it("persists successful PreSkillUse activation and guidance across reopening without rerunning it", async () => {
  const f = await fixture({ event: "PreSkillUse", matcher: "review" }, undefined, {
    additionalContext: "VERIFIED_ACTIVATION_CONTEXT"
  })
  const first = await f.lifecycle().activate(f.skillId, 1, "read-first")
  expect(first).toContain("VERIFIED_ACTIVATION_CONTEXT")
  f.reopen()
  expect(await f.lifecycle().activate(f.skillId, 1, "read-first")).toBe(first)
  expect(await f.lifecycle().activate(f.skillId, 1, "read-page-two")).toBeNull()
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
})

it("does not activate a rejected skill or run its subsequent completion checks", async () => {
  const f = await fixture({ event: "PreSkillUse", matcher: "review" }, undefined, {
    decision: "block",
    reason: "SKILL_REQUIREMENTS_NOT_MET"
  })
  await expect(f.lifecycle().activate(f.skillId, 1, "rejected-read")).rejects.toThrow(
    "SKILL_REQUIREMENTS_NOT_MET"
  )
  f.reopen()
  expect(await f.lifecycle().review({}, "final")).toBeNull()
  expect(f.approvals()).toBe(1)
})

it("defers PostSkillUse until completion and replays a revision decision only for that completion", async () => {
  const f = await fixture({ event: "PostSkillUse", matcher: "review" }, undefined, {
    decision: "block",
    reason: "ADD_REVIEW_EVIDENCE"
  })
  await f.lifecycle().activate(f.skillId, 1, "read-first")
  expect(f.approvals()).toBe(0)
  await expect(readFile(join(f.root, "project/invocations"))).rejects.toThrow()
  const context = {
    stopContext: {
      userMessage: "Review",
      assistantResponse: "Draft",
      toolCalls: ["read_skill"],
      usedSkills: ["review"]
    }
  }
  const first = await f.lifecycle().review(context, "final-first")
  expect(first).toMatchObject({
    event: "PostSkillUse",
    result: { blocked: true, reason: "ADD_REVIEW_EVIDENCE" }
  })
  f.reopen()
  expect(await f.lifecycle().review(context, "final-first")).toEqual(first)
  expect(await f.lifecycle().review(context, "final-revised")).toBeNull()
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
})

it("preserves submitted input rewrites across recovery without repeating the Hook or changing unrelated messages", async () => {
  const f = await fixture({ event: "UserPromptSubmit", matcher: "*" }, undefined, {
    updatedInput: { message: "REWRITTEN_TASK" },
    additionalContext: "INPUT_POLICY_CONTEXT"
  })
  await f.lifecycle().activate(f.skillId, 1, "selected")
  const messages = [
    new HumanMessage({ id: f.run.messageId, content: "Review" }),
    new HumanMessage({ id: "unrelated", content: "untouched" })
  ]
  const first = await f.prompts().prepare(messages)
  expect(first[0].content).toContain("REWRITTEN_TASK")
  expect(first[0].content).toContain("INPUT_POLICY_CONTEXT")
  expect(first[1]).toBe(messages[1])
  f.reopen()
  expect((await f.prompts().prepare(messages)).map((message) => message.content)).toEqual(
    first.map((message) => message.content)
  )
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
})

it("keeps host-resolved skill instructions when the submit Hook rewrites the task", async () => {
  const f = await fixture({ event: "UserPromptSubmit", matcher: "*" }, undefined, {
    updatedInput: { message: "REWRITTEN_TASK" },
    additionalContext: "INPUT_POLICY_CONTEXT"
  })
  await f.lifecycle().activate(f.skillId, 1, "selected")
  const original = f.store().message({ conversationId: f.run.conversationId, id: f.run.messageId })
  const content = await prepareBotUserPrompt({
    store: f.store(),
    lease: f.lease,
    message: original
  })
  const messages = [new HumanMessage({ id: original.id, content })]
  const first = await f.prompts().prepare(messages)
  expect(first[0].content).toContain("REWRITTEN_TASK")
  expect(first[0].content).toContain("INPUT_POLICY_CONTEXT")
  expect(first[0].content).toContain("Review the task.")
  expect(first[0].content).toContain(f.skillId)
  f.reopen()
  expect((await f.prompts().prepare(messages))[0].content).toBe(first[0].content)
  expect(f.approvals()).toBe(1)
  expect(await readFile(join(f.root, "project/invocations"), "utf8")).toBe("x")
})

it("does not retroactively submit an earlier message when a skill is activated later", async () => {
  const f = await fixture({ event: "UserPromptSubmit", matcher: "*" }, undefined, {
    decision: "block",
    reason: "NEW_POLICY"
  })
  const messages = [new HumanMessage({ id: f.run.messageId, content: "Review" })]
  expect((await f.prompts().prepare(messages))[0].content).toBe("Review")
  await f.lifecycle().activate(f.skillId, 1, "later-read")
  f.reopen()
  expect((await f.prompts().prepare(messages))[0].content).toBe("Review")
  expect(f.approvals()).toBe(0)
})
