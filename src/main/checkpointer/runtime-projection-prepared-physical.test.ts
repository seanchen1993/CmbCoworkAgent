import * as fileIdentity from "./checkpoint-database-identity"
import { EventEmitter } from "node:events"
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { afterEach, expect, it, vi } from "vitest"
import { CheckpointRuntimeProjectionClient } from "./runtime-projection-client"
import { resolveCheckpointDatabaseIdentity } from "./checkpoint-database-identity"
import { runCheckpointDatabaseMaintenance } from "./checkpoint-database-admission"
import type {
  PreparedNativeDataFacts,
  PreparedNativeDataSource
} from "./runtime-projection-protocol"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function facts(): PreparedNativeDataFacts {
  return {
    checkpointId: "point",
    parentCheckpointId: null,
    checkpointTs: "time",
    state: {
      version: 1,
      logicalSessionId: "logical",
      conversationId: "conversation",
      branchId: "branch",
      frontier: 0
    },
    stateDigest: "a".repeat(64),
    nativeMessageCount: 0,
    nativeSnapshotDigest: "b".repeat(64),
    stamped: [],
    chainSeal: [],
    sealedPlanDigest: "c".repeat(64)
  }
}
// Controlled transport only; Saver role/source/Store authority is tested by the real native suites.
class ControlledWorker extends EventEmitter {
  readonly posted: Array<{ type: string; requestId?: number; ok?: boolean; source?: unknown }> = []
  readonly exitGate = deferred()
  terminated = false
  ref() {
    return this
  }
  unref() {
    return this
  }
  postMessage(message: (typeof this.posted)[number]) {
    if (message.type === "shutdown") {
      this.emit("message", { type: "shutdown-complete" })
      return
    }
    this.posted.push(message)
  }
  async terminate() {
    this.terminated = true
    await this.exitGate.promise
    this.emit("exit", 0)
    return 0
  }
  pull(id = 1) {
    this.emit("message", { type: "prepared-native-source-request", requestId: id })
  }
  final(id = 1, value: unknown = facts()) {
    this.emit("message", {
      type: "prepared-native-data-result",
      requestId: id,
      ok: true,
      facts: value
    })
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prepared-physical-")),
    path = join(root, "cp.sqlite")
  await writeFile(path, "owned identity transport fixture")
  const identity = await resolveCheckpointDatabaseIdentity(path),
    worker = new ControlledWorker()
  const client = new CheckpointRuntimeProjectionClient(async () => worker as unknown as Worker)
  const requests: Promise<unknown>[] = []
  cleanups.push(async () => {
    worker.exitGate.resolve()
    try {
      await client.close()
      await Promise.allSettled(requests)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const source: PreparedNativeDataSource = {
    file: identity.capturedFile!,
    parentCheckpointId: null,
    checkpoint: { type: "json", bytes: "{}" },
    metadata: { type: "json", bytes: "{}" },
    messages: null
  }
  const readSource = vi.fn(() => source),
    assertSource = vi.fn(() => undefined)
  const signal = new AbortController()
  const options = {
    checkpointSource: { identity, file: identity.capturedFile!, assertCurrent: assertSource },
    signal: signal.signal,
    readSource
  }
  const start = () => {
    const request = client.readPreparedNativeData(path, "physical", "native", "point", options)
    requests.push(request)
    void request.catch(() => undefined)
    return request
  }
  return {
    root,
    path,
    identity,
    worker,
    client,
    source,
    readSource,
    assertSource,
    signal,
    options,
    start
  }
}

it("posts only metadata before one authenticated active-source pull", async () => {
  const f = await fixture()
  const running = f.start()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  expect(f.worker.posted[0].type).toBe("prepared-native-data")
  expect(f.worker.posted[0]).not.toHaveProperty("source")
  expect(f.readSource).not.toHaveBeenCalled()
  expect(f.assertSource).toHaveBeenCalledTimes(3)
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  expect(f.readSource).toHaveBeenCalledTimes(1)
  expect(f.assertSource).toHaveBeenCalledTimes(5)
  expect(f.worker.posted[1]).toMatchObject({
    type: "prepared-native-source-response",
    ok: true,
    source: f.source
  })
  f.worker.final()
  expect(await running).toEqual(facts())
  expect(f.assertSource).toHaveBeenCalledTimes(7)
})

it("rejects a prepared request without a Saver guard before posting work", async () => {
  const f = await fixture()
  const options = {
    ...f.options,
    checkpointSource: { ...f.options.checkpointSource, assertCurrent: undefined! }
  }
  await expect(f.client.readPreparedNativeData(f.path, "physical", "native", "point", options))
    .rejects.toThrow("PREPARED_NATIVE_SOURCE_PROTOCOL")
  expect(f.worker.posted).toHaveLength(0)
  expect(f.readSource).not.toHaveBeenCalled()
})

it("rechecks the Saver guard after the asynchronous pull verification", async () => {
  const f = await fixture()
  const release = deferred()
  const originalVerify = fileIdentity.assertCheckpointDatabaseFileIdentity
  let pulling = false, entered = false
  const verify = vi
    .spyOn(fileIdentity, "assertCheckpointDatabaseFileIdentity")
    .mockImplementation(async (path, file) => {
      await originalVerify(path, file)
      if (pulling && path === f.identity.path) {
        entered = true
        await release.promise
      }
    })
  const running = f.start().catch((error) => error)
  let settled = false
  void running.then(() => { settled = true })
  try {
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    pulling = true
    f.worker.pull()
    await vi.waitFor(() => expect(entered).toBe(true))
    const stale = Error("Saver source retired after pull")
    f.assertSource.mockImplementation(() => {
      throw stale
    })
    release.resolve()
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
    expect(f.worker.posted[1]).toMatchObject({ type: "prepared-native-source-response", ok: false })
    expect(f.worker.posted[1]).not.toHaveProperty("source")
    expect(f.readSource).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    f.worker.final()
    expect(await running).toBe(stale)
  } finally {
    release.resolve()
    verify.mockRestore()
  }
})

it("holds the Saver-facing promise and shared database admission through canceled actual final", async () => {
  const f = await fixture()
  let completed = false
  const running = f
    .start()
    .catch((error) => error as Error)
    .finally(() => {
      completed = true
    })
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  f.signal.abort(Error("original abort"))
  let maintenanceEntered = false
  const maintenance = runCheckpointDatabaseMaintenance(f.identity.key, async () => {
    maintenanceEntered = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(maintenanceEntered).toBe(false)
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  expect(f.worker.posted[1]).toMatchObject({ ok: false })
  expect(f.readSource).not.toHaveBeenCalled()
  f.worker.final()
  expect(await running).toMatchObject({ message: "original abort" })
  await maintenance
  expect(maintenanceEntered).toBe(true)
})

it.each(["duplicate", "wrong"] as const)(
  "rejects %s request pulls without another getter and drains true Worker exit",
  async (kind) => {
    const f = await fixture()
    let completed = false
    const running = f
      .start()
      .catch((error) => error as Error)
      .finally(() => {
        completed = true
      })
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    if (kind === "duplicate") {
      f.worker.pull()
      await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
    }
    f.worker.pull(kind === "duplicate" ? 1 : 999)
    await vi.waitFor(() => expect(f.worker.terminated).toBe(true))
    expect(completed).toBe(false)
    expect(f.readSource).toHaveBeenCalledTimes(kind === "duplicate" ? 1 : 0)
    f.worker.exitGate.resolve()
    expect(await running).toBeInstanceOf(Error)
  }
)

it("reports original file replacement and waits corresponding physical final", async () => {
  const f = await fixture()
  let completed = false
  const running = f
    .start()
    .catch((error) => error as Error)
    .finally(() => {
      completed = true
    })
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  await rename(f.path, join(f.root, "old.sqlite"))
  await writeFile(f.path, "replacement inode")
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  expect(f.worker.posted[1]).toMatchObject({ ok: false })
  expect(completed).toBe(false)
  f.worker.final()
  expect(await running).toMatchObject({ message: "SQLJS_SAVER_DATABASE_IDENTITY_CHANGED" })
})

it("owns compact facts synchronously before another listener mutates the same message", async () => {
  const f = await fixture(),
    running = f.start()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  const original = {
    ...facts(),
    nativeMessageCount: 1,
    stamped: [
      {
        ordinal: 0,
        stamp: {
          conversationId: "conversation",
          branchId: "branch",
          uuid: "uuid",
          sequence: 1,
          messageType: "user" as const,
          door: "note" as const,
          origin: { kind: "composer" as const }
        }
      }
    ]
  }
  f.worker.on("message", (wire) => {
    if (wire.type === "prepared-native-data-result") {
      original.state.frontier = 99
      original.stamped[0].stamp.sequence = 99
    }
  })
  f.worker.final(1, original)
  const result = await running
  expect(result.state.frontier).toBe(0)
  expect(result.stamped[0].stamp.sequence).toBe(1)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.state)).toBe(true)
  expect(Object.isFrozen(result.stamped)).toBe(true)
  expect(Object.isFrozen(result.stamped[0].stamp.origin)).toBe(true)
})

it.each(["premature", "getter"] as const)(
  "rejects %s success without granting unsafe facts",
  async (kind) => {
    const f = await fixture()
    const running = f.start().catch((error) => error as Error)
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    if (kind === "getter") {
      f.worker.pull()
      await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
    }
    let getters = 0
    const value = facts()
    if (kind === "getter")
      Object.defineProperty(value, "state", {
        enumerable: true,
        get: () => {
          getters++
          throw Error("must not execute")
        }
      })
    f.worker.final(1, value)
    await vi.waitFor(() => expect(f.worker.terminated).toBe(true))
    expect(getters).toBe(0)
    f.worker.exitGate.resolve()
    expect(await running).toBeInstanceOf(Error)
  }
)

it("defines each compact list slot without inherited index setters", async () => {
  const f = await fixture(),
    running = f.start()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  const value: PreparedNativeDataFacts = {
    ...facts(),
    nativeMessageCount: 4,
    stamped: Array.from({ length: 4 }, (_, ordinal) => ({
      ordinal,
      stamp: {
        conversationId: "conversation",
        branchId: "branch",
        uuid: `uuid${ordinal}`,
        sequence: ordinal + 1,
        messageType: "user",
        door: "note",
        origin: { kind: "composer" }
      }
    })),
    chainSeal: Array.from({ length: 4 }, (_, index) => ({
      checkpointId: `parent${index}`,
      parentCheckpointId: index === 3 ? null : `parent${index + 1}`,
      prefixLength: 0,
      messageCount: 4,
      generation: "original",
      type: "json",
      rawDigest: "d".repeat(64)
    }))
  }
  const original1 = Object.getOwnPropertyDescriptor(Array.prototype, "1")
  const original3 = Object.getOwnPropertyDescriptor(Array.prototype, "3")
  let setters = 0,
    getters = 0
  try {
    Object.defineProperty(Array.prototype, "1", {
      configurable: true,
      set: () => {
        setters++
      },
      get: () => {
        getters++
        return "forged"
      }
    })
    Object.defineProperty(Array.prototype, "3", {
      configurable: true,
      set: () => {
        setters++
      },
      get: () => {
        getters++
        return "forged"
      }
    })
    // Only the synchronous real client listener runs while this test-only poison is installed.
    f.worker.final(1, value)
  } finally {
    if (original1) Object.defineProperty(Array.prototype, "1", original1)
    else Reflect.deleteProperty(Array.prototype, "1")
    if (original3) Object.defineProperty(Array.prototype, "3", original3)
    else Reflect.deleteProperty(Array.prototype, "3")
  }
  const result = await running
  expect(setters).toBe(0)
  expect(getters).toBe(0)
  expect(result).toEqual(value)
  for (const list of [result.stamped, result.chainSeal]) {
    expect(list).toHaveLength(4)
    expect(Object.isFrozen(list)).toBe(true)
    for (let index = 0; index < 4; index++)
      expect(Object.getOwnPropertyDescriptor(list, `${index}`)).toMatchObject({
        value: value[list === result.stamped ? "stamped" : "chainSeal"][index],
        enumerable: true,
        writable: false,
        configurable: false
      })
  }
})

it("owns new latch and flight slots through inherited setters and held actual file verification", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred()
  const originalVerify = fileIdentity.assertCheckpointDatabaseFileIdentity
  let armed = false,
    held = false,
    completed = false,
    setters = 0,
    getters = 0
  const verify = vi
    .spyOn(fileIdentity, "assertCheckpointDatabaseFileIdentity")
    .mockImplementation(async (path, file) => {
      await originalVerify(path, file)
      if (armed && !held && path === f.identity.path) {
        held = true
        entered.resolve()
        await release.promise
      }
    })
  const names = [
    "preparedSource",
    "preparedPulled",
    "preparedSourcePosted",
    "preparedFlight",
    "assertPreparedSource",
    "verifyPreparedFile"
  ]
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(Object.prototype, name))
  let running: Promise<unknown> | undefined
  try {
    for (const name of names)
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        set: () => {
          setters++
        },
        get: () => {
          getters++
          return undefined
        }
      })
    running = f
      .start()
      .catch((error) => error as Error)
      .finally(() => {
        completed = true
      })
    await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
    const records = Object.getOwnPropertyDescriptor(f.client, "physical")!.value as Map<
      number,
      object
    >
    const record = records.get(1)!
    for (const name of names)
      expect(Object.getOwnPropertyDescriptor(record, name)).toHaveProperty("value")
    armed = true
    f.worker.pull()
    await entered.promise
    expect(f.readSource).toHaveBeenCalledTimes(1)
    f.worker.pull()
    await vi.waitFor(() => expect(f.worker.terminated).toBe(true))
    const exited = deferred()
    f.worker.once("exit", () => exited.resolve())
    f.worker.exitGate.resolve()
    await exited.promise
    // Let all exit/finally microtasks settle while the real file verifier remains held.
    await new Promise<void>((done) => setImmediate(done))
    expect(completed).toBe(false)
    expect(records.has(1)).toBe(true)
    expect(f.readSource).toHaveBeenCalledTimes(1)
    expect(setters).toBe(0)
    expect(getters).toBe(0)
    release.resolve()
    await running
    expect(records.has(1)).toBe(false)
  } finally {
    release.resolve()
    for (let index = 0; index < names.length; index++) {
      if (previous[index]) Object.defineProperty(Object.prototype, names[index], previous[index]!)
      else Reflect.deleteProperty(Object.prototype, names[index])
    }
    verify.mockRestore()
    await running
  }
})

it("finishes the entire owned freeze before original stamp validation can call back", async () => {
  const f = await fixture(),
    running = f.start()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(1))
  f.worker.pull()
  await vi.waitFor(() => expect(f.worker.posted).toHaveLength(2))
  const value = {
    ...facts(),
    nativeMessageCount: 1,
    stamped: [
      {
        ordinal: 0,
        stamp: {
          conversationId: "conversation",
          branchId: "branch",
          uuid: "uuid",
          sequence: 1,
          messageType: "user" as const,
          door: "note" as const,
          origin: { kind: "composer" as const }
        }
      }
    ],
    chainSeal: [
      {
        checkpointId: "parent",
        parentCheckpointId: null,
        prefixLength: 0,
        messageCount: 1,
        generation: "generation",
        type: "json",
        rawDigest: "d".repeat(64)
      }
    ]
  }
  const originalPrototype = Object.getPrototypeOf,
    own = Object.getOwnPropertyDescriptor
  let callbacks = 0,
    couldMutate = false
  const prototype = vi.spyOn(Object, "getPrototypeOf").mockImplementation((candidate: unknown) => {
    if (candidate && typeof candidate === "object" && own(candidate, "uuid")?.value === "uuid") {
      callbacks++
      couldMutate = Reflect.set(candidate, "sequence", 99) || couldMutate
      value.checkpointTs = "changed raw header during original validator"
      value.state.frontier = 99
      value.chainSeal[0].rawDigest = "e".repeat(64)
    }
    return originalPrototype(candidate)
  })
  try {
    f.worker.final(1, value)
  } finally {
    prototype.mockRestore()
  }
  const result = await running
  expect(callbacks).toBeGreaterThan(0)
  expect(couldMutate).toBe(false)
  expect(result.checkpointTs).toBe("time")
  expect(result.state.frontier).toBe(0)
  expect(result.stamped[0].stamp.sequence).toBe(1)
  expect(result.chainSeal[0].rawDigest).toBe("d".repeat(64))
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.chainSeal[0])).toBe(true)
})
