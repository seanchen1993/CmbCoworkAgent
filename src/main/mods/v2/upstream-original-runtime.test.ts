// Original upstream runtime integration. Provenance and scope: tests/fixtures/mods-upstream/provenance.json
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { readPluginManifest } from "../../plugins/manifest"
import type { FunctionPaneSnapshot, FunctionUiElement, FunctionUiNode } from "../../../shared/mods/v2/ui"

const upstream = resolve("tests/fixtures/mods-upstream")
const provenance = JSON.parse(readFileSync(resolve(upstream, "provenance.json"), "utf8"))
const results: Array<{ name: string; status: string; [key: string]: unknown }> = []
async function hashes() {
  for (const item of provenance.files) {
    const bytes = await readFile(resolve(upstream, item.fixturePath))
    assert.equal(bytes.length, item.bytes, item.path)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.path)
  }
}
function content(node: unknown): string {
  if (typeof node === "string") return node
  if (!node || typeof node !== "object") return ""
  const children = (node as { children?: unknown }).children
  return Array.isArray(children) ? children.map(content).join("") : ""
}
async function check(name: string, run: (s: FunctionSession) => Promise<void>) {
  const root = resolve(upstream, name)
  let session: FunctionSession | undefined
  let guest: FunctionGuestRuntime | undefined
  try {
    await hashes()
    assert.equal(readPluginManifest(root)?.manifest.name, name)
    const compiled = await compileFunctionPlugin(root)
    assert.equal(compiled.name, name)
    guest = await FunctionGuestRuntime.create(compiled.code)
    let usageReads = 0
    session = new FunctionSession([{
      name: compiled.name, root: compiled.root, tier: "user", guest,
      capabilities: [...SESSION_CAPABILITIES]
    }], {
      workspace: process.cwd(), threadId: `upstream-${name}`,
      assertLive: () => {}, publish: async value => value,
      cwd: () => process.cwd(),
      readSession: async method => {
        assert.equal(method, "session.usage")
        usageReads++
        return { context: { window: 1000, tokens: usageReads === 1 ? 100 : 800,
          percent: usageReads === 1 ? 10 : 80 }, rateLimits: [] }
      },
      // Never spawn an external executable from this integration fixture.
      authorizeProcess: async () => { throw Error("UPSTREAM_TEST_PROCESS_REFUSED") }
    })
    await session.start()
    await run(session)
    results.push({ name, status: "pass", level: "FunctionSession integration",
      sourceUnchanged: true, productionInstallVerified: false, realNativeToolsVerified: false })
  } catch (error) {
    results.push({ name, status: "fail", error: error instanceof Error ? error.stack ?? error.message : String(error) })

  } finally {
    if (session) await session.close()
    else guest?.dispose()
    await hashes()
  }
}
const finish = (turnId: string) => ({ answer: "fixture answer", durationMs: 1,
  isAborted: false, turnId, reason: "answer" as const })
async function band(s: FunctionSession) {
  const owner = await s.sites.mount("AbovePrompt")
  const snapshot = await s.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8 })
  return { owner, snapshot }
}

async function cancelOriginalHold(s: FunctionSession): Promise<void> {
  const deadline = performance.now() + 10000
  let pane: FunctionPaneSnapshot | undefined
  while (!pane && performance.now() < deadline) {
    try { pane = (await s.panes.snapshot()).find(row => row.id === "blast-radius") }
    catch (error) {
      if ((error as { code?: string }).code !== "MODS_UI_DRAWING_STALE") throw error
    }
    if (!pane) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(pane, "original hold pane must appear")
  let cancel: FunctionUiNode | undefined
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string" || node.type === "engine") return
    if (node.type !== "fragment" && node.type !== "Markdown" && node.props.key === "cancel") cancel = node
    node.children?.forEach(visit)
  }
  visit(pane.tree)
  assert.ok(cancel?.press, "original Cancel closure must exist")
  await s.panes.act({ pane: pane.key, generation: pane.generation, intentId: randomUUID(),
    plugin: cancel.press.plugin, handle: cancel.press.handle, kind: "press" })
}
it("runs byte-identical official packages through registration, events and UI", async () => {
  try {
    await hashes()
    await check("token-weather", async s => {
      const first = await band(s)
      assert.match(content(first.snapshot.tree), /Clear/)
      assert.match(content(first.snapshot.tree), /10%/)
      await s.turnComplete(finish("weather-1"))
      const after = await s.sites.render(first.owner,
        { isWorking: false, bodyColumns: 80, maxRows: 8 })
      assert.match(content(after.tree), /Storm/)
      assert.match(content(after.tree), /80%/)
      assert.equal((await s.panes.snapshot()).length, 0)
    })
    await check("replay-theater", async s => {
      let coreCalls = 0
      await s.turnStart({ turnId: "replay-1", text: "edit fixture" })
      // Official event shape, not a CMB-native adapter claim. Source matcher is unchanged.
      await s.interceptTool({ tool: "Edit", tool_use_id: "replay-edit",
        file_path: `${process.cwd()}/upstream-never-written.txt`,
        old_string: "before", new_string: "after", replace_all: false }, undefined,
      async () => { coreCalls++; return { result: "fixture edit receipt", text: "fixture edit receipt" } })
      assert.equal(coreCalls, 1)
      await s.turnComplete(finish("replay-1"))
      const hint = await band(s)
      assert.match(content(hint.snapshot.tree), /Replay.*1 edit/, JSON.stringify(hint.snapshot))
      await s.run("replay", "")
      const panes = await s.panes.snapshot()
      assert.ok(panes.some(p => p.id === "replay-theater"), "original command opens pane")
      assert.match(content(panes.find(p => p.id === "replay-theater")!.tree), /before|after/)
    })
    await check("blast-radius", async s => {
      let coreCalls = 0
      await s.interceptTool({ tool: "Bash", tool_use_id: "safe", command: "echo fixture" },
        undefined, async () => { coreCalls++; return { result: "safe receipt", text: "safe receipt" } })
      assert.equal(coreCalls, 1)
      const controller = new AbortController()
      const pending = s.interceptTool({ tool: "Bash", tool_use_id: "risk",
        command: "rm -rf upstream-never-executed" }, controller.signal,
      async () => { coreCalls++; throw Error("RISKY_CORE_MUST_NOT_RUN") })
      const settled = pending.then(value => ({ value }), error => ({ error }))
      try {
        await cancelOriginalHold(s)
        const outcome = await settled
        if ("error" in outcome) throw outcome.error
        assert.equal(coreCalls, 1)
        assert.match(String(outcome.value.deny), /the user pressed Cancel/)
      } finally { controller.abort(); await settled }
      assert.deepEqual(await s.panes.snapshot(), [], "Denied original call must not leave a pane")
      // Measurement remains denied, but the original Cancel closure now settles
      // its internal wait. No dangerous core or external executable is run here.
    })
  } finally {
    await hashes()

  }
  assert.equal(results.filter((item) => item.status === "fail").length, 0, JSON.stringify(results, null, 2))
}, 30000)
