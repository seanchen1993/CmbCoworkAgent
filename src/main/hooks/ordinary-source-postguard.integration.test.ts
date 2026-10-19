import { createServer, type ServerResponse } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"
import type { PluginMetadata } from "../types"
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("../storage", () => ({ getHookLoggingConfig: () => ({ diagnostic: false }), getUserInfo: () => undefined }))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { resetHookOnceStateForTests, runHooks } from "./runner"
const roots: string[] = []
afterEach(() => {
  resetHookOnceStateForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ordinary-hook-postguard-")); roots.push(root)
  const source = join(root, "source"); mkdirSync(source)
  writeFileSync(join(source, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  writeFileSync(join(source, "devclaw.project-runtime.json"), JSON.stringify(hostProjectFixture(root).manifest))
  writeFileSync(join(source, "hook.py"), "original source bytes")
  const snapshots = new HostPackageSnapshots(join(root, "packages")), snapshot = snapshots.capture(source)
  const plugin: PluginMetadata = { id: "installed", name: "docs", version: "1.0.0", enabled: true,
    path: snapshot.root, author: "", description: "", createdAt: "", updatedAt: "", skillCount: 0,
    hookCount: 0, mcpServerCount: 0 }
  const token = issueRuntimePluginSourceToken({ mode: "legacy", threadId: "thread", incarnationKey: "live",
    projectId: "project", operationId: "operation", workspace: root, packageDigest: snapshot.digest,
    stageId: "draft", plugin }, () => { snapshots.read(snapshot.digest) })
  return { root, snapshot, token, context: { sessionId: "thread", workspacePath: root, toolName: "read_file" } }
}

it.each([false, true])("fences real ordinary HTTP results after await before once/publication (changed=%s)", async changed => {
  const f = fixture(), observed = vi.fn()
  let receive!: (response: ServerResponse) => void
  const received = new Promise<ServerResponse>(resolve => { receive = resolve })
  const server = createServer((request, response) => { request.resume(); receive(response) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); if (!address || typeof address === "string") throw Error("HTTP fixture missing")
  const hook = { id: "ordinary-http", event: "PreToolUse" as const, type: "http" as const,
    url: `http://127.0.0.1:${address.port}`, once: true, enabled: true, createdAt: "", updatedAt: "" }
  try {
    await withRuntimePluginSource(f.token, async () => {
      const task = runHooks([hook], "PreToolUse", f.context, observed)
      const response = await received
      const path = join(f.snapshot.root, "hook.py"), original = readFileSync(path)
      if (changed) writeFileSync(path, "changed during actual HTTP await")
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"continue":true}')
      if (changed) {
        await expect(task).rejects.toThrow("PACKAGE_CHANGED")
        expect(observed).not.toHaveBeenCalled()
        writeFileSync(path, original)
        // A rejected result cannot consume once: use a real second request after restoring bytes.
        const second = runHooks([hook], "PreToolUse", f.context, observed)
        server.once("request", (_request, next) => { next.writeHead(200); next.end('{"continue":true}') })
        await second
        expect(observed).toHaveBeenCalledOnce()
      } else {
        await task
        expect(observed).toHaveBeenCalledOnce()
      }
      await runHooks([hook], "PreToolUse", f.context, observed)
      expect(observed).toHaveBeenCalledOnce()
    })
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it("rejects a real ordinary command result changed during child IO before marking once", async () => {
  const f = fixture(), observed = vi.fn(), ready = join(f.root, "ready"), release = join(f.root, "release")
  const script = join(f.root, "wait.py")
  writeFileSync(script, "import pathlib,time,sys\npathlib.Path(sys.argv[1]).write_text('ready')\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.01)\nprint('{\"continue\":true}')\n")
  const quote = (path: string) => `"${path.replaceAll("\\", "/")}"`
  const hook = { id: "ordinary-command", event: "PreToolUse" as const, type: "command" as const,
    command: `python -I -B ${quote(script)} ${quote(ready)} ${quote(release)}`, once: true,
    enabled: true, createdAt: "", updatedAt: "" }
  await withRuntimePluginSource(f.token, async () => {
    const task = runHooks([hook], "PreToolUse", f.context, observed)
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(existsSync(ready)).toBe(true)
      writeFileSync(join(f.snapshot.root, "hook.py"), "changed during real command await")
    } finally { writeFileSync(release, "release") }
    await expect(task).rejects.toThrow("PACKAGE_CHANGED")
    expect(observed).not.toHaveBeenCalled()
  })
}, 15000)
