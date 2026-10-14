import { describe, expect, it, vi } from "vitest"
import { FunctionMarkdownLinkRegistry, type NativeMarkdownLeaf } from "./markdown-link-registry"
import type { FunctionMarkdownLinkAction } from "../../../shared/mods/v2/markdown-links"

function fixture() {
  const registry = new FunctionMarkdownLinkRegistry()
  const owner = {}
  const epoch = {}
  let alive = true
  const address = { kind: "pane" as const, pane: "q:report", generation: "drawing-1" }
  const binding = {
    owner,
    epoch,
    address,
    contentFingerprint: "safe-picture-1",
    assertCurrent: () => {
      if (!alive) throw Error("source revoked")
    }
  }
  const leaf: NativeMarkdownLeaf = {
    nodePath: [0],
    props: {
      text: "[report](https://example.test/report) [docs](https://example.test/docs)"
    }
  }
  const publish = (leaves = [leaf], nextBinding = binding) => {
    const plan = registry.prepare(nextBinding, leaves)
    registry.assertPrepared([plan])
    registry.commit([plan])
    return plan
  }
  const action = (
    nonce: string,
    href = "https://example.test/report"
  ): FunctionMarkdownLinkAction => ({ address, nonce, href, intentId: "intent-1" })
  return {
    registry,
    owner,
    binding,
    leaf,
    publish,
    action,
    revoke: () => {
      alive = false
    }
  }
}

describe("native Markdown publication ledger", () => {
  it("reuses private parsed targets without retaining a replaced callback or accepting changed props", async () => {
    const f = fixture()
    const original = vi.fn(async () => {})
    const replacement = vi.fn(async () => {})
    const source: NativeMarkdownLeaf = {
      ...f.leaf,
      props: { ...f.leaf.props, key: "links" },
      callback: { identity: {}, run: original }
    }
    const first = f.publish([source])
    const second = f.publish([{ ...source, callback: { identity: {}, run: replacement } }])
    expect(second.markdownLinks[0].nonce).not.toBe(first.markdownLinks[0].nonce)
    const open = vi.fn(async () => ({ state: "opened" as const }))
    await expect(
      f.registry.invoke(f.action(second.markdownLinks[0].nonce), () => {}, open)
    ).resolves.toEqual({ state: "handled" })
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(original).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(() =>
      f.registry.prepare(f.binding, [
        { ...source, props: { ...source.props, text: source.props.text + "\u0000" } }
      ])
    ).toThrow()
    const changed = f.publish([
      {
        ...source,
        props: { ...source.props, text: "[New](https://example.test/new)", pressableLinks: [] }
      }
    ])
    expect(() =>
      f.registry.invoke(f.action(changed.markdownLinks[0].nonce), () => {}, open)
    ).toThrow("MODS_UI_MARKDOWN_STALE")
    await expect(
      f.registry.invoke(
        f.action(changed.markdownLinks[0].nonce, "https://example.test/new"),
        () => {},
        open
      )
    ).resolves.toEqual({ state: "opened" })
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(original).not.toHaveBeenCalled()
  })

  it("admits only protected final targets at the actual current address", async () => {
    const f = fixture()
    const plan = f.publish()
    const open = vi.fn(async () => ({ state: "opened" as const }))
    const guard = vi.fn()
    const action = f.action(plan.markdownLinks[0].nonce)
    expect(() =>
      f.registry.invoke({ ...action, href: "https://elsewhere.test" }, guard, open)
    ).toThrow("MODS_UI_MARKDOWN_STALE")
    expect(() =>
      f.registry.invoke({ ...action, address: { ...action.address, pane: "p:other" } }, guard, open)
    ).toThrow("MODS_UI_MARKDOWN_STALE")
    await expect(f.registry.invoke(action, guard, open)).resolves.toEqual({ state: "opened" })
    expect(open).toHaveBeenCalledExactlyOnceWith(action.href, expect.any(Function))
    expect(guard).toHaveBeenCalled()
  })

  it("keeps unchanged queries and settled intents stable, but rejects changed payloads", async () => {
    const f = fixture()
    const first = f.publish()
    const open = vi.fn(async () => ({ state: "opened" as const }))
    const action = f.action(first.markdownLinks[0].nonce)
    const original = f.registry.invoke(action, () => {}, open)
    await original
    const second = f.publish()
    expect(second.markdownLinks).toEqual(first.markdownLinks)
    expect(f.registry.invoke(action, () => {}, open)).toBe(original)
    expect(() =>
      f.registry.invoke({ ...action, href: "https://example.test/docs" }, () => {}, open)
    ).toThrow("MODS_UI_INTENT_CONFLICT")
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("does not turn a failed or discarded candidate into a live address", async () => {
    const f = fixture()
    const first = f.publish()
    const candidate = f.registry.prepare(f.binding, [{ ...f.leaf, props: { text: "changed" } }])
    f.registry.discard(candidate)
    expect(() => f.registry.commit([candidate])).toThrow("MODS_UI_MARKDOWN_STALE")
    expect(() => f.registry.prepare(f.binding, [{ ...f.leaf, props: { text: "\u0000" } }])).toThrow(
      "MODS_UI_MARKDOWN_INVALID"
    )
    await expect(
      f.registry.invoke(
        f.action(first.markdownLinks[0].nonce),
        () => {},
        async () => ({ state: "opened" })
      )
    ).resolves.toEqual({ state: "opened" })
  })

  it("invalidates every old nonce after safe content, native epoch or owner changes", () => {
    const f = fixture()
    const first = f.publish()
    const second = f.publish([{ ...f.leaf, props: { ...f.leaf.props, dimColor: true } }])
    expect(second.markdownLinks[0].nonce).not.toBe(first.markdownLinks[0].nonce)
    const open = async () => ({ state: "opened" as const })
    expect(() => f.registry.invoke(f.action(first.markdownLinks[0].nonce), () => {}, open)).toThrow(
      "MODS_UI_MARKDOWN_STALE"
    )
    const third = f.publish([f.leaf], { ...f.binding, epoch: {} })
    f.registry.retire(f.owner)
    expect(() => f.registry.invoke(f.action(third.markdownLinks[0].nonce), () => {}, open)).toThrow(
      "MODS_UI_MARKDOWN_STALE"
    )
  })

  it("invalidates unchanged Markdown when another part of the safe picture changes", () => {
    const f = fixture()
    const first = f.publish()
    const second = f.publish([f.leaf], { ...f.binding, contentFingerprint: "safe-picture-2" })
    expect(second.markdownLinks[0].nonce).not.toBe(first.markdownLinks[0].nonce)
    expect(() =>
      f.registry.invoke(
        f.action(first.markdownLinks[0].nonce),
        () => {},
        async () => ({ state: "opened" })
      )
    ).toThrow("MODS_UI_MARKDOWN_STALE")
    const empty = f.publish([])
    expect(empty.markdownLinks).toEqual([])
    const third = f.publish()
    expect(third.markdownLinks[0].nonce).not.toBe(second.markdownLinks[0].nonce)
  })

  it("uses the native original callback only for its final takeover list", async () => {
    const f = fixture()
    const run = vi.fn(async () => {
      f.registry.retire(f.owner)
    })
    const open = vi.fn(async () => ({ state: "opened" as const }))
    const first = f.publish([
      {
        ...f.leaf,
        props: { ...f.leaf.props, key: "links", pressableLinks: ["https://example.test/report"] },
        callback: { identity: {}, run }
      }
    ])
    await expect(
      f.registry.invoke(f.action(first.markdownLinks[0].nonce), () => {}, open)
    ).resolves.toEqual({ state: "handled" })
    expect(run).toHaveBeenCalledExactlyOnceWith("https://example.test/report", "intent-1")
    expect(open).not.toHaveBeenCalled()
    const second = f.publish([
      {
        ...f.leaf,
        props: { ...f.leaf.props, key: "links", pressableLinks: [] },
        callback: { identity: {}, run }
      }
    ])
    await expect(
      f.registry.invoke(f.action(second.markdownLinks[0].nonce), () => {}, open)
    ).resolves.toEqual({ state: "opened" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("rechecks source and sender before side effects and after awaited default work", async () => {
    const f = fixture()
    const plan = f.publish()
    const open = vi.fn(async () => {
      f.revoke()
      return { state: "opened" as const }
    })
    await expect(
      f.registry.invoke(f.action(plan.markdownLinks[0].nonce), () => {}, open)
    ).rejects.toThrow("source revoked")
    const g = fixture()
    const other = g.publish()
    const blocked = vi.fn(async () => ({ state: "opened" as const }))
    expect(() =>
      g.registry.invoke(
        g.action(other.markdownLinks[0].nonce),
        () => {
          throw Error("frame replaced")
        },
        blocked
      )
    ).toThrow("frame replaced")
    expect(blocked).not.toHaveBeenCalled()
  })

  it("preserves pending real work while retiring its address", async () => {
    const f = fixture()
    const first = f.publish()
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const open = vi.fn(async () => {
      await waiting
      return { state: "opened" as const }
    })
    const action = f.action(first.markdownLinks[0].nonce)
    const pending = f.registry.invoke(action, () => {}, open)
    await Promise.resolve()
    f.registry.retire(f.owner)
    const second = f.publish()
    expect(() =>
      f.registry.invoke(f.action(second.markdownLinks[0].nonce), () => {}, open)
    ).toThrow("MODS_UI_INTENT_CONFLICT")
    finish()
    await expect(pending).rejects.toThrow("MODS_UI_MARKDOWN_STALE")
    await expect(
      f.registry.invoke(f.action(second.markdownLinks[0].nonce), () => {}, open)
    ).resolves.toEqual({ state: "opened" })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("preflights a whole batch before committing and rejects stale competing candidates", () => {
    const f = fixture()
    const first = f.registry.prepare(f.binding, [f.leaf])
    const second = f.registry.prepare(f.binding, [f.leaf])
    expect(() => f.registry.commit([first, second])).toThrow("MODS_UI_MARKDOWN_STALE")
    f.registry.commit([first])
    expect(() => f.registry.commit([second])).toThrow("MODS_UI_MARKDOWN_STALE")
    f.registry.close()
    expect(() => f.publish()).toThrow("MODS_UI_MARKDOWN_STALE")
  })

  it("rejects new intents at the live-frame limit instead of evicting executed requests", async () => {
    const f = fixture()
    const plan = f.publish()
    const open = vi.fn(async () => ({ state: "opened" as const }))
    const action = f.action(plan.markdownLinks[0].nonce)
    const first = f.registry.invoke(action, () => {}, open)
    const pending = [first]
    for (let index = 1; index < 4096; index++)
      pending.push(
        f.registry.invoke(
          {
            ...action,
            intentId: `intent-${index + 1}`
          },
          () => {},
          open
        )
      )
    await Promise.all(pending)
    expect(open).toHaveBeenCalledTimes(4096)
    expect(() =>
      f.registry.invoke({ ...action, intentId: "intent-overflow" }, () => {}, open)
    ).toThrow("MODS_UI_INTENT_LIMIT")
    expect(f.registry.invoke(action, () => {}, open)).toBe(first)
    f.registry.retire(f.owner)
    expect(() => f.registry.invoke(action, () => {}, open)).toThrow("MODS_UI_MARKDOWN_STALE")
    expect(open).toHaveBeenCalledTimes(4096)
  })
})
