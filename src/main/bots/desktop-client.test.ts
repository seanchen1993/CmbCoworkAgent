import { EventEmitter } from "node:events"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BotHostDescriptor } from "./transport-client"

const fixture = vi.hoisted(() => ({
  descriptor: undefined as BotHostDescriptor | undefined,
  status: vi.fn(),
  spawn: vi.fn(),
  sync: vi.fn(),
  upgrade: vi.fn(),
  readDescriptor: vi.fn(),
  restart: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  recoveryProgress: vi.fn(),
  inspectResources: vi.fn(),
  clients: [] as { closed: boolean }[]
}))

vi.mock("../app-data-root", () => ({
  getCmbCoworkAgentDataRoot: () => "/fixture/cmb"
}))
vi.mock("./desktop-model-sync", () => ({ syncDesktopBotModels: fixture.sync }))
vi.mock("./host-upgrade", () => ({ requestBotHostUpgrade: fixture.upgrade }))
vi.mock("./host-lock", () => ({ BotHostLock: { acquire: fixture.acquire } }))
vi.mock("./computer-startup-progress", () => ({
  readVerifiedComputerStartupProgress: fixture.recoveryProgress
}))
vi.mock("./desktop-owned-shell-maintenance", () => ({
  inspectDesktopBotShellResources: fixture.inspectResources
}))
vi.mock("./shell-contract", () => ({ botShellEnvironment: () => ({}) }))
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }))
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  existsSync: (path: string) => path.endsWith("bot-host.js") || !!fixture.descriptor,
  readFileSync: fixture.readDescriptor
}))
vi.mock("./transport-client", () => ({
  BotTransportClient: class {
    closed = false
    constructor(readonly descriptor: BotHostDescriptor) {
      fixture.clients.push(this)
    }
    call(method: string) {
      expect(method).toBe("status")
      return fixture.status(this.descriptor)
    }
    close() {
      this.closed = true
    }
    restartIfIdle(hostId: string) {
      expect(hostId).toBe(this.descriptor.hostId)
      return fixture.restart()
    }
  }
}))

const ready: BotHostDescriptor = {
  version: 1,
  pid: 123,
  hostId: "ready",
  socketPath: "/fixture/socket",
  token: "fixture-token"
}
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> }
let exitListeners: ((code: number) => void)[]

beforeEach(() => {
  exitListeners = process.listeners("exit")
  vi.resetModules()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  fixture.descriptor = undefined
  fixture.clients.length = 0
  fixture.sync.mockReset().mockResolvedValue(undefined)
  fixture.upgrade.mockReset().mockResolvedValue(false)
  fixture.restart.mockReset().mockResolvedValue({ accepted: true, reason: null })
  fixture.release.mockReset()
  fixture.acquire.mockReset().mockReturnValue({ release: fixture.release })
  fixture.recoveryProgress.mockReset().mockResolvedValue(undefined)
  fixture.inspectResources.mockReset().mockResolvedValue({
    mode: "active-owner",
    review: { state: "ready", reason: "none", entries: [], title: "已核对", hint: "" }
  })
  fixture.readDescriptor.mockReset().mockImplementation(() => {
    if (!fixture.descriptor)
      throw Object.assign(new Error("missing descriptor"), { code: "ENOENT" })
    return JSON.stringify(fixture.descriptor)
  })
  fixture.status.mockReset().mockImplementation(async (descriptor: BotHostDescriptor) => ({
    hostId: descriptor.hostId
  }))
  child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  fixture.spawn.mockReset().mockImplementation(() => {
    setTimeout(() => child.emit("spawn"), 0)
    return child
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const listener of process.listeners("exit")) {
    if (!exitListeners.includes(listener)) {
      process.off("exit", listener)
      listener(0)
    }
  }
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function connect() {
  return import("./desktop-client")
}

it("blocks desktop admission until private native work drains before Host maintenance", async () => {
  const api = await connect()
  let finish: (() => void) | undefined
  const drain = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const end = vi.fn()
  const unregister = api.registerDesktopBotMaintenanceParticipant({
    drain,
    end
  })
  const operation = vi.fn().mockResolvedValue("maintained")
  const pending = api.withDesktopBotMaintenance(operation)
  await Promise.resolve()
  await expect(api.getDesktopBotClient()).rejects.toMatchObject({
    code: "host_maintenance"
  })
  expect(operation).not.toHaveBeenCalled()
  finish!()
  expect(await pending).toBe("maintained")
  expect(end).toHaveBeenCalledOnce()
  unregister()
})

it("releases desktop admission after a native drain failure without stopping the Host", async () => {
  const api = await connect(),
    end = vi.fn(),
    operation = vi.fn()
  const unregister = api.registerDesktopBotMaintenanceParticipant({
    drain: async () => {
      throw new Error("native work not drained")
    },
    end
  })
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toThrow("native work not drained")
  expect(operation).not.toHaveBeenCalled()
  expect(fixture.restart).not.toHaveBeenCalled()
  expect(end).toHaveBeenCalledOnce()
  api.assertDesktopBotConnectionAvailable()
  unregister()
})

it("restarts only the displayed idle Host and returns the replacement status", async () => {
  fixture.descriptor = ready
  const api = await connect()
  const original = await api.getDesktopBotClient()
  fixture.restart.mockImplementation(async () => {
    fixture.descriptor = undefined
    return { accepted: true, reason: null }
  })
  const pending = api.restartDesktopBotHost(ready.hostId)
  await vi.advanceTimersByTimeAsync(10)
  expect(fixture.clients[0].closed).toBe(true)
  expect(fixture.spawn).toHaveBeenCalledOnce()
  fixture.descriptor = { ...ready, hostId: "replacement" }
  await vi.advanceTimersByTimeAsync(500)
  expect(await pending).toMatchObject({ hostId: "replacement" })
  expect(await api.getDesktopBotClient()).not.toBe(original)
  expect(fixture.restart).toHaveBeenCalledOnce()
})

it("rejects stale and busy restart requests without terminating the current connection", async () => {
  fixture.descriptor = ready
  const api = await connect()
  const original = await api.getDesktopBotClient()
  await expect(api.restartDesktopBotHost("old-host")).rejects.toMatchObject({
    code: "host_changed"
  })
  expect(fixture.restart).not.toHaveBeenCalled()
  fixture.restart.mockResolvedValue({
    accepted: false,
    reason: "仍有任务执行或等待回复"
  })
  await expect(api.restartDesktopBotHost(ready.hostId)).rejects.toMatchObject({
    code: "host_busy"
  })
  expect(fixture.clients[0].closed).toBe(false)
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(await api.getDesktopBotClient()).toBe(original)
})

it.each(["missing", "unresponsive"])("does not report a restart for a %s Host", async (kind) => {
  if (kind === "unresponsive") {
    fixture.descriptor = ready
    fixture.status.mockImplementation(() => new Promise(() => {}))
  }
  const api = await connect()
  const pending = api.restartDesktopBotHost(ready.hostId).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(3500)
  expect(await pending).toMatchObject({ code: "host_unavailable" })
  expect(fixture.restart).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})

it("keeps one launch pending across a slow cold start and shares it between windows", async () => {
  const api = await connect()
  const first = api.getDesktopBotClient()
  const second = api.getDesktopBotClient()
  // Capture rejection immediately: the old five-second loop must fail this test,
  // without turning the regression into an unhandled promise rejection.
  const outcome = Promise.all([first, second]).then(
    (clients) => ({ clients, error: null }),
    (error) => ({ clients: null, error })
  )
  await vi.advanceTimersByTimeAsync(6000)
  fixture.descriptor = ready
  await vi.advanceTimersByTimeAsync(500)
  const result = await outcome
  expect(result.error).toBeNull()
  expect(result.clients?.[0]).toBe(result.clients?.[1])
  expect(fixture.spawn).toHaveBeenCalledTimes(1)
  expect(child.unref).toHaveBeenCalledOnce()
})

it("waits beyond normal startup only while verified recovery makes supervised progress", async () => {
  fixture.descriptor = { ...ready, hostId: "starting" }
  let sequence = 0
  fixture.recoveryProgress.mockImplementation(async () => ({
    format: 1,
    owner: {
      pid: 123,
      hostTokenSha256: "a".repeat(64),
      root: { dev: "1", ino: "2" },
      lock: { dev: "1", ino: "3" }
    },
    nonce: "70f04d3c-ef11-48e6-9446-c4c9fd6a8a3e",
    operation: "startup-restore",
    phase: "prepare",
    component: "data",
    activity: "native-sqlite",
    startedAt: Date.now() - 1000,
    updatedAt: Date.now(),
    sequence: ++sequence,
    entries: 0,
    bytes: 0
  }))
  // A stable start time belongs to one operation; heartbeats cannot start it anew.
  const startedAt = Date.now() - 1000
  const implementation = fixture.recoveryProgress.getMockImplementation()!
  fixture.recoveryProgress.mockImplementation(async () => ({
    ...(await implementation()),
    startedAt
  }))
  const api = await connect()
  let completed = false
  const pending = api.getDesktopBotClient().then((result) => {
    completed = true
    return result
  })
  await vi.advanceTimersByTimeAsync(35_000)
  expect(completed).toBe(false)
  fixture.descriptor = ready
  await vi.advanceTimersByTimeAsync(500)
  expect(await pending).toBe(fixture.clients.at(-1))
  expect(fixture.spawn).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("does not extend startup for an unverified recovery record", async () => {
  fixture.descriptor = { ...ready, hostId: "starting" }
  const api = await connect()
  const outcome = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(30_500)
  expect(await outcome).toMatchObject({
    message: expect.stringContaining("超时")
  })
  expect(fixture.recoveryProgress).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("accepts the other lock owner after the launched contender exits cleanly", async () => {
  const api = await connect()
  const pending = api.getDesktopBotClient()
  await vi.advanceTimersByTimeAsync(10)
  child.emit("exit", 0, null)
  await vi.advanceTimersByTimeAsync(600)
  fixture.descriptor = ready
  await vi.advanceTimersByTimeAsync(500)
  expect(await pending).toBe(fixture.clients.at(-1))
  expect(fixture.spawn).toHaveBeenCalledTimes(1)
})

it("reports a crashed launch promptly and allows a fresh retry", async () => {
  const api = await connect()
  const failed = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(10)
  child.emit("exit", 1, null)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await failed).toMatchObject({
    message: expect.stringContaining("启动失败")
  })
  fixture.descriptor = ready
  expect(await api.getDesktopBotClient()).toBe(fixture.clients.at(-1))
  expect(fixture.spawn).toHaveBeenCalledTimes(1)
})

it("bounds repeated failed launches without extending backoff on snapshot polling", async () => {
  let clock = 0
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  const api = await connect()
  const failLaunch = async () => {
    const pending = api.getDesktopBotClient().catch((error: Error) => error)
    const shared = api.getDesktopBotClient().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10)
    child.emit("exit", 1, null)
    await vi.advanceTimersByTimeAsync(500)
    const error = await pending
    expect(error).toMatchObject({ message: expect.stringContaining("启动失败") })
    expect(await shared).toBe(error)
    expect(child.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    return error
  }
  let error = await failLaunch()
  let launches = 1
  for (const delay of [5000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    const retryAt = clock + delay
    for (let poll = 0; poll < 20; poll++) {
      clock = retryAt - 1
      await expect(api.getDesktopBotClient()).rejects.toBe(error)
    }
    expect(fixture.spawn).toHaveBeenCalledTimes(launches)
    clock = retryAt
    error = await failLaunch()
    expect(fixture.spawn).toHaveBeenCalledTimes(++launches)
  }
  // Another launcher can become ready during cooldown: admission to an
  // authenticated existing owner is immediate and resets the failure count.
  fixture.descriptor = ready
  expect(await api.getDesktopBotClient()).toBe(fixture.clients.at(-1))
  expect(fixture.spawn).toHaveBeenCalledTimes(launches)
  fixture.descriptor = undefined
  fixture.status.mockRejectedValue(new Error("old connection ended"))
  error = await failLaunch()
  expect(fixture.spawn).toHaveBeenCalledTimes(++launches)
  clock += 4999
  await expect(api.getDesktopBotClient()).rejects.toBe(error)
  clock += 1
  await failLaunch()
  expect(fixture.spawn).toHaveBeenCalledTimes(launches + 1)
})

it("clears failed launch backoff after successful maintenance, not rejected maintenance", async () => {
  const api = await connect()
  const pending = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(10)
  child.emit("exit", 1, null)
  await vi.advanceTimersByTimeAsync(500)
  const error = await pending
  await expect(
    api.withDesktopBotMaintenance(async () => {
      throw new Error("maintenance rejected")
    })
  ).rejects.toThrow("maintenance rejected")
  await expect(api.getDesktopBotClient()).rejects.toBe(error)
  expect(fixture.spawn).toHaveBeenCalledOnce()
  expect(await api.withDesktopBotMaintenance(async () => "maintained")).toBe("maintained")
  const retried = api.getDesktopBotClient().catch((next: Error) => next)
  await vi.advanceTimersByTimeAsync(10)
  expect(fixture.spawn).toHaveBeenCalledTimes(2)
  child.emit("exit", 1, null)
  await vi.advanceTimersByTimeAsync(500)
  expect(await retried).toBeInstanceOf(Error)
  expect(child.eventNames()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it("reports a spawn error without exposing raw process arguments or retaining listeners", async () => {
  fixture.spawn.mockImplementation(() => {
    setTimeout(() => child.emit("error", new Error("sensitive-launch-arguments")), 0)
    return child
  })
  const api = await connect()
  const failed = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(10)
  expect(await failed).toMatchObject({
    message: "Bot 后台启动失败，请检查应用安装是否完整"
  })
  expect(child.eventNames()).toEqual([])
  expect(child.unref).not.toHaveBeenCalled()
})

it("bounds a stale descriptor probe and connects to the later authenticated host", async () => {
  fixture.descriptor = { ...ready, hostId: "stale" }
  fixture.status.mockImplementation((descriptor: BotHostDescriptor) =>
    descriptor.hostId === "stale"
      ? new Promise(() => {})
      : Promise.resolve({ hostId: descriptor.hostId })
  )
  const api = await connect()
  const pending = api.getDesktopBotClient()
  await vi.advanceTimersByTimeAsync(3500)
  expect(fixture.spawn).toHaveBeenCalledTimes(1)
  expect(fixture.clients[0].closed).toBe(true)
  fixture.descriptor = ready
  await vi.advanceTimersByTimeAsync(3500)
  expect(await pending).toBe(fixture.clients.at(-1))
})

it("times out a nonresponsive host without leaving probes or accepting a late response", async () => {
  const late: ((value: unknown) => void)[] = []
  fixture.descriptor = ready
  fixture.status.mockImplementation(() => new Promise((resolve) => late.push(resolve)))
  const api = await connect()
  const pending = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(30_500)
  expect(await pending).toMatchObject({
    message: expect.stringContaining("超时")
  })
  expect(fixture.clients.every((client) => client.closed)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  for (const resolve of late) resolve({ hostId: ready.hostId })
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.upgrade).not.toHaveBeenCalled()
  fixture.status.mockResolvedValue({ hostId: ready.hostId })
  const retry = await api.getDesktopBotClient()
  expect(retry).toBe(fixture.clients.at(-1))
  expect(fixture.clients.at(-1)?.closed).toBe(false)
})

it("does not accept a status from a different host identity", async () => {
  fixture.descriptor = ready
  fixture.status.mockResolvedValue({ hostId: "another-host" })
  const api = await connect()
  const pending = api.getDesktopBotClient().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(30_500)
  expect(await pending).toBeInstanceOf(Error)
  expect(fixture.clients.every((client) => client.closed)).toBe(true)
  expect(fixture.upgrade).not.toHaveBeenCalled()
})

it("connects to an existing host without spawning or duplicating its status query", async () => {
  fixture.descriptor = ready
  const api = await connect()
  const first = await api.getDesktopBotClient()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.status).toHaveBeenCalledTimes(1)
  expect(await api.getDesktopBotClient()).toBe(first)
  expect(fixture.status).toHaveBeenCalledTimes(2)
})

it("keeps the older usable client when its read-only upgrade preflight exceeds the original deadline", async () => {
  fixture.descriptor = ready
  fixture.status.mockResolvedValue({ hostId: ready.hostId, buildId: "older-build" })
  const actual = await vi.importActual<typeof import("./host-upgrade")>("./host-upgrade")
  fixture.upgrade.mockImplementation((...args) => {
    return actual.requestBotHostUpgrade(
      ...(args as Parameters<typeof actual.requestBotHostUpgrade>)
    )
  })
  let finish!: (value: unknown) => void
  fixture.inspectResources.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
  const api = await connect()
  const pending = api.getDesktopBotClient()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.inspectResources).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30_500)
  expect(fixture.clients[0].closed).toBe(false)
  expect(fixture.restart).not.toHaveBeenCalled()
  finish({ mode: "active-owner", review: { state: "ready" } })
  expect(await pending).toBe(fixture.clients[0])
  expect(fixture.clients[0].closed).toBe(false)
  expect(fixture.restart).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps the older authenticated client after an upgrade reader error", async () => {
  fixture.descriptor = ready
  fixture.status.mockResolvedValue({ hostId: ready.hostId, buildId: "older-build" })
  const actual = await vi.importActual<typeof import("./host-upgrade")>("./host-upgrade")
  fixture.upgrade.mockImplementation((...args) => {
    return actual.requestBotHostUpgrade(
      ...(args as Parameters<typeof actual.requestBotHostUpgrade>)
    )
  })
  fixture.inspectResources.mockRejectedValue(new Error("resource reader unavailable"))
  const api = await connect()
  expect(await api.getDesktopBotClient()).toBe(fixture.clients[0])
  expect(fixture.inspectResources).toHaveBeenCalledOnce()
  expect(fixture.clients[0].closed).toBe(false)
  expect(fixture.restart).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})

it("keeps the same client when the restart continuation crosses its deadline after a ready read", async () => {
  fixture.descriptor = ready
  fixture.status.mockResolvedValue({ hostId: ready.hostId, buildId: "older-build" })
  const actual = await vi.importActual<typeof import("./host-upgrade")>("./host-upgrade")
  fixture.upgrade.mockImplementation(async (...args) => {
    const [client, status, desiredBuild, ports] = args as Parameters<
      typeof actual.requestBotHostUpgrade
    >
    if (!ports) throw new Error("Main must supply its real upgrade ports")
    const checked = await ports.negativePreflight()
    expect(checked).toBeNull()
    // Cross only the continuation boundary, after the read was already ready.
    await vi.advanceTimersByTimeAsync(30_001)
    return actual.requestBotHostUpgrade(client, status, desiredBuild, {
      negativePreflight: async () => checked,
      restartIfIdle: ports.restartIfIdle
    })
  })
  const api = await connect()
  expect(await api.getDesktopBotClient()).toBe(fixture.clients[0])
  expect(fixture.clients[0].closed).toBe(false)
  expect(fixture.inspectResources).toHaveBeenCalledOnce()
  expect(fixture.restart).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("continues maintenance when the accepted old host removes its descriptor during the read", async () => {
  fixture.descriptor = ready
  const api = await connect()
  await api.getDesktopBotClient()
  // Simulate the real packaged failure: an exists check could see this file,
  // while the next actual read sees ENOENT after the old Host releases its lock.
  fixture.readDescriptor.mockImplementationOnce(() => {
    throw Object.assign(new Error("descriptor removed on shutdown"), {
      code: "ENOENT"
    })
  })
  const operation = vi.fn().mockResolvedValue("checkpoint-saved")
  expect(await api.withDesktopBotMaintenance(operation)).toBe("checkpoint-saved")
  expect(fixture.restart).toHaveBeenCalledOnce()
  expect(operation).toHaveBeenCalledOnce()
  expect(fixture.clients[0].closed).toBe(true)
})

it("does not enter maintenance if another host replaces the descriptor after idle restart", async () => {
  fixture.descriptor = ready
  const api = await connect()
  await api.getDesktopBotClient()
  fixture.restart.mockImplementation(async () => {
    fixture.descriptor = { ...ready, hostId: "new-owner" }
    return { accepted: true, reason: null }
  })
  const operation = vi.fn()
  await expect(api.withDesktopBotMaintenance(operation)).rejects.toThrow("其他窗口已启动")
  expect(operation).not.toHaveBeenCalled()
})

it("rejects installation while the Host has unfinished work and keeps the connection usable", async () => {
  fixture.descriptor = ready
  fixture.restart.mockResolvedValue({
    accepted: false,
    reason: "仍有任务执行或等待回复"
  })
  const api = await connect()
  const client = await api.getDesktopBotClient()
  const install = vi.fn()
  await expect(api.withDesktopBotUpdate(install)).rejects.toThrow("等待回复")
  expect(install).not.toHaveBeenCalled()
  expect(fixture.acquire).not.toHaveBeenCalled()
  expect(await api.getDesktopBotClient()).toBe(client)
  expect(fixture.clients[0].closed).toBe(false)
})

it.each(["missing", "unresponsive"])(
  "refuses installation when the %s descriptor hides a live lock owner",
  async (kind) => {
    if (kind === "unresponsive") {
      fixture.descriptor = ready
      fixture.status.mockImplementation(() => new Promise(() => {}))
    }
    fixture.acquire.mockReturnValue(null)
    const api = await connect()
    const install = vi.fn()
    const outcome = api.withDesktopBotUpdate(install).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(3100)
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("仍在运行")
    })
    expect(install).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.clients.every((client) => client.closed)).toBe(true)
  }
)

it("holds desktop admission and the lifetime lock throughout installation and delayed app exit", async () => {
  fixture.descriptor = ready
  fixture.restart.mockImplementation(async () => {
    fixture.descriptor = undefined
    return { accepted: true, reason: null }
  })
  const api = await connect()
  let started!: () => void
  const install = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        started = resolve
      })
  )
  const pending = api.withDesktopBotUpdate(install)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.restart).toHaveBeenCalledOnce()
  expect(fixture.acquire).toHaveBeenCalledOnce()
  expect(install).toHaveBeenCalledOnce()
  await expect(api.getDesktopBotClient()).rejects.toThrow("安装更新")
  await expect(api.withDesktopBotMaintenance(vi.fn())).rejects.toThrow("安装更新")
  await expect(api.withDesktopBotUpdate(vi.fn())).rejects.toThrow("安装更新")
  started()
  await pending
  await expect(api.getDesktopBotClient()).rejects.toThrow("安装更新")
  expect(fixture.release).not.toHaveBeenCalled()
  expect(process.listeners("exit").length).toBe(exitListeners.length + 1)
})

it("releases both fences after launch failure so a user can retry", async () => {
  const api = await connect()
  await expect(
    api.withDesktopBotUpdate(async () => {
      throw new Error("launch failed")
    })
  ).rejects.toThrow("launch failed")
  expect(fixture.release).toHaveBeenCalledOnce()
  expect(process.listeners("exit")).toEqual(exitListeners)
  fixture.descriptor = ready
  expect(await api.getDesktopBotClient()).toBe(fixture.clients.at(-1))
})

it("desktop startup retains trusted native provider configuration without command credentials", async () => {
  const native = {
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "/fixture/verified-native",
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "a".repeat(64),
    CMB_BOT_DELEGATED_CGROUP_DIRECTORY: "/fixture/delegated-cgroup",
    CMB_BOT_SHELL_PIDS_MAX: "512",
    CMB_BOT_SHELL_MEMORY_MAX_BYTES: "2147483648"
  }
  for (const [key, value] of Object.entries(native)) vi.stubEnv(key, value)
  vi.stubEnv("CMB_BOT_NATIVE_FORCE_READY", "true")
  vi.stubEnv("MODEL_API_KEY", "private-model-key")
  const api = await connect(),
    pending = api.getDesktopBotClient()
  await vi.advanceTimersByTimeAsync(10)
  fixture.descriptor = ready
  await vi.advanceTimersByTimeAsync(500)
  await pending
  expect(fixture.spawn).toHaveBeenCalledOnce()
  const options = fixture.spawn.mock.calls[0][2]
  expect(options.env).toMatchObject(native)
  expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1")
  expect(options.env).not.toHaveProperty("CMB_BOT_NATIVE_FORCE_READY")
  expect(options.env).not.toHaveProperty("MODEL_API_KEY")
})
