import { describe, expect, it } from "vitest"
import { FunctionDisplayScopes } from "./display-scopes"
import {
  FunctionDisplaySnapshotCache,
  validateFunctionDisplaySnapshotData
} from "./display-snapshot-cache"
import type { FunctionDisplaySnapshotData } from "../../../shared/mods/v2/display-snapshot"
import { FunctionNamedState } from "./named-state"

const data = (text = "protected"): FunctionDisplaySnapshotData => ({
  component: "AssistantMessage",
  tree: { type: "engine", ref: 0 },
  nativeContent: {
    component: "AssistantMessage",
    entries: [{ ref: 0, props: { text, isFirstOfReply: true } }]
  }
})

function fixture(limits = {}) {
  const scopes = new FunctionDisplayScopes()
  const database = {}
  let live = true
  let now = 100
  const input = {
    database,
    threadId: "same-id",
    workspace: "/project",
    incarnation: { token: "incarnation-a", legacyCreatedAt: 1 },
    assertCurrent: () => {
      if (!live) throw Error("scope revoked")
    }
  }
  const scope = scopes.capture(input)
  const cache = new FunctionDisplaySnapshotCache(scopes, limits, () => now)
  const proof = (options = {}) =>
    cache.captureProof(scope, {
      reusable: true,
      version: "graph/config/source/policy-v1",
      assertCurrent() {
        /* Stable fixture source. */
      },
      ...options
    })!
  return {
    scopes,
    scope,
    input,
    cache,
    proof,
    revoke: () => {
      live = false
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe("host-owned display snapshots", () => {
  it("reclaims only the same scope's least recently used proof before handoff", () => {
    const f = fixture()
    const released: string[] = []
    f.cache.write(f.scope, "first", f.proof({ onEvict: () => released.push("first") }), data())
    f.cache.write(f.scope, "second", f.proof({ onEvict: () => released.push("second") }), data())
    f.cache.read(f.scope, "first")
    expect(f.cache.evictOldest(f.scope)).toBe(true)
    expect(released).toEqual(["second"])
    expect(f.cache.read(f.scope, "first")).not.toBeNull()
    expect(f.cache.read(f.scope, "second")).toBeNull()
    expect(f.cache.evictOldest(f.scope)).toBe(true)
    expect(f.cache.evictOldest(f.scope)).toBe(false)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
  })

  it("rechecks scope validity after dependency eviction callbacks", () => {
    const f = fixture()
    f.cache.write(f.scope, "first", f.proof({ onEvict: f.revoke }), data())
    expect(() => f.cache.evictOldest(f.scope)).toThrow("scope revoked")
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
  })
  it("publishes validated data without retaining it when passive cache rollout is disabled", async () => {
    const f = fixture()
    let released = 0
    const proof = () =>
      f.proof({
        onEvict: () => {
          released++
        }
      })
    const first = f.cache.write(f.scope, "key", proof(), data("uncached"), false)
    expect(first.data).toEqual(data("uncached"))
    expect(f.cache.read(f.scope, "key")).toBeNull()
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
    expect(released).toBe(1)
    let calls = 0
    const produce = async () => {
      calls++
      return data("fresh")
    }
    const second = await f.cache.resolve(f.scope, "key", proof(), produce, false)
    expect(second.data).toEqual(data("fresh"))
    await f.cache.resolve(f.scope, "key", proof(), produce, false)
    expect(calls).toBe(2)
    expect(released).toBe(3)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
  })

  it("does not share retained and unretained work across the rollback boundary", async () => {
    const f = fixture()
    let finish!: (value: FunctionDisplaySnapshotData) => void
    const retained = f.cache.resolve(
      f.scope,
      "key",
      f.proof(),
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const uncached = await f.cache.resolve(
      f.scope,
      "key",
      f.proof(),
      async () => data("rollback"),
      false
    )
    expect(uncached.data).toEqual(data("rollback"))
    expect(f.cache.stats()).toMatchObject({ entries: 0, pending: 1 })
    finish(data("retained"))
    await retained
    expect(f.cache.read(f.scope, "key")?.data).toEqual(data("retained"))
    expect(f.cache.stats()).toMatchObject({ entries: 1, pending: 0 })
  })

  it("separates database and recreated native thread identities and never revives a retired token", () => {
    const f = fixture()
    expect(f.scopes.capture(f.input)).toBe(f.scope)
    expect(f.scopes.capture({ ...f.input, database: {} }).id).not.toBe(f.scope.id)
    expect(
      f.scopes.capture({ ...f.input, incarnation: { token: "incarnation-b", legacyCreatedAt: 1 } })
        .id
    ).not.toBe(f.scope.id)
    f.scopes.deleteScope(f.scope.id)
    expect(() => f.scopes.assertCurrent(f.scope)).toThrow("MODS_DISPLAY_SCOPE_CHANGED")
    expect(f.scopes.capture(f.input).id).not.toBe(f.scope.id)
  })

  it("returns independent protected data without owner, callback, action or runtime objects", () => {
    const f = fixture()
    const original = data()
    const result = f.cache.write(f.scope, "message/block/revision", f.proof(), original)
    original.nativeContent!.entries[0].props.text = "mutated source"
    result.data.nativeContent!.entries[0].props.text = "mutated reply"
    const cached = f.cache.read(f.scope, "message/block/revision")!
    expect(cached.data.nativeContent!.entries[0].props.text).toBe("protected")
    expect(Object.keys(cached).sort()).toEqual(["data", "expiresAt", "key", "scopeId", "version"])
  })

  it("rejects unissued proof objects and unknown reuse eligibility", () => {
    const f = fixture()
    expect(
      f.cache.captureProof(f.scope, {
        reusable: false,
        version: "v1",
        assertCurrent() {
          /* Stable fixture source. */
        }
      })
    ).toBeUndefined()
    expect(() => f.cache.write(f.scope, "key", {} as ReturnType<typeof f.proof>, data())).toThrow(
      "MODS_DISPLAY_PROOF_INVALID"
    )
  })

  it.each([
    { type: "Button", props: { label: "run" }, press: { plugin: "p", handle: 1 } },
    { type: "Client", props: { key: "client" }, client: { plugin: "p" } },
    { type: "Markdown", props: { text: "link" }, press: { plugin: "p", handle: 1 } }
  ])("rejects active $type trees instead of retaining old controls", (tree) => {
    expect(() =>
      validateFunctionDisplaySnapshotData({
        component: "AssistantMessage",
        tree: tree as FunctionDisplaySnapshotData["tree"]
      })
    ).toThrow()
  })

  it("rejects authority nested inside native data", () => {
    const unsafe = data()
    unsafe.nativeContent!.entries[0].props.extra = { owner: "old owner" }
    expect(() => validateFunctionDisplaySnapshotData(unsafe)).toThrow("MODS_DISPLAY_DATA_ACTIVE")
  })

  it("rechecks source and native scope on hits, evicts rejected data and does not serve fallback", () => {
    const f = fixture()
    let source = true
    f.cache.write(
      f.scope,
      "key",
      f.proof({
        assertCurrent() {
          if (!source) throw Error("source changed")
        }
      }),
      data()
    )
    source = false
    expect(() => f.cache.read(f.scope, "key")).toThrow("source changed")
    expect(f.cache.stats().entries).toBe(0)
    f.revoke()
    expect(() => f.cache.read(f.scope, "key")).toThrow("scope revoked")
    expect(f.scopes.read(f.scope.id)).toBeUndefined()
  })

  it("evicts stale dependency results and releases their proof exactly once", () => {
    const f = fixture()
    let current = true
    let released = 0
    f.cache.write(
      f.scope,
      "key",
      f.proof({
        dependencies: {
          current: () => current,
          release: () => {
            released++
          }
        }
      }),
      data()
    )
    current = false
    expect(f.cache.read(f.scope, "key")).toBeNull()
    f.cache.clear()
    expect(released).toBe(1)
  })

  it("keeps real named-state dependencies after DOM release and reclaims them on cache eviction", () => {
    const f = fixture()
    const state = new FunctionNamedState()
    const ref = { plugin: "display", key: "count" }
    state.read(ref, { drawing: "dom-generation" })
    const dependency = state.captureDrawingDependencies("dom-generation")!
    f.cache.write(
      f.scope,
      "key",
      f.proof({
        dependencies: {
          current: () => state.drawingDependenciesCurrent(dependency),
          release: () => state.releaseDrawingDependencies(dependency)
        }
      }),
      data()
    )
    state.release("dom-generation")
    expect(f.cache.read(f.scope, "key")).not.toBeNull()
    state.write({ ...ref, value: 1 }, {})
    expect(f.cache.read(f.scope, "key")).toBeNull()
    expect(state.dependencyStats()).toEqual({ readers: 0, proofs: 0, subscriptions: 0, bytes: 0 })
  })

  it("bounds entries, expiry and bytes and releases proof resources on all eviction paths", () => {
    const f = fixture({ maxEntriesPerScope: 1, maxEntryBytes: 2000, maxBytes: 2500, maxAgeMs: 10 })
    let released = 0
    const proof = () =>
      f.proof({
        onEvict: () => {
          released++
        }
      })
    f.cache.write(f.scope, "a", proof(), data())
    f.cache.write(f.scope, "b", proof(), data())
    expect(f.cache.read(f.scope, "a")).toBeNull()
    expect(f.cache.stats().entries).toBe(1)
    f.advance(11)
    expect(f.cache.read(f.scope, "b")).toBeNull()
    f.cache.write(f.scope, "large", proof(), data("x".repeat(2000)))
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
    expect(released).toBe(3)
  })

  it("maintains separate scope LRU budgets and a shared global oldest eviction order", () => {
    const f = fixture({ maxEntriesPerScope: 2, maxBytes: 2500 })
    const other = f.scopes.capture({ ...f.input, database: {} })
    const otherProof = () =>
      f.cache.captureProof(other, {
        reusable: true,
        version: "v1",
        assertCurrent() {
          /* Current independent DB. */
        }
      })!
    f.cache.write(f.scope, "first", f.proof(), data())
    f.cache.write(other, "other", otherProof(), data())
    expect(f.cache.read(f.scope, "first")).not.toBeNull()
    f.cache.write(f.scope, "second", f.proof(), data())
    expect(f.cache.read(other, "other")).toBeNull()
    expect(f.cache.read(f.scope, "first")).not.toBeNull()
    f.cache.write(f.scope, "third", f.proof(), data())
    expect(f.cache.read(f.scope, "second")).toBeNull()
    expect(f.cache.stats().entries).toBe(2)
    f.cache.deleteScope(f.scope.id)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
  })

  it("releases failed new proofs and isolates passive cleanup failures", async () => {
    const f = fixture({ maxEntriesPerScope: 1 })
    let released = 0
    const proof = f.proof({
      onEvict() {
        released++
        throw Error("observer")
      }
    })
    expect(() =>
      f.cache.write(f.scope, "bad", proof, {
        component: "AssistantMessage",
        tree: { type: "Button", props: { key: "go", label: "go" } }
      })
    ).toThrow()
    expect(released).toBe(1)
    expect(() => f.cache.write(f.scope, "retry", proof, data())).toThrow(
      "MODS_DISPLAY_PROOF_INVALID"
    )
    const stale = f.proof({
      onEvict() {
        released++
      }
    })
    f.revoke()
    await expect(f.cache.resolve(f.scope, "late", stale, async () => data())).rejects.toThrow(
      "scope revoked"
    )
    expect(released).toBe(2)
  })

  it("coalesces pure concurrent work and rejects a source changed during its await", async () => {
    const f = fixture()
    let finish!: (value: FunctionDisplaySnapshotData) => void
    let calls = 0
    const produce = () => {
      calls++
      return new Promise<FunctionDisplaySnapshotData>((resolve) => {
        finish = resolve
      })
    }
    const first = f.cache.resolve(f.scope, "key", f.proof(), produce)
    const second = f.cache.resolve(f.scope, "key", f.proof(), produce)
    expect(calls).toBe(1)
    finish(data())
    expect(await first).toEqual(await second)
    let current = true
    const pending = f.cache.resolve(
      f.scope,
      "changed",
      f.proof({
        assertCurrent() {
          if (!current) throw Error("source changed during await")
        }
      }),
      produce
    )
    current = false
    finish(data())
    await expect(pending).rejects.toThrow("source changed during await")
    expect(f.cache.stats().entries).toBe(1)
  })

  it("rejects late writes after clear while physical work is still counted", async () => {
    const f = fixture()
    let finish!: (value: FunctionDisplaySnapshotData) => void
    const pending = f.cache.resolve(
      f.scope,
      "key",
      f.proof(),
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.cache.clear()
    expect(f.cache.stats().pending).toBe(1)
    finish(data())
    await expect(pending).rejects.toThrow("MODS_DISPLAY_SCOPE_CHANGED")
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
  })

  it("rejects synchronous observer writes and releases a preissued new proof without replacing the committed entry", () => {
    const f = fixture()
    let released = 0
    const errors: string[] = []
    const replacement = f.proof({
      dependencies: {
        current: () => true,
        release: () => {
          released++
        }
      }
    })
    f.cache.write(
      f.scope,
      "same",
      f.proof({
        onEvict() {
          try {
            f.proof()
          } catch (error) {
            errors.push((error as Error).message)
          }
          try {
            f.cache.write(f.scope, "same", replacement, data("reentrant"))
          } catch (error) {
            errors.push((error as Error).message)
          }
          // Passive observation remains legal and cannot resurrect the removed entry.
          expect(f.cache.read(f.scope, "same")).toBeNull()
        }
      }),
      data("old")
    )
    f.cache.write(f.scope, "same", f.proof(), data("new"))
    expect(errors).toEqual(["MODS_DISPLAY_OBSERVER_REENTRY", "MODS_DISPLAY_OBSERVER_REENTRY"])
    expect(released).toBe(1)
    expect(f.cache.read(f.scope, "same")?.data).toEqual(data("new"))
    expect(f.cache.stats()).toMatchObject({ entries: 1 })
    f.cache.clear()
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
    expect(released).toBe(1)
  })

  it("rejects observer single-flight admission without starting work or releasing an existing retained proof", async () => {
    const f = fixture()
    let produced = 0,
      released = 0
    const fresh = f.proof({
      onEvict() {
        released++
      }
    })
    const retained = f.proof({
      onEvict() {
        released++
      }
    })
    f.cache.write(f.scope, "kept", retained, data("kept"))
    let rejected: Promise<unknown> | undefined
    const errors: string[] = []
    f.cache.write(
      f.scope,
      "old",
      f.proof({
        onEvict() {
          rejected = f.cache
            .resolve(f.scope, "reentrant", fresh, async () => {
              produced++
              return data("not executed")
            })
            .catch((error: Error) => error.message)
          try {
            f.cache.write(f.scope, "kept", retained, data("forged"))
          } catch (error) {
            errors.push((error as Error).message)
          }
        }
      }),
      data()
    )
    f.cache.write(f.scope, "old", f.proof(), data("replacement"))
    expect(await rejected).toBe("MODS_DISPLAY_OBSERVER_REENTRY")
    expect(errors).toEqual(["MODS_DISPLAY_OBSERVER_REENTRY"])
    expect(produced).toBe(0)
    expect(released).toBe(1)
    expect(f.cache.read(f.scope, "kept")?.data).toEqual(data("kept"))
    f.cache.clear()
    expect(released).toBe(2)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
  })

  it("detaches a large clear batch before reentrant cleanup and releases each proof exactly once", () => {
    const f = fixture()
    const released = new Set<number>()
    let duplicates = 0
    for (let group = 0; group < 32; group++) {
      const scope = f.scopes.capture({ ...f.input, threadId: `group-${group}` })
      for (let row = 0; row < 40; row++) {
        const id = group * 40 + row
        const proof = f.cache.captureProof(scope, {
          version: "v1",
          reusable: true,
          assertCurrent() {
            /* Stable independent fixture source. */
          },
          onEvict() {
            if (released.has(id)) duplicates++
            released.add(id)
            f.cache.clear()
            f.cache.deleteScope(scope.id)
          }
        })!
        f.cache.write(scope, String(row), proof, data())
      }
    }
    expect(f.cache.stats().entries).toBe(1280)
    f.cache.clear()
    expect(released.size).toBe(1280)
    expect(duplicates).toBe(0)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
    f.cache.clear()
    expect(released.size).toBe(1280)
  })

  it("keeps eviction and scope deletion accounting exact when an observer clears the remaining entries", () => {
    const f = fixture({ maxEntriesPerScope: 2 })
    let released = 0
    f.cache.write(
      f.scope,
      "first",
      f.proof({
        onEvict() {
          released++
          f.cache.deleteScope(f.scope.id)
          f.cache.clear()
        }
      }),
      data()
    )
    f.cache.write(
      f.scope,
      "second",
      f.proof({
        onEvict() {
          released++
          f.cache.clear()
        }
      }),
      data()
    )
    const next = f.proof({
      onEvict() {
        released++
      }
    })
    expect(() => f.cache.write(f.scope, "third", next, data())).toThrow(
      "MODS_DISPLAY_SCOPE_CHANGED"
    )
    expect(released).toBe(3)
    expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0, pending: 0 })
    f.cache.deleteScope(f.scope.id)
    expect(released).toBe(3)
  })
})
