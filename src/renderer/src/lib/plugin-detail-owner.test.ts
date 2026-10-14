import { describe, expect, it } from "vitest"
import { PluginDetailOwner } from "./plugin-detail-owner"

function deferred() {
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe("plugin detail response ownership", () => {
  it.each(["returned failure", "thrown failure"])("reloads selected details after deletion %s", async outcome => {
    const owner = new PluginDetailOwner()
    owner.mount()
    const initial = deferred(), deletion = deferred(), values: string[] = []
    const first = owner.read("A", () => initial.promise, value => values.push(value), () => values.push("old failure"))
    owner.invalidate("A")
    const recover = () => owner.recover("A", () => owner.read("A", async () => "fresh A",
      value => values.push(value), () => values.push("new failure")))
    const deleting = deletion.promise.then(recover, recover)
    initial.resolve("obsolete A")
    await first
    if (outcome === "returned failure") deletion.resolve("success:false")
    else deletion.reject(Error("delete failed"))
    await deleting
    expect(values).toEqual(["fresh A"])
  })
  it("failed deletion recovery cannot steal B or revive an unmounted component", async () => {
    for (const change of ["B", "unmount"]) {
      const owner = new PluginDetailOwner()
      owner.mount()
      owner.select("A")
      owner.invalidate("A")
      const deletion = deferred()
      let reloaded = false
      const deleting = deletion.promise.then(() => owner.recover("A", async () => { reloaded = true }))
      if (change === "B") owner.select("B")
      else owner.unmount()
      deletion.resolve("failed")
      await deleting
      expect(reloaded).toBe(false)
    }
  })
  it.each(["success", "failure"])("ignores A late %s after B resolves", async (outcome) => {
    const owner = new PluginDetailOwner()
    owner.mount()
    const a = deferred(),
      b = deferred(),
      values: string[] = []
    const first = owner.read(
      "A",
      () => a.promise,
      (value) => values.push(value),
      () => values.push("A error")
    )
    const second = owner.read(
      "B",
      () => b.promise,
      (value) => values.push(value),
      () => values.push("B error")
    )
    b.resolve("B detail")
    await second
    if (outcome === "success") a.resolve("A detail")
    else a.reject(Error("A failed"))
    await first
    expect(values).toEqual(["B detail"])
  })
  it("rejects older reads of the same selected plugin", async () => {
    const owner = new PluginDetailOwner()
    owner.mount()
    const a = deferred(),
      b = deferred(),
      values: string[] = []
    const first = owner.read(
      "A",
      () => a.promise,
      (value) => values.push(value),
      () => values.push("error")
    )
    const second = owner.read(
      "A",
      () => b.promise,
      (value) => values.push(value),
      () => values.push("error")
    )
    b.resolve("new")
    await second
    a.resolve("old")
    await first
    expect(values).toEqual(["new"])
  })
  it("component unmount invalidates responses even after remount", async () => {
    const owner = new PluginDetailOwner()
    owner.mount()
    const a = deferred(),
      values: string[] = []
    const read = owner.read(
      "A",
      () => a.promise,
      (value) => values.push(value),
      () => values.push("error")
    )
    owner.unmount()
    owner.mount()
    a.resolve("late")
    await read
    expect(values).toEqual([])
  })
  it("deletion invalidates pending reads and cannot clear a later B selection", async () => {
    const owner = new PluginDetailOwner()
    owner.mount()
    const a = deferred(),
      deletion = deferred(),
      values: string[] = []
    const read = owner.read(
      "A",
      () => a.promise,
      (value) => values.push(value),
      () => values.push("error")
    )
    owner.invalidate("A")
    const deleting = deletion.promise.then(() => owner.clear("A"))
    await owner.read(
      "B",
      async () => "B detail",
      (value) => values.push(value),
      () => values.push("error")
    )
    a.resolve("late A")
    deletion.resolve("deleted")
    await read
    expect(await deleting).toBe(false)
    expect(owner.isSelected("B")).toBe(true)
    expect(values).toEqual(["B detail"])
    expect(owner.clear("B")).toBe(true)
    expect(owner.isSelected("B")).toBe(false)
  })
})
