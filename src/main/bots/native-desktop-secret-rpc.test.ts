import { afterEach, expect, it, vi } from "vitest"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import type { BotComputerClient } from "./computer-client"
import type { NativeDesktopBroker } from "./native-desktop-broker"

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-native-secret-rpc-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const release = vi.fn(),
    pause = vi.fn<NonNullable<BotHost["teach"]>["pauseForNativeSecret"]>()
  const store = new BotStore(":memory:"),
    host = new BotHost(store, undefined, undefined, undefined, undefined, {
      pauseForNativeSecret: pause
    } as unknown as NonNullable<BotHost["teach"]>)
  cleanups.push(() => store.close())
  const { bot } = store.createBot({ nonce: "bot", name: "Native secret" })
  const target = {
    backend: "windows-native" as const,
    botId: bot.id,
    generation: randomUUID(),
    controlEpoch: 1,
    control: "human" as const,
    viewId: randomUUID()
  }
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\native-secret-test-${token.slice(0, 20)}`
        : join(root, "rpc.sock")
  const server = new BotRpcServer(host, token)
  await server.listen(socketPath)
  cleanups.push(() => server.close())
  const descriptor = { version: 1, hostId: host.id, token, pid: process.pid, socketPath }
  const client = new BotTransportClient(descriptor),
    other = new BotTransportClient(descriptor)
  cleanups.push(
    () => other.close(),
    () => client.close()
  )
  let owner: BotComputerClient | undefined
  const secretToken = randomUUID(),
    elementId = randomUUID()
  const prepare = vi.fn(async (_target, _element, connection: BotComputerClient) => {
    owner = connection
    return { token: secretToken, windowTitle: "登录", field: "密码" }
  })
  const fill = vi.fn(async (_target, _token, _value, connection: BotComputerClient) =>
    connection.throwIfAborted()
  )
  const assertHumanClient = (_id: string, connection: BotComputerClient) => {
    connection.throwIfAborted()
    if (owner && owner !== connection)
      throw new BotDomainError("computer_owned_elsewhere", "Different client")
  }
  host.nativeComputer = {
    assertHumanClient,
    prepareHumanSecret: prepare,
    fillHumanSecret: fill
  } as unknown as NativeDesktopBroker
  pause.mockImplementation(async (_id, connection) => {
    assertHumanClient(bot.id, connection)
    return release
  })
  const dump = () => {
    const tables = store.db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )[0].values
    return JSON.stringify(
      tables.map(([name]) => store.db.exec(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`))
    )
  }
  return {
    host,
    store,
    target,
    token: secretToken,
    elementId,
    client,
    other,
    prepare,
    fill,
    pause,
    release,
    dump
  }
}
it("admits a native secret only on the exact authenticated control connection", async () => {
  const f = await fixture()
  await f.client.call("nativeComputerPrepareSecret", { target: f.target, elementId: f.elementId })
  await expect(
    f.other.call("nativeComputerProvideSecret", {
      target: f.target,
      token: f.token,
      value: "transient"
    })
  ).rejects.toMatchObject({ code: "computer_owned_elsewhere" })
  expect(f.pause.mock.calls.length).toBe(0)
  expect(f.fill.mock.calls.length).toBe(0)
})
it("pauses capture before fill, releases its guard, and does not write any credential into SQLite/events/checkpoints", async () => {
  const f = await fixture(),
    order: string[] = [],
    value = ` ${randomUUID()} `
  f.pause.mockImplementation(async () => {
    order.push("paused")
    return () => {
      order.push("released")
    }
  })
  f.fill.mockImplementation(async (_target, _token, provided) => {
    order.push("filled")
    expect(provided === value).toBe(true)
  })
  await f.client.call("nativeComputerPrepareSecret", { target: f.target, elementId: f.elementId })
  const before = f.dump()
  await f.client.call("nativeComputerProvideSecret", { target: f.target, token: f.token, value })
  expect(order).toEqual(["paused", "filled", "released"])
  expect(f.dump() === before).toBe(true)
  expect(f.dump().includes(value)).toBe(false)
  expect(JSON.stringify(f.store.events()).includes(value)).toBe(false)
  expect(JSON.stringify(f.store.snapshot()).includes(value)).toBe(false)
})
it("never forwards provider error text or malformed secret content over RPC", async () => {
  const f = await fixture(),
    value = randomUUID()
  await f.client.call("nativeComputerPrepareSecret", { target: f.target, elementId: f.elementId })
  f.fill.mockImplementation(async () => {
    throw new Error(value)
  })
  const caught = await f.client
    .call("nativeComputerProvideSecret", { target: f.target, token: f.token, value })
    .then(
      () => null,
      (error) => error
    )
  expect(caught.code).toBe("native_secret_failed")
  expect(String(caught.message).includes(value)).toBe(false)
  expect(JSON.stringify(caught.diagnostic).includes(value)).toBe(false)
  expect(f.release.mock.calls.length).toBe(1)
  await expect(
    f.client.call("nativeComputerProvideSecret", {
      target: f.target,
      token: f.token,
      value: value + "\0"
    })
  ).rejects.toMatchObject({ code: "native_secret_invalid" })
  expect(f.fill.mock.calls.length).toBe(1)
})
it("settles a credential request and releases capture protection when the owning RPC disconnects", async () => {
  const f = await fixture()
  await f.client.call("nativeComputerPrepareSecret", { target: f.target, elementId: f.elementId })
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  f.fill.mockImplementation(async (_target, _token, _value, connection) => {
    started()
    await new Promise<void>((_resolve, reject) =>
      connection.addEventListener("abort", () => reject(new Error("closed")), { once: true })
    )
  })
  const pending = f.client
    .call("nativeComputerProvideSecret", { target: f.target, token: f.token, value: "transient" })
    .then(
      () => true,
      () => false
    )
  await entered
  f.client.close()
  expect(await pending).toBe(false)
  await vi.waitFor(() => expect(f.release.mock.calls.length).toBe(1))
})
