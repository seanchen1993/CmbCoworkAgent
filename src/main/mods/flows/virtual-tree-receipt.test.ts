import { expect, it } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VirtualTreeStore, readVirtualTreeFacts } from "./virtual-tree"

it("verifies retained roots and exact settled owner/effect chain through a read-only connection", () => {
  const directory = mkdtempSync(join(tmpdir(), "file-receipt-"))
  const filename = join(directory, "tree.sqlite")
  const store = new VirtualTreeStore(filename)
  let observer: VirtualTreeStore | undefined
  try {
    const original = store.create([{ path: "a", content: Buffer.from("before") }])
    const binding = { executionId: "exec", parentIncarnation: "incarnation" }
    const session = store.open(original.treeId, original.root, () => {}, binding)
    const first = session.beginWrite("a", Buffer.from("after"))
    const changed = session.settleWrite(first)
    const second = session.beginWrite("a", Buffer.from("last"))
    const finalRoot = session.settleWrite(second)
    const facts = readVirtualTreeFacts(session.seal())!
    const input = {
      treeId: original.treeId,
      inputRoot: original.root,
      finalRoot,
      originDigest: facts.originDigest,
      effectIds: facts.effects,
      binding,
      assertCurrent: () => {}
    }
    observer = new VirtualTreeStore(filename, undefined, true)
    expect(observer!.verifyReceipt(input)).toEqual(store.verifyReceipt(input))
    expect(() => observer!.verifyReceipt({ ...input, effectIds: [second, first] })).toThrow()
    expect(() => observer!.verifyReceipt({ ...input, effectIds: [first] })).toThrow()
    expect(() =>
      observer!.verifyReceipt({ ...input, binding: { ...binding, executionId: "other" } })
    ).toThrow()
    expect(() => observer!.verifyReceipt({ ...input, finalRoot: changed })).toThrow()
    const next = store.open(original.treeId, finalRoot, () => {}, {
      executionId: "later",
      parentIncarnation: "incarnation"
    })
    next.settleWrite(next.beginWrite("a", Buffer.from("later")))
    next.seal()
    expect(observer!.verifyReceipt(input)).toEqual(store.verifyReceipt(input))
    expect(() => observer!.create([])).toThrow()
  } finally {
    observer?.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("a diagnostic read-only open never creates a missing store", () => {
  const directory = mkdtempSync(join(tmpdir(), "file-receipt-missing-"))
  const filename = join(directory, "missing.sqlite")
  try {
    expect(() => new VirtualTreeStore(filename, undefined, true)).toThrow()
    expect(existsSync(filename)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
