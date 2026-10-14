import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VirtualTreeStore } from "../src/main/mods/flows/virtual-tree"
import {
  createVirtualFileTools,
  isFixedVirtualFileTool,
  readVirtualFileToolFacts
} from "../src/main/mods/flows/virtual-file-tools"

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "flow-file-tools-"))
  const store = new VirtualTreeStore(join(directory, "store.sqlite"))
  let cases = 0
  const test = async (name: string, run: () => Promise<void>) => {
    await run()
    cases++
    process.stdout.write(`PASS ${name}\n`)
  }
  const setup = (
    options: {
      maxCalls?: number
      deadline?: number
      assertCurrent?: () => void
      invocation?: object
    } = {}
  ) => {
    const tree = store.create([{ path: "a.txt", content: Buffer.from("original") }])
    const controller = new AbortController()
    const invocation = Object.hasOwn(options, "invocation")
      ? options.invocation!
      : Object.freeze({})
    const bundle = createVirtualFileTools({
      store,
      ...tree,
      invocation,
      binding: { executionId: "execution", parentIncarnation: "parent" },
      signal: controller.signal,
      maxCalls: options.maxCalls ?? 16,
      deadline: options.deadline ?? Date.now() + 5000,
      assertCurrent: options.assertCurrent ?? (() => {})
    })
    return {
      tree,
      bundle,
      controller,
      invocation,
      tool: (name: string) => bundle.tools.find((item) => item.name === name)!
    }
  }
  try {
    await test("an invocation must be an actual frozen non-proxy object", async () => {
      for (const invocation of [undefined, null, false, 1, "identity", Object.freeze(() => {})]) {
        assert.throws(() => setup({ invocation: invocation as never }), /OPTIONS/)
      }
      assert.throws(() => setup({ invocation: {} }), /OPTIONS/)
      assert.throws(() => setup({ invocation: new Proxy(Object.freeze({}), {}) }), /OPTIONS/)
      const fakeStore = Object.create(VirtualTreeStore.prototype)
      assert.throws(
        () =>
          createVirtualFileTools({
            store: fakeStore,
            treeId: "forged",
            root: "forged",
            binding: { executionId: "x", parentIncarnation: "p" },
            invocation: Object.freeze({}),
            signal: new AbortController().signal,
            deadline: Date.now() + 5000,
            maxCalls: 1,
            assertCurrent() {
              /* live authority */
            }
          }),
        /OPTIONS/
      )
      class ForeignStore extends VirtualTreeStore {}
      assert.throws(() => new ForeignStore(join(directory, "foreign.sqlite")), /STORE_IDENTITY/)
    })
    await test("fixed identity, exact reads and negative query, sync seal closes new calls", async () => {
      const f = setup()
      assert.equal(isFixedVirtualFileTool(f.tool("virtual_read"), f.invocation), true)
      assert.equal(isFixedVirtualFileTool({ ...f.tool("virtual_read") }, f.invocation), false)
      assert.equal(
        isFixedVirtualFileTool(new Proxy(f.tool("virtual_read"), {}), f.invocation),
        false
      )
      assert.equal(isFixedVirtualFileTool(f.tool("virtual_read"), Object.freeze({})), false)
      const pending = f.tool("virtual_read").invoke({ path: "a.txt" })
      const seal = f.bundle.seal()
      await assert.rejects(f.tool("virtual_exists").invoke({ path: "a.txt" }), /CLOSED/)
      assert.deepEqual(JSON.parse(await pending), { text: "original" })
      const token = await seal
      assert.equal(readVirtualFileToolFacts(token)!.calls.length, 1)
      assert.equal(readVirtualFileToolFacts({}), undefined)
      assert.equal(readVirtualFileToolFacts(new Proxy(token, {})), undefined)
    })
    await test("write intent and settled output are included with final tree facts", async () => {
      const f = setup()
      await f.tool("virtual_write").invoke({ path: "new.txt", content: "new" })
      assert.deepEqual(JSON.parse(await f.tool("virtual_exists").invoke({ path: "missing" })), {
        exists: false
      })
      assert.deepEqual(JSON.parse(await f.tool("virtual_list").invoke({})), {
        names: ["a.txt", "new.txt"]
      })
      const facts = readVirtualFileToolFacts(await f.bundle.seal())!
      assert.equal(facts.tree.effects.length, 1)
      assert.equal(facts.calls.length, 3)
      assert.notEqual(facts.tree.root, f.tree.root)
    })
    await test("failed negative read poisons evidence even when caller catches the error", async () => {
      const f = setup()
      await assert.rejects(f.tool("virtual_read").invoke({ path: "missing" }), /NOT_FILE/)
      await assert.rejects(f.bundle.seal(), /CLOSED/)
    })
    await test("cancellation before result delivery prevents sealing a successful write", async () => {
      const f = setup()
      const pending = f.tool("virtual_write").invoke({ path: "a.txt", content: "changed" })
      f.controller.abort()
      await assert.rejects(pending)
      await assert.rejects(f.bundle.seal(), /CLOSED/)
    })
    await test("call budget and deadline fail closed", async () => {
      const f = setup({ maxCalls: 1 })
      await f.tool("virtual_exists").invoke({ path: "none" })
      await assert.rejects(f.tool("virtual_exists").invoke({ path: "none" }), /LIMIT/)
      await assert.rejects(f.bundle.seal(), /CLOSED/)
      const expiring = setup({ deadline: Date.now() + 10 })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await assert.rejects(expiring.bundle.seal(), /CLOSED/)
    })
    await test("input getters, proxies and toJSON are never executed", async () => {
      let invoked = 0
      const f = setup()
      await assert.rejects(
        f.tool("virtual_read").invoke({
          get path() {
            invoked++
            return "a.txt"
          }
        }),
        /INPUT/
      )
      const g = setup()
      await assert.rejects(
        g.tool("virtual_write").invoke({
          path: "a.txt",
          content: {
            toJSON() {
              invoked++
              return "forged"
            }
          }
        }),
        /INPUT/
      )
      const h = setup()
      await assert.rejects(
        h.tool("virtual_list").invoke(
          new Proxy(
            {},
            {
              getPrototypeOf() {
                invoked++
                return Object.prototype
              }
            }
          )
        ),
        /INPUT/
      )
      assert.equal(invoked, 0)
    })
    process.stdout.write(`${cases} fixed file tool cases passed\n`)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
