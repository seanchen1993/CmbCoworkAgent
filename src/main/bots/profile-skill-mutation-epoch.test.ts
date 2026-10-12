import { afterEach, expect, it } from "vitest"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { botProfileTools } from "./profile-tools"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-profile-skill-epoch-")),
    path = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite")
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({
      nonce: "owner",
      name: "Owner"
    }),
    peer = store.createBot({ nonce: "peer", name: "Peer" }).bot,
    skill = store.saveSkill({
      botId: bot.id,
      name: "Original",
      instructions: "Original evidence",
      enabled: true
    })
  const create = { nonce: "create", name: "Created" },
    update = {
      nonce: "update",
      id: bot.id,
      revision: bot.revision,
      title: "Reviewed"
    },
    save = {
      nonce: "save",
      botId: bot.id,
      name: "Reviewed",
      instructions: "Evidence",
      enabled: true
    },
    edit = { ...save, nonce: "edit", id: skill.id, version: skill.version }
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
      fenceBotCheckpointDatabase(path, "replacement", ledger)
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
    peer,
    skill,
    conversationId,
    create,
    update,
    save,
    edit,
    checkpoint,
    restore
  }
}
it.each(["create", "update", "save", "edit"] as const)(
  "rejects new stale and omitted %s scope after an actual checkpoint restore without consuming nonce",
  (kind) => {
    const f = fixture()
    f.checkpoint()
    const store = f.restore(),
      input = f[kind]
    const dispatch = (value: typeof input & { expectedDataEpoch?: string }) =>
      kind === "create"
        ? store.createBot(value as typeof f.create)
        : kind === "update"
          ? store.updateBot(value as typeof f.update)
          : store.saveSkill(value as typeof f.save)
    const before = store.snapshot(),
      skills = store.skills(f.bot.id)
    expect(() => dispatch({ ...input, expectedDataEpoch: "initial" })).toThrow(
      expect.objectContaining({ code: "data_epoch" })
    )
    expect(() => dispatch(input)).toThrow(expect.objectContaining({ code: "data_epoch" }))
    expect(store.snapshot()).toEqual(before)
    expect(store.skills(f.bot.id)).toEqual(skills)
    expect(
      store.db.exec("SELECT nonce FROM bot_receipts WHERE nonce=?", [input.nonce])[0]?.values ?? []
    ).toEqual([])
    expect(dispatch({ ...input, expectedDataEpoch: "replacement" })).toBeTruthy()
  }
)
it.each([false, true])(
  "accepted %s-scope create/update/skill receipts remain read-only after restore and later edits",
  (scoped) => {
    const f = fixture(),
      scope = scoped ? { expectedDataEpoch: "initial" } : {}
    const created = f.store.createBot({ ...f.create, ...scope }),
      updated = f.store.updateBot({ ...f.update, ...scope }),
      saved = f.store.saveSkill({ ...f.save, ...scope })
    f.checkpoint()
    const store = f.restore()
    store.updateBot({
      id: f.bot.id,
      revision: updated.revision,
      name: "Current name",
      expectedDataEpoch: "replacement"
    })
    const current = store.getBot(f.bot.id),
      count = store.skills(f.bot.id).length,
      cursor = store.snapshot().cursor
    expect(store.createBot({ ...f.create, ...scope })).toEqual(created)
    expect(store.updateBot({ ...f.update, ...scope })).toEqual(updated)
    expect(store.saveSkill({ ...f.save, ...scope })).toEqual(saved)
    expect(store.getBot(f.bot.id)).toEqual(current)
    expect(store.skills(f.bot.id)).toHaveLength(count)
    expect(store.snapshot().cursor).toBe(cursor)
    expect(() => store.createBot({ ...f.create, ...scope, name: "Different payload" })).toThrow(
      expect.objectContaining({ code: "nonce_conflict" })
    )
  }
)
it("accepted skill receipt cannot resurrect a deleted skill, and fresh omitted nonce does not bypass the restored scope", () => {
  const f = fixture(),
    input = { ...f.save, expectedDataEpoch: "initial" },
    saved = f.store.saveSkill(input)
  f.checkpoint()
  const store = f.restore()
  store.deleteSkill({
    nonce: "delete",
    botId: f.bot.id,
    skillId: saved.id,
    version: saved.version
  })
  expect(store.saveSkill(input)).toEqual(saved)
  expect(store.skills(f.bot.id).some((skill) => skill.id === saved.id)).toBe(false)
  expect(() =>
    store.saveSkill({
      botId: f.bot.id,
      name: "Unscoped",
      instructions: "Public input",
      enabled: true
    })
  ).toThrow(expect.objectContaining({ code: "data_epoch" }))
})
it("trusted lease-only skill and self-profile writes work in the restored workspace but reject another Bot or stopped lease", () => {
  const f = fixture()
  f.checkpoint()
  const store = f.restore()
  store.send({
    nonce: "run",
    conversationId: f.conversationId,
    text: "Save a reviewed skill"
  })
  const { lease } = store.claim("host")!
  const input = {
    botId: f.bot.id,
    name: "Trusted",
    instructions: "Reviewed evidence",
    enabled: true
  }
  const saved = store.toolOnce(lease, "call", { name: input.name }, () =>
    store.saveSkill(input, { kind: "task", lease })
  )
  expect(saved.botId).toBe(f.bot.id)
  expect(
    store.toolOnce(lease, "call", { name: input.name }, () => {
      throw new Error("Must not replay")
    })
  ).toEqual(saved)
  expect(() => store.saveSkill({ ...input, botId: f.peer.id }, { kind: "task", lease })).toThrow(
    expect.objectContaining({ code: "skill_scope" })
  )
  const updated = store.updateBotProfile(lease, {
    id: f.bot.id,
    revision: f.bot.revision,
    instructions: "Current run instructions"
  })
  expect(updated.instructions).toBe("Current run instructions")
  store.cancel(lease.runId)
  expect(() => store.saveSkill(input, { kind: "task", lease })).toThrow()
})
it("omitted and explicitly undefined optional scope retain original nonce hashes", () => {
  const f = fixture()
  const created = f.store.createBot(f.create),
    updated = f.store.updateBot(f.update),
    saved = f.store.saveSkill(f.save)
  expect(f.store.createBot({ ...f.create, expectedDataEpoch: undefined })).toEqual(created)
  expect(f.store.updateBot({ ...f.update, expectedDataEpoch: undefined })).toEqual(updated)
  expect(f.store.saveSkill({ ...f.save, expectedDataEpoch: undefined })).toEqual(saved)
})

it("approved model creation carries current epoch inside its existing lease and local effect receipt", async () => {
  const f = fixture()
  f.checkpoint()
  const store = f.restore()
  store.send({
    nonce: "model-create",
    conversationId: f.conversationId,
    text: "Create a requested teammate"
  })
  const claimed = store.claim("host")!,
    request = {
      ...claimed,
      bot: store.getBot(f.bot.id),
      store,
      signal: new AbortController().signal,
      messages: store.messagesForRun(claimed.run.id)
    }
  const tools = botProfileTools(
    request,
    () => store.assertLease(claimed.lease),
    async (id, action, operation) => {
      const previous = store.effectResult(claimed.lease, id, action)
      if (previous) return previous.result!
      const approval = store.requestInteraction(claimed.lease, {
        kind: "approval",
        action,
        prompt: "Create requested teammate"
      })
      store.answerInteraction({
        id: approval.id,
        revision: approval.revision,
        answer: "approve"
      })
      return store.approvedToolOnce(
        claimed.lease,
        { id, action, approvalId: approval.id },
        operation
      )
    }
  )
  const invoke = () =>
    tools
      .find((tool) => tool.name === "create_bot")!
      .invoke({
        type: "tool_call",
        name: "create_bot",
        id: "create-current",
        args: {
          name: "Current teammate",
          description: "Reviewed responsibility"
        }
      })
  const result = await invoke()
  expect(JSON.parse(String(result.content))).toMatchObject({
    ok: true,
    bot: { name: "Current teammate" }
  })
  expect((await invoke()).content).toBe(result.content)
  expect(store.listBots()).toHaveLength(3)
})
