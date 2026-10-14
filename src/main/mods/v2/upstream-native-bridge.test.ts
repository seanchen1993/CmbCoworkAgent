import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ToolMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"
import { ModGuestRuntime, type ModHostCall } from "../guest-runtime"
import type { ModObject } from "../../../shared/mods/types"

// As in model-tools.test.ts, only the V1 process transport is replaced.
vi.mock("../runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      return this.guests.get(id)!.invoke(handler, event, call)
    }
    async unload(id: string) { this.guests.get(id)?.dispose(); this.guests.delete(id) }
    stop() {
      for (const guest of this.guests.values()) guest.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
import { ModsManager, setModsManager } from "../manager"
import { withModToolCall } from "../adapters"
import { getModCallContext } from "../context"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { withFunctionExecution } from "./execution-context"
import type { FunctionPaneSnapshot, FunctionUiAction, FunctionUiElement,
  FunctionUiNode } from "../../../shared/mods/v2/ui"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  setModsManager(undefined)
  for (const close of cleanup.splice(0)) await close()
})
const upstream = resolve("tests/fixtures/mods-upstream")
function verifyOriginals() {
  const provenance = JSON.parse(readFileSync(join(upstream, "provenance.json"), "utf8"))
  for (const file of provenance.files) {
    const bytes = readFileSync(join(upstream, file.fixturePath))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
  }
}
async function fixture(name: string, denyTools: string[] = [], measure = false) {
  verifyOriginals()
  const temp = mkdtempSync(join(tmpdir(), "mods-upstream-native-"))
  const manager = new ModsManager(join(temp, "control.sqlite"), () => [],
    async () => true, () => {})
  manager.configure(temp, true, true)
  setModsManager(manager)
  const workspace = manager.workspaceKey(temp)
  const binding = { workspace, threadId: "original-native", turnId: "turn" }
  const compiled = await compileFunctionPlugin(join(upstream, name))
  const grant = manager.store.grant(workspace, `function:${name}`, compiled.digest, true)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const approvedProcesses: string[][] = []
  const session = new FunctionSession([{
    name, root: compiled.root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES]
  }], {
    ...binding, cwd: () => workspace,
    assertLive: () => manager.store.assertGrant(grant),
    publish: (value, signal) => manager.publish(workspace, value, undefined, signal),
    authorizeProcess: async (_plugin, request) => {
      if (!measure) throw Error("FIXTURE_PROCESS_PERMISSION_REFUSED")
      expect(resolve(request.cwd)).toBe(resolve(temp))
      const argv = [...request.argv]
      const allowed = [
        ["git", "status", "--porcelain"],
        ["git", "diff", "--shortstat", "HEAD"]
      ]
      expect(allowed.some(value => JSON.stringify(value) === JSON.stringify(argv))).toBe(true)
      expect(request.input).toBeUndefined()
      approvedProcesses.push(argv)
    }
  })
  manager.attachFunctions({
    registeredTools: () => session.registeredTools(),
    invalidate: () => { void session.close() },
    closeThread: () => { void session.close() },
    close: () => { void session.close() },
    toolCall: (scope, input, core) => withFunctionExecution({
      workspace, threadId: binding.threadId, userInitiated: false,
      leased: true, immediate: false
    }, () => session.interceptTool(input, scope.signal, core))
  })
  cleanup.push(async () => {
    const failures: unknown[] = []
    try { await session.close() } catch (error) { failures.push(error) }
    try { manager.close() } catch (error) { failures.push(error) }
    try { verifyOriginals() } catch (error) { failures.push(error) }
    try {
      const target = resolve(temp)
      if (dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith("mods-upstream-native-")) throw Error("Invalid cleanup target")
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Upstream fixture cleanup failed")
  })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const run = (nativeName: string, args: Record<string, unknown>, signal?: AbortSignal) => withModToolCall({ ...binding, signal },
    { toolCall: { name: nativeName, id: `native-${calls.length}`, args } }, new Set(),
    async request => {
      expect(getModCallContext()?.identity.origin).toBe("model")
      expect(request.toolCall.name).toBe(nativeName)
      if (denyTools.includes(nativeName)) throw Error("FINAL_HOST_PERMISSION_DENIED")
      calls.push({ name: request.toolCall.name, args: request.toolCall.args })
      if (nativeName === "edit_file") {
        const file = String(request.toolCall.args.file_path)
        expect(dirname(file)).toBe(temp)
        const before = readFileSync(file, "utf8")
        writeFileSync(file, before.replace(String(request.toolCall.args.old_string),
          String(request.toolCall.args.new_string)))
      }
      return new ToolMessage({ content: "native fixture receipt", status: "success",
        name: nativeName, tool_call_id: request.toolCall.id })
    })
  return { temp, session, run, calls, approvedProcesses }
}

it("original Blast Radius intercepts native execute without changing its Bash matcher", async () => {
  const f = await fixture("blast-radius")
  const safe = await f.run("execute", { command: "echo never spawned", cwd: f.temp })
  expect(safe).toBeInstanceOf(ToolMessage)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].args).toEqual({ command: "echo never spawned", cwd: f.temp })
  const controller = new AbortController()
  const pending = f.run("execute", { command: "rm -rf never-executed", cwd: f.temp }, controller.signal)
  const settled = pending.then(value => ({ value }), error => ({ error }))
  let blocked: unknown
  try {
    const pane = await heldPane(f.session)
    await f.session.panes.act(press(pane, "cancel"))
    const outcome = await settled
    if ("error" in outcome) throw outcome.error
    blocked = outcome.value
  } finally { controller.abort(); await settled }
  expect(f.calls).toHaveLength(1)
  expect(blocked).toMatchObject({ status: "error" })
  expect(String((blocked as ToolMessage).content)).toContain("Blast Radius held this command")
})

it("original Replay Theater sees native edit_file and preserves native arguments and receipt", async () => {
  const f = await fixture("replay-theater")
  const file = join(f.temp, "editable.txt")
  writeFileSync(file, "before\n")
  await f.session.turnStart({ turnId: "turn", text: "edit fixture" })
  const args = { file_path: file, old_string: "before", new_string: "after", replace_all: false }
  const result = await f.run("edit_file", args)
  expect(readFileSync(file, "utf8")).toBe("after\n")
  expect(f.calls).toEqual([{ name: "edit_file", args }])
  expect(result).toMatchObject({ name: "edit_file", content: "native fixture receipt" })
  await f.session.turnComplete({ turnId: "turn", answer: "done", durationMs: 1,
    reason: "answer", isAborted: false })
  expect(await f.session.run("replay", "")).toEqual({ text: "Replay Theater: 1 edits" })
  expect((await f.session.panes.snapshot()).some(p => p.id === "replay-theater")).toBe(true)
})

it("an upstream hook cannot bypass the final native host refusal", async () => {
  const f = await fixture("blast-radius", ["execute"])
  await expect(f.run("execute", { command: "echo refused" })).rejects.toThrow("FINAL_HOST_PERMISSION_DENIED")
  expect(f.calls).toHaveLength(0)
})

function press(pane: FunctionPaneSnapshot, key: string): FunctionUiAction {
  let found: FunctionUiNode | undefined
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string" || node.type === "engine") return
    if (node.type !== "fragment" && node.type !== "Markdown" && node.props.key === key)
      found = node
    node.children?.forEach(visit)
  }
  visit(pane.tree)
  if (!found?.press) throw Error(`Original control not rendered: ${key}`)
  return { pane: pane.key, generation: pane.generation, intentId: randomUUID(),
    plugin: found.press.plugin, handle: found.press.handle, kind: "press" }
}

function dirtyRepo(temp: string): string {
  const git = (args: string[]) => execFileSync("git", [
    "-c", `core.hooksPath=${join(temp, "no-hooks")}`, ...args
  ], { cwd: temp, windowsHide: true, timeout: 10000, stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })
  git(["init", "--template="])
  const file = join(temp, "tracked.txt")
  writeFileSync(file, "committed\n")
  git(["add", "--", "tracked.txt"])
  git(["-c", "user.name=Upstream Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "-m", "fixture"])
  writeFileSync(file, "uncommitted fixture\n")
  return file
}

async function heldPane(session: FunctionSession): Promise<FunctionPaneSnapshot> {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    try {
      const pane = (await session.panes.snapshot()).find(p => p.id === "blast-radius")
      if (pane) return pane
    } catch (error) {
      // The original opens then invalidates its pane. Discard only that stale
      // read and acquire a current drawing; never retry an action on an old ticket.
      if ((error as { code?: string }).code !== "MODS_UI_DRAWING_STALE") throw error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw Error("Original Blast Radius did not open its hold pane within 10 seconds")
}

it.each(["cancel", "proceed"] as const)(
  "original Blast Radius %s closure settles a real measured native call", async decision => {
    const f = await fixture("blast-radius", [], true)
    const file = dirtyRepo(f.temp)
    const controller = new AbortController()
    const pending = f.run("execute", { command: "git reset --hard", cwd: f.temp }, controller.signal)
    // Attach immediately: a failing measurement cannot create an unhandled rejection.
    const settled = pending.then(value => ({ value }), error => ({ error }))
    try {
      const pane = await heldPane(f.session)
      expect(f.calls).toHaveLength(0)
      const action = press(pane, decision)
      await f.session.panes.act(action)
      const outcome = await settled
      if ("error" in outcome) throw outcome.error
      expect(f.calls).toHaveLength(decision === "proceed" ? 1 : 0)
      expect(outcome.value).toMatchObject({ status: decision === "proceed" ? "success" : "error" })
      if (decision === "cancel") expect(String((outcome.value as ToolMessage).content)).toContain("the user pressed Cancel")
      if (decision === "proceed") expect(f.calls[0]).toEqual({ name: "execute",
        args: { command: "git reset --hard", cwd: f.temp } })
      expect(f.approvedProcesses).toContainEqual(["git", "status", "--porcelain"])
      expect(f.approvedProcesses).toContainEqual(["git", "diff", "--shortstat", "HEAD"])
      expect(f.approvedProcesses.some(argv => argv[0] === "sleep")).toBe(false)
      expect(await f.session.panes.snapshot()).toEqual([])
      expect(readFileSync(file, "utf8")).toBe("uncommitted fixture\n")
      await expect(f.session.panes.act({ ...action, intentId: randomUUID() })).rejects.toThrow()
    } finally {
      controller.abort()
      await settled
    }
  }, 25000
)

it("cancelling the held native call prevents execution and retires its pane", async () => {
  const f = await fixture("blast-radius", [], true)
  const file = dirtyRepo(f.temp)
  const controller = new AbortController()
  const settled = f.run("execute", { command: "git reset --hard", cwd: f.temp }, controller.signal)
    .then(value => ({ value }), error => ({ error }))
  try {
    const pane = await heldPane(f.session)
    const action = press(pane, "proceed")
    controller.abort()
    await settled
    expect(f.calls).toHaveLength(0)
    // Session close is the final cleanup barrier after revoked hook SDK access.
    await f.session.close()
    await expect(async () => f.session.panes.act(action)).rejects.toThrow()
    expect(readFileSync(file, "utf8")).toBe("uncommitted fixture\n")
  } finally { controller.abort(); await settled }
}, 25000)
