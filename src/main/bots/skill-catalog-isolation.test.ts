import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { DEFAULT_MAX_TOKENS } from "../models/defaults"
import { BotHost } from "./host"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotSkillCatalogSync } from "./skill-catalog-sync"
import { BotSkillCatalogProcess } from "./skill-catalog-process"
import { writeBotModelSnapshot } from "./model-config"
import { createBotAPI } from "./rpc"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function settled(store: BotStore, runId: string) {
  for (let i = 0; i < 250; i++) {
    const run = store.getRun(runId)
    if (["succeeded", "failed", "needs_review"].includes(run.status)) return run
    await delay(20)
  }
  throw new Error("controlled skill task did not settle")
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-skill-isolation-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const requests: TestModelRequest[] = []
  let skillId = ""
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    requests.push(body)
    const read = body.messages.some((message) => message.role === "tool")
    const calls = [
      {
        id: "read-sqlite-skill",
        type: "function",
        index: 0,
        function: { name: "read_skill", arguments: JSON.stringify({ id: skillId }) }
      }
    ]
    response.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: `skill-fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    response.end(
      chunk(
        read
          ? { role: "assistant", content: "Skill read returned; awaiting human review." }
          : { role: "assistant", tool_calls: calls },
        null
      ) +
        chunk({}, read ? "stop" : "tool_calls") +
        "data: [DONE]\n\n"
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
  const sources = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    disabledSkillsRevision: 0,
    globalRevision: 0
  }
  await mkdir(sources.builtinSkillsDir)
  await mkdir(join(sources.customSkillsDir, "review"), { recursive: true })
  const externalFile = join(sources.customSkillsDir, "review", "SKILL.md")
  await writeFile(externalFile, "---\nname: review\n---\nINSTALLED_ORIGINAL")
  await writeFile(sources.pluginsStorePath, "[]")
  await writeFile(sources.disabledSkillsPath, "[]")
  const modelFile = join(root, "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "fixture",
    skillSources: sources,
    models: [
      {
        id: "fixture",
        ref: "fixture",
        name: "Fixture",
        model: "gpt-test",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "fixture-only",
        maxTokens: DEFAULT_MAX_TOKENS
      }
    ]
  })
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "Owner" })
  const peer = store.createBot({ nonce: "peer", name: "Peer" })
  const privateSkill = store.saveSkill({
    botId: owner.bot.id,
    name: "Local workflow",
    enabled: true,
    instructions:
      "---\ncmbdevclaw-dependencies:\n  schemaVersion: 1\n  checks:\n    - {id: platform, kind: platform, platforms: [darwin]}\n---\nSQLITE_ORIGINAL_INSTRUCTIONS"
  })
  const shared = store.skillLibrary.publish({
    nonce: "publish",
    botId: owner.bot.id,
    skillId: privateSkill.id,
    version: privateSkill.version,
    libraryRevision: 0
  })
  const service = new BotSkillCatalogSync(
    store,
    modelFile,
    new BotSkillCatalogProcess({
      entry: resolve("src/main/bots/skill-catalog-entry.ts"),
      execArgv: ["--import", "tsx"]
    })
  )
  cleanup.push(() => service.close())
  await service.ensure()
  const desktop = store.externalSkills.list(owner.bot.id)[0]
  const computer = new LocalBotComputerProvider(join(root, "browser"))
  cleanup.push(() => computer.shutdown())
  const runtime = new CmbBotRuntime(modelFile, computer, { skillCatalog: service })
  const host = new BotHost(store, runtime)
  cleanup.push(() => host.stop())
  const api = createBotAPI(host)
  const selection = { botId: owner.bot.id, id: privateSkill.id, version: privateSkill.version }
  const sharedSelection = { botId: peer.bot.id, id: shared.id, version: shared.revision }
  async function failCatalog() {
    await rename(sources.builtinSkillsDir, join(root, "builtin-unavailable"))
    await expect(service.ensure(0)).rejects.toThrow("技能目录读取失败")
    expect(store.externalSkills.list(owner.bot.id)).toEqual([])
  }
  return {
    root,
    requests,
    sources,
    externalFile,
    store,
    owner,
    peer,
    privateSkill,
    shared,
    service,
    desktop,
    runtime,
    host,
    api,
    selection,
    sharedSelection,
    failCatalog,
    select: (id: string) => {
      skillId = id
    }
  }
}

it.each(["private", "shared"] as const)(
  "reads the exact %s SQLite instructions through the actual graph while installed catalog refresh fails",
  async (scope) => {
    const f = await fixture()
    await f.failCatalog()
    const selection = scope === "private" ? f.selection : f.sharedSelection
    f.select(selection.id)
    const runId = f.store.send({
      nonce: "read",
      conversationId: scope === "private" ? f.owner.conversationId : f.peer.conversationId,
      text: "Read the selected workflow.",
      skills: [selection]
    }).runIds[0]
    f.host.start()
    const run = await settled(f.store, runId)
    expect(run, run.error ?? "").toMatchObject({ status: "succeeded" })
    expect(f.requests).toHaveLength(2)
    const result = f.requests[1].messages.find((message) => message.role === "tool")!
    expect(JSON.parse(String(result.content))).toMatchObject({
      id: selection.id,
      version: selection.version,
      instructions: f.privateSkill.instructions,
      dependencies: {
        declaration: { state: "structured", checks: [{ id: "platform" }] },
        current: null
      }
    })
    expect(f.store.effects(runId)).toEqual([])
    expect(f.store.skillLibrary.current(selection.botId, selection.id).verified).toBe(false)
  }
)

it("keeps an admitted private trial's exact snapshot readable after revision without verifying it or admitting a new retired trial", async () => {
  const f = await fixture()
  await f.failCatalog()
  f.select(f.privateSkill.id)
  const input = {
    nonce: "trial",
    expectedDataEpoch: f.store.dataEpoch(),
    botId: f.owner.bot.id,
    skillId: f.privateSkill.id,
    version: f.privateSkill.version,
    inputs: "Read saved evidence.",
    criteria: "Return exact instructions."
  }
  const trial = await f.api.trialSkill(input)
  f.store.saveSkill({ ...f.privateSkill, enabled: false, instructions: "RETIRED_REPLACEMENT" })
  f.host.start()
  const run = await settled(f.store, trial.runId)
  expect(run, run.error ?? "").toMatchObject({ status: "succeeded" })
  const result = f.requests[1].messages.find((message) => message.role === "tool")!
  expect(JSON.parse(String(result.content))).toMatchObject({
    id: f.privateSkill.id,
    version: 1,
    instructions: f.privateSkill.instructions,
    dependencies: { declaration: { state: "structured" }, current: null }
  })
  expect(f.store.skillTrials(f.owner.bot.id)[0]).toMatchObject({ verdict: "pending", version: 1 })
  await expect(f.api.trialSkill({ ...input, nonce: "retired-new" })).rejects.toMatchObject({
    code: "revision_conflict"
  })
  expect(f.store.skills(f.owner.bot.id)[0]).toMatchObject({ enabled: false, verified: false })
})

it("returns local and shared dependency history without scanning the broken catalog and preserves ownership, revision, disablement and withdrawal", async () => {
  const f = await fixture()
  const receipt = f.store.skillDependencies.submit({
    nonce: "historical-check",
    expectedDataEpoch: f.store.dataEpoch(),
    skill: f.selection
  })
  const claim = f.store.claim("fixture")!
  f.store.finish(claim.lease, "failed", "Prior check interrupted")
  await f.failCatalog()
  const ensure = vi.spyOn(f.service, "ensure")
  expect((await f.api.skillDependencies(f.selection)).history[0]).toMatchObject({
    receipt: { runId: receipt.runId },
    status: "failed",
    current: false,
    reason: "not_checked"
  })
  expect((await f.api.skillDependencies(f.sharedSelection)).declaration.state).toBe("structured")
  await expect(
    f.api.skillDependencies({ ...f.selection, botId: f.peer.bot.id })
  ).rejects.toMatchObject({ code: "skill_unavailable" })
  const disabled = f.store.saveSkill({ ...f.privateSkill, enabled: false })
  await expect(f.api.skillDependencies(f.selection)).rejects.toMatchObject({
    code: "skill_changed"
  })
  expect(
    (await f.api.skillDependencies({ ...f.selection, version: disabled.version })).history
  ).toHaveLength(1)
  expect(() =>
    f.store.skillDependencies.submit({
      nonce: "disabled-check",
      expectedDataEpoch: f.store.dataEpoch(),
      skill: { ...f.selection, version: disabled.version }
    })
  ).toThrow("停用")
  f.store.skillLibrary.withdraw({ nonce: "withdraw", id: f.shared.id, revision: f.shared.revision })
  await expect(f.api.skillDependencies(f.sharedSelection)).rejects.toMatchObject({
    code: "skill_unavailable"
  })
  expect(ensure).not.toHaveBeenCalled()
})

it("requires successful catalog refresh for desktop dependencies and never revives persisted cached instructions after failure", async () => {
  const f = await fixture()
  const selection = { botId: f.owner.bot.id, id: f.desktop.id, version: f.desktop.version }
  expect((await f.api.skillDependencies(selection)).skill.scope).toBe("desktop")
  await f.failCatalog()
  const ensure = vi.spyOn(f.service, "ensure")
  await expect(f.runtime.skillDependencies(selection, f.store)).rejects.toThrow("技能目录读取失败")
  await expect(f.api.skillDependencies(selection)).rejects.toThrow("技能目录读取失败")
  expect(ensure).toHaveBeenCalled()
  expect(() => f.store.skillLibrary.current(selection.botId, selection.id)).toThrow("同步失败")
  await rename(join(f.root, "builtin-unavailable"), f.sources.builtinSkillsDir)
  expect((await f.api.skillDependencies(selection)).skill).toMatchObject({
    scope: "desktop",
    version: 1
  })
})

it("keeps the desktop source guard active even inside the fresh-catalog cache interval", async () => {
  const f = await fixture()
  const selection = { botId: f.owner.bot.id, id: f.desktop.id, version: f.desktop.version }
  await f.api.skillDependencies(selection)
  await writeFile(f.externalFile, "---\nname: review\n---\nUNREVIEWED_REPLACEMENT")
  await expect(f.api.skillDependencies(selection)).rejects.toThrow(/来源已变化|新版本/)
  await f.service.ensure(0)
  await expect(f.api.skillDependencies(selection)).rejects.toMatchObject({ code: "skill_changed" })
  expect((await f.api.skillDependencies({ ...selection, version: 2 })).skill.version).toBe(2)
})
