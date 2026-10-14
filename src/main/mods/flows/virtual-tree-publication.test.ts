import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { ModControlStore } from "../control-store"
import { VirtualTreeStore } from "./virtual-tree"
import { importVirtualTreeSource } from "./virtual-tree-import"
import {
  exportReviewedVirtualTree,
  prepareVirtualTreeReview,
  readVirtualTreeReview,
  VirtualPublicationJournal
} from "./virtual-tree-publication"
import { publishReviewedVirtualTree } from "./virtual-tree-writeback"

const spawned = vi.hoisted(() => ({
  helper: undefined as import("node:child_process").ChildProcess | undefined
}))
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      if (args[0] === "powershell.exe") spawned.helper = child
      return child
    }
  }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "virtual-publication-"))
  const workspace = join(directory, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "answer.txt"), "initial")
  const store = new VirtualTreeStore(join(directory, "tree.sqlite"))
  const control = new ModControlStore(join(directory, "control.sqlite"))
  cleanups.push(async () => {
    store.close()
    control.close()
    await rm(directory, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const tree = store.createImported(
    await importVirtualTreeSource({ sourceDirectory: workspace, signal, assertCurrent: () => {} })
  )
  const session = store.open(tree.treeId, tree.root, () => {}, {
    executionId: "write",
    parentIncarnation: "owner"
  })
  const intent = session.beginWrite("answer.txt", Buffer.from("edited"), "operation")
  session.settleWrite(intent)
  session.seal()
  const finalRoot = store.currentRoot(tree.treeId, () => {})
  const token = prepareVirtualTreeReview({
    store,
    treeId: tree.treeId,
    finalRoot,
    assertCurrent: () => {}
  })
  const review = readVirtualTreeReview(token)!
  const journal = new VirtualPublicationJournal(control)
  return {
    directory,
    workspace,
    store,
    token,
    review,
    journal,
    input: {
      token,
      approvedDigest: review.digest,
      destination: join(directory, "review.json"),
      journal,
      signal,
      assertCurrent: () => {}
    }
  }
}

it("exports the reviewed exact initial-to-final patch without modifying the workspace", async () => {
  const f = await setup()
  expect(f.review.changes).toMatchObject([
    { path: "answer.txt", kind: "replace", content: "edited" }
  ])
  f.review.changes[0].content = "forged"
  expect(readVirtualTreeReview(f.token)!.changes[0].content).toBe("edited")
  expect(readVirtualTreeReview({ ...f.token })).toBeUndefined()
  const result = await exportReviewedVirtualTree(f.input)
  expect(result).toMatchObject({ state: "exported", workspace: "unchanged" })
  expect(JSON.parse(await readFile(f.input.destination, "utf8")).changes[0].content).toBe("edited")
  expect(await readFile(join(f.workspace, "answer.txt"), "utf8")).toBe("initial")
  expect(f.journal.list()).toMatchObject([{ state: "settled", kind: "reviewed-export" }])
})

it("rejects source conflicts and review digest substitution before any intent or export", async () => {
  const f = await setup()
  await expect(
    exportReviewedVirtualTree({ ...f.input, approvedDigest: "0".repeat(64) })
  ).rejects.toThrow("REVIEW_REQUIRED")
  await writeFile(join(f.workspace, "answer.txt"), "external edit")
  await expect(exportReviewedVirtualTree(f.input)).rejects.toThrow("SOURCE_CONFLICT")
  expect(f.journal.list()).toEqual([])
  await expect(readFile(f.input.destination)).rejects.toMatchObject({ code: "ENOENT" })
})

it("never overwrites an existing export and journals a confirmed no-effect failed attempt", async () => {
  const f = await setup()
  await writeFile(f.input.destination, "owned by user")
  await expect(exportReviewedVirtualTree(f.input)).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(f.input.destination, "utf8")).toBe("owned by user")
  expect(f.journal.list()).toMatchObject([{ state: "failed" }])
})

it("records no-effect failure when authority is revoked before destination creation", async () => {
  const f = await setup()
  await expect(
    exportReviewedVirtualTree({
      ...f.input,
      assertCurrent: () => {
        if (f.journal.list().length) throw Error("revoked")
      }
    })
  ).rejects.toThrow("revoked")
  expect(f.journal.list()).toMatchObject([{ state: "failed" }])
  await expect(readFile(f.input.destination)).rejects.toMatchObject({ code: "ENOENT" })
})

const windows = process.platform === "win32" ? it : it.skip
windows(
  "publishes only after exact review, retaining the original file under its locked handle",
  async () => {
    const f = await setup()
    const result = await publishReviewedVirtualTree({
      ...f.input,
      signal: AbortSignal.timeout(15000)
    })
    cleanups.unshift(async () => {
      await rm(result.backupDirectory, { recursive: true, force: true })
    })
    expect(result.state).toBe("published")
    expect(await readFile(join(f.workspace, "answer.txt"), "utf8")).toBe("edited")
    expect(await readFile(join(result.backupDirectory, "0.before"), "utf8")).toBe("initial")
    expect(f.journal.list()).toMatchObject([
      {
        kind: "workspace-writeback",
        state: "settled",
        paths: [{ path: "answer.txt", state: "written" }]
      }
    ])
  },
  20000
)

windows(
  "preserves the original backup and records unknown after post-backup revocation",
  async () => {
    const f = await setup()
    await expect(
      publishReviewedVirtualTree({
        ...f.input,
        signal: AbortSignal.timeout(15000),
        assertCurrent: () => {
          if (f.journal.list().some((row) => row.paths?.some((path) => path.state === "backed-up")))
            throw Error("revoked")
        }
      })
    ).rejects.toThrow("revoked")
    const record = f.journal.list()[0]
    cleanups.unshift(async () => {
      await rm(record.backupDirectory!, { recursive: true, force: true })
    })
    expect(record).toMatchObject({ state: "unknown", paths: [{ state: "backed-up" }] })
    expect(
      await readFile(join(record.backupDirectory!, "0.before"), "utf8").catch(async (error) => {
        throw Error(String(error) + JSON.stringify(await readdir(f.directory, { recursive: true })))
      })
    ).toBe("initial")
    await expect(readFile(join(f.workspace, "answer.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  },
  20000
)

windows(
  "publishes new nested files using exclusive directory creation and held ancestors",
  async () => {
    const f = await setup()
    const session = f.store.open(f.review.treeId, f.review.finalRoot, () => {}, {
      executionId: "new-file",
      parentIncarnation: "owner"
    })
    session.settleWrite(session.beginWrite("new/nested/result.txt", Buffer.from("new artifact")))
    session.seal()
    const token = prepareVirtualTreeReview({
      store: f.store,
      treeId: f.review.treeId,
      finalRoot: f.store.currentRoot(f.review.treeId, () => {}),
      assertCurrent: () => {}
    })
    const result = await publishReviewedVirtualTree({
      ...f.input,
      token,
      approvedDigest: readVirtualTreeReview(token)!.digest,
      signal: AbortSignal.timeout(15000)
    })
    expect(await readFile(join(f.workspace, "new/nested/result.txt"), "utf8")).toBe("new artifact")
    expect(await readFile(join(result.backupDirectory, "0.before"), "utf8")).toBe("initial")
  },
  20000
)

windows(
  "a real Node crash after durable backup leaves retained originals and blocks automatic retry",
  async () => {
    const f = await setup()
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../../../../tests/fixtures/virtual-publication-crash.ts", import.meta.url)
        ),
        f.directory,
        f.review.treeId,
        f.review.finalRoot
      ],
      { windowsHide: true, stdio: "ignore" }
    )
    const timer = setTimeout(() => child.kill(), 20000)
    const [code] = await once(child, "exit")
    clearTimeout(timer)
    expect(code).toBe(0)
    const record = f.journal.list()[0]
    expect(record).toMatchObject({ state: "intent", paths: [{ state: "backed-up" }] })
    expect(
      await readFile(join(record.backupDirectory!, "0.before"), "utf8").catch(async (error) => {
        throw Error(String(error) + JSON.stringify(await readdir(f.directory, { recursive: true })))
      })
    ).toBe("initial")
    await expect(readFile(join(f.workspace, "answer.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    })
    expect(() =>
      f.journal.begin(
        { reviewDigest: f.review.digest, target: f.workspace, kind: "workspace-writeback" },
        () => {}
      )
    ).toThrow("RECONCILE_REQUIRED")
  },
  25000
)

it("rejects malformed journal inputs before the durable CAS", async () => {
  const f = await setup()
  expect(() =>
    f.journal.begin(
      {
        reviewDigest: f.review.digest,
        target: f.workspace,
        kind: "workspace-writeback",
        backupDirectory: "relative/unsafe"
      },
      () => {}
    )
  ).toThrow("JOURNAL_INVALID")
  expect(() =>
    f.journal.begin(
      { reviewDigest: "bad", target: f.workspace, kind: "workspace-writeback" },
      () => {}
    )
  ).toThrow("JOURNAL_INVALID")
  expect(f.journal.list()).toEqual([])
})

windows.each([1, 3])(
  "helper death after final locking poisons settlement (guard %i)",
  async (killAt) => {
    const f = await setup()
    let observed = 0
    await expect(
      publishReviewedVirtualTree({
        ...f.input,
        signal: AbortSignal.timeout(15000),
        assertCurrent: () => {
          if (
            f.journal.list().some((row) => row.paths?.every((path) => path.state === "written"))
          ) {
            if (++observed === killAt) spawned.helper!.kill()
          }
        }
      })
    ).rejects.toThrow(/LOCK/)
    expect(observed).toBeGreaterThanOrEqual(killAt)
    const record = f.journal.list()[0]
    expect(record.state).toBe("unknown")
    expect(await readFile(join(record.backupDirectory!, "0.before"), "utf8")).toBe("initial")
  },
  20000
)
