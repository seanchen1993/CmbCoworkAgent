import { DEFAULT_MAX_TOKENS } from "../models/defaults"
import { BOT_DELIVERY_QUALITY_POLICY } from "./delivery-quality-policy"
import { createHash, randomBytes } from "node:crypto"
import { BotHost } from "./host"
import { safeBotErrorText } from "./error-diagnostic"
import { BotHostLock } from "./host-lock"
import { createBotLocalToolAuthority } from "./local-tool-authority"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, renameSync } from "node:fs"
import { build } from "esbuild"
import { BotWorkflowProcess } from "./workflow-process"
import { BotWorktrees } from "./worktrees"
import type { BotShellProcess } from "./shell-process"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotLocalToolGate } from "./local-tool-gate"
import { BotCheckpointSaver } from "./checkpointer"
import {
  bindTestLocalProjectAuthority,
  createTestLocalProjectAccess
} from "./test-local-project-permission"
import { BotArtifacts } from "./artifacts"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { readBotModelSnapshot, writeBotModelSnapshot } from "./model-config"
import { BotWorkflowStore } from "./workflow-store"
import { botWorkflowChildRunner } from "./workflow-child-runner"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import type { WorkflowSubagentRunner } from "../agent/workflow/types"
import type { BotOutputContract } from "../../shared/bot-output-contract"
import { DEFAULT_MOD_POLICY } from "../mods/policy-core"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const call = (name: string, args: unknown, id = name) => ({
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
})
async function fixture(
  respond: (body: TestModelRequest) => Record<string, unknown> | Promise<Record<string, unknown>>,
  enableWorkflow = false,
  contextTokens = DEFAULT_MAX_TOKENS,
  plugin?: string,
  standaloneBrowserHost = false,
  shell?: BotShellProcess,
  outputContract?: BotOutputContract
) {
  const root = await mkdtemp(join(tmpdir(), "bot-workflow-model-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project")
  await mkdir(project)
  await writeFile(join(project, "app.ts"), "const value = 1\n")
  const requests: TestModelRequest[] = []
  const requestPaths: string[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    requests.push(body)
    requestPaths.push(req.url ?? "")
    const message = await respond(body),
      id = `chatcmpl-${requests.length}`
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream")
      const calls = (message.tool_calls as Record<string, unknown>[] | undefined)?.map(
        (call, index) => ({ ...call, index })
      )
      const delta = {
        role: "assistant",
        ...(calls ? { tool_calls: calls } : { content: message.content ?? "" })
      }
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } }
      ])
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "gpt-test", created: 1, ...chunk })}\n\n`
        )
      res.end("data: [DONE]\n\n")
    } else
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model: "gpt-test",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", ...message },
              finish_reason: message.tool_calls ? "tool_calls" : "stop"
            }
          ],
          usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 }
        })
      )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  const file = join(root, "host", "models.private")
  let modsWorkerDirectory: string | undefined
  const pluginPath = join(root, "plugin")
  if (plugin) {
    await cp(resolve("resources/mods/function-commands"), pluginPath, { recursive: true })
    await writeFile(join(pluginPath, "hooks/registered-tools.ts"), plugin)
    await mkdir(resolve("output"), { recursive: true })
    modsWorkerDirectory = await mkdtemp(resolve("output/bot-child-mods-"))
    const workers = modsWorkerDirectory
    cleanup.push(() => rm(workers, { recursive: true, force: true }))
    await build({
      entryPoints: {
        "mod-host": "src/main/mods/host-entry.ts",
        "function-mod-host": "src/main/mods/v2/host-entry.ts"
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outdir: workers,
      external: ["quickjs-emscripten"],
      logLevel: "silent"
    })
  }
  await writeBotModelSnapshot(file, {
    version: 1,
    ...(plugin
      ? {
          mods: {
            enabled: true,
            policy: DEFAULT_MOD_POLICY,
            plugins: [
              { id: "fixture", name: "Cmb Function Commands", enabled: true, path: pluginPath }
            ]
          }
        }
      : {}),
    defaultRef: "test",
    models: [
      {
        ref: "test",
        id: "test",
        name: "Test",
        model: "gpt-test",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "test-only",
        maxTokens: contextTokens
      }
    ],
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  })
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  if (!standaloneBrowserHost) cleanup.push(bindTestLocalProjectAuthority(store, root))
  const computer = new LocalBotComputerProvider(join(root, "browser"))
  cleanup.push(() => computer.close())
  const files = new BotArtifacts(join(root, "files"), store)
  let worker: BotWorkflowProcess | undefined
  let worktrees: BotWorktrees | undefined
  if (enableWorkflow) {
    const entry = join(root, "workflow.cjs")
    await build({
      entryPoints: ["src/main/bots/workflow-worker-entry.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: entry,
      logLevel: "silent"
    })
    worker = new BotWorkflowProcess({ entry })
    const worktreeEntry = join(root, "worktree.cjs"),
      shellEntry = join(root, "shell.cjs")
    await build({
      entryPoints: ["src/main/bots/worktree-worker-entry.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: worktreeEntry,
      logLevel: "silent"
    })
    await build({
      entryPoints: ["src/main/bots/shell-worker-entry.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: shellEntry,
      logLevel: "silent"
    })
    worktrees = new BotWorktrees(file, { entry: worktreeEntry })
    shell = await createTrustedBotShellTestRunner(cleanup, { workerEntry: shellEntry })
    vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "settings"))
    cleanup.push(() => {
      vi.unstubAllEnvs()
    })
  }
  const runtimeOptions = { files, workflow: worker, worktrees, shell, modsWorkerDirectory }
  const runtime = new CmbBotRuntime(file, computer, runtimeOptions)
  cleanup.push(() => runtime.functionSessions.close())
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Developer",
    instructions: "PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT",
    workspacePath: project,
    ...(plugin ? { connectorIds: ["bot-mod:fixture"] } : {})
  })
  store.saveMemory({ botId: bot.id, text: "PRIVATE_MEMORY_NOT_CHILD_CONTEXT" })
  store.send({
    nonce: "task",
    conversationId,
    text: "PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED",
    ...(outputContract ? { outputContract } : {})
  })
  const claimed = store.claim("host")!
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const request = {
    ...claimed,
    store,
    bot,
    messages: store.messagesForRun(claimed.run.id),
    signal: controller.signal
  }
  const workflow = BotWorkflowStore.open(store, claimed.lease, "workflow", {
    script: 'export const meta={name:"Review",description:"Review"}; return await agent("task");',
    maxConcurrency: 2,
    defaultModelId: "test",
    agentProfiles: [],
    authority: { project }
  })
  const runChild = botWorkflowChildRunner(request, workflow, (input) => runtime.execute(input))
  const activeChildren = new Set<ReturnType<WorkflowSubagentRunner>>()
  const runner: WorkflowSubagentRunner = (input) => {
    const pending = runChild(input)
    activeChildren.add(pending)
    void pending.then(
      () => activeChildren.delete(pending),
      () => activeChildren.delete(pending)
    )
    return pending
  }
  // Join cancellation before closing SQLite, servers or plugin worker files.
  // Assertion failures must not leave a child cleaning up in the next test.
  cleanup.push(async () => {
    controller.abort()
    await Promise.allSettled([...activeChildren])
  })
  const input = (n = 0): Parameters<WorkflowSubagentRunner>[0] => ({
    prompt: `Assigned task ${n}`,
    agentIndex: n + 1,
    label: `Task ${n}`,
    phase: null,
    toolStreamKey: `${"a".repeat(64)}_c${n}`,
    durableCallKey: `${"a".repeat(64)}_n${n}`,
    signal: controller.signal
  })
  return {
    root,
    modelFile: file,
    store,
    project,
    requests,
    requestPaths,
    runner,
    input,
    controller,
    parent: claimed,
    conversationId,
    workflow,
    runtime,
    request,
    files,
    computer,
    runtimeOptions
  }
}

async function installChildLifecycleHooks(f: Awaited<ReturnType<typeof fixture>>, halt = false) {
  const settings = join(f.root, "hook-settings")
  await mkdir(settings)
  await mkdir(join(f.project, ".cmbdevclaw/hooks"), { recursive: true })
  for (const event of ["SubagentStart", "SubagentStop"])
    await writeFile(
      join(f.project, `.cmbdevclaw/hooks/${event}.json`),
      JSON.stringify({
        id: event,
        event,
        matcher: "*",
        command: "node child-lifecycle.cjs",
        enabled: true
      })
    )
  await writeFile(
    join(f.project, "child-lifecycle.cjs"),
    `let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{
      const input=JSON.parse(text),fs=require('fs'),p=require('path');
      fs.appendFileSync(p.join(process.env.WORKSPACE_PATH,'child-lifecycle.jsonl'),JSON.stringify(input)+'\\n');
      console.log(JSON.stringify(${halt} && input.hook_event_name==='SubagentStop'
        ? {continue:false,stopReason:'Release evidence missing'} : {}));
    });`
  )
  await writeBotModelSnapshot(f.modelFile, {
    ...(await readBotModelSnapshot(f.modelFile)),
    hookSources: { root: settings }
  })
}

function approveChildHooks(f: Awaited<ReturnType<typeof fixture>>, rejectStart = false) {
  const approvals: { runId: string; event: string }[] = []
  const timer = setInterval(() => {
    try {
      for (const interaction of f.store.snapshot().interactions) {
        if (interaction.status !== "pending") continue
        const action = JSON.parse(interaction.prompt)
        const event = action.hook?.event
        if (event !== "SubagentStart" && event !== "SubagentStop")
          throw new Error("Unexpected non-lifecycle approval")
        approvals.push({ runId: interaction.runId, event })
        f.store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: rejectStart && event === "SubagentStart" ? "reject" : "approve"
        })
      }
    } catch (error) {
      f.controller.abort(error)
    }
  }, 20)
  cleanup.push(() => clearInterval(timer))
  return approvals
}

it("binds the child's model and assigned input before plugin session.start", async () => {
  let observed: {
    initial?: { messages: unknown[]; usage: { context: { tokens?: number } } }
    live?: { messages: unknown[]; usage: { context: { tokens?: number } } }
  } = {}
  const f = await fixture(
    (body) => {
      const result = body.messages.find((message) => message.role === "tool")
      if (typeof result?.content === "string") observed = JSON.parse(result.content)
      return result
        ? { content: JSON.stringify(result.content) }
        : call("project_list", { path: "." })
    },
    false,
    16000,
    `export function register(on) {
      let initial;
      on("session.start", {}, async ($, e, next) => {
        initial = {messages:await $.session.messages(), model:await $.session.model(), usage:await $.session.usage()};
        return next(e);
      });
      on("tool.call", {tool:"project_list"}, async ($) => ({result:{initial,live:{messages:await $.session.messages(),usage:await $.session.usage()}}}));
    }`
  )
  const snapshot = await readBotModelSnapshot(f.modelFile)
  snapshot.models.push({
    ...snapshot.models[0],
    id: "child-model",
    ref: "child-model",
    maxTokens: 24000
  })
  await writeBotModelSnapshot(f.modelFile, snapshot)
  const pending = f.runner({ ...f.input(), model: "custom:child-model" })
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  // This waits for a real plugin worker to start, within the test's 25s budget.
  await vi.waitFor(() => expect(f.store.snapshot().interactions.length).toBe(1), {
    timeout: 10_000
  })
  const approval = f.store.snapshot().interactions[0]
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  const result = await settled
  if ("error" in result) throw result.error
  expect(result.value.text).toContain("Assigned task 0")
  expect(result.value.text).toContain("child-model")
  expect(result.value.text).toContain("24000")
  expect(result.value.text).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
  expect(result.value.text).not.toContain("PRIVATE_MEMORY_NOT_CHILD_CONTEXT")
  expect(result.value.text).not.toContain("PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT")
  expect(observed.initial?.messages).toHaveLength(1)
  expect(observed.initial?.usage.context.tokens).toBeUndefined()
  expect(observed.live?.messages.length).toBeGreaterThan(1)
  expect(observed.live?.usage.context.tokens).toBe(50)
  expect(f.requests).toHaveLength(2)
}, 25_000)

it("keeps an in-flight plugin model receipt live when a sibling child opens the same Bot store", async () => {
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  let reachedModel!: () => void
  const modelEntered = new Promise<void>((done) => {
    reachedModel = done
  })
  let nested = 0
  const f = await fixture(
    async (body) => {
      if (JSON.stringify(body.messages).includes("PLUGIN_CONCURRENT_COMPLETION")) {
        if (++nested === 1) {
          reachedModel()
          await held
        }
        return { content: "PLUGIN_MODEL_CONFIRMED" }
      }
      if (body.messages.at(-1)?.role === "tool")
        return { content: JSON.stringify(body.messages.at(-1)?.content) }
      return call("project_list", { path: "." })
    },
    false,
    16000,
    `export function register(on) {
    on("tool.call", {tool:"project_list"}, async($) => ({result:{proof:await $.model.complete({model:"default",prompt:"PLUGIN_CONCURRENT_COMPLETION",maxTokens:64})}}));
  }`
  )
  cleanup.push(() => release())
  const first = f.runner(f.input(0))
  // Retain a handler while the first child's real permission card is displayed.
  const firstResult = first.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  await vi.waitFor(() => expect(f.store.snapshot().interactions.length).toBe(1), {
    timeout: 10_000
  })
  const approval = f.store.snapshot().interactions[0]
  expect(JSON.parse(approval.prompt).pluginGrant).toBeDefined()
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  await Promise.race([
    // The receipt race starts at the actual model request, not after an
    // arbitrary worker-startup deadline. The whole test remains bounded to 30s.
    modelEntered,
    firstResult.then((result) => {
      if ("error" in result) throw result.error
      throw new Error(`Child finished before its plugin model request: ${result.value.text}`)
    })
  ])
  const second = await f.runner(f.input(1))
  expect(second.text).toContain("PLUGIN_MODEL_CONFIRMED")
  release()
  const result = await firstResult
  if ("error" in result) throw result.error
  expect(result.value.text).toContain("PLUGIN_MODEL_CONFIRMED")
  expect(nested).toBe(2)
  const database = new DatabaseSync(
    join(
      f.root,
      "host/mods",
      createHash("sha256").update(JSON.stringify(f.request.bot.id)).digest("hex"),
      "control.sqlite"
    ),
    { readOnly: true }
  )
  try {
    const rows = database
      .prepare("SELECT status FROM mods_calls WHERE model_usage IS NOT NULL")
      .all()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.status)).toEqual(["succeeded", "succeeded"])
  } finally {
    database.close()
  }
}, 30_000)

it.each([false, true])(
  "runs durable child lifecycle checks through native approvals (decline=%s)",
  async (decline) => {
    const f = await fixture(() => ({ content: "Child evidence" }), true)
    await installChildLifecycleHooks(f)
    const approvals = approveChildHooks(f, decline)
    const input = { ...f.input(), agentType: "Reviewer" }
    if (decline) {
      await expect(f.runner(input)).rejects.toThrow("用户未授权此技能 Hook")
      expect(f.requests).toHaveLength(0)
      expect(approvals.map((item) => item.event)).toEqual(["SubagentStart"])
      await expect(readFile(join(f.project, "child-lifecycle.jsonl"))).rejects.toMatchObject({
        code: "ENOENT"
      })
      return
    }
    expect(await f.runner(input)).toMatchObject({ text: "Child evidence" })
    expect(approvals.map((item) => item.event)).toEqual(["SubagentStart", "SubagentStop"])
    const text = await readFile(join(f.project, "child-lifecycle.jsonl"), "utf8")
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const childId = f.store.workflowChildren.list(f.parent.run.id)[0].id
    expect(rows.map((row) => row.subagent)).toEqual([
      { id: childId, name: "Reviewer", status: "started" },
      { id: childId, name: "Reviewer", status: "completed" }
    ])
    expect(rows.every((row) => row.agent_id === childId && row.session_id === childId)).toBe(true)
    expect(text).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
    expect(await f.runner(input)).toMatchObject({ text: "Child evidence" })
    expect(await readFile(join(f.project, "child-lifecycle.jsonl"), "utf8")).toBe(text)
    expect(f.requests).toHaveLength(1)
  },
  20_000
)

it("halts the real parent workflow when its script catches a child's lifecycle stop", async () => {
  const script =
    'export const meta={name:"Review",description:"Review"}; try { await agent("Inspect release"); } catch {} return "MUST_NOT_BYPASS_HOOK";'
  const f = await fixture((body) => {
    if (body.tools.some((tool) => tool.function.name === "workflow")) {
      if (body.messages.some((message) => message.role === "tool"))
        return { content: "MUST_NOT_CONTINUE_PARENT" }
      return call("workflow", { script, maxConcurrency: 1 }, "lifecycle-workflow")
    }
    return { content: "Child release findings" }
  }, true)
  await installChildLifecycleHooks(f, true)
  approveChildHooks(f)
  await expect(f.runtime.execute(f.request)).rejects.toThrow("Release evidence missing")
  expect(f.requests).toHaveLength(2)
  const children = f.store.workflowChildren.list(f.parent.run.id)
  expect(children).toHaveLength(1)
  expect(children[0].status).toBe("failed")
  const rows = (await readFile(join(f.project, "child-lifecycle.jsonl"), "utf8")).trim().split("\n")
  expect(rows).toHaveLength(2)
}, 20_000)

it("runs a failed child stop without replacing its model failure with success", async () => {
  const f = await fixture(() => ({ content: "" }), true)
  await installChildLifecycleHooks(f)
  const approvals = approveChildHooks(f)
  await expect(f.runner(f.input())).rejects.toThrow()
  expect(f.store.workflowChildren.list(f.parent.run.id)[0].status).toBe("failed")
  expect(approvals.map((item) => item.event)).toEqual(["SubagentStart", "SubagentStop"])
  const rows = (await readFile(join(f.project, "child-lifecycle.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(rows[1].subagent.status).toBe("failed")
  expect(f.requests.length).toBeGreaterThan(0)
}, 20_000)

it.each(["allow", "ask"])(
  "reviews delegated writes with the parent model and keeps private context out of the child model (%s)",
  async (decision) => {
    const f = await fixture((body) => {
      if (String(body.messages[0]?.content).includes("independently review ONE")) {
        expect(body.model).toBe("gpt-test")
        expect(body.tools).toHaveLength(0)
        const data = JSON.parse(String(body.messages.find((m) => m.role === "user")?.content))
        expect(data.task.messages[0].text).toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
        expect(data.task.delegation.assignment).toBe(
          "Create review-result.txt with assigned evidence"
        )
        expect(data.proposedAction.project.path).toBe("review-result.txt")
        return { content: JSON.stringify({ decision, reason: "检查父任务授权与子任务范围" }) }
      }
      expect(body.model).toBe("gpt-child")
      expect(JSON.stringify(body.messages)).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
      expect(JSON.stringify(body.messages)).not.toContain("PRIVATE_MEMORY_NOT_CHILD_CONTEXT")
      return body.messages.some((m) => m.role === "tool")
        ? { content: decision === "allow" ? "Evidence file created" : "User declined the write" }
        : call(
            "project_edit",
            { path: "review-result.txt", expected_sha256: null, content: "Assigned evidence" },
            "child-edit"
          )
    })
    const snapshot = await readBotModelSnapshot(f.modelFile)
    await writeBotModelSnapshot(f.modelFile, {
      ...snapshot,
      models: [
        ...snapshot.models,
        {
          ...snapshot.models[0],
          ref: "child",
          id: "child",
          model: "gpt-child",
          baseUrl: snapshot.models[0].baseUrl!.replace("/v1", "/child/v1")
        }
      ]
    })
    f.store.autoReview.change({
      ...f.store.autoReview.read(f.request.bot.id),
      isEnabled: true,
      nonce: "enable-review"
    })
    const pending = f.runner({
      ...f.input(),
      model: "child",
      prompt: "Create review-result.txt with assigned evidence"
    })
    if (decision === "ask") {
      await vi.waitFor(
        () =>
          expect(f.store.snapshot().interactions.some((i) => i.status === "pending")).toBe(true),
        { timeout: 10_000 }
      )
      const interaction = f.store.snapshot().interactions.find((i) => i.status === "pending")!
      expect(interaction.runId).not.toBe(f.parent.run.id)
      expect(interaction.autoReview).toMatchObject({ decision: "ask", model: "gpt-test" })
      f.store.answerInteraction({
        id: interaction.id,
        revision: interaction.revision,
        answer: "reject"
      })
    }
    expect(await pending).toMatchObject({
      text: decision === "allow" ? "Evidence file created" : "User declined the write"
    })
    if (decision === "allow")
      expect(await readFile(join(f.project, "review-result.txt"), "utf8")).toBe("Assigned evidence")
    else
      await expect(readFile(join(f.project, "review-result.txt"))).rejects.toMatchObject({
        code: "ENOENT"
      })
    expect(f.requestPaths).toEqual([
      "/child/v1/chat/completions",
      "/v1/chat/completions",
      "/child/v1/chat/completions"
    ])
    expect(f.store.db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0].values[0][0]).toBe(3)
  },
  20_000
)

it.each([false, true])(
  "keeps plugin native file SDKs inside the child role (deny read_file: %s)",
  async (denied) => {
    const plugin = `export function register(on) {
    on("session.start", {}, async ($, e, next) => {
      await $.tool.register({name:"unavailable_child_tool",description:"Parent-only registered tool",inputSchema:{type:"object",properties:{}}});
      return next(e);
    });
    on("tool.call", {tool:"project_list"}, async ($) => {
      const catalog = await $.tool.list();
      const list = await $.tool.call({tool:"ls",path:"."});
      const files = await $.tool.call({tool:"glob",pattern:"*.ts"});
      const permission = await $.tool.check({tool:"read_file",input:{file_path:"app.ts"}});
      let fileContent = "", blocked = false;
      try { fileContent = (await $.tool.call({tool:"read_file",file_path:"app.ts"})).text; } catch { blocked = true; }
      return {result:{catalog,list,files,permission,fileContent,blocked}};
    });
  }`
    const f = await fixture(
      (body) => {
        const result = body.messages.find((m) => m.role === "tool")
        return result
          ? {
              content:
                typeof result.content === "string" ? result.content : JSON.stringify(result.content)
            }
          : call("project_list", { path: "." })
      },
      false,
      16000,
      plugin
    )
    const pending = f.runner({
      ...f.input(),
      shellAccess: "read_only",
      disallowedTools: denied ? ["read_file"] : []
    })
    // Attach a rejection handler while waiting for the real child's grant card.
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    let approval: ReturnType<BotStore["getInteraction"]> | undefined
    for (let attempt = 0; attempt < 500; attempt++) {
      const id = f.store.db.exec("SELECT id FROM bot_interactions WHERE status='pending'")[0]
        ?.values[0]?.[0]
      if (id) {
        approval = f.store.getInteraction(String(id))
        break
      }
      await delay(10)
    }
    expect(approval).toBeDefined()
    f.store.answerInteraction({ id: approval!.id, revision: approval!.revision, answer: "approve" })
    const result = await settled
    if ("error" in result) throw result.error
    expect(result.value.text).toContain("app.ts")
    expect(result.value.text).toContain('"blocked":' + denied)
    expect(result.value.text).toContain('"decision":"' + (denied ? "deny" : "allow") + '"')
    if (denied) expect(result.value.text).not.toContain("const value = 1")
    else expect(result.value.text).toContain("const value = 1")
    expect(result.value.text).not.toContain("unavailable_child_tool")
    for (const request of f.requests)
      expect(
        request.tools.some((tool) => tool.function.name.includes("unavailable_child_tool"))
      ).toBe(false)
    expect(f.store.getRun(f.parent.run.id).status).toBe("running")
    expect(f.store.messages(f.conversationId)).toHaveLength(1)
  },
  30_000
)

it.each(["glob", "project_glob", "project_list", "grep", "project_grep"])(
  "blocks plugin file discovery when the child role denies %s",
  async (denied) => {
    const grep = denied === "grep" || denied === "project_grep"
    const plugin = `export function register(on) {
    on("tool.call",{tool:"project_read"},async($)=>{
      const permission=await $.tool.check({tool:${JSON.stringify(grep ? "grep" : "glob")},input:{pattern:"*.ts"}});
      let blocked=false;try{await $.tool.call({tool:${JSON.stringify(grep ? "grep" : "glob")},pattern:"*.ts"})}catch{blocked=true}
      return {result:{permission,blocked}};
    });
  }`
    const f = await fixture(
      (body) => {
        expect(
          body.tools.some((item) => item.function.name === (grep ? "project_grep" : "project_glob"))
        ).toBe(false)
        const result = body.messages.find((item) => item.role === "tool")
        return result
          ? { content: String(result.content) }
          : call("project_read", { path: "app.ts" })
      },
      false,
      16000,
      plugin
    )
    const pending = f.runner({ ...f.input(), shellAccess: "read_only", disallowedTools: [denied] })
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    let approval: ReturnType<BotStore["getInteraction"]> | undefined
    for (let attempt = 0; attempt < 500; attempt++) {
      const id = f.store.db.exec("SELECT id FROM bot_interactions WHERE status='pending'")[0]
        ?.values[0]?.[0]
      if (id) {
        approval = f.store.getInteraction(String(id))
        break
      }
      await delay(10)
    }
    expect(approval).toBeDefined()
    f.store.answerInteraction({ id: approval!.id, revision: approval!.revision, answer: "approve" })
    const result = await settled
    if ("error" in result) throw result.error
    expect(result.value.text).toContain('"blocked":true')
    expect(result.value.text).toContain('"decision":"deny"')
  },
  30000
)

it.each([
  { shellAccess: "full" as const, denied: false, inherits: true },
  { shellAccess: "read_only" as const, denied: false, inherits: false },
  { shellAccess: "none" as const, denied: false, inherits: false },
  { shellAccess: "full" as const, denied: true, inherits: false }
])(
  "honors Cmb project-instruction scope for the child role $shellAccess (deny read: $denied)",
  async ({ shellAccess, denied, inherits }) => {
    const f = await fixture(
      () => ({ content: "ROLE_SCOPED_RESULT" }),
      false,
      DEFAULT_MAX_TOKENS,
      undefined,
      false,
      await createTrustedBotShellTestRunner(cleanup)
    )
    const agentsHome = join(f.root, "global-rules")
    await mkdir(agentsHome)
    await writeFile(join(agentsHome, "AGENTS.md"), "GLOBAL_RULE_ONLY_FOR_FULL_ROLE")
    await writeBotModelSnapshot(f.modelFile, {
      ...(await readBotModelSnapshot(f.modelFile)),
      instructionSources: { agentsHome },
      toolStrategy: "shell-first"
    })
    await writeFile(join(f.project, "AGENTS.md"), "PROJECT_RULE_ONLY_FOR_FULL_ROLE")
    await writeFile(join(f.root, "AGENTS.md"), "OUTSIDE_PROJECT_RULE_NEVER_INHERITED")
    const result = await f.runner({
      ...f.input(),
      roleSystemPrompt: "EXPLICIT_ASSIGNED_ROLE_INSTRUCTIONS",
      shellAccess,
      disallowedTools: denied ? ["read_file"] : []
    })
    expect(result.text).toBe("ROLE_SCOPED_RESULT")
    const input = JSON.stringify(f.requests[0].messages)
    expect(input).toContain("EXPLICIT_ASSIGNED_ROLE_INSTRUCTIONS")
    expect(input).toContain("Assigned task 0")
    expect(input.includes("PROJECT_RULE_ONLY_FOR_FULL_ROLE")).toBe(inherits)
    expect(input.includes("GLOBAL_RULE_ONLY_FOR_FULL_ROLE")).toBe(inherits)
    expect(input.includes("Read project instructions (AGENTS.md)")).toBe(inherits)
    expect(input).not.toContain("OUTSIDE_PROJECT_RULE_NEVER_INHERITED")
    expect(input).not.toContain("PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT")
    expect(input).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
    expect(input).not.toContain("PRIVATE_MEMORY_NOT_CHILD_CONTEXT")
    const tools = f.requests[0].tools.map((tool) => tool.function.name)
    expect(input.includes("## Tool strategy: shell-first")).toBe(shellAccess === "full")
    expect(tools.includes("project_read")).toBe(!denied)
    expect(tools.includes("read_global_instructions")).toBe(inherits)
    if (shellAccess === "read_only") expect(tools).not.toContain("project_edit")
    if (shellAccess === "none") expect(tools).not.toContain("execute")
  }
)

it("runs actual Cmb model graphs concurrently and returns schema-validated results without exposing parent private history", async () => {
  const f = await fixture((body) =>
    body.messages.some((m) => m.role === "tool")
      ? call("structured_output", { findings: ["verified source"] }, "result")
      : call("project_read", { path: "app.ts" }, "read")
  )
  const schema = {
    type: "object",
    properties: { findings: { type: "array", items: { type: "string" } } },
    required: ["findings"],
    additionalProperties: false
  }
  const results = await Promise.all(
    [0, 1].map((n) =>
      f.runner({
        ...f.input(n),
        schema,
        shellAccess: "read_only",
        disallowedTools: ["write_file", "edit_file"]
      })
    )
  )
  expect(results.map((r) => r.structured)).toEqual([
    { findings: ["verified source"] },
    { findings: ["verified source"] }
  ])
  expect(results.every((r) => r.outputTokens >= 24)).toBe(true)
  expect(f.requests).toHaveLength(4)
  for (const request of f.requests) {
    const system = JSON.stringify(request.messages.filter((message) => message.role === "system"))
    expect(system).toContain(BOT_DELIVERY_QUALITY_POLICY)
    const tools = request.tools.map((t) => t.function.name)
    expect(tools).toContain("project_read")
    expect(tools).not.toContain("project_edit")
    expect(tools).not.toContain("browser")
    expect(tools).not.toContain("message_bot")
    expect(JSON.stringify(request.messages)).not.toContain("PRIVATE_MEMORY_NOT_CHILD_CONTEXT")
    expect(JSON.stringify(request.messages)).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
    expect(JSON.stringify(request.messages)).not.toContain("PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT")
  }
  expect(f.store.messages(f.conversationId)).toHaveLength(1)
  const before = f.requests.length
  expect(
    (
      await f.runner({
        ...f.input(),
        schema,
        shellAccess: "read_only",
        disallowedTools: ["write_file", "edit_file"]
      })
    ).structured
  ).toEqual(results[0].structured)
  expect(f.requests).toHaveLength(before)
}, 20_000)

it("completes a read-only model child without making it deliver the parent's final CSV", async () => {
  const f = await fixture(
    (body) =>
      body.messages.some((message) => message.role === "tool")
        ? call("structured_output", { findings: ["const value = 1"] }, "inspection-result")
        : call("project_read", { path: "app.ts" }, "inspection-read"),
    false,
    DEFAULT_MAX_TOKENS,
    undefined,
    false,
    undefined,
    { files: [{ name: "result.csv", kind: "csv", columns: ["project_id", "amount万元"] }] }
  )
  const result = await f.runner({
    ...f.input(),
    prompt: "Read app.ts and return its contents. Do not create files.",
    shellAccess: "read_only",
    schema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false
    }
  })
  expect(result.structured).toEqual({ findings: ["const value = 1"] })
  expect(f.store.workflowChildren.list(f.parent.run.id)[0].status).toBe("succeeded")
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  expect(f.requests).toHaveLength(2)
  expect(f.store.finish(f.parent.lease, "succeeded", "Missing parent file")).toMatchObject({
    status: "needs_review",
    error: expect.stringContaining("result.csv")
  })
}, 20_000)

it("keeps an approval scoped to its child while its sibling finishes", async () => {
  const f = await fixture((body) => {
    const task = body.messages.find((m) => m.role === "user")?.content
    return task === "Assigned task 1" || body.messages.some((m) => m.role === "tool")
      ? { content: "Verified result" }
      : call("ask_user", { prompt: "Choose the module" }, "question")
  })
  const pending = f.runner(f.input())
  let card: ReturnType<BotStore["getInteraction"]> | undefined
  for (let i = 0; i < 100; i++) {
    const row = f.store.db.exec("SELECT id FROM bot_interactions WHERE status='pending'")[0]
      ?.values[0]?.[0]
    if (row) {
      card = f.store.getInteraction(String(row))
      break
    }
    await delay(20)
  }
  expect(card).toBeDefined()
  expect((await f.runner(f.input(1))).text).toBe("Verified result")
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  expect(f.store.getInteraction(card!.id).status).toBe("pending")
  f.store.answerInteraction({ id: card!.id, revision: card!.revision, answer: "Use app.ts" })
  expect((await pending).text).toBe("Verified result")
}, 20_000)

it("enforces read-only shell policy inside the actual graph before approval or file writes", async () => {
  const f = await fixture(
    () => call("execute", { command: "printf overwritten > app.ts", timeout_seconds: 1 }),
    false,
    DEFAULT_MAX_TOKENS,
    undefined,
    false,
    await createTrustedBotShellTestRunner(cleanup)
  )
  await expect(f.runner({ ...f.input(), shellAccess: "read_only" })).rejects.toThrow("只读命令")
  expect(await readFile(join(f.project, "app.ts"), "utf8")).toBe("const value = 1\n")
  expect(f.store.db.exec("SELECT id FROM bot_effects")[0]?.values ?? []).toHaveLength(0)
}, 15_000)

it("uses the original bounded structured-output repair without restarting the child", async () => {
  let attempts = 0
  const f = await fixture(() =>
    ++attempts === 1
      ? call("structured_output", { value: "wrong" }, "bad")
      : call("structured_output", { total: 3 }, "good")
  )
  const result = await f.runner({
    ...f.input(),
    schema: {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
      additionalProperties: false
    }
  })
  expect(result.structured).toEqual({ total: 3 })
  expect(attempts).toBe(2)
  expect(
    f.store.db.exec("SELECT id FROM bot_runs WHERE source='workflow-child'")[0].values
  ).toHaveLength(1)
}, 15_000)

it("refuses unavailable explicit models before any model dispatch", async () => {
  const f = await fixture(() => ({ content: "must not run" }))
  await expect(f.runner({ ...f.input(), model: "missing-model" })).rejects.toThrow("模型未配置")
  expect(f.requests).toHaveLength(0)
})

it("revises a captured structured answer when the user steers that child before final completion", async () => {
  const f = await fixture((body) =>
    call(
      "structured_output",
      {
        answer: body.messages.some((message) =>
          JSON.stringify(message.content).includes("Use the revised constraint")
        )
          ? "revised"
          : "initial"
      },
      `result-${body.messages.length}`
    )
  )
  const save = f.store.workflowChildren.saveStructured.bind(f.store.workflowChildren)
  let steered = false
  vi.spyOn(f.store.workflowChildren, "saveStructured").mockImplementation((lease, value) => {
    save(lease, value)
    if (steered) return
    steered = true
    const run = f.store.getRun(lease.runId)
    f.store.controlWorkflowChild({
      conversationId: run.conversationId,
      runId: run.id,
      nonce: "actual-child-steer",
      revision: run.revision,
      operation: "message",
      text: "Use the revised constraint"
    })
  })
  const result = await f.runner({
    ...f.input(),
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
  })
  expect(result.structured).toEqual({ answer: "revised" })
  expect(f.requests).toHaveLength(2)
  expect(JSON.stringify(f.requests)).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
}, 20_000)

it.each([false, true])(
  "admits child steering during renewed project reads without bypassing a replaced project (replaced: %s)",
  async (replaceProject) => {
    const revised = "READ_BOUNDARY_REVISED"
    const f = await fixture((body) =>
      call(
        "structured_output",
        {
          answer: body.messages.some((message) => String(message.content).includes(revised))
            ? "revised"
            : "initial"
        },
        `result-${body.messages.length}`
      )
    )
    const save = f.store.workflowChildren.saveStructured.bind(f.store.workflowChildren)
    let childId: string | undefined
    const saved = vi
      .spyOn(f.store.workflowChildren, "saveStructured")
      .mockImplementation((lease, value) => {
        save(lease, value)
        childId ??= lease.runId
      })
    cleanup.push(() => saved.mockRestore())
    const read = BotLocalToolGate.prototype.read
    let messageId: string | undefined
    const admission = vi
      .spyOn(BotLocalToolGate.prototype, "read")
      .mockImplementation(async function (this: BotLocalToolGate, signal) {
        if (childId && !messageId) {
          const run = f.store.getRun(childId)
          messageId = f.store.controlWorkflowChild({
            conversationId: run.conversationId,
            runId: run.id,
            nonce: "read-boundary-steer",
            revision: run.revision,
            operation: "message",
            text: revised
          }).messageId!
          if (replaceProject) {
            renameSync(f.project, `${f.project}-original`)
            mkdirSync(f.project)
          }
        }
        return read.call(this, signal)
      })
    cleanup.push(() => admission.mockRestore())
    const pending = f.runner({
      ...f.input(),
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"]
      }
    })
    if (replaceProject) {
      await expect(pending).rejects.toMatchObject({
        code: "local_project_changed"
      })
      expect(f.requests).toHaveLength(1)
      expect(f.store.steering.state(messageId!)?.state).not.toBe("accepted")
    } else {
      expect((await pending).structured).toEqual({ answer: "revised" })
      expect(f.requests).toHaveLength(2)
      expect(
        f.requests[1].messages.filter(
          (message) =>
            message.content ===
            f.store.message({ conversationId: f.conversationId, id: messageId! }).text
        )
      ).toHaveLength(1)
      expect(f.store.steering.state(messageId!)?.state).toBe("accepted")
      const child = f.store.getRun(childId!)
      const checkpoint = await new BotCheckpointSaver(
        f.store,
        { runId: child.id, owner: f.parent.lease.owner, fence: child.fence },
        child.id
      ).getTuple({ configurable: { thread_id: child.id } })
      expect(checkpoint!.checkpoint.channel_values.cmbCurrentRunMessageIds).toContain(messageId)
    }
    expect(JSON.stringify(f.requests)).not.toMatch(
      /PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED|PRIVATE_MEMORY_NOT_CHILD_CONTEXT/
    )
  }
)

it.each([false, true])(
  "keeps background commands inside the child worktree and role (readOnly=%s)",
  async (readOnly) => {
    const f = await fixture((body) => {
      if (!body.messages.some((message) => message.role === "tool"))
        return call(
          "execute",
          { command: "node build.cjs", run_in_background: true, timeout_seconds: 10 },
          "child-background"
        )
      return {
        content: body.messages.some((message) =>
          String(message.content).includes("BACKGROUND_CHILD_DONE")
        )
          ? "Child background evidence verified"
          : "Waiting for background result"
      }
    }, true)
    await writeFile(
      join(f.project, "build.cjs"),
      "setTimeout(()=>{require('fs').writeFileSync('child-result.txt',process.cwd());console.log('BACKGROUND_CHILD_DONE')},500)"
    )
    const exec = promisify(execFile)
    for (const args of [
      ["init", "-b", "main"],
      ["add", "app.ts", "build.cjs"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "initial"
      ]
    ])
      await exec("git", ["-C", f.project, ...args])
    const execution = f.runner({
      ...f.input(),
      isolation: "worktree",
      ...(readOnly ? { shellAccess: "read_only" } : {})
    })
    let finished = false
    const pending = execution
      .then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      .finally(() => {
        finished = true
      })
    const deadline = Date.now() + 20000
    while (!finished) {
      if (Date.now() > deadline) throw new Error("Child command did not settle")
      for (const interaction of f.store.snapshot().interactions) {
        if (readOnly) throw new Error("Read-only role must reject before approval")
        f.store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: "approve"
        })
      }
      await delay(30)
    }
    const result = await pending
    await expect(readFile(join(f.project, "child-result.txt"))).rejects.toThrow()
    const jobs = f.store.db.exec("SELECT id,run_id FROM bot_shell_jobs")[0]?.values ?? []
    if (readOnly) {
      expect(jobs).toHaveLength(0)
      expect("error" in result).toBe(true)
      if ("error" in result) expect(String(result.error)).toContain("只读命令")
    } else {
      if ("error" in result) throw result.error
      expect(result.value.text).toBe("Child background evidence verified")
      expect(jobs).toHaveLength(1)
      const job = f.store.shellJobs.get(String(jobs[0][1]), String(jobs[0][0]))
      expect(job).toMatchObject({ status: "succeeded", exit_code: 0 })
      expect(job.output).toContain("BACKGROUND_CHILD_DONE")
      expect(job.run_id).not.toBe(f.parent.run.id)
      expect(() => f.store.shellJobs.get(f.parent.run.id, job.id)).toThrow("不属于")
    }
  },
  30000
)

it("drains a child's running background process when its parent is cancelled", async () => {
  const f = await fixture(
    (body) =>
      body.messages.some((message) => message.role === "tool")
        ? { content: "Waiting for command result" }
        : call("execute", {
            command: "node running.cjs",
            run_in_background: true,
            timeout_seconds: 30
          }),
    true
  )
  await writeFile(
    join(f.project, "running.cjs"),
    "const fs=require('fs'); console.log('CHILD_PROCESS_STARTED'); setInterval(()=>fs.appendFileSync('child-ticks','x'),50)"
  )
  const pending = f.runner(f.input()).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  const deadline = Date.now() + 15000
  for (;;) {
    if (Date.now() > deadline) throw new Error("Child command did not start")
    for (const interaction of f.store.snapshot().interactions)
      f.store.answerInteraction({
        id: interaction.id,
        revision: interaction.revision,
        answer: "approve"
      })
    const ready = f.store.db.exec(
      "SELECT id,run_id FROM bot_shell_jobs WHERE output LIKE '%CHILD_PROCESS_STARTED%'"
    )[0]?.values[0]
    if (ready) break
    await delay(30)
  }
  f.controller.abort(new Error("Parent cancelled"))
  const result = await pending
  expect("error" in result).toBe(true)
  const ticks = await readFile(join(f.project, "child-ticks"), "utf8")
  await delay(300)
  expect(await readFile(join(f.project, "child-ticks"), "utf8")).toBe(ticks)
  const row = f.store.db.exec("SELECT id,run_id FROM bot_shell_jobs")[0].values[0]
  expect(f.store.shellJobs.get(String(row[1]), String(row[0])).status).toBe("needs_review")
  expect(f.store.effects(String(row[1]))).toMatchObject([{ status: "unknown" }])
}, 20000)

it("runs an isolated coding child through real model, approved edits and Cmb shell without modifying its source project", async () => {
  const f = await fixture((body) => {
    const results = body.messages.filter((message) => message.role === "tool")
    if (!results.length)
      return call(
        "project_edit",
        { path: "result.txt", expected_sha256: null, content: "isolated evidence\n" },
        "isolated-edit"
      )
    if (results.length === 1)
      return call(
        "execute",
        {
          command:
            "git add result.txt && git -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit -m isolated",
          timeout_seconds: 30
        },
        "commit-isolated"
      )
    return { content: "ISOLATED_AND_COMMITTED" }
  }, true)
  const exec = promisify(execFile)
  for (const args of [
    ["init", "-b", "main"],
    ["add", "app.ts"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial"
    ]
  ])
    await exec("git", ["-C", f.project, ...args])
  const execution = f.runner({ ...f.input(), isolation: "worktree" })
  const result = expect(execution).resolves.toMatchObject({ text: "ISOLATED_AND_COMMITTED" })
  let finished = false
  void execution
    .finally(() => {
      finished = true
    })
    .catch(() => {})
  const deadline = Date.now() + 25_000
  while (!finished) {
    if (Date.now() > deadline) throw new Error("Isolated child did not finish")
    for (const interaction of f.store.snapshot().interactions)
      if (interaction.kind === "approval")
        f.store.answerInteraction({
          id: interaction.id,
          revision: interaction.revision,
          answer: "approve"
        })
    await delay(30)
  }
  await result
  const [row] = f.store.db.exec("SELECT record FROM bot_worktrees")[0].values
  const record = JSON.parse(String(row[0]))
  expect(
    record,
    JSON.stringify(f.requests.at(-1)?.messages.filter((message) => message.role === "tool"))
  ).toMatchObject({ status: "ready", dirty: false })
  expect(record.headCommit).not.toBe(record.baseCommit)
  expect(await readFile(join(record.workspaceDirectory, "result.txt"), "utf8")).toBe(
    "isolated evidence\n"
  )
  await expect(readFile(join(f.project, "result.txt"))).rejects.toThrow()
  expect((await exec("git", ["-C", f.project, "status", "--porcelain"])).stdout).toBe("")
  expect(JSON.stringify(f.requests[0].messages)).toContain("private Git worktree")
  const child = f.store.workflowChildren.list(f.parent.run.id)[0]
  expect(f.store.effects(child.id)).toHaveLength(2)
  expect(f.store.effects(child.id).every((effect) => effect.status === "succeeded")).toBe(true)
  const address = { conversationId: f.conversationId, runId: child.id }
  await expect(
    f.runtime.worktrees.detail(
      f.store,
      { ...address, conversationId: "wrong-conversation" },
      f.controller.signal
    )
  ).rejects.toThrow()
  const detail = await f.runtime.worktrees.detail(f.store, address, f.controller.signal)
  expect(detail.patch).toContain("+isolated evidence")
  const merge = {
    ...address,
    nonce: "reviewed-merge",
    expectedHeadCommit: detail.worktree.headCommit!
  }
  expect(await f.runtime.worktrees.merge(f.store, merge, f.controller.signal)).toMatchObject({
    status: "merged"
  })
  expect(await f.runtime.worktrees.merge(f.store, merge, f.controller.signal)).toMatchObject({
    status: "merged"
  })
  await expect(
    f.runtime.worktrees.merge(
      f.store,
      { ...merge, expectedHeadCommit: record.baseCommit },
      f.controller.signal
    )
  ).rejects.toThrow("标识")
  expect(await readFile(join(f.project, "result.txt"), "utf8")).toBe("isolated evidence\n")
}, 30_000)

it("executes a model-authored workflow through the real Bot tool, isolated engine, model children and durable result", async () => {
  const script =
    'export const meta={name:"Review",description:"Review project"}; return await parallel([() => agent("Check A", {agentType:"Explore", schema:{type:"object",properties:{checked:{type:"string"}},required:["checked"]}}), () => agent("Check B", {agentType:"Explore", schema:{type:"object",properties:{checked:{type:"string"}},required:["checked"]}})]);'
  const f = await fixture((body) => {
    const parent = body.tools.some((tool) => tool.function.name === "workflow")
    const hasResult = body.messages.some((message) => message.role === "tool")
    if (parent)
      return hasResult
        ? { content: "Both tasks returned verified results." }
        : call("workflow", { script, maxConcurrency: 2, tokenBudget: 50_000 }, "workflow-call")
    if (!hasResult) return call("project_read", { path: "app.ts" }, "read")
    return call("structured_output", { checked: "app.ts" }, "structured")
  }, true)
  const content = await f.runtime.execute(f.request)
  expect(content).toBe("Both tasks returned verified results.")
  const calls = f.store.db.exec("SELECT consumed,reserved FROM bot_workflow_model_calls")[0].values
  expect(calls).toHaveLength(6) // Two parent calls and four child calls share the root pool.
  expect(calls.every(([used]) => used === 12)).toBe(true)
  const rows = f.store.db.exec("SELECT status FROM bot_runs WHERE source='workflow-child'")[0]
    .values
  expect(rows).toEqual([["succeeded"], ["succeeded"]])
  const saved = f.store.db.exec(
    "SELECT state FROM bot_workflows WHERE invocation='workflow-call'"
  )[0].values[0][0]
  expect(JSON.parse(String(saved))).toMatchObject({
    status: "completed",
    result: [{ checked: "app.ts" }, { checked: "app.ts" }]
  })
  expect(f.store.finish(f.parent.lease, "succeeded", content).status).toBe("succeeded")
}, 20_000)

it("dispatches background tasks while the parent continues and delivers both results before final completion", async () => {
  let parentRead = false
  const f = await fixture((body) => {
    const assigned = body.messages.find((message) => message.role === "user")?.content
    if (assigned === "Background A" || assigned === "Background B") {
      expect(body.tools?.some((item) => item.function.name === "dispatch_task")).toBe(false)
      return body.messages.some((message) => message.role === "tool")
        ? { content: `Evidence from ${assigned}` }
        : call("ask_user", { prompt: `Hold ${assigned}` }, "child-question")
    }
    const results = body.messages.filter(
      (message) =>
        message.role === "user" && String(message.content).includes("[Background workflow result")
    )
    if (results.length === 2) return { content: "Consolidated A and B evidence" }
    if (!body.messages.some((message) => message.tool_call_id === "dispatch-a"))
      return call(
        "dispatch_task",
        { prompt: "Background A", label: "A", agentType: "Explore" },
        "dispatch-a"
      )
    if (!body.messages.some((message) => message.tool_call_id === "dispatch-b"))
      return call(
        "dispatch_task",
        { prompt: "Background B", label: "B", agentType: "Explore" },
        "dispatch-b"
      )
    if (!body.messages.some((message) => message.tool_call_id === "parent-read"))
      return call("project_read", { path: "app.ts" }, "parent-read")
    parentRead = true
    return { content: "Parent preliminary findings" }
  }, true)
  let finished = false
  const running = f.runtime.execute(f.request).then((value) => {
    finished = true
    return value
  })
  for (let i = 0; i < 200; i++) {
    if (
      parentRead &&
      f.store.snapshot().interactions.filter((item) => item.status === "pending").length === 2
    )
      break
    await delay(20)
  }
  expect(parentRead).toBe(true)
  expect(finished).toBe(false)
  const cards = f.store.snapshot().interactions.filter((item) => item.status === "pending")
  expect(cards).toHaveLength(2)
  expect(f.store.workflowChildren.list(f.parent.run.id)).toHaveLength(2)
  f.store.answerInteraction({ id: cards[0].id, revision: cards[0].revision, answer: "Proceed A" })
  for (
    let i = 0;
    i < 100 &&
    !f.requests.some((body) =>
      body.messages.some((message) =>
        String(message.content).includes("[Background workflow result")
      )
    );
    i++
  )
    await delay(20)
  expect(finished).toBe(false)
  f.store.answerInteraction({ id: cards[1].id, revision: cards[1].revision, answer: "Proceed B" })
  expect(await running).toBe("Consolidated A and B evidence")
  expect(f.store.workflowChildren.outstanding(f.parent.run.id)).toEqual([])
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_background_workflows WHERE receipt IS NOT NULL")[0]
      .values[0][0]
  ).toBe(2)
  const completed = f.store.finish(f.parent.lease, "succeeded", "Consolidated A and B evidence")
  expect(completed.status).toBe("succeeded")
}, 20000)

it("lets the model inspect, steer and stop background children without impersonating human input", async () => {
  let childrenSeen = 0
  let ready!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const f = await fixture(
    async (body) => {
      const assigned = body.messages.find((message) => message.role === "user")?.content
      if (assigned === "Steer A" || assigned === "Stop B") {
        if (body.messages.some((message) => String(message.content).includes("CHECK_EDGE_CASE")))
          return { content: "A checked the edge case" }
        if (++childrenSeen === 2) ready()
        return call("ask_user", { prompt: `Waiting ${assigned}` }, "child-hold")
      }
      const result = (id: string) =>
        body.messages.find((message) => message.tool_call_id === id)?.content
      if (!result("dispatch-a"))
        return call("dispatch_task", { prompt: "Steer A", label: "A" }, "dispatch-a")
      if (!result("dispatch-b"))
        return call("dispatch_task", { prompt: "Stop B", label: "B" }, "dispatch-b")
      await bothStarted
      if (!result("inspect-a"))
        return call(
          "check_task",
          { workflow_id: JSON.parse(String(result("dispatch-a"))).workflowId },
          "inspect-a"
        )
      if (!result("steer-a"))
        return call(
          "message_task",
          {
            run_id: JSON.parse(String(result("inspect-a")))[0].children[0].id,
            message: "CHECK_EDGE_CASE"
          },
          "steer-a"
        )
      if (!result("inspect-b"))
        return call(
          "check_task",
          { workflow_id: JSON.parse(String(result("dispatch-b"))).workflowId },
          "inspect-b"
        )
      if (!result("stop-b"))
        return call(
          "stop_task",
          { run_id: JSON.parse(String(result("inspect-b")))[0].children[0].id },
          "stop-b"
        )
      const receipts = body.messages.filter(
        (message) =>
          message.role === "user" && String(message.content).includes("[Background workflow result")
      )
      return {
        content: receipts.length === 2 ? "A updated; B stopped" : "Awaiting task settlement"
      }
    },
    true,
    64000
  )
  expect(await f.runtime.execute(f.request)).toBe("A updated; B stopped")
  const children = f.store.workflowChildren.list(f.parent.run.id)
  expect(children.find((child) => child.label === "A")?.status).toBe("succeeded")
  expect(children.find((child) => child.label === "B")?.status).toBe("cancelled")
  const messages = f.store.messages(f.conversationId)
  expect(messages.filter((message) => message.sender === "user")).toHaveLength(1)
  const steering = messages.find((message) => message.text.includes("CHECK_EDGE_CASE"))!
  expect(steering.sender).toBe("bot")
  expect(steering.botId).toBe(f.request.bot.id)
  expect(f.store.steering.state(steering.id)?.state).toBe("accepted")
  expect(
    f.store.snapshot().interactions.some((interaction) => interaction.status === "pending")
  ).toBe(false)
}, 20000)

it("returns queued child IDs immediately and cancels the fifth task before any model or file action", async () => {
  const f = await fixture(
    (body) => {
      const assigned = String(body.messages.find((message) => message.role === "user")?.content)
      if (assigned.startsWith("Queued child "))
        return body.messages.some((message) => message.role === "tool")
          ? { content: `Evidence ${assigned}` }
          : call("ask_user", { prompt: assigned }, "hold-child")
      for (let index = 0; index < 5; index++) {
        if (!body.messages.some((message) => message.tool_call_id === `dispatch-${index}`))
          return call(
            "dispatch_task",
            { prompt: `Queued child ${index}`, label: `Child ${index}` },
            `dispatch-${index}`
          )
      }
      if (!body.messages.some((message) => message.tool_call_id === "cancel-queued")) {
        const receipt = body.messages.find((message) => message.tool_call_id === "dispatch-4")!
        return call(
          "stop_task",
          { run_id: JSON.parse(String(receipt.content)).runId },
          "cancel-queued"
        )
      }
      const receipts = body.messages.filter(
        (message) =>
          message.role === "user" && String(message.content).includes("[Background workflow result")
      )
      return {
        content:
          receipts.length === 5
            ? "Four completed, fifth cancelled before dispatch"
            : "Waiting for active children"
      }
    },
    true,
    64000
  )
  const running = f.runtime.execute(f.request)
  for (let i = 0; i < 250; i++) {
    if (
      f.store.workflowChildren.list(f.parent.run.id).find((child) => child.label === "Child 4")
        ?.status === "cancelled" &&
      f.store.snapshot().interactions.length === 4
    )
      break
    await delay(20)
  }
  const children = f.store.workflowChildren.list(f.parent.run.id)
  expect(children).toHaveLength(5)
  const cancelled = children.find((child) => child.label === "Child 4")!
  expect(cancelled.status).toBe("cancelled")
  expect(f.store.getRun(cancelled.id).fence).toBe(0)
  expect(f.store.getRun(cancelled.id).checkpoint).toBeNull()
  expect(f.store.effects(cancelled.id)).toEqual([])
  for (const card of f.store.snapshot().interactions)
    if (card.status === "pending")
      f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "Proceed" })
  expect(await running).toBe("Four completed, fifth cancelled before dispatch")
  expect(
    f.requests.some((body) =>
      body.messages.some(
        (message) => message.role === "user" && message.content === "Queued child 4"
      )
    )
  ).toBe(false)
  expect(f.store.workflowChildren.outstanding(f.parent.run.id)).toEqual([])
}, 20000)

it("joins background cleanup when the user cancels a parent waiting for its child", async () => {
  const f = await fixture((body) => {
    const assigned = body.messages.find((message) => message.role === "user")?.content
    if (assigned === "Wait until cancelled") return call("ask_user", { prompt: "Wait" }, "hold")
    return body.messages.some((message) => message.tool_call_id === "dispatch-wait")
      ? { content: "Waiting for child" }
      : call("dispatch_task", { prompt: "Wait until cancelled", label: "Wait" }, "dispatch-wait")
  }, true)
  const running = f.runtime.execute(f.request)
  for (
    let i = 0;
    i < 150 && !f.store.snapshot().interactions.some((card) => card.status === "pending");
    i++
  )
    await delay(20)
  expect(f.store.snapshot().interactions.some((card) => card.status === "pending")).toBe(true)
  f.store.cancel(f.parent.run.id)
  f.controller.abort(new Error("User cancelled"))
  await expect(running).rejects.toThrow()
  expect(f.store.workflowChildren.outstanding(f.parent.run.id)).toEqual([])
  expect(f.store.workflowChildren.list(f.parent.run.id)[0].status).toBe("cancelled")
  expect(f.store.snapshot().interactions.some((card) => card.status === "pending")).toBe(false)
  expect(f.store.finish(f.parent.lease, "cancelled", "User cancelled").status).toBe("cancelled")
}, 20000)

it.each([false, true])(
  "recovers pending child steering through the original checkpoint without replaying its completed sibling (bootstrap interrupted: %s)",
  async (interruptBootstrap) => {
    let readReady!: () => void
    const readRequested = new Promise<void>((resolve) => {
      readReady = resolve
    })
    let releaseRead!: () => void
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let resumed = false
    const f = await fixture(async (body) => {
      const assigned = body.messages.find((message) => message.role === "user")?.content
      if (assigned === "Assigned task 0")
        return body.messages.some((message) => message.tool_call_id === "write-sibling-once")
          ? { content: "WRITE_COMPLETED" }
          : call(
              "project_edit",
              {
                path: "completed.txt",
                expected_sha256: null,
                content: "written exactly once"
              },
              "write-sibling-once"
            )
      if (body.messages.some((message) => message.tool_call_id === "read-before-crash")) {
        if (!resumed) {
          readReady()
          await heldRead
        }
        return { content: "READ_COMPLETED" }
      }
      return call("project_read", { path: "app.ts" }, "read-before-crash")
    })
    const approvalTimer = setInterval(() => {
      for (const item of f.store.snapshot().interactions) {
        if (item.status !== "pending") continue
        if (!JSON.parse(item.prompt).project) continue
        f.store.answerInteraction({ id: item.id, revision: item.revision, answer: "approve" })
      }
    }, 10)
    cleanup.push(() => clearInterval(approvalTimer))
    const completed = await f.runner(f.input(0))
    expect(completed.text).toBe("WRITE_COMPLETED")
    const writeChild = f.store.workflowChildren.list(f.parent.run.id)[0]
    const originalEffects = f.store.effects(writeChild.id)
    expect(originalEffects).toMatchObject([{ status: "succeeded" }])
    const running = f.runner(f.input(1))
    const interrupted = expect(running).rejects.toThrow()
    await readRequested
    const readChild = f.store.workflowChildren
      .list(f.parent.run.id)
      .find((child) => child.id !== writeChild.id)!
    const originalCheckpoint = f.store.getRun(readChild.id).checkpoint
    expect(originalCheckpoint).not.toBeNull()
    const control = {
      conversationId: f.conversationId,
      runId: readChild.id,
      nonce: "pending-child-instruction",
      revision: f.store.getRun(readChild.id).revision,
      operation: "message" as const,
      text: "RECOVERY_STEER_PRESERVED: report the read evidence."
    }
    const instruction = f.store.controlWorkflowChild(control)
    expect(f.store.controlWorkflowChild(control)).toEqual(instruction)
    expect(f.store.steering.state(instruction.messageId!)?.state).toBe("pending")
    f.store.fenceOwner("host", "source Runtime recovery boundary")
    f.controller.abort(new Error("original executor stopped"))
    releaseRead()
    await interrupted
    resumed = true
    const restore = (owner: string) => {
      for (const id of [readChild.id, f.parent.run.id]) {
        const run = f.store.getRun(id)
        expect(run.status).toBe("needs_review")
        f.store.recover({
          id,
          revision: run.revision,
          decision: "resume",
          note: "Reviewed original task",
          effects: []
        })
      }
      const parent = f.store.claim(owner)!
      const workflow = BotWorkflowStore.open(f.store, parent.lease, "workflow", {
        script:
          'export const meta={name:"Review",description:"Review"}; return await agent("task");',
        maxConcurrency: 2,
        defaultModelId: "test",
        agentProfiles: [],
        authority: { project: f.project }
      })
      const controller = new AbortController()
      cleanup.push(() => controller.abort())
      const request = { ...f.request, ...parent, signal: controller.signal }
      const runner = botWorkflowChildRunner(request, workflow, (input) => f.runtime.execute(input))
      return { parent, controller, runner }
    }
    let current = restore("recovered-host")
    const beforeRequests = f.requests.length
    if (interruptBootstrap) {
      const originalRead = BotLocalToolGate.prototype.read
      let bootstrapStopped = false
      const read = vi.spyOn(BotLocalToolGate.prototype, "read").mockImplementation(async function (
        this: BotLocalToolGate,
        signal
      ) {
        if (
          !bootstrapStopped &&
          f.store.steering.state(instruction.messageId!)?.state === "accepted"
        ) {
          bootstrapStopped = true
          f.store.fenceOwner(current.parent.lease.owner, "accepted input not checkpointed yet")
          current.controller.abort(new Error("bootstrap executor stopped"))
          throw current.controller.signal.reason
        }
        return originalRead.call(this, signal)
      })
      try {
        await expect(
          current.runner({ ...f.input(1), signal: current.controller.signal })
        ).rejects.toThrow("bootstrap executor stopped")
        expect(bootstrapStopped).toBe(true)
        expect(f.store.getRun(readChild.id).checkpoint).toBe(originalCheckpoint)
        expect(f.store.steering.state(instruction.messageId!)?.state).toBe("accepted")
        expect(f.requests).toHaveLength(beforeRequests)
      } finally {
        read.mockRestore()
      }
      current = restore("second-recovered-host")
    }
    const replayedWrite = await current.runner({ ...f.input(0), signal: current.controller.signal })
    expect(replayedWrite).toEqual(completed)
    expect(f.requests).toHaveLength(beforeRequests)
    const policy = f.store.localTools.read()
    f.store.localTools.change({
      nonce: "recover-with-original-ask-policy",
      targetId: policy.target.id,
      dataEpoch: policy.dataEpoch,
      revision: policy.revision,
      choice: "ask"
    })
    const executing = current.runner({ ...f.input(1), signal: current.controller.signal })
    void executing.catch(() => {})
    await Promise.race([
      executing,
      vi.waitFor(() =>
        expect(
          f.store
            .snapshot()
            .interactions.some(
              (item) =>
                item.runId === readChild.id && item.status === "pending" && item.localProjectAccess
            )
        ).toBe(true)
      )
    ])
    expect(f.requests).toHaveLength(beforeRequests)
    expect(f.store.steering.state(instruction.messageId!)?.state).toBe("accepted")
    expect(f.store.getRun(readChild.id).checkpoint).toBe(originalCheckpoint)
    const access = await createTestLocalProjectAccess({
      workspace: f.project,
      runId: readChild.id,
      readProject: true
    })
    await access.snapshot({
      snapshot: async () => f.store.snapshot(),
      resolve: async (input) => f.store.localTools.resolve(input)
    })
    expect(f.store.localTools.read().choice).toBe("ask")
    const result = await executing
    expect(result.text).toBe("READ_COMPLETED")
    expect(
      f.store.workflowChildren
        .list(f.parent.run.id)
        .map((child) => child.id)
        .sort()
    ).toEqual([writeChild.id, readChild.id].sort())
    expect(
      f.store.workflowChildren.list(f.parent.run.id).every((child) => child.status === "succeeded")
    ).toBe(true)
    expect(f.store.steering.state(instruction.messageId!)?.state).toBe("accepted")
    expect(f.requests).toHaveLength(beforeRequests + 1)
    const messages = f.requests.at(-1)!.messages
    expect(
      messages.filter((message) => String(message.content).includes("RECOVERY_STEER_PRESERVED"))
    ).toHaveLength(1)
    expect(
      messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "read-before-crash"
      )
    ).toBe(true)
    expect(f.store.effects(writeChild.id)).toEqual(originalEffects)
    expect(await readFile(join(f.project, "completed.txt"), "utf8")).toBe("written exactly once")
    const child = f.store.getRun(readChild.id)
    const saved = await new BotCheckpointSaver(
      f.store,
      { runId: child.id, owner: current.parent.lease.owner, fence: child.fence },
      child.id
    ).getTuple({ configurable: { thread_id: child.id } })
    expect(saved!.checkpoint.channel_values.cmbCurrentRunMessageIds).toContain(
      instruction.messageId
    )
    expect(
      f.store.db.exec("SELECT followup_run_id FROM bot_steering WHERE message_id=?", [
        instruction.messageId!
      ])[0].values[0][0]
    ).toBeNull()
  }
)

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "runs a trusted browser child through the original background graph, approval and waiting path",
  async () => {
    const website = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        "<html><head><title>Child approved website</title></head><body><p>APPROVED_CHILD_PAGE</p></body></html>"
      )
    })
    await new Promise<void>((done) => website.listen(0, "127.0.0.1", done))
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          website.closeAllConnections()
          website.close(() => done())
        })
    )
    const websiteUrl = `http://127.0.0.1:${(website.address() as { port: number }).port}/`
    const f = await fixture((body) => {
      const assigned = body.messages.find((message) => message.role === "user")?.content
      if (assigned === "Read separate browser evidence") {
        expect(body.tools?.some((item) => item.function.name === "browser")).toBe(true)
        expect(body.tools?.some((item) => item.function.name === "execute")).toBe(false)
        expect(body.tools?.some((item) => item.function.name === "project_read")).toBe(false)
        expect(JSON.stringify(body.messages)).not.toContain("PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT")
        expect(JSON.stringify(body.messages)).not.toContain("PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED")
        if (!body.messages.some((message) => message.tool_call_id === "child-browser-navigation"))
          return call(
            "browser",
            { op: "navigate", arguments_json: JSON.stringify({ url: websiteUrl }) },
            "child-browser-navigation"
          )
        if (!body.messages.some((message) => message.tool_call_id === "child-browser-snapshot"))
          return call("browser", { op: "snapshot", arguments_json: "{}" }, "child-browser-snapshot")
        if (!body.messages.some((message) => message.tool_call_id === "child-human-step"))
          return call(
            "ask_user",
            { prompt: "Review this task browser and continue" },
            "child-human-step"
          )
        if (!body.messages.some((message) => message.tool_call_id === "child-fresh-snapshot"))
          return call("browser", { op: "snapshot", arguments_json: "{}" }, "child-fresh-snapshot")
        return { content: "BROWSER_CHILD_EVIDENCE" }
      }
      if (
        body.messages.some(
          (message) =>
            message.role === "user" &&
            String(message.content).includes("[Background workflow result")
        )
      )
        return { content: "PARENT_CONSOLIDATED_BROWSER_EVIDENCE" }
      if (!body.messages.some((message) => message.tool_call_id === "dispatch-browser"))
        return call(
          "dispatch_task",
          { prompt: "Read separate browser evidence", label: "Web evidence", taskType: "browser" },
          "dispatch-browser"
        )
      return { content: "Parent continues while browser task waits" }
    }, true)
    f.computer.persistence = f.store
    let finished = false
    const running = f.runtime.execute(f.request).then((value) => {
      finished = true
      return value
    })
    cleanup.push(async () => {
      f.controller.abort()
      await running.catch(() => {})
    })
    try {
      await expect
        .poll(
          () => f.store.snapshot().interactions.find((item) => item.status === "pending")?.kind,
          {
            timeout: 5000
          }
        )
        .toBe("approval")
    } catch (error) {
      // Capture only existing state before cleanup aborts children or closes SQLite.
      // These reads must never call get/ensure, open a target or start a browser.
      try {
        const safeText = (value: string | null) =>
          value === null
            ? null
            : safeBotErrorText(value, 2000, [
                "test-only",
                f.root,
                "PRIVATE_BOT_DUTIES_NOT_CHILD_CONTEXT",
                "PARENT_PRIVATE_CONTEXT_NOT_ASSIGNED"
              ])
        const runs = [
          f.parent.run.id,
          ...f.store.workflowChildren.list(f.parent.run.id).map(({ id }) => id)
        ]
          .map((id) => f.store.getRun(id))
          .map((run) => ({
            id: run.id,
            parentRunId: run.parentRunId,
            source: run.source,
            status: run.status,
            fence: run.fence,
            leaseUntil: run.leaseUntil,
            waitingForComputer: run.waitingForComputer === true,
            activityKind: run.activity?.kind,
            error: safeText(run.error)
          }))
        console.error(
          "[BotWorkflowBrowserChildApprovalFailure]",
          JSON.stringify({
            parentGraphFinished: finished,
            runs,
            requests: f.requests.slice(0, 64).map((body, index) => ({
              index,
              messageCount: body.messages.length,
              offeredToolNames: body.tools.map((item) => item.function.name),
              assistantToolNames: body.messages
                .filter((message) => message.role === "assistant")
                .flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls : []))
                .map((call) => call?.function?.name)
                .filter((name): name is string => typeof name === "string")
            })),
            provider: f.computer.status(),
            restartBlockedReason: safeText(f.computer.restartBlockedReason)
          })
        )
      } catch (diagnosticError) {
        console.error(
          "[BotWorkflowBrowserChildApprovalDiagnosticFailure]",
          safeBotErrorText(String(diagnosticError), 2000, ["test-only", f.root])
        )
      }
      throw error
    }
    const navigationApproval = f.store
      .snapshot()
      .interactions.find((item) => item.status === "pending")!
    expect(navigationApproval.runId).not.toBe(f.parent.run.id)
    f.store.answerInteraction({
      id: navigationApproval.id,
      revision: navigationApproval.revision,
      answer: "approve"
    })
    await expect
      .poll(() => f.store.snapshot().interactions.find((item) => item.status === "pending")?.kind, {
        timeout: 5000
      })
      .toBe("question")
    const card = f.store.snapshot().interactions.find((item) => item.status === "pending")!
    const child = f.store.getRun(card.runId)
    expect(child.status).toBe("waiting_input")
    expect(child.parentRunId).toBe(f.parent.run.id)
    expect(finished).toBe(false)
    const broker = await f.computer.get()
    const target = broker.target(f.request.bot.id, child.id)
    const client = new AbortController().signal
    const held = await broker.takeControl(target, f.conversationId, undefined, client)
    const frame = await broker.frame(f.request.bot.id, client, child.id)
    expect(frame.taskRunId).toBe(child.id)
    expect(frame.title).toBe("Child approved website")
    expect(f.store.effects(child.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `browser:${child.id}:child-browser-navigation`,
          status: "succeeded"
        })
      ])
    )
    expect(frame.controlOwner).toBe("self")
    f.store.answerInteraction({
      id: card.id,
      revision: card.revision,
      answer: "Continue after handback"
    })
    await expect
      .poll(
        () =>
          f.requests.filter(
            (body) =>
              body.messages.find((message) => message.role === "user")?.content ===
              "Read separate browser evidence"
          ).length
      )
      .toBe(4)
    expect(f.store.getRun(child.id).status).toBe("waiting_input")
    await broker.releaseControl(held, client)
    expect(await running).toBe("PARENT_CONSOLIDATED_BROWSER_EVIDENCE")
    expect(f.store.getRun(child.id).status).toBe("succeeded")
    expect(f.store.workflowChildren.outstanding(f.parent.run.id)).toEqual([])
    expect(
      f.store.db.exec("SELECT COUNT(*) FROM bot_background_workflows WHERE receipt IS NOT NULL")[0]
        .values[0][0]
    ).toBe(1)
    expect(
      f.store.db.exec("SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?", [
        child.id
      ])[0].values[0][0]
    ).not.toBeNull()
    const terminalFrame = await broker.frame(f.request.bot.id, client, child.id)
    expect(terminalFrame.taskRunId).toBe(child.id)
    await expect(
      broker.takeControl(terminalFrame, f.conversationId, undefined, client)
    ).rejects.toMatchObject({ code: "workflow_browser_inactive" })
  },
  30_000
)

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1").each([false, true])(
  "dispatches a pure browser child from an authenticated Bot with no configured project through the real Host queue (recover original checkpoint: %s)",
  async (recoverOriginal) => {
    const f = await fixture(
      (body) => {
        const assigned = body.messages.find((message) => message.role === "user")?.content
        if (assigned === "PURE_BROWSER_CHILD") {
          if (!body.messages.some((message) => message.tool_call_id === "pure-browser-snapshot"))
            return call(
              "browser",
              { op: "snapshot", arguments_json: "{}" },
              "pure-browser-snapshot"
            )
          if (!body.messages.some((message) => message.tool_call_id === "pure-browser-question"))
            return call(
              "ask_user",
              { prompt: "Review the standalone browser task" },
              "pure-browser-question"
            )
          if (!body.messages.some((message) => message.tool_call_id === "pure-browser-fresh"))
            return call("browser", { op: "snapshot", arguments_json: "{}" }, "pure-browser-fresh")
          return { content: "PURE_BROWSER_CHILD_COMPLETE" }
        }
        if (
          body.messages.some(
            (message) =>
              message.role === "user" &&
              String(message.content).includes("[Background workflow result")
          )
        )
          return { content: "PURE_BROWSER_PARENT_COMPLETE" }
        if (!body.tools?.some((item) => item.function.name === "dispatch_task"))
          return { content: "DISPATCH_UNAVAILABLE" }
        if (!body.messages.some((message) => message.tool_call_id === "pure-browser-dispatch"))
          return call(
            "dispatch_task",
            { prompt: "PURE_BROWSER_CHILD", label: "Standalone web task", taskType: "browser" },
            "pure-browser-dispatch"
          )
        return { content: "Parent waits for the independent browser" }
      },
      true,
      DEFAULT_MAX_TOKENS,
      undefined,
      true
    )
    let computer = f.computer
    let runtime = f.runtime
    computer.persistence = f.store
    const lock = BotHostLock.acquire(f.root)!
    cleanup.push(() => lock.release())
    let host = new BotHost(f.store, runtime, 1, computer)
    host.bindOwnership(lock)
    f.store.localTools.bind(createBotLocalToolAuthority(f.root, lock))
    expect(f.store.localTools.read().effective).toBe("ask")
    cleanup.push(() => host.stop())
    const token = randomBytes(32).toString("hex"),
      socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\cmb-browser-child-runtime-${randomBytes(12).toString("hex")}`
          : join(f.root, "browser-rpc.sock")
    let server = new BotRpcServer(host, token)
    await server.listen(socketPath)
    cleanup.push(() => server.close())
    let client = new BotTransportClient({
      version: 1,
      pid: process.pid,
      hostId: host.id,
      socketPath,
      token
    })
    cleanup.push(() => client.closeAndWait())
    const { bot, conversationId } = await client.call("create", {
      nonce: "no-project",
      name: "Browser only"
    })
    expect(bot.workspacePath).toBeNull()
    const receipt = await client.call("send", {
      nonce: "pure-browser-work",
      conversationId,
      text: "PURE_BROWSER_GOAL"
    })
    expect(receipt.runIds).toHaveLength(1)
    const parentRunId = receipt.runIds[0]
    host.start()
    await expect
      .poll(
        () =>
          f.store.workflowChildren.list(parentRunId).length > 0 ||
          f.store.getRun(parentRunId).status === "succeeded",
        { timeout: 5000 }
      )
      .toBe(true)
    const children = f.store.workflowChildren.list(parentRunId)
    expect(children).toHaveLength(1)
    const child = children[0],
      address = { conversationId, runId: child.id }
    await expect
      .poll(
        () =>
          f.store
            .snapshot()
            .interactions.find((item) => item.runId === child.id && item.status === "pending")
            ?.kind,
        { timeout: 5000 }
      )
      .toBe("question")
    const frame = await client.call("computerFrame", address)
    expect(frame.taskRunId).toBe(child.id)
    let held = await client.call("computerTake", frame)
    if (recoverOriginal) {
      // This is a real SQLite lease/Runtime checkpoint recovery boundary in one
      // OS process, not a claim of an operating-system SIGKILL or lock handoff.
      const originalCheckpoint = f.store.getRun(child.id).checkpoint
      expect(originalCheckpoint).not.toBeNull()
      const originalWorkflow = f.store.db.exec(
        "SELECT id,fingerprint FROM bot_workflows WHERE run_id=?",
        [parentRunId]
      )[0].values
      const originalEffects = f.store.effects(child.id)
      const originalToolReceipts =
        f.store.db.exec(
          "SELECT nonce,request_hash,response FROM bot_receipts WHERE nonce LIKE ? ORDER BY nonce",
          [`tool:${parentRunId}:%`]
        )[0]?.values ?? []
      f.store.fenceOwner(host.id, "Reviewed standalone browser recovery boundary")
      const active = Reflect.get(host, "active") as Map<
        string,
        { abort: AbortController; completion: Promise<void> }
      >
      for (const entry of active.values()) entry.abort.abort(new Error("original executor stopped"))
      await Promise.allSettled([...active.values()].map((entry) => entry.completion))
      expect(f.store.getRun(parentRunId).status).toBe("needs_review")
      expect(f.store.getRun(child.id).status).toBe("needs_review")
      expect(f.store.getRun(child.id).checkpoint).toBe(originalCheckpoint)
      await client.closeAndWait()
      await server.close()
      await host.stop()
      await computer.close()
      computer = new LocalBotComputerProvider(join(f.root, "browser"))
      computer.persistence = f.store
      cleanup.push(() => computer.close())
      runtime = new CmbBotRuntime(f.modelFile, computer, f.runtimeOptions)
      cleanup.push(() => runtime.functionSessions.close())
      host = new BotHost(f.store, runtime, 1, computer)
      host.bindOwnership(lock)
      server = new BotRpcServer(host, token)
      const recoveredSocket =
        process.platform === "win32"
          ? `\\\\.\\pipe\\cmb-browser-child-recovered-${randomBytes(12).toString("hex")}`
          : join(f.root, "recovered-browser-rpc.sock")
      await server.listen(recoveredSocket)
      client = new BotTransportClient({
        version: 1,
        pid: process.pid,
        hostId: host.id,
        socketPath: recoveredSocket,
        token
      })
      for (const id of [child.id, parentRunId]) {
        const run = f.store.getRun(id)
        await client.call("recover", {
          id,
          revision: run.revision,
          decision: "resume",
          note: "Reviewed original browser task; no unknown effects",
          effects: []
        })
      }
      host.start()
      await expect
        .poll(
          () =>
            f.store
              .snapshot()
              .interactions.find((item) => item.runId === child.id && item.status === "pending")
              ?.kind,
          { timeout: 5000 }
        )
        .toBe("question")
      expect(f.store.workflowChildren.list(parentRunId).map((item) => item.id)).toEqual([child.id])
      expect(
        f.store.db.exec("SELECT id,fingerprint FROM bot_workflows WHERE run_id=?", [parentRunId])[0]
          .values
      ).toEqual(originalWorkflow)
      expect(f.store.effects(child.id)).toEqual(originalEffects)
      expect(
        f.store.db.exec(
          "SELECT nonce,request_hash,response FROM bot_receipts WHERE nonce LIKE ? ORDER BY nonce",
          [`tool:${parentRunId}:%`]
        )[0]?.values ?? []
      ).toEqual(originalToolReceipts)
      const recoveredFrame = await client.call("computerFrame", address)
      expect(recoveredFrame.taskRunId).toBe(child.id)
      expect(recoveredFrame.control).toBe("human")
      await expect(client.call("computerTake", recoveredFrame)).rejects.toMatchObject({
        code: "computer_owned_elsewhere"
      })
      held = await client.call("computerTake", { ...recoveredFrame, replaceHuman: true })
    }
    const card = f.store
      .snapshot()
      .interactions.find((item) => item.runId === child.id && item.status === "pending")!
    f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "Reviewed" })
    await expect
      .poll(() => f.store.getRun(child.id).status, { timeout: 3000 })
      .toBe("waiting_input")
    await client.call("computerRelease", held)
    await expect.poll(() => f.store.getRun(parentRunId).status, { timeout: 5000 }).toBe("succeeded")
    expect(f.store.getRun(parentRunId).result).toBe("PURE_BROWSER_PARENT_COMPLETE")
    expect(f.store.getRun(child.id).status).toBe("succeeded")
    expect(f.store.getBot(bot.id).workspacePath).toBeNull()
    expect(
      f.requests
        .filter(
          (body) =>
            body.messages.find((message) => message.role === "user")?.content ===
            "PURE_BROWSER_CHILD"
        )
        .every(
          (body) =>
            !body.tools?.some((item) =>
              ["project_read", "execute", "project_edit", "project_write"].includes(
                item.function.name
              )
            )
        )
    ).toBe(true)
    expect(
      f.store.db.exec("SELECT COUNT(*) FROM bot_local_tool_requests WHERE run_id IN (?,?)", [
        parentRunId,
        child.id
      ])[0].values[0][0]
    ).toBe(0)
    expect((await client.call("runHistory", address)).hasBrowser).toBe(true)
  },
  30000
)

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "exposes and executes native selection in an independently owned browser child model graph",
  async () => {
    const website = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        '<select aria-label="Child choices" multiple onchange="document.getElementById(\'result\').textContent=Array.from(this.selectedOptions,x=>x.value).join(\',\')"><option value="a">Alpha</option><option value="b">Beta</option></select><p id="result">none</p>'
      )
    })
    await new Promise<void>((done) => website.listen(0, "127.0.0.1", done))
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          website.closeAllConnections()
          website.close(() => done())
        })
    )
    const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`
    const f = await fixture((body) => {
      const assigned = body.messages.find((message) => message.role === "user")?.content
      if (assigned === "Select the browser child choices") {
        const tool = (id: string) => body.messages.find((message) => message.tool_call_id === id)
        if (!tool("child-selection-nav"))
          return call(
            "browser",
            { op: "navigate", arguments_json: JSON.stringify({ url }) },
            "child-selection-nav"
          )
        if (!tool("child-selection-snapshot"))
          return call(
            "browser",
            { op: "snapshot", arguments_json: "{}" },
            "child-selection-snapshot"
          )
        const snapshot = JSON.parse(String(tool("child-selection-snapshot")!.content))
          .data as string
        const ref = /Child choices[^\n]*?ref=(e\d+)/.exec(snapshot)![1]
        if (!tool("child-selection-input"))
          return call(
            "browser",
            {
              op: "select_option",
              arguments_json: JSON.stringify({
                ref,
                values: ["a", "b"],
                element: "Select the two child choices"
              })
            },
            "child-selection-input"
          )
        if (!tool("child-selection-evidence"))
          return call(
            "browser",
            { op: "snapshot", arguments_json: "{}" },
            "child-selection-evidence"
          )
        return { content: "CHILD_SELECTION_EVIDENCE" }
      }
      if (
        body.messages.some(
          (message) =>
            message.role === "user" &&
            String(message.content).includes("[Background workflow result")
        )
      )
        return { content: "PARENT_SELECTION_COMPLETE" }
      if (!body.messages.some((message) => message.tool_call_id === "dispatch-selection"))
        return call(
          "dispatch_task",
          {
            prompt: "Select the browser child choices",
            label: "Native selection",
            taskType: "browser"
          },
          "dispatch-selection"
        )
      return { content: "Parent continues while child runs" }
    }, true)
    f.computer.persistence = f.store
    const running = f.runtime.execute(f.request)
    cleanup.push(async () => {
      f.controller.abort()
      await running.catch(() => {})
    })
    const cards: string[] = []
    for (let steps = 0; steps < 4; steps++) {
      await expect
        .poll(
          () =>
            f.store.snapshot().interactions.find((item) => item.status === "pending")?.id ??
            (f.store.workflowChildren.outstanding(f.parent.run.id).length === 0 && cards.length > 0
              ? "done"
              : undefined),
          { timeout: 5000 }
        )
        .toBeDefined()
      const card = f.store.snapshot().interactions.find((item) => item.status === "pending")
      if (!card) break
      expect(card.kind).toBe("approval")
      expect(card.runId).not.toBe(f.parent.run.id)
      cards.push(card.runId)
      f.store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
    }
    expect(await running).toBe("PARENT_SELECTION_COMPLETE")
    expect(cards).toHaveLength(2)
    const child = f.store.getRun(cards[0])
    expect(child.parentRunId).toBe(f.parent.run.id)
    expect(child.status).toBe("succeeded")
    const childRequests = f.requests.filter(
      (body) =>
        body.messages.find((message) => message.role === "user")?.content ===
        "Select the browser child choices"
    )
    const directory = childRequests[0].tools?.find((item) => item.function.name === "browser")
      ?.function.parameters as { properties: { op: { enum: string[] } } }
    for (const op of ["select_option", "drag", "mouse_click_xy", "highlight"])
      expect(directory.properties.op.enum).toContain(op)
    expect(
      String(
        childRequests
          .at(-1)!
          .messages.find((item) => item.tool_call_id === "child-selection-evidence")!.content
      )
    ).toContain("a,b")
    expect(f.store.effects(child.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `browser:${child.id}:child-selection-input`,
          status: "succeeded"
        })
      ])
    )
    expect(
      f.store.effects(f.parent.run.id).filter((item) => item.id.startsWith("browser:"))
    ).toEqual([])
    expect((await f.computer.get()).target(f.request.bot.id, child.id).taskRunId).toBe(child.id)
  },
  30_000
)
