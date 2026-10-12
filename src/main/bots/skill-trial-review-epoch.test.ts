import { afterEach, expect, it, vi } from "vitest"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-trial-review-epoch-")),
    database = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite")
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new BotStore(database)
  cleanup.push(() => store.close())
  const { bot } = store.createBot({ nonce: "bot", name: "验收助手" }),
    skill = store.saveSkill({
      botId: bot.id,
      name: "核对产物",
      instructions: "核对当前输入和产物，并保留证据。",
      enabled: true
    }),
    trial = store.trialSkill({
      nonce: "trial",
      botId: bot.id,
      skillId: skill.id,
      version: skill.version,
      inputs: "SAMPLE-002",
      criteria: "实际产物必须包含 SAMPLE-002"
    }),
    claim = store.claim("fixture-host")!
  store.finish(claim.lease, "succeeded", "SAMPLE-002 已完成并保留原始证据")
  const review = {
    id: trial.id,
    verdict: "passed" as const,
    note: "已逐项核对 SAMPLE-002 的实际产物",
    expectedDataEpoch: "initial"
  }
  const state = () => ({
    trial: store.skillTrials(bot.id)[0],
    skills: store.skills(bot.id),
    events: store.db.exec("SELECT * FROM bot_events"),
    runs: store.db.exec("SELECT * FROM bot_runs"),
    receipts: store.db.exec("SELECT * FROM bot_receipts")
  })
  const checkpoint = () => {
    store.close()
    copyFileSync(database, point)
    store = new BotStore(database)
  }
  const restore = () => {
    store.close()
    copyFileSync(point, database)
    const ledger = new BotDeletionLedger(database)
    try {
      fenceBotCheckpointDatabase(database, "replacement", ledger)
    } finally {
      ledger.close()
    }
    store = new BotStore(database)
  }
  const connect = async () => {
    const host = new BotHost(store),
      token = randomBytes(32).toString("hex"),
      socket =
        process.platform === "win32"
          ? `\\\\.\\pipe\\cmb-trial-review-${token.slice(0, 16)}`
          : join(directory, `rpc-${token.slice(0, 8)}.sock`),
      server = new BotRpcServer(host, token)
    await server.listen(socket)
    cleanup.push(async () => {
      await server.close()
      await host.stop()
    })
    const client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    cleanup.push(() => client.close())
    return { host, server, client }
  }
  return {
    get store() {
      return store
    },
    bot,
    skill,
    trial,
    review,
    state,
    checkpoint,
    restore,
    connect
  }
}

it("rejects an old page verdict through replacement authenticated RPC after actual checkpoint restore, without marking the skill verified", async () => {
  const f = fixture()
  f.checkpoint()
  f.restore()
  const { client } = await f.connect(),
    before = f.state(),
    result = await client.call("reviewSkillTrial", f.review).catch((error: unknown) => error)
  expect.soft(result).toMatchObject({ code: "data_epoch" })
  expect.soft(f.state()).toEqual(before)
  expect.soft(f.store.skills(f.bot.id)[0].verified).toBe(false)
  expect.soft(f.store.skillTrials(f.bot.id)[0].verdict).toBe("pending")
})

it("requires the reviewed scope for new Store writes, but accepts and replays a current-scope verdict without new events or tasks", async () => {
  const f = fixture()
  f.checkpoint()
  f.restore()
  const before = f.state(),
    legacy = { id: f.review.id, verdict: f.review.verdict, note: f.review.note }
  for (const input of [f.review, legacy])
    expect(() => f.store.reviewSkillTrial(input)).toThrow(
      expect.objectContaining({ code: "data_epoch" })
    )
  expect(f.state()).toEqual(before)
  const input = { ...f.review, expectedDataEpoch: "replacement" },
    accepted = f.store.reviewSkillTrial(input),
    committed = f.state()
  expect(accepted.verdict).toBe("passed")
  expect(f.store.skills(f.bot.id)[0].verified).toBe(true)
  expect(f.store.reviewSkillTrial(input)).toEqual(accepted)
  expect(f.state()).toEqual(committed)
  expect(f.state().runs).toEqual(before.runs)
})

it("keeps accepted verdicts as readonly Store evidence across restore, while public old-scope acknowledgements remain fenced", async () => {
  const f = fixture(),
    accepted = f.store.reviewSkillTrial(f.review)
  f.checkpoint()
  f.restore()
  const { client } = await f.connect(),
    before = f.state()
  expect(f.store.reviewSkillTrial(f.review)).toEqual(accepted)
  expect(f.state()).toEqual(before)
  await expect(client.call("reviewSkillTrial", f.review)).rejects.toMatchObject({
    code: "data_epoch"
  })
  expect(f.state()).toEqual(before)
  expect(
    await client.call("reviewSkillTrial", { ...f.review, expectedDataEpoch: "replacement" })
  ).toEqual(accepted)
  expect(f.state()).toEqual(before)
})

it("fences the success acknowledgement when scope changes during an accepted review without undoing its original commit", async () => {
  const input = { id: "trial", verdict: "passed", note: "checked", expectedDataEpoch: "initial" }
  let epoch = "initial"
  const execute = vi.fn(async () => {
    epoch = "replacement"
    return { verdict: "passed" }
  })
  await expect(
    guardBotRpcMutationEpoch("reviewSkillTrial", input, () => epoch, execute)
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(execute).toHaveBeenCalledTimes(1)
})

it("does not publish an old success after an authenticated RPC review commits and the durable scope changes before its reply", async () => {
  const f = fixture(),
    { client } = await f.connect(),
    original = f.store.reviewSkillTrial.bind(f.store),
    beforeRuns = f.state().runs
  const review = vi.spyOn(f.store, "reviewSkillTrial").mockImplementationOnce((input) => {
    const receipt = original(input)
    // Deterministically exercise the final response window with the real
    // persisted epoch record. The full snapshot/fence path is covered above.
    f.store.transaction(() =>
      f.store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
        "workspace.restored",
        "replacement",
        JSON.stringify({ message: "fixture scope changed" }),
        f.store.now()
      ])
    )
    return receipt
  })
  await expect(client.call("reviewSkillTrial", f.review)).rejects.toMatchObject({
    code: "data_epoch"
  })
  expect(review).toHaveBeenCalledTimes(1)
  expect(f.store.skillTrials(f.bot.id)[0].verdict).toBe("passed")
  expect(f.store.skills(f.bot.id)[0].verified).toBe(true)
  expect(f.state().runs).toEqual(beforeRuns)
  const committed = f.state()
  expect(f.store.reviewSkillTrial(f.review).verdict).toBe("passed")
  expect(f.state()).toEqual(committed)
})

it("does not transfer verification to an edited version, revise an accepted verdict, or resurrect a deleted skill", () => {
  const f = fixture(),
    edited = f.store.saveSkill({ ...f.skill, instructions: "新版本步骤" })
  f.store.reviewSkillTrial(f.review)
  expect(f.store.skillVersion(f.bot.id, f.skill.id, f.skill.version).verified).toBe(true)
  expect(f.store.skillVersion(f.bot.id, f.skill.id, edited.version).verified).toBe(false)
  expect(() =>
    f.store.reviewSkillTrial({ ...f.review, verdict: "failed", note: "改写原判定" })
  ).toThrow(expect.objectContaining({ code: "revision_conflict" }))
  f.store.deleteSkill({
    nonce: "delete",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: edited.version
  })
  const before = f.state()
  expect(f.store.reviewSkillTrial(f.review).verdict).toBe("passed")
  expect(f.state()).toEqual(before)
  expect(f.store.skills(f.bot.id)).toEqual([])
})
