import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, link, symlink, rename, rm } from "node:fs/promises"
import { renameSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importVirtualTreeSource } from "../src/main/mods/flows/virtual-tree-import"
import { VirtualTreeStore } from "../src/main/mods/flows/virtual-tree"

async function main() {
  const base = await mkdtemp(join(tmpdir(), "flow-tree-import-"))
  let cases = 0
  const test = async (name: string, fn: (root: string) => Promise<void>) => {
    const root = join(base, String(cases++))
    await mkdir(root)
    await fn(root)
    process.stdout.write(`PASS ${name}\n`)
  }
  const capture = (root: string, assertCurrent = () => {}) =>
    importVirtualTreeSource({
      sourceDirectory: root,
      signal: new AbortController().signal,
      assertCurrent
    })
  try {
    await test("revoked or cancelled import checks authority before filesystem acquisition", async (root) => {
      const controller = new AbortController()
      controller.abort(Error("already cancelled"))
      await assert.rejects(
        importVirtualTreeSource({
          sourceDirectory: join(root, "missing"),
          signal: controller.signal,
          assertCurrent() {
            throw Error("should not run")
          }
        }),
        /already cancelled/
      )
      await assert.rejects(
        capture(join(root, "missing"), () => {
          throw Error("revoked")
        }),
        /revoked/
      )
    })
    await test("ignored files and empty directories are imported without Git filtering", async (root) => {
      await writeFile(join(root, ".gitignore"), "ignored.txt\n")
      await writeFile(join(root, "ignored.txt"), "ignored input")
      await mkdir(join(root, "empty"))
      const result = await capture(root)
      assert.deepEqual(
        result.entries.map((entry) => entry.path),
        [".gitignore", "empty", "ignored.txt"]
      )
      assert.equal(result.provenance.observation, "bounded-per-file-observation")
    })
    await test("abort from every authority callback, including the last, prevents import token", async (root) => {
      await writeFile(join(root, "file"), "bytes")
      let boundaries = 0
      await capture(root, () => {
        boundaries++
      })
      for (let stop = 1; stop <= boundaries; stop++) {
        const controller = new AbortController()
        let visited = 0
        await assert.rejects(
          importVirtualTreeSource({
            sourceDirectory: root,
            signal: controller.signal,
            assertCurrent() {
              if (++visited === stop) controller.abort(Error("authority aborted"))
            }
          }),
          /authority aborted/
        )
      }
    })
    await test("hardlinked input is rejected", async (root) => {
      await writeFile(join(root, "original"), "secret")
      await link(join(root, "original"), join(root, "alias"))
      await assert.rejects(capture(root), /LINK/)
    })
    await test("directory junction escaping selected root is rejected", async (root) => {
      const outside = join(base, "outside")
      await mkdir(outside)
      await writeFile(join(outside, "foreign"), "outside")
      await symlink(outside, join(root, "junction"), "junction")
      await assert.rejects(capture(root), /LINK/)
    })
    await test("selected root substitution during acquisition is rejected", async (root) => {
      await writeFile(join(root, "file"), "original")
      let calls = 0
      await assert.rejects(
        capture(root, () => {
          if (++calls === 3) {
            renameSync(root, `${root}-old`)
            mkdirSync(root)
          }
        }),
        /CHANGED/
      )
    })
    await test("parent directory replacement during acquisition is rejected", async (root) => {
      await mkdir(join(root, "parent"))
      await writeFile(join(root, "parent/file"), "original")
      let calls = 0
      await assert.rejects(
        capture(root, () => {
          if (++calls === 5) {
            renameSync(join(root, "parent"), join(root, "retained"))
            mkdirSync(join(root, "parent"))
          }
        }),
        /CHANGED|ENOENT/
      )
    })
    await test("oversized input rejects and root metadata is explicitly excluded", async (root) => {
      await writeFile(join(root, "large"), Buffer.alloc(4 * 1024 * 1024 + 1))
      await assert.rejects(capture(root), /too large/)
      await rename(join(root, "large"), join(base, "large"))
      await mkdir(join(root, ".git"))
      const imported = await capture(root)
      assert.deepEqual(imported.provenance.excludedPrefixes, [".git"])
      assert.deepEqual(imported.entries, [])
    })
    await test("private import provenance binds original bytes and survives SQLite reopen", async (root) => {
      await writeFile(join(root, "source"), "original")
      const imported = await capture(root)
      const sourceDigest = imported.provenance.digest
      imported.entries[0].content!.fill(0)
      imported.provenance.digest = "forged"
      const database = join(base, "provenance.sqlite")
      let store = new VirtualTreeStore(database)
      try {
        assert.throws(() => store.createImported({ ...imported }), /IDENTITY/)
        assert.throws(() => store.createImported(new Proxy(imported, {})), /IDENTITY/)
        const tree = store.createImported(imported)
        store.close()
        store = new VirtualTreeStore(database)
        assert.equal((store.provenance(tree.treeId) as { digest: string }).digest, sourceDigest)
        const session = store.open(tree.treeId, tree.root, () => {}, {
          executionId: "import-test",
          parentIncarnation: "parent"
        })
        assert.equal(session.read("source").toString(), "original")
        session.seal()
      } finally {
        store.close()
      }
    })
    process.stdout.write(`${cases} real filesystem import cases passed\n`)
  } finally {
    // All paths are descendants of the one OS-created, task-owned temp root.
    await rm(base, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
