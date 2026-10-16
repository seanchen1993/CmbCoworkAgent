import { AsyncResource } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore, type ModGrant } from "../control-store"
import {
  FunctionDevelopmentSessions,
  type DevelopmentActivation,
  type DevelopmentRevision,
  type DevelopmentScope
} from "./development-session"
import {
  assertDevelopmentNativeGrant,
  captureDevelopmentNativeResourceGuard,
  developmentNativeGrant,
  withDevelopmentNativeAuthority
} from "./development-native-authority"
import { withFunctionExecution } from "./execution-context"
import { assertFunctionGrant } from "./host-call"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "development-authority-boundaries-"))
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const otherStore = new ModControlStore(join(workspace, "other.sqlite"))
  const scope: DevelopmentScope = {
    workspace,
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  let sourceCurrent = true
  let activation: DevelopmentActivation | undefined
  const sessions = new FunctionDevelopmentSessions({
    assertScope: () => {},
    prepare: async () => ({ dispose: async () => {} }),
    retire: async () => {},
    activate: (next) => {
      activation = next
    },
    changed: () => {}
  })
  const revision: DevelopmentRevision = {
    componentId: randomUUID(),
    draftId: "boundaries",
    revision: 1,
    sourcePath: workspace,
    bundleDigest: "a".repeat(64),
    compiledDigest: "b".repeat(64),
    turnId: "first-turn",
    validation: "authorized-real",
    purpose: "Authority boundary verification",
    capabilities: ["tool.call", "http.fetch"]
  }
  const stage = (next: DevelopmentRevision) =>
    sessions.stage(scope, next, () => {
      if (!sourceCurrent) throw Error("MODS_DEVELOPMENT_SOURCE_CHANGED")
    })
  stage(revision)
  sessions.approve(
    scope,
    revision.componentId,
    revision.compiledDigest,
    revision.capabilities,
    () => {}
  )
  sessions.noteSettled(scope, revision.turnId, "completed")
  await vi.waitFor(() => expect(activation).toBeDefined())
  cleanups.push(async () => {
    sessions.close()
    store.close()
    otherStore.close()
    await rm(workspace, { recursive: true, force: true })
  })
  const run = <T>(work: () => Promise<T>, threadId = scope.threadId) =>
    withFunctionExecution(
      { workspace, threadId, leased: false, immediate: true, userInitiated: false },
      work
    )
  const call = <T>(work: (identity: ModGrant) => Promise<T>, method = "tool.call") =>
    run(() =>
      withDevelopmentNativeAuthority(store, workspace, scope.threadId, activation!, method, work)
    )
  return {
    workspace,
    store,
    otherStore,
    scope,
    sessions,
    revision,
    stage,
    run,
    call,
    activation: () => activation!,
    invalidateSource: () => {
      sourceCurrent = false
    }
  }
}

it("uses exact host identity and store without installing a permanent development grant", async () => {
  const f = await fixture()
  let captured!: ModGrant
  await f.call(async (identity) => {
    captured = identity
    expect(identity.modId).toBe(`development:${f.activation().id}`)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(f.store.getGrant(f.workspace, identity.modId)).toBe(identity)
    expect(() => f.store.assertGrant(identity)).not.toThrow()
    expect(() =>
      assertFunctionGrant(
        f.store,
        f.workspace,
        f.scope.threadId,
        identity,
        new AbortController().signal
      )
    ).not.toThrow()
    expect(() => assertDevelopmentNativeGrant(f.store, { ...identity })).toThrow()
    expect(() => f.store.assertGrant({ ...identity, digest: "c".repeat(64) })).toThrow()
    expect(() => f.store.assertGrant({ ...identity, epoch: identity.epoch + 1 })).toThrow()
    expect(() => f.otherStore.assertGrant(identity)).toThrow()
    expect(() => captureDevelopmentNativeResourceGuard(f.store, { ...identity })).toThrow()
    expect(() => captureDevelopmentNativeResourceGuard(f.otherStore, identity)).toThrow()
    expect(developmentNativeGrant(f.otherStore, f.workspace, identity.modId)).toBeUndefined()
    expect(developmentNativeGrant(f.store, "another-workspace", identity.modId)).toBeUndefined()
    expect(developmentNativeGrant(f.store, f.workspace, "development:forged")).toBeUndefined()
  })
  expect(f.store.getGrant(f.workspace, captured.modId)).toBeNull()
  expect(() => f.store.assertGrant(captured)).toThrow()
  expect(() => captureDevelopmentNativeResourceGuard(f.store, captured)).toThrow()
  expect(f.store.getGrant(f.workspace, "function:boundaries")).toBeNull()
})

it("denies cross-thread/workspace scope and unapproved SDK methods before invoking a host", async () => {
  const f = await fixture()
  const invoke = vi.fn(async () => undefined)
  await expect(
    f.run(
      () =>
        withDevelopmentNativeAuthority(
          f.store,
          f.workspace,
          f.scope.threadId,
          f.activation(),
          "tool.call",
          invoke
        ),
      "another-thread"
    )
  ).rejects.toThrow()
  await expect(
    f.run(() =>
      withDevelopmentNativeAuthority(
        f.store,
        "another-workspace",
        f.scope.threadId,
        f.activation(),
        "tool.call",
        invoke
      )
    )
  ).rejects.toThrow()
  await expect(f.call(invoke, "fs.write")).rejects.toThrow("CAPABILITY_DENIED")
  expect(invoke).not.toHaveBeenCalled()
})

it("expires escaped asynchronous callbacks in finally even while their execution scope remains open", async () => {
  const f = await fixture()
  await f.run(async () => {
    let late!: () => void
    await withDevelopmentNativeAuthority(
      f.store,
      f.workspace,
      f.scope.threadId,
      f.activation(),
      "tool.call",
      async (identity) => {
        late = AsyncResource.bind(() => f.store.assertGrant(identity))
        expect(() => late()).not.toThrow()
      }
    )
    expect(() => late()).toThrow("REVOKED")
  })
})

it("expires rejected calls and does not authorize their retained identity", async () => {
  const f = await fixture()
  await f.run(async () => {
    let late!: () => void
    await expect(
      withDevelopmentNativeAuthority(
        f.store,
        f.workspace,
        f.scope.threadId,
        f.activation(),
        "tool.call",
        async (identity) => {
          late = AsyncResource.bind(() => f.store.assertGrant(identity))
          throw Error("host failed")
        }
      )
    ).rejects.toThrow("host failed")
    expect(() => late()).toThrow("REVOKED")
  })
})

it.each(["stop", "source"] as const)("rechecks %s after asynchronous admission", async (kind) => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const effects = vi.fn()
  const pending = f.call(async (identity) => {
    entered.resolve()
    await gate.promise
    f.store.assertGrant(identity)
    effects()
  })
  const refused = expect(pending).rejects.toThrow()
  await entered.promise
  if (kind === "stop") await f.sessions.stop(f.scope, f.revision.componentId, () => {})
  else f.invalidateSource()
  gate.resolve()
  await refused
  expect(effects).not.toHaveBeenCalled()
})

it("revokes removed capabilities and old activation identity when adopting a narrower version", async () => {
  const f = await fixture()
  const old = f.activation()
  const next = {
    ...f.revision,
    revision: 2,
    compiledDigest: "c".repeat(64),
    turnId: "second-turn",
    capabilities: ["http.fetch"]
  }
  f.stage(next)
  f.sessions.noteSettled(f.scope, next.turnId, "completed")
  await vi.waitFor(() => expect(f.activation().revision.revision).toBe(2))
  const invoke = vi.fn(async () => undefined)
  await expect(
    f.run(() =>
      withDevelopmentNativeAuthority(
        f.store,
        f.workspace,
        f.scope.threadId,
        old,
        "tool.call",
        invoke
      )
    )
  ).rejects.toThrow()
  await expect(f.call(invoke)).rejects.toThrow("CAPABILITY_DENIED")
  expect(invoke).not.toHaveBeenCalled()
  await expect(
    f.call(async (identity) => f.store.assertGrant(identity), "http.fetch")
  ).resolves.toBeUndefined()
})

it("retains ordinary formal grants before, during, and after development authority", async () => {
  const f = await fixture()
  const formal = f.store.grant(f.workspace, "function:formal", "formal-digest", true)
  const verify = () =>
    assertFunctionGrant(
      f.store,
      f.workspace,
      f.scope.threadId,
      formal,
      new AbortController().signal
    )
  await f.run(async () => {
    expect(verify).not.toThrow()
    await withDevelopmentNativeAuthority(
      f.store,
      f.workspace,
      f.scope.threadId,
      f.activation(),
      "tool.call",
      async () => {
        expect(verify).not.toThrow()
      }
    )
    expect(verify).not.toThrow()
    f.store.grant(f.workspace, formal.modId, "changed-digest", true)
    expect(verify).toThrow("REVOKED")
  })
})
