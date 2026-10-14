import { expect, it, vi } from "vitest"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile, writeFile, lstat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { VirtualTreeStore, readVirtualTreeSnapshot } from "./virtual-tree"
import {
  materializeVirtualTree,
  assertVirtualTreeMaterializationCurrent,
  readVirtualTreeMaterialization
} from "./virtual-tree-materialization"

it("rejects post-check content changes and extra outputs before a pass can bind to the old root", async () => {
  const f = fixture()
  try {
    const handle = await materializeVirtualTree(f.input)
    try {
      await assertVirtualTreeMaterializationCurrent(handle)
      await writeFile(join(handle.directory, "a/x"), "check silently repaired its input")
      await expect(assertVirtualTreeMaterializationCurrent(handle)).rejects.toThrow(
        "CONTENT_CHANGED"
      )
      await writeFile(join(handle.directory, "a/x"), "nested")
      await writeFile(join(handle.directory, "unknown-output"), "background writer")
      await expect(assertVirtualTreeMaterializationCurrent(handle)).rejects.toThrow(
        "CONTENT_CHANGED"
      )
    } finally {
      await handle.dispose()
    }
    await expect(assertVirtualTreeMaterializationCurrent(handle)).rejects.toThrow("IDENTITY")
  } finally {
    f.close()
  }
})

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "virtual-materialize-test-"))
  const store = new VirtualTreeStore(join(directory, "tree.sqlite"))
  const tree = store.create([
    { path: "empty" },
    { path: "a" },
    { path: "a/x", content: Buffer.from("nested") },
    { path: "a-z", content: Buffer.from("neighbor") },
    { path: ".gitignore", content: Buffer.from("ignored\n") },
    { path: "ignored", content: Buffer.from([0, 255, 13, 10]) }
  ])
  const controller = new AbortController()
  return {
    store,
    tree,
    controller,
    input: { store, ...tree, signal: controller.signal, assertCurrent: () => {} },
    close() {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

it("copies exact settled root including binary, ignored files and empty directories", async () => {
  const f = fixture()
  try {
    const handle = await materializeVirtualTree(f.input)
    try {
      expect(await readFile(join(handle.directory, "ignored"))).toEqual(
        Buffer.from([0, 255, 13, 10])
      )
      expect((await lstat(join(handle.directory, "empty"))).isDirectory()).toBe(true)
      expect(await readFile(join(handle.directory, "a/x"), "utf8")).toBe("nested")
      expect(await readFile(join(handle.directory, "a-z"), "utf8")).toBe("neighbor")
      expect(readVirtualTreeMaterialization(handle)).toMatchObject({
        ...f.tree,
        coverage: "owned-materialization-initial-content-v1"
      })
      expect(readVirtualTreeMaterialization({ ...handle })).toBeUndefined()
      expect(readVirtualTreeMaterialization(new Proxy(handle, {}))).toBeUndefined()
      await writeFile(join(handle.directory, "ignored"), "check subprocess changed its own input")
      const session = f.store.open(f.tree.treeId, f.tree.root, () => {}, {
        executionId: "read",
        parentIncarnation: "owner"
      })
      expect(session.read("ignored")).toEqual(Buffer.from([0, 255, 13, 10]))
      session.dispose()
    } finally {
      await handle.dispose()
    }
    expect(readVirtualTreeMaterialization(handle)).toBeUndefined()
    await expect(lstat(handle.directory)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    f.close()
  }
})

it("snapshot identity is private and returned bytes cannot alias accepted SQLite content", () => {
  const f = fixture()
  try {
    const token = f.store.captureSnapshot(f.tree.treeId, f.tree.root, () => {})
    const first = readVirtualTreeSnapshot(token)!
    first.entries.find((entry) => entry.path === "ignored")!.content!.fill(7)
    expect(
      readVirtualTreeSnapshot(token)!.entries.find((entry) => entry.path === "ignored")!.content
    ).toEqual(Buffer.from([0, 255, 13, 10]))
    expect(readVirtualTreeSnapshot({ ...token })).toBeUndefined()
    expect(readVirtualTreeSnapshot(new Proxy(token, {}))).toBeUndefined()
  } finally {
    f.close()
  }
})

it("rejects unresolved effects and superseded roots before materialization", async () => {
  const f = fixture()
  try {
    const session = f.store.open(f.tree.treeId, f.tree.root, () => {}, {
      executionId: "write",
      parentIncarnation: "owner"
    })
    const operation = session.beginWrite("ignored", Buffer.from("new"))
    await expect(materializeVirtualTree(f.input)).rejects.toThrow()
    session.settleWrite(operation)
    await expect(materializeVirtualTree(f.input)).rejects.toThrow("VIRTUAL_TREE_STALE")
    session.dispose()
  } finally {
    f.close()
  }
})

it("retains original abort binding and refuses authority revocation during extraction", async () => {
  const f = fixture()
  try {
    let calls = 0
    f.input.assertCurrent = () => {
      if (++calls === 5) {
        f.input.signal = new AbortController().signal
        f.controller.abort(Error("original-abort"))
      }
    }
    await expect(materializeVirtualTree(f.input)).rejects.toThrow("original-abort")
    await expect(
      materializeVirtualTree({
        ...f.input,
        assertCurrent() {
          throw Error("revoked")
        }
      })
    ).rejects.toThrow("revoked")
  } finally {
    f.close()
  }
})

it("does not turn a failed cleanup into a successful repeated disposal", async () => {
  const f = fixture()
  let directory: string | undefined
  try {
    const handle = await materializeVirtualTree(f.input)
    directory = handle.directory
    const failure = vi.spyOn(fsPromises, "rm").mockRejectedValue(Error("disk-cleanup-failed"))
    try {
      await expect(handle.dispose()).rejects.toThrow("disk-cleanup-failed")
      await expect(handle.dispose()).rejects.toThrow("disk-cleanup-failed")
      expect(failure).toHaveBeenCalledTimes(1)
      expect(readVirtualTreeMaterialization(handle)).toBeUndefined()
    } finally {
      failure.mockRestore()
    }
  } finally {
    if (directory) await fsPromises.rm(directory, { recursive: true, force: true })
    f.close()
  }
})
