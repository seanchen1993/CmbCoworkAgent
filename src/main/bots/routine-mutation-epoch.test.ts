import { afterEach, expect, it } from "vitest"
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { botRoutineTools } from "./routine-tools"

const close: (() => void)[] = []
afterEach(() =>
  close
    .splice(0)
    .reverse()
    .forEach((callback) => callback())
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-routine-epoch-")),
    path = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite")
  close.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new BotStore(path)
  close.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Owner" })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "Original",
    prompt: "Original task",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "event", topic: "build.failed" }
  })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "Original",
    instructions: "Read evidence",
    enabled: true
  })
  const save = {
    nonce: "save",
    botId: bot.id,
    id: routine.id,
    revision: routine.revision,
    name: routine.name,
    prompt: "Reviewed change",
    enabled: false,
    timezone: routine.timezone,
    schedule: routine.schedule
  }
  const run = { nonce: "run", id: routine.id, revision: routine.revision }
  const trial = {
    nonce: "trial",
    botId: bot.id,
    skillId: skill.id,
    version: skill.version,
    inputs: "Sample",
    criteria: "Evidence"
  }
  const checkpoint = () => {
    store.close()
    copyFileSync(path, point)
    store = new BotStore(path)
  }
  const restore = () => {
    store.close()
    copyFileSync(point, path)
    const ledger = new BotDeletionLedger(path)
    try {
      fenceBotCheckpointDatabase(path, "restored", ledger)
    } finally {
      ledger.close()
    }
    store = new BotStore(path)
    return store
  }
  return {
    get store() {
      return store
    },
    bot,
    conversationId,
    routine,
    skill,
    save,
    run,
    trial,
    checkpoint,
    restore
  }
}

it.each(["save", "run", "trial"] as const)(
  "rejects fresh stale or unscoped %s after real restore, without consuming nonce",
  (kind) => {
    const f = fixture()
    f.checkpoint()
    // The restore increments the frozen routine revision. A live post-checkpoint edit has the same revision.
    const live = f.store.saveRoutine({ ...f.routine, prompt: "Live edit" })
    const store = f.restore()
    expect(store.routine(f.bot.id, f.routine.id).revision).toBe(live.revision)
    const input =
      kind === "save"
        ? { ...f.save, revision: live.revision }
        : kind === "run"
          ? { ...f.run, revision: live.revision }
          : f.trial
    const dispatch = (value: typeof input & { expectedDataEpoch?: string }) =>
      kind === "save"
        ? store.saveRoutine(value as typeof f.save)
        : kind === "run"
          ? store.runRoutine(value as typeof f.run)
          : store.trialSkill(value as typeof f.trial)
    const messages = store.messages(f.conversationId).length,
      count = store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0],
      routines = store.routines(f.bot.id)
    expect(() => dispatch({ ...input, expectedDataEpoch: "initial" })).toThrow(
      expect.objectContaining({ code: "data_epoch" })
    )
    expect(() => dispatch(input)).toThrow(expect.objectContaining({ code: "data_epoch" }))
    expect(store.messages(f.conversationId)).toHaveLength(messages)
    expect(store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(count)
    expect(store.routines(f.bot.id)).toEqual(routines)
    expect(
      store.db.exec("SELECT nonce FROM bot_receipts WHERE nonce=?", [input.nonce])[0]?.values ?? []
    ).toEqual([])
    const accepted = dispatch({ ...input, expectedDataEpoch: "restored" })
    expect(accepted).toBeTruthy()
  }
)

it.each([false, true])(
  "replays accepted %s-scope legacy/scoped receipts after restore and deletion without new writes",
  (scoped) => {
    const f = fixture(),
      epoch = scoped ? { expectedDataEpoch: "initial" } : {}
    const acceptedRun = f.store.runRoutine({ ...f.run, ...epoch }),
      acceptedTrial = f.store.trialSkill({ ...f.trial, ...epoch }),
      acceptedSave = f.store.saveRoutine({ ...f.save, ...epoch })
    f.checkpoint()
    const store = f.restore()
    store.deleteRoutine({
      botId: f.bot.id,
      id: acceptedSave.id,
      revision: store.routine(f.bot.id, acceptedSave.id).revision,
      nonce: "delete-original"
    })
    const before = store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]
    expect(store.runRoutine({ ...f.run, ...epoch })).toEqual(acceptedRun)
    expect(store.trialSkill({ ...f.trial, ...epoch })).toEqual(acceptedTrial)
    expect(store.saveRoutine({ ...f.save, ...epoch })).toEqual(acceptedSave)
    expect(store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(before)
    expect(store.routines(f.bot.id)).toEqual([])
    if (scoped)
      expect(() => store.saveRoutine({ ...f.save, expectedDataEpoch: "restored" })).toThrow(
        expect.objectContaining({ code: "nonce_conflict" })
      )
  }
)

it("keeps omitted and explicit undefined trial scope hashes compatible across native structured clone", () => {
  const f = fixture(),
    original = f.store.trialSkill(f.trial)
  expect(f.store.trialSkill({ ...f.trial, expectedDataEpoch: undefined })).toEqual(original)
})

it("trusted model update derives current epoch only inside its checked lease/tool receipt boundary", async () => {
  const f = fixture()
  f.checkpoint()
  const store = f.restore()
  store.send({
    nonce: "fresh-request",
    conversationId: f.conversationId,
    text: "Update restored routine"
  })
  const { run, lease } = store.claim("current-host")!,
    tools = botRoutineTools(
      {
        store,
        bot: f.bot,
        run,
        lease,
        signal: new AbortController().signal,
        messages: store.messagesForRun(run.id)
      },
      () => store.assertLease(lease),
      async (...parameters) => parameters[2]()
    )
  const current = store.routine(f.bot.id, f.routine.id),
    update = tools.find((tool) => tool.name === "update_routine")!
  await update.invoke({
    id: "current-tool",
    type: "tool_call",
    name: update.name,
    args: { id: current.id, revision: current.revision, prompt: "Current restored task" }
  })
  expect(store.routine(f.bot.id, current.id).prompt).toBe("Current restored task")
})

it("authenticates to a replacement Host and rejects delayed old payloads before SQLite queue writes", async () => {
  const { randomBytes } = await import("node:crypto"),
    { BotHost } = await import("./host"),
    { BotRpcServer } = await import("./rpc"),
    { BotTransportClient } = await import("./transport-client"),
    { BOT_PROTOCOL_VERSION } = await import("../../shared/bot-types")
  const f = fixture()
  f.checkpoint()
  const live = f.store.saveRoutine({ ...f.routine, prompt: "Live current revision" }),
    store = f.restore()
  const host = new BotHost(store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token),
    directory = mkdtempSync(join(tmpdir(), "cmb-routine-epoch-rpc-")),
    socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-epoch-${token.slice(0, 16)}`
        : join(directory, "s.sock")
  let client: InstanceType<typeof BotTransportClient> | undefined
  try {
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    expect((await client.call("status")).capabilities).toContain("mutation-data-epoch")
    const before = store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]
    await expect(
      client.call("saveRoutine", { ...f.save, revision: live.revision })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("runRoutine", { ...f.run, revision: live.revision })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(client.call("trialSkill", f.trial)).rejects.toMatchObject({ code: "data_epoch" })
    expect(store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(before)
    expect(store.routine(f.bot.id, f.routine.id).enabled).toBe(false)
    const current = await client.call("runRoutine", {
      ...f.run,
      revision: live.revision,
      expectedDataEpoch: "restored"
    })
    expect(store.getRun(current.id).status).toBe("queued")
  } finally {
    client?.close()
    if (server.server.listening) await server.close()
    await host.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
