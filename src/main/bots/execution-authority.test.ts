import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { botAutoReviewer } from "./auto-review"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { prepareBotWorkflow } from "./workflow-tool"
import { BotWorkflowStore } from "./workflow-store"
import { BotBackgroundWorkflows } from "./background-workflows"
import { BotDomainError } from "../../shared/bot-types"
import { createHash } from "node:crypto"
import { canonicalJson } from "./validation"
import { invalidateBotModelSnapshot } from "./model-config-fence"

vi.mock("../agent/agent-registry", () => ({ loadAgentProfilesAsync: async () => [] }))

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-execution-authority-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project")
  await mkdir(project)
  const modelFile = join(root, "host", "models.private")
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: "configured",
    models: [
      {
        id: "configured",
        ref: "configured",
        name: "Fixture",
        model: "fixture-model",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "fixture-only"
      }
    ],
    timezone: "Asia/Shanghai",
    graphRecursionLimit: 200,
    toolStrategy: "standard",
    failureFuse: { mode: "warn", userNoticeEnabled: true, modelFeedbackEnabled: false },
    workflowWorktreeTimeoutMinutes: 3,
    workflowWorktreeRemoveTimeoutMinutes: 1,
    execution: { resourceDirectory: root, windowsSandbox: "none" },
    mcpSources: []
  }
  await writeBotModelSnapshot(modelFile, snapshot)
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({
    nonce: "owner",
    name: "Developer",
    workspacePath: project
  })
  store.send({ nonce: "task", conversationId, text: "Review the project" })
  const claim = store.claim("host", 60_000)!
  const request = {
    ...claim,
    bot,
    store,
    messages: store.messagesForRun(claim.run.id),
    signal: new AbortController().signal
  }
  const reviewer = botAutoReviewer({
    request,
    modelFile,
    snapshot,
    config: snapshot.models[0],
    check: () => store.assertDispatch(claim.lease),
    scope: () => "fixture"
  })
  const prepare = () =>
    prepareBotWorkflow(
      { request, modelFile },
      {
        script: 'export const meta={name:"Review",description:"Inspect"}; return "checked";',
        maxConcurrency: 1
      }
    )
  return { request, store, path, modelFile, snapshot, reviewer, prepare }
}

const preferences: Partial<BotModelSnapshot>[] = [
  { timezone: "America/New_York" },
  { graphRecursionLimit: 321 },
  { toolStrategy: "shell-first-relaxed" },
  { failureFuse: { mode: "debug", userNoticeEnabled: false, modelFeedbackEnabled: true } },
  { workflowWorktreeTimeoutMinutes: 17 },
  { workflowWorktreeRemoveTimeoutMinutes: 4 }
]

it.each(preferences)(
  "keeps active review authority after a non-authorizing preference changes: %j",
  async (change) => {
    const f = await fixture()
    await f.reviewer.assertConfiguration()
    await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, ...change })
    await expect(f.reviewer.assertConfiguration()).resolves.toBeUndefined()
  }
)

it("recovers the same workflow and saved results after preferences change and SQLite reopens", async () => {
  const f = await fixture()
  const definition = await f.prepare()
  const first = BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", definition)
  first.appendJournal({
    index: 0,
    hash: "a".repeat(64),
    result: "original evidence",
    outputTokens: 1
  })
  await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, ...Object.assign({}, ...preferences) })
  const current = await f.prepare()
  f.store.close()
  const reopened = new BotStore(f.path)
  cleanup.push(() => reopened.close())
  const restored = BotWorkflowStore.open(reopened, f.request.lease, "workflow-one", current)
  expect(restored.id).toBe(first.id)
  expect(restored.state.journal.map((entry) => entry.result)).toEqual(["original evidence"])
  expect(reopened.db.exec("SELECT COUNT(*) FROM bot_workflows")[0].values[0][0]).toBe(1)
})

it.each([
  "model",
  "default-model",
  "sandbox",
  "connector",
  "instructions",
  "future-authority"
] as const)(
  "still rejects changed %s authority for both review and workflow replay",
  async (kind) => {
    const f = await fixture()
    BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", await f.prepare())
    const changed = structuredClone(f.snapshot)
    if (kind === "model") changed.models[0].apiKey = "revoked-fixture"
    else if (kind === "default-model") changed.defaultRef = "other"
    else if (kind === "sandbox") changed.execution!.windowsSandbox = "readonly"
    else if (kind === "instructions")
      changed.instructionSources = { agentsHome: join(f.path, "rules") }
    else if (kind === "connector")
      changed.mcpSources = [
        {
          kind: "connector",
          providerKey: "new-provider",
          providerDisplayName: "Fixture",
          visibility: "lazy",
          priority: 1,
          scope: "global",
          serverConfig: { type: "http", url: "http://127.0.0.1:1" }
        }
      ]
    else Object.assign(changed, { futureAuthority: { enabled: true } })
    await writeBotModelSnapshot(f.modelFile, changed)
    await expect(f.reviewer.assertConfiguration()).rejects.toMatchObject({
      code: "approval_required"
    })
    const next = await f.prepare()
    expect(() => BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", next)).toThrow(
      "不能重放"
    )
  }
)

it("never uses a stale snapshot while configuration publication is pending", async () => {
  const f = await fixture()
  invalidateBotModelSnapshot(f.modelFile)
  await expect(f.reviewer.assertConfiguration()).rejects.toThrow("配置正在同步")
  await expect(f.prepare()).rejects.toThrow("配置正在同步")
})

it("adopts an unchanged legacy workflow atomically, then permits preference changes", async () => {
  const f = await fixture()
  const current = await f.prepare()
  const old = {
    ...current,
    authority: {
      ...(current.authority as Record<string, unknown>),
      modelConfig: createHash("sha256").update(canonicalJson(f.snapshot)).digest("hex")
    }
  }
  delete old.legacyAuthority
  const legacy = BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", old)
  legacy.appendJournal({
    index: 0,
    hash: "b".repeat(64),
    result: "legacy evidence",
    outputTokens: 1
  })
  const adopted = BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", current)
  expect(adopted.id).toBe(legacy.id)
  expect(() =>
    legacy.appendJournal({ index: 1, hash: "c".repeat(64), result: "stale", outputTokens: 1 })
  ).toThrow("接替")
  await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, graphRecursionLimit: 500 })
  const recovered = BotWorkflowStore.open(
    f.store,
    f.request.lease,
    "workflow-one",
    await f.prepare()
  )
  expect(recovered.state.journal.map((entry) => entry.result)).toEqual(["legacy evidence"])
})

it("does not infer old permissions when a legacy workflow's original snapshot no longer matches", async () => {
  const f = await fixture()
  const current = await f.prepare()
  const old = { ...current, authority: current.legacyAuthority }
  delete old.legacyAuthority
  BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", old)
  await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, graphRecursionLimit: 500 })
  const changed = await f.prepare()
  expect(() => BotWorkflowStore.open(f.store, f.request.lease, "workflow-one", changed)).toThrow(
    "不能重放"
  )
})

it("restores interrupted background work under changed preferences without dispatching a second task", async () => {
  const f = await fixture()
  const initial = new BotBackgroundWorkflows(f.request, f.prepare, async () => {
    throw new BotDomainError("fixture_interrupted", "Interrupted before result delivery")
  })
  cleanup.push(() => initial.close())
  const original = initial.dispatch("background-one", await f.prepare())
  await initial.close()
  await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, ...Object.assign({}, ...preferences) })
  let executions = 0
  const recovered = new BotBackgroundWorkflows(f.request, f.prepare, async (workflow) => {
    executions++
    expect(workflow.id).toBe(JSON.parse(original).workflowId)
    return JSON.stringify({ workflowId: workflow.id, status: "completed", result: "resumed" })
  })
  cleanup.push(() => recovered.close())
  await recovered.restore()
  expect(recovered.dispatch("background-one", await f.prepare())).toBe(original)
  await recovered.close()
  expect(executions).toBe(1)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_workflows")[0].values[0][0]).toBe(1)
})
