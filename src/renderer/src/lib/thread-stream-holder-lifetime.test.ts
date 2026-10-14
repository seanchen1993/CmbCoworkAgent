import { describe, expect, it } from "vitest"
import {
  ThreadStreamHolderLifetime,
  type ThreadStreamHolderIdentity
} from "./thread-stream-holder-lifetime"

type Record = ThreadStreamHolderIdentity & { readonly token: object }

function fixture() {
  const lifetime = new ThreadStreamHolderLifetime<Record>()
  const actor = Object.freeze({})
  const key = lifetime.keyFor("thread", actor)
  const record: Record = Object.freeze({ threadId: "thread", actor, key, token: Object.freeze({}) })
  return { lifetime, actor, key, record }
}

describe("committed thread stream holder continuity", () => {
  it("keeps the first unknown baseline closed, including an uncommitted render", () => {
    const { lifetime, actor, key } = fixture()
    expect(lifetime.canRender("thread", actor, key, false)).toBe(false)
    expect(lifetime.canRender("thread", actor, key, true)).toBe(true)
    // Rendering the ready holder does not publish its later React commit.
    expect(lifetime.canRender("thread", actor, key, false)).toBe(false)
  })

  it("retains only the actual committed actor and managed key while history is unknown", () => {
    const { lifetime, actor, key, record } = fixture()
    expect(lifetime.commit(record, actor, key)).toBe(true)
    expect(lifetime.canRender("thread", actor, key, false)).toBe(true)
    expect(lifetime.isCurrent(record, actor, key)).toBe(true)
    const managedKey = lifetime.keyFor("thread", actor, "managed-run")
    expect(managedKey).not.toBe(key)
    expect(lifetime.canRender("thread", actor, managedKey, false)).toBe(false)
    expect(lifetime.isCurrent(record, actor, managedKey)).toBe(false)
  })

  it("never opens a holder without its actual actor even if stale state is ready", () => {
    const { lifetime, actor, key, record } = fixture()
    lifetime.commit(record, actor, key)
    expect(lifetime.canRender("thread", undefined, key, true)).toBe(false)
    expect(lifetime.canRender("thread", undefined, key, false)).toBe(false)
    expect(lifetime.isCurrent(record, undefined, key)).toBe(false)
    expect(lifetime.commit(record, undefined, key)).toBe(false)
  })

  it("does not admit a stale managed submit after retirement between render and commit", () => {
    const { lifetime, actor, record } = fixture()
    const key = lifetime.keyFor("thread", actor, "old-managed-run")
    const rendered: Record = Object.freeze({ ...record, key })
    expect(lifetime.canRender("thread", actor, key, true)).toBe(true)
    // The actual actor can disappear before React runs this commit effect.
    expect(lifetime.commit(rendered, undefined, key)).toBe(false)
    expect(lifetime.isCurrent(rendered, undefined, key)).toBe(false)
    expect(lifetime.isCurrent(rendered, actor, key)).toBe(false)
    const replacementKey = lifetime.keyFor("thread", actor, "new-managed-run")
    expect(lifetime.commit(rendered, actor, replacementKey)).toBe(false)
    expect(lifetime.isCurrent(rendered, actor, replacementKey)).toBe(false)
  })

  it("gives a reopened actor a new key and requires its first full baseline", () => {
    const { lifetime, actor, key, record } = fixture()
    lifetime.commit(record, actor, key)
    const reopenedActor = Object.freeze({})
    const reopenedKey = lifetime.keyFor("thread", reopenedActor)
    expect(reopenedKey).not.toBe(key)
    expect(lifetime.keyFor("thread", actor)).toBe(key)
    expect(lifetime.keyFor("thread", reopenedActor)).toBe(reopenedKey)
    expect(lifetime.canRender("thread", reopenedActor, reopenedKey, false)).toBe(false)
    expect(lifetime.commit(record, reopenedActor, reopenedKey)).toBe(false)
  })

  it("does not let old cleanup retire or dispose a committed successor", () => {
    const { lifetime, actor, key, record } = fixture()
    lifetime.commit(record, actor, key)
    const successor: Record = Object.freeze({ ...record, token: Object.freeze({}) })
    lifetime.commit(successor, actor, key)
    const disposed: Record[] = []
    const cleanup = (candidate: Record): void => {
      if (lifetime.retire(candidate)) disposed.push(candidate)
    }
    cleanup(record)
    expect(disposed).toEqual([])
    expect(lifetime.isCurrent(successor, actor, key)).toBe(true)
    cleanup(successor)
    cleanup(successor)
    expect(disposed).toEqual([successor])
    expect(lifetime.canRender("thread", actor, key, false)).toBe(false)
  })

  it("keeps independent thread records separate while retiring a mounted instance", () => {
    const { lifetime, actor, key, record } = fixture()
    const otherActor = Object.freeze({})
    const otherKey = lifetime.keyFor("other", otherActor)
    const other: Record = Object.freeze({
      threadId: "other",
      actor: otherActor,
      key: otherKey,
      token: Object.freeze({})
    })
    lifetime.commit(record, actor, key)
    lifetime.commit(other, otherActor, otherKey)
    expect(lifetime.retire(record)).toBe(true)
    expect(lifetime.canRender("thread", actor, key, false)).toBe(false)
    expect(lifetime.canRender("other", otherActor, otherKey, false)).toBe(true)
  })
})
