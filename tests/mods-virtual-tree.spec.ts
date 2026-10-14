import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { VirtualTreeStore, readVirtualTreeFacts } from "../src/main/mods/flows/virtual-tree"

const directory = mkdtempSync(join(tmpdir(), "flow-virtual-tree-"))
const database = join(directory, "tree.sqlite")
let store = new VirtualTreeStore(database)
let cases = 0
const test = (name: string, fn: () => void) => {
  fn()
  cases++
  process.stdout.write(`PASS ${name}\n`)
}
const binding = { executionId: "execution-1", parentIncarnation: "parent-1" }
const initial = () =>
  store.create([
    { path: "src" },
    { path: "src/a.txt", content: Buffer.from("first") },
    { path: ".ignored", content: Buffer.from("included") }
  ])
try {
  test("namespace includes ignored, directory and negative queries", () => {
    const tree = initial()
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    assert.equal(session.read(".ignored").toString(), "included")
    assert.deepEqual(session.list(), [".ignored", "src"])
    assert.equal(session.exists("missing"), false)
    assert.deepEqual(session.list("src"), ["a.txt"])
    const token = session.seal()
    const facts = readVirtualTreeFacts(token)!
    assert.equal(facts.dependencies.length, 4)
    assert.equal(readVirtualTreeFacts({}), undefined)
    assert.equal(readVirtualTreeFacts(new Proxy(token, {})), undefined)
    assert.throws(() => session.read(".ignored"), /CLOSED/)
  })
  test("input and output aliases cannot mutate persisted content or facts", () => {
    const bytes = Buffer.from("safe")
    const tree = store.create([{ path: "__proto__", content: bytes }])
    bytes.fill(0)
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    session.read("__proto__").fill(0)
    assert.equal(session.read("__proto__").toString(), "safe")
    const id = session.beginWrite("constructor", Buffer.from("also safe"))
    session.settleWrite(id)
    assert.equal(session.read("constructor").toString(), "also safe")
    const token = session.seal()
    const facts = readVirtualTreeFacts(token)!
    const effects = facts.effects as string[]
    effects.push("forged")
    assert.deepEqual(readVirtualTreeFacts(token)!.effects, [id])
  })
  test("intent is durable and cannot be silently retried after reopen", () => {
    const tree = initial()
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    session.beginWrite("src/a.txt", Buffer.from("second"))
    assert.throws(() => session.read("src/a.txt"), /UNKNOWN_EFFECT/)
    assert.throws(() => session.seal(), /UNKNOWN_EFFECT/)
    store.close()
    store = new VirtualTreeStore(database)
    assert.throws(() => store.open(tree.treeId, tree.root, () => {}, binding), /UNKNOWN_EFFECT/)
  })
  test("settled update is atomic and durable with an idempotent result", () => {
    const tree = initial()
    const first = store.open(tree.treeId, tree.root, () => {}, binding)
    const competing = store.open(tree.treeId, tree.root, () => {}, binding)
    const id = first.beginWrite("src/a.txt", Buffer.from("second"))
    assert.throws(() => competing.beginWrite("src/new", Buffer.from("race")), /UNKNOWN_EFFECT/)
    const next = first.settleWrite(id)
    assert.equal(first.settleWrite(id), next)
    assert.throws(() => competing.exists("src/a.txt"), /STALE/)
    assert.equal(first.read("src/a.txt").toString(), "second")
    first.seal()
    store.close()
    store = new VirtualTreeStore(database)
    const recovered = store.open(tree.treeId, next, () => {}, binding)
    assert.equal(recovered.read("src/a.txt").toString(), "second")
    recovered.seal()
  })
  test("revocation after intent prevents settlement and successful seal", () => {
    const tree = initial()
    let live = true
    const session = store.open(
      tree.treeId,
      tree.root,
      () => {
        if (!live) throw Error("revoked")
      },
      binding
    )
    const id = session.beginWrite("src/a.txt", Buffer.from("uncommitted"))
    live = false
    assert.throws(() => session.settleWrite(id), /revoked/)
    live = true
    assert.throws(() => session.seal(), /CLOSED/)
    assert.throws(() => store.open(tree.treeId, tree.root, () => {}, binding), /UNKNOWN_EFFECT/)
  })
  test("paths, collisions, non-directory parents and size violations fail before intent", () => {
    for (const path of ["../outside", "a/../b", "C:/bad", ".git/config", "a\\b", "CON"]) {
      assert.throws(() => store.create([{ path, content: Buffer.alloc(0) }]), /PATH/)
    }
    assert.throws(() => store.create([{ path: "A" }, { path: "a" }]), /COLLISION/)
    const tree = initial()
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    assert.throws(() => session.beginWrite("src/a.txt/file", Buffer.from("x")), /PARENT/)
    assert.throws(() => session.beginWrite("src", Buffer.from("x")), /NOT_FILE/)
    assert.throws(() => session.beginWrite("large", Buffer.alloc(4 * 1024 * 1024 + 1)), /LIMIT/)
    session.seal()
  })
  test("independent SQLite connections compete for the same immutable root", () => {
    const tree = initial()
    const otherStore = new VirtualTreeStore(database)
    try {
      const first = store.open(tree.treeId, tree.root, () => {}, binding)
      const second = otherStore.open(tree.treeId, tree.root, () => {}, binding)
      const id = first.beginWrite("src/a.txt", Buffer.from("winner"), "competing-operation")
      assert.throws(() => second.beginWrite("src/a.txt", Buffer.from("loser")), /UNKNOWN_EFFECT/)
      first.settleWrite(id)
      assert.throws(() => second.seal(), /STALE/)
      first.seal()
    } finally {
      otherStore.close()
    }
  })
  test("same operation ID is payload-bound and settled replay is idempotent", () => {
    const tree = initial()
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    const id = session.beginWrite("src/a.txt", Buffer.from("once"), "idempotency-key")
    session.settleWrite(id)
    assert.equal(session.beginWrite("src/a.txt", Buffer.from("once"), id), id)
    assert.throws(() => session.beginWrite("src/a.txt", Buffer.from("different"), id), /CONFLICT/)
    assert.deepEqual(readVirtualTreeFacts(session.seal())!.effects, [id])
  })
  test("revoked owner can durably record unknown without authorization to replay", () => {
    const tree = initial()
    let revoked = false
    const session = store.open(
      tree.treeId,
      tree.root,
      () => {
        if (revoked) throw Error("revoked")
      },
      binding
    )
    session.beginWrite("src/a.txt", Buffer.from("unknown"))
    revoked = true
    session.abandon()
    assert.throws(() => store.open(tree.treeId, tree.root, () => {}, binding), /UNKNOWN_EFFECT/)
    assert.throws(() => session.seal(), /CLOSED/)
  })
  test("real process exit before settlement leaves unknown; after settlement survives", () => {
    for (const phase of ["intent", "settled"]) {
      const tree = initial()
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/virtual-tree-crash.ts", import.meta.url)),
          database,
          tree.treeId,
          tree.root,
          phase
        ],
        { encoding: "utf8", timeout: 10000 }
      )
      assert.equal(child.status, 23, child.stderr)
      if (phase === "intent") {
        assert.throws(() => store.open(tree.treeId, tree.root, () => {}, binding), /UNKNOWN_EFFECT/)
      } else {
        const session = store.open(tree.treeId, child.stdout, () => {}, binding)
        assert.equal(session.read("src/a.txt").toString(), "child-write")
        session.seal()
      }
    }
  })
  test("retained roots count toward capacity and failed commit leaves intent unknown", () => {
    const limited = new VirtualTreeStore(join(directory, "limited.sqlite"), { roots: 2 })
    try {
      const tree = limited.create([{ path: "file", content: Buffer.from("v1") }])
      const session = limited.open(tree.treeId, tree.root, () => {}, binding)
      session.settleWrite(session.beginWrite("file", Buffer.from("v2")))
      const id = session.beginWrite("file", Buffer.from("v3"))
      assert.throws(() => session.settleWrite(id), /STORE_LIMIT/)
      assert.throws(() => session.seal(), /UNKNOWN_EFFECT/)
    } finally {
      limited.close()
    }
  })
  test("retained historical roots fork independently with bounded ancestry", () => {
    const tree = initial()
    const session = store.open(tree.treeId, tree.root, () => {}, binding)
    const next = session.settleWrite(session.beginWrite("src/a.txt", Buffer.from("v2")))
    session.seal()
    const child = store.fork({
      treeId: tree.treeId,
      expectedHead: next,
      root: tree.root,
      assertCurrent() {
        /* host authority remains live */
      }
    })
    const childSession = store.open(child.treeId, child.root, () => {}, binding)
    assert.equal(childSession.read("src/a.txt").toString(), "first")
    childSession.seal()
    const current = store.open(tree.treeId, next, () => {}, binding)
    assert.equal(current.read("src/a.txt").toString(), "v2")
    current.seal()
    assert.throws(
      () =>
        store.fork({
          treeId: tree.treeId,
          expectedHead: tree.root,
          root: tree.root,
          assertCurrent() {
            /* host authority remains live */
          }
        }),
      /STALE/
    )
    const unrelated = store.create([{ path: "foreign" }])
    assert.throws(
      () =>
        store.fork({
          treeId: tree.treeId,
          expectedHead: next,
          root: unrelated.root,
          assertCurrent() {
            /* host authority remains live */
          }
        }),
      /ANCESTRY/
    )
    let descendant = child
    for (let depth = 2; depth <= 8; depth++) {
      descendant = store.fork({
        ...descendant,
        expectedHead: descendant.root,
        assertCurrent() {
          /* host authority remains live */
        }
      })
    }
    assert.throws(
      () =>
        store.fork({
          ...descendant,
          expectedHead: descendant.root,
          assertCurrent() {
            /* host authority remains live */
          }
        }),
      /ANCESTRY_LIMIT/
    )
  })
  process.stdout.write(`${cases} virtual tree cases passed\n`)
} finally {
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
