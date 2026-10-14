import { mkdtemp, mkdir, writeFile, lstat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { isVirtualTreeStore, readVirtualTreeSnapshot, type VirtualTreeStore } from "./virtual-tree"
import { importVirtualTreeSource } from "./virtual-tree-import"

interface MaterializationFacts {
  coverage: "owned-materialization-initial-content-v1"
  treeId: string
  root: string
  originDigest: string
  directory: string
}
const handles = new WeakMap<object, MaterializationFacts>()
const observers = new WeakMap<object, () => Promise<void>>()

/** Bounded post-drain observation, not an OS atomic read fence. */
export async function assertVirtualTreeMaterializationCurrent(handle: object): Promise<void> {
  const observe = observers.get(handle)
  if (!observe) throw Error("VIRTUAL_MATERIALIZATION_IDENTITY")
  await observe()
}

/** Input binding only. Neither an OS sandbox proof nor a native-check pass receipt. */
export function readVirtualTreeMaterialization(handle: object): MaterializationFacts | undefined {
  const facts = handles.get(handle)
  return facts ? { ...facts } : undefined
}

export async function materializeVirtualTree(input: {
  store: VirtualTreeStore
  treeId: string
  root: string
  signal: AbortSignal
  assertCurrent(): void
}) {
  const { store, treeId, root, signal, assertCurrent } = input
  if (!isVirtualTreeStore(store)) throw Error("VIRTUAL_TREE_STORE_IDENTITY")
  const guard = () => {
    signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
  }
  guard()
  const snapshot = readVirtualTreeSnapshot(store.captureSnapshot(treeId, root, guard))!
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, "flow-virtual-check-"))
  // The exact generated root stays owned even when authority is later revoked.
  if (dirname(directory) !== parent) throw Error("VIRTUAL_MATERIALIZATION_PATH")
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => {
    handles.delete(handle)
    observers.delete(handle)
    cleanupPromise ??= rm(directory, { recursive: true, force: true })
    return cleanupPromise
  }
  const handle = Object.freeze({ directory, dispose: cleanup })
  try {
    guard()
    const initial = await lstat(directory)
    const checkRoot = async () => {
      guard()
      const current = await lstat(directory)
      guard()
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino
      )
        throw Error("VIRTUAL_MATERIALIZATION_REPLACED")
    }
    for (const entry of snapshot.entries) {
      await checkRoot()
      // Paths came from the private validated SQLite snapshot, never tool input here.
      const target = join(directory, ...entry.path.split("/"))
      let ancestor = dirname(target)
      while (ancestor !== directory) {
        const stat = await lstat(ancestor)
        guard()
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw Error("VIRTUAL_MATERIALIZATION_REPLACED")
        ancestor = dirname(ancestor)
      }
      if (entry.content) await writeFile(target, entry.content, { flag: "wx", mode: 0o600 })
      else await mkdir(target, { mode: 0o700 })
      guard()
    }
    await checkRoot()
    const observed = await importVirtualTreeSource({
      sourceDirectory: directory,
      signal,
      assertCurrent
    })
    guard()
    const expectedByPath = new Map(snapshot.entries.map((entry) => [entry.path, entry]))
    if (
      observed.entries.length !== snapshot.entries.length ||
      observed.entries.some((entry) => {
        const expected = expectedByPath.get(entry.path)
        return (
          !expected ||
          !!entry.content !== !!expected.content ||
          (entry.content && !Buffer.from(entry.content).equals(expected.content!))
        )
      })
    )
      throw Error("VIRTUAL_MATERIALIZATION_CONTENT_CHANGED")
    // Check callbacks may revoke or mutate the namespace; do not substitute a newer head.
    store.captureSnapshot(treeId, root, guard)
    observers.set(handle, async () => {
      await checkRoot()
      const after = await importVirtualTreeSource({
        sourceDirectory: directory,
        signal,
        assertCurrent
      })
      guard()
      if (
        after.entries.length !== snapshot.entries.length ||
        after.entries.some((entry) => {
          const expected = expectedByPath.get(entry.path)
          return (
            !expected ||
            !!entry.content !== !!expected.content ||
            (entry.content && !Buffer.from(entry.content).equals(expected.content!))
          )
        })
      )
        throw Error("VIRTUAL_MATERIALIZATION_CONTENT_CHANGED")
      await checkRoot()
      store.captureSnapshot(treeId, root, guard)
    })
    handles.set(handle, {
      coverage: "owned-materialization-initial-content-v1",
      treeId,
      root,
      originDigest: snapshot.originDigest,
      directory
    })
    return handle
  } catch (error) {
    await cleanup()
    throw error
  }
}
