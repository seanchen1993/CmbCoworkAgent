import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type {
  PlatformSurfaceCatalog,
  PlatformSurfaceEntry
} from "../../../shared/mods/v2/platform-surfaces"

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("./store", () => ({ useAppStore: { getState: () => fixture.state } }))
import {
  assertSurfaceDevelopmentCurrent,
  captureSurfaceNavigationScope,
  dismissPlatformSurfaceIntent,
  exactSurfaceEntries,
  readPlatformSurfaceIntent,
  requestPlatformSurface,
  surfaceNavigationScopeCurrent
} from "./platform-surface-intent"

const digest = "c".repeat(64)
const scope = () => captureSurfaceNavigationScope("chat", "C:/owned")!
beforeEach(() => {
  const previous = readPlatformSurfaceIntent()
  if (previous) dismissPlatformSurfaceIntent(previous.id)
  fixture.state = {
    accountRevision: 1,
    currentThreadId: "chat",
    showCustomizeView: false,
    threads: [{ thread_id: "chat", created_at: "one", metadata: { workspacePath: "C:/owned" } }],
    setShowCustomizeView: vi.fn(),
    selectThread: vi.fn()
  }
})
afterEach(() => vi.unstubAllGlobals())

const entry = (capability: string, provider = "author"): PlatformSurfaceEntry => ({
  type: "surface",
  apiVersion: "devclaw.surface/v1",
  id: "same",
  title: capability,
  placement: "page",
  paneId: capability,
  openAction: "open",
  enabled: true,
  key: `${provider}/${capability}/generation`,
  ref: { provider, id: capability, version: "1.0.0" },
  source: { provider, digest, generation: "generation" }
})
const catalog = (...entries: PlatformSurfaceEntry[]): PlatformSurfaceCatalog => ({
  revision: 1,
  entries,
  errors: []
})

it("resolves only an exact compiled source and never conflates same-id capability keys", () => {
  const first = entry("first"),
    second = entry("second")
  expect(
    exactSurfaceEntries(catalog(first, second, entry("foreign", "foreign")), {
      provider: "author",
      compiledDigest: digest
    }).map((row) => row.key)
  ).toEqual([first.key, second.key])
  expect(() =>
    exactSurfaceEntries(catalog(first, entry("copy", "foreign")), { compiledDigest: digest })
  ).toThrow("不唯一")
  expect(
    exactSurfaceEntries(catalog({ ...first, source: { ...first.source, provider: "wrong" } }), {
      compiledDigest: digest
    })
  ).toEqual([])
})

it.each(["account", "workspace", "birth"])(
  "invalidates navigation after same-thread %s change",
  (kind) => {
    const old = scope()
    if (kind === "account") fixture.state.accountRevision = 2
    else
      fixture.state.threads = [
        {
          thread_id: "chat",
          created_at: kind === "birth" ? "two" : "one",
          metadata: { workspacePath: kind === "workspace" ? "C:/new" : "C:/owned" }
        }
      ]
    expect(surfaceNavigationScopeCurrent(old)).toBe(false)
    expect(() =>
      requestPlatformSurface({
        ...old,
        provider: "author",
        compiledDigest: digest,
        entryKey: "key",
        surfaceId: "same"
      })
    ).toThrow()
    expect(readPlatformSurfaceIntent()).toBeNull()
  }
)

it("claims only an explicit navigation and keeps its full source key", () => {
  requestPlatformSurface({
    ...scope(),
    provider: "author",
    compiledDigest: digest,
    entryKey: "second-key",
    surfaceId: "same"
  })
  const requested = readPlatformSurfaceIntent()!
  expect(requested).toMatchObject({
    provider: "author",
    compiledDigest: digest,
    entryKey: "second-key"
  })
  dismissPlatformSurfaceIntent("foreign")
  expect(readPlatformSurfaceIntent()).toBe(requested)
  dismissPlatformSurfaceIntent(requested.id)
  expect(readPlatformSurfaceIntent()).toBeNull()
})

it("rechecks the host's actual active revision and rejects a pending or replaced trial", async () => {
  let trial = {
    componentId: "component",
    phase: "active",
    compiledDigest: digest,
    activeDigest: digest,
    revision: 2,
    activeRevision: 2
  }
  const status = vi.fn(async () => ({
    threadId: "chat",
    workspace: "C:/owned",
    enabled: true,
    trials: [trial]
  }))
  vi.stubGlobal("window", { api: { mods: { development: { status } } } })
  await expect(assertSurfaceDevelopmentCurrent(scope(), "component", digest, 2)).resolves.toBe(2)
  trial = { ...trial, phase: "needs-approval", revision: 3 }
  await expect(assertSurfaceDevelopmentCurrent(scope(), "component", digest, 2)).rejects.toThrow(
    "试用版本"
  )
  trial = {
    ...trial,
    phase: "active",
    revision: 3,
    activeRevision: 3,
    activeDigest: "d".repeat(64)
  }
  await expect(assertSurfaceDevelopmentCurrent(scope(), "component", digest, 2)).rejects.toThrow(
    "试用版本"
  )
  expect(status).toHaveBeenCalledTimes(3)
})
