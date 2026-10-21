import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionNamedState } from "./named-state"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import { functionSdkToolInput } from "./tool-sdk"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const ref = { provider: "mods-release-review", id: "release-review", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }

async function fixture(retained?: { workspace: string; generation?: string }) {
  const workspace =
    retained?.workspace ?? (await mkdtemp(join(tmpdir(), "mods-business-state-machine-")))
  if (!retained) cleanup.push(() => rm(workspace, { recursive: true, force: true }))
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const hub = new PlatformCapabilityHub(store.functionState)
  const compiled = await compileFunctionPlugin(resolve("examples/mods-release-review"))
  const guest = await FunctionGuestRuntime.create(compiled.code, {
    nodeExecutable: process.execPath
  })
  const provider: FunctionPlugin = {
    name: compiled.name,
    root: compiled.root,
    tier: "user",
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  let live = true
  let reads = 0
  let processes = 0
  let onRead: (() => Promise<void>) | undefined
  let denyProcess = false
  const namedState = new FunctionNamedState()
  const session = new FunctionSession([provider], {
    workspace,
    threadId: "release-review-test",
    namedState,
    platformHub: hub,
    platformIncarnation: "stable-test-incarnation",
    platformSource: (plugin) => ({
      provider: plugin.name,
      digest: compiled.digest,
      generation: retained?.generation ?? "grant"
    }),
    assertLive() {
      if (!live) throw Error("REVOKED")
    },
    publish: async (value) => value,
    authorizeProcess: async (_plugin, request) => {
      processes++
      if (denyProcess) throw Error("PROCESS_DENIED")
      expect(request.argv[0]).toBe(process.execPath)
      expect(request.argv[1]).toBe(compiled.root + "/scripts/validate.mjs")
    },
    callTool: async (_plugin, input, signal) => {
      signal.throwIfAborted()
      const { target, args } = functionSdkToolInput(input)
      expect(target).toBe("host:read_file")
      expect(args.file_path).toBe("release-review.json")
      reads++
      await onRead?.()
      return { result: await readFile(join(workspace, "release-review.json"), "utf8") }
    }
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await session.close(true)
    hub.close()
    store.close()
  }
  cleanup.push(close)
  const signal = new AbortController().signal
  const artifact = (value: ModObject) =>
    writeFile(join(workspace, "release-review.json"), JSON.stringify(value), "utf8")
  const act = (requestKey: string, event: string, expectedRevision: number) =>
    session.platform.act(
      provider,
      { ...query, action: "transition", input: { event, expectedRevision }, requestKey },
      signal
    )
  const state = () => session.platform.call(provider, "platform.read", [query], signal)
  return {
    workspace,
    store,
    session,
    provider,
    signal,
    artifact,
    act,
    state,
    namedState,
    close,
    stats: () => ({ reads, processes }),
    revoke: () => {
      live = false
    },
    denyProcess: () => {
      denyProcess = true
    },
    onRead: (callback: () => Promise<void>) => {
      onRead = callback
    },
    persistRows: () => {
      const namespace = hub.namespace(workspace, "workspace", "workspace")
      return store.functionState
        .keys(namespace)
        .map((key) => store.functionState.get(namespace, key))
    }
  }
}

it("runs an independent business state graph in real QuickJS using existing actions and real validators", async () => {
  const f = await fixture()
  expect(f.session.hasStarted).toBe(false)
  expect(f.session.platform.list().filter((item) => item.ref.id === "release-review")).toHaveLength(
    1
  )
  expect(f.stats()).toEqual({ reads: 0, processes: 0 })
  await f.artifact({ description: "Release reviewed changes", qualityAccepted: false })
  expect(await f.act("submit-1", "submit", 0)).toMatchObject({
    status: "succeeded",
    value: { status: "advanced", stage: "review", revision: 1 }
  })
  expect(await f.act("approve-blocked", "approve", 1)).toMatchObject({
    status: "succeeded",
    value: { status: "blocked", stage: "review" }
  })
  expect(await f.state()).toMatchObject({ revision: 1, value: { stage: "review" } })
  await f.artifact({ description: "Release reviewed changes", qualityAccepted: true })
  expect(await f.act("approve-success", "approve", 1)).toMatchObject({
    status: "succeeded",
    value: { status: "advanced", stage: "approved", revision: 2 }
  })
  expect(await f.state()).toMatchObject({
    revision: 2,
    value: {
      stage: "approved",
      evidence: { check: "approval", artifactDigest: expect.any(String) }
    }
  })
  expect(f.session.hasStarted).toBe(false)
  expect(f.persistRows()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        revision: 2,
        value: expect.objectContaining({ stage: "approved" })
      })
    ])
  )
})

it("does not advance for a missing/failed check, forged check input or an illegal edge", async () => {
  const f = await fixture()
  await f.artifact({ description: "" })
  expect(await f.act("missing-description", "submit", 0)).toMatchObject({
    value: { status: "blocked", stage: "draft" }
  })
  await expect(
    f.session.platform.act(
      f.provider,
      {
        ...query,
        action: "transition",
        input: { event: "submit", expectedRevision: 0, passed: true },
        requestKey: "forged"
      },
      f.signal
    )
  ).rejects.toThrow()
  await f.artifact({ description: "Ready", qualityAccepted: true })
  expect(await f.act("skip-stage", "approve", 0)).toMatchObject({
    value: { status: "blocked", stage: "draft" }
  })
  expect(await f.state()).toMatchObject({ status: "unknown", revision: 0 })
})

it("keeps duplicate and stale requests from advancing a second stage", async () => {
  const f = await fixture()
  await f.artifact({ description: "Ready", qualityAccepted: true })
  const first = await f.act("same-key", "submit", 0)
  const stats = f.stats()
  expect(await f.act("same-key", "submit", 0)).toEqual(first)
  expect(f.stats()).toEqual(stats)
  await expect(f.act("same-key", "approve", 1)).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
  expect(await f.act("stale", "approve", 0)).toMatchObject({
    value: { status: "conflict", stage: "review", revision: 1 }
  })
  expect(await f.state()).toMatchObject({ revision: 1, value: { stage: "review" } })
})

it("uses real SDK compare-and-set to reject overlapping transitions", async () => {
  const f = await fixture()
  await f.artifact({ description: "Ready", qualityAccepted: true })
  let entered!: () => void
  let release!: () => void
  const reading = new Promise<void>((resolveRead) => {
    entered = resolveRead
  })
  const held = new Promise<void>((resolveRead) => {
    release = resolveRead
  })
  f.onRead(async () => {
    entered()
    await held
  })
  const first = f.act("concurrent-a", "submit", 0)
  try {
    await reading
    expect(await f.act("concurrent-b", "submit", 0)).toMatchObject({ value: { status: "busy" } })
    expect(f.stats().reads).toBe(1)
  } finally {
    release()
  }
  expect(await first).toMatchObject({ value: { status: "advanced", stage: "review" } })
  expect(await f.state()).toMatchObject({ revision: 1 })
})

it("does not turn a denied real process or revoked source into successful advancement", async () => {
  const f = await fixture()
  await f.artifact({ description: "Ready", qualityAccepted: true })
  f.denyProcess()
  expect(await f.act("denied", "submit", 0)).toMatchObject({ status: "unknown" })
  expect(await f.state()).toMatchObject({ status: "unknown", revision: 0 })
  const before = f.stats()
  expect(await f.act("denied", "submit", 0)).toMatchObject({ status: "unknown" })
  expect(f.stats()).toEqual(before)
  f.revoke()
  await expect(f.act("revoked", "submit", 0)).rejects.toThrow("REVOKED")
})

it("offers an actual user command without requiring the model to interpret state transitions", async () => {
  const f = await fixture()
  await f.artifact({ description: "Ready", qualityAccepted: false })
  const initial = await f.session.run("release-review", "status", f.signal)
  expect(JSON.parse(String(initial.text))).toMatchObject({ revision: 0 })
  const submitted = await f.session.run("release-review", "submit", f.signal)
  expect(JSON.parse(String(submitted.text))).toMatchObject({
    status: "succeeded",
    value: { status: "advanced", stage: "review" }
  })
  const blocked = await f.session.run("release-review", "approve", f.signal)
  expect(JSON.parse(String(blocked.text))).toMatchObject({
    value: { status: "blocked", stage: "review" }
  })
})

it("retains completed actions after VM/session and SQLite reopen with the same authority generation", async () => {
  const original = await fixture()
  await original.artifact({ description: "Ready", qualityAccepted: true })
  const first = await original.act("survives-restart", "submit", 0)
  expect(first).toMatchObject({ value: { status: "advanced", stage: "review" } })
  await original.close()
  expect(original.provider.guest.stats.disposed).toBe(true)
  const restarted = await fixture({ workspace: original.workspace })
  expect(await restarted.act("survives-restart", "submit", 0)).toEqual(first)
  expect(restarted.stats()).toEqual({ reads: 0, processes: 0 })
  expect(await restarted.state()).toMatchObject({
    status: "ready",
    revision: 1,
    value: { stage: "review" }
  })
  expect(await restarted.act("after-restart", "approve", 1)).toMatchObject({
    value: { status: "advanced", stage: "approved", revision: 2 }
  })
})

it("shows source-inactive state after rebinding and refuses to initialize over existing business state", async () => {
  const original = await fixture()
  await original.artifact({ description: "Ready", qualityAccepted: true })
  await original.act("original", "submit", 0)
  await original.close()
  const rebound = await fixture({ workspace: original.workspace, generation: "new-grant" })
  const current = await rebound.session.run("release-review", "status", rebound.signal)
  expect(JSON.parse(String(current.text))).toMatchObject({
    status: "unknown",
    revision: 1,
    reason: "source-inactive"
  })
  expect(await rebound.act("rebound", "submit", 1)).toMatchObject({
    status: "unknown",
    error: expect.stringContaining("RELEASE_REVIEW_SOURCE_REQUIRES_RECONCILIATION")
  })
  expect(rebound.stats()).toEqual({ reads: 0, processes: 0 })
  expect(rebound.persistRows()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ revision: 1, value: expect.objectContaining({ stage: "review" }) })
    ])
  )
})
