import { afterEach, expect, it, vi } from "vitest"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

it.each([
  "create",
  "update",
  "createGroup",
  "updateGroup",
  "saveRoutine",
  "runRoutine",
  "saveSkill",
  "trialSkill",
  "changeAvatar",
  "changeWebhook",
  "workflowControl",
  "setMemoryPolicy",
  "saveMemory",
  "deleteMemory",
  "saveSharedMemory",
  "deleteSharedMemory"
])(
  "%s keeps the original reviewed epoch and rejects omitted legacy admission on replacement",
  async (method) => {
    const execute = vi.fn(async () => "receipt")
    await expect(
      guardBotRpcMutationEpoch(method, { expectedDataEpoch: "old" }, () => "new", execute)
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(guardBotRpcMutationEpoch(method, {}, () => "new", execute)).rejects.toMatchObject({
      code: "data_epoch"
    })
    expect(execute).not.toHaveBeenCalled()
    expect(
      await guardBotRpcMutationEpoch(method, { expectedDataEpoch: "new" }, () => "new", execute)
    ).toBe("receipt")
  }
)
it.each([
  "changeUsageBudget",
  "answerIntroductionQuestion",
  "changeNotifications",
  "changeBackupSchedule",
  "changeAutoReview",
  "changeApprovalRule",
  "retryMemory",
  "recover",
  "stopShellJob"
])("%s fences a current-scope receipt after asynchronous completion", async (method) => {
  let epoch = "before"
  await expect(
    guardBotRpcMutationEpoch(
      method,
      { dataEpoch: "before" },
      () => epoch,
      async () => {
        epoch = "replacement"
        return "old accepted receipt"
      }
    )
  ).rejects.toMatchObject({ code: "data_epoch" })
})
it("does not add authority or a success fence to ordinary readonly calls", async () => {
  const epoch = vi.fn(() => "new"),
    result = { evidence: "exact" }
  expect(await guardBotRpcMutationEpoch("snapshot", undefined, epoch, async () => result)).toBe(
    result
  )
  expect(epoch).not.toHaveBeenCalled()
})
it("captures the submitted scope instead of following later mutation of a caller-owned object", async () => {
  const input = { expectedDataEpoch: "before" }
  let epoch = "before"
  await expect(
    guardBotRpcMutationEpoch(
      "updateGroup",
      input,
      () => epoch,
      async () => {
        input.expectedDataEpoch = epoch = "replacement"
        return "receipt"
      }
    )
  ).rejects.toMatchObject({ code: "data_epoch" })
})
const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
it("replacement authenticated RPC cannot send an old accepted success ACK, while the exact Store receipts remain readonly evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-rpc-reply-epoch-")),
    path = join(root, "bots.sqlite"),
    point = join(root, "point.sqlite")
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let store = new BotStore(path)
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "A" }).bot,
    b = store.createBot({ nonce: "b", name: "B" }).bot,
    group = store.createGroup({ nonce: "group", name: "Group", members: [a.id, b.id] }),
    request = {
      nonce: "accepted",
      expectedDataEpoch: "initial",
      id: group.id,
      revision: group.revision,
      name: "Original",
      description: "Original",
      members: group.members
    },
    receipt = store.updateGroup(request)
  store.close()
  copyFileSync(path, point)
  copyFileSync(point, path)
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(path, "replacement", ledger)
  } finally {
    ledger.close()
  }
  store = new BotStore(path)
  const host = new BotHost(store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token),
    socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-reply-${token.slice(0, 16)}`
        : join(root, "rpc.sock")
  let client: BotTransportClient | undefined
  try {
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    const before = JSON.stringify(store.db.exec("SELECT * FROM bot_events"))
    expect(store.updateGroup(request)).toEqual(receipt)
    await expect(client.call("updateGroup", request)).rejects.toMatchObject({ code: "data_epoch" })
    expect(JSON.stringify(store.db.exec("SELECT * FROM bot_events"))).toBe(before)
    expect(await client.call("snapshot")).toMatchObject({ dataEpoch: "replacement" })
  } finally {
    client?.close()
    await server.close()
    await host.stop()
  }
})
