import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { PlatformSurfaces } from "./platform-surfaces"
import { createGitInspectionPlatformProvider } from "./platform-git-provider"
import { createWorkflowPlatformProvider } from "./platform-workflow-provider"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import type {
  FunctionPaneSnapshot,
  FunctionUiElement,
  FunctionUiNode
} from "../../../shared/mods/v2/ui"
import type { WorkflowRunObservation } from "../../agent/workflow/observation"
import type { ModObject } from "../../../shared/mods/types"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

it("makes the shipped source verifiable by the creator SDK analyzer", async () => {
  const compiled = await compileFunctionPlugin(
    resolve("resources/native-compositions/worktree-changes"),
    { captureSources: true }
  )
  const result = await analyzeFunctionSdk(compiled)
  expect(result.diagnostics).toEqual([])
  expect(result.strictCompatible).toBe(true)
  expect(result.usages.map((usage) => usage.method)).toEqual(
    expect.arrayContaining([
      "platform.act",
      "platform.read",
      "platform.list",
      "ui.open",
      "ui.invalidate"
    ])
  )
})

function nodes(tree: FunctionUiElement | string): FunctionUiNode[] {
  if (typeof tree === "string" || tree.type === "engine") return []
  if (tree.type === "fragment") return tree.children.flatMap(nodes)
  if (tree.type === "Markdown") return []
  return [tree, ...(tree.children ?? []).flatMap(nodes)]
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "worktree-pane-real-"))
  cleanups.push(() => rm(parent, { recursive: true, force: true }))
  const repo = join(parent, "repo"),
    linked = join(parent, "linked")
  await mkdir(repo)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_AUTHOR_NAME: "Pane Test",
        GIT_AUTHOR_EMAIL: "pane@example.invalid",
        GIT_COMMITTER_NAME: "Pane Test",
        GIT_COMMITTER_EMAIL: "pane@example.invalid"
      }
    }).trim()
  git(repo, "init", "-q")
  git(repo, "config", "core.autocrlf", "false")
  await writeFile(join(repo, "same.txt"), "baseline\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "base")
  const baseCommit = git(repo, "rev-parse", "HEAD")
  git(repo, "worktree", "add", "--detach", linked, baseCommit)
  await writeFile(join(repo, "same.txt"), "main directory change\n")
  await writeFile(join(linked, "same.txt"), "linked directory change\n")
  const compiled = await compileFunctionPlugin(
    resolve("resources/native-compositions/worktree-changes")
  )
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const plugin = {
    ...compiled,
    guest,
    tier: "user" as const,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const threadId = randomUUID()
  const confirmDirectory = vi.fn(async () => true)
  const authorizePath = vi.fn(async () => {})
  const nativeGit = createGitInspectionPlatformProvider({ confirmDirectory, authorizePath })
  const originalGitAct = nativeGit.act.bind(nativeGit)
  const gitAction = vi.spyOn(nativeGit, "act")
  const observation = {
    runId: "real-run",
    status: "running",
    worktrees: [
      {
        id: "linked",
        branch: "detached",
        directory: linked,
        baseCommit,
        status: "active"
      }
    ],
    nextWorktreeOffset: null
  } as unknown as WorkflowRunObservation
  const cancel = vi.fn(() => false)
  const nativeWorkflow = createWorkflowPlatformProvider({
    active: async () => observation,
    latest: async () => null,
    inspect: async () => observation,
    changed: () => () => {},
    confirmCancel: async () => false,
    cancel,
    settled: async () => {}
  })
  const session = new FunctionSession([plugin], {
    threadId,
    workspace: parent,
    assertLive: () => {},
    publish: async (value) => value,
    platformNativeProviders: [nativeGit, nativeWorkflow]
  })
  cleanups.push(async () => {
    await session.close(true)
  })
  const registry = new PlatformSurfaces({
    capabilities: () => session.platform.list(),
    assertCurrent: () => {},
    paneOwner: () => plugin.name,
    panes: session.panes,
    changed: () => {},
    invoke: (ref, action, input, requestKey, signal) =>
      session.platform.act(
        plugin,
        { ref, target: { kind: "current" }, action, input, requestKey },
        signal
      ),
    cleanup: (ref, action, input, requestKey, signal) =>
      session.platform.act(
        plugin,
        { ref, target: { kind: "current" }, action, input, requestKey },
        signal
      )
  })
  cleanups.push(async () => registry.close())
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "running-business-task" })
  cleanups.push(async () => {
    releaseLocalThreadRunLease(threadId, "desktop", "running-business-task")
  })
  const catalog = registry.list()
  expect(catalog.errors).toEqual([])
  expect(catalog.entries).toHaveLength(1)
  expect(catalog.entries[0].interaction).toBe("query")
  const start = { key: catalog.entries[0].key, revision: catalog.revision }
  const opened = await registry.open(start, new AbortController().signal)
  const address = { ...start, openId: opened.openId }
  const pane = async (): Promise<FunctionPaneSnapshot> => {
    const frame = await registry.read(address)
    expect(frame.pane).not.toBeNull()
    return frame.pane!
  }
  const action = async (
    key: string,
    kind: "press" | "submit" | "select" = "press",
    value?: string
  ) => {
    const frame = await pane()
    const node = nodes(frame.tree).find((entry) => entry.props.key === key)
    expect(node, `missing control ${key}: ${JSON.stringify(frame.tree)}`).toBeDefined()
    await registry.act(
      address,
      {
        pane: frame.key,
        generation: frame.generation,
        intentId: randomUUID(),
        plugin: node!.press!.plugin,
        handle: node!.press!.handle,
        kind,
        ...(value !== undefined ? { value } : {})
      },
      new AbortController().signal
    )
  }
  const text = async () => JSON.stringify((await pane()).tree)
  return {
    threadId,
    repo,
    linked,
    parent,
    baseCommit,
    session,
    registry,
    address,
    pane,
    action,
    text,
    confirmDirectory,
    authorizePath,
    gitAction,
    originalGitAct,
    nativeGit,
    cancel
  }
}

it("loads the shipped query surface and real linked worktree diff while a business lease remains held", async () => {
  const f = await fixture()
  const leaseBefore = getLocalThreadRunLease(f.threadId)
  expect(leaseBefore?.runId).toBe("running-business-task")
  expect(f.gitAction).not.toHaveBeenCalled()
  await f.action("discover")
  expect(await f.text()).toContain(f.linked.replaceAll("\\", "\\\\"))
  await f.action("worktree", "select", "linked")
  await f.action("load")
  expect(f.confirmDirectory).toHaveBeenCalledTimes(1)
  expect(await f.text()).toContain("same.txt")
  const indexPath = join(f.repo, ".git", "worktrees", "linked", "index")
  const before = await readFile(indexPath)
  await f.action("file-0")
  let code = nodes((await f.pane()).tree).find((node) => node.type === "Code")!
  expect(code.props.format).toBe("diff")
  expect(code.props.wrap).toBe("wrap")
  expect((await f.pane()).tree).toMatchObject({ props: { width: "100%" } })
  expect(code.props.source).toContain("+linked directory change")
  expect(code.props.source).not.toContain("+main directory change")
  await writeFile(join(f.linked, "same.txt"), "new running task output\n")
  await f.action("file-0")
  expect(nodes((await f.pane()).tree).some((node) => node.type === "Code")).toBe(false)
  expect(await f.text()).toContain("读取失败")
  await f.action("load")
  await f.action("file-0")
  code = nodes((await f.pane()).tree).find((node) => node.type === "Code")!
  expect(code.props.source).toContain("+new running task output")
  expect(f.confirmDirectory).toHaveBeenCalledTimes(1)
  expect(await readFile(indexPath)).toEqual(before)
  expect(f.cancel).not.toHaveBeenCalled()
  expect(getLocalThreadRunLease(f.threadId)).toEqual(leaseBefore)
}, 60000)

it("clears the old repository body on selection, uses explicit baselines, and rejects revoked refs", async () => {
  const f = await fixture()
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", f.baseCommit)
  await f.action("load")
  await f.action("file-0")
  expect(await f.text()).toContain("+main directory change")
  await f.action("directory", "submit", f.linked)
  expect(nodes((await f.pane()).tree).some((node) => node.type === "Code")).toBe(false)
  await f.action("load")
  await f.action("file-0")
  expect(await f.text()).toContain("+linked directory change")
  expect(await f.text()).not.toContain("+main directory change")
  expect(f.gitAction.mock.calls.some(([, action]) => action === "release")).toBe(true)
  await f.nativeGit.close!()
  await f.action("file-0")
  expect(nodes((await f.pane()).tree).some((node) => node.type === "Code")).toBe(false)
  expect(await f.text()).toContain("读取失败")
  await f.registry.closePage(f.address)
  expect(await f.session.panes.snapshot()).toEqual([])
}, 60000)

it("shows a missing baseline as a failure and never guesses HEAD", async () => {
  const f = await fixture()
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", "missing-task-baseline")
  await f.action("load")
  expect(await f.text()).toContain("读取失败")
  expect(await f.text()).not.toContain("没有代码变更")
  expect(nodes((await f.pane()).tree).some((node) => node.type === "Code")).toBe(false)
}, 30000)

it("shows authorized changes while explicitly marking protected paths as unchecked", async () => {
  const f = await fixture()
  await writeFile(join(f.repo, ".env"), "fixture-only-protected-content\n")
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", f.baseCommit)
  await f.action("load")
  expect(await f.text()).toContain("1 项受权限保护")
  expect(await f.text()).toContain("same.txt")
  expect(await f.text()).not.toContain("fixture-only-protected-content")
  expect(await f.text()).not.toContain(".env")
  await f.action("file-0")
  expect(await f.text()).toContain("+main directory change")
  await writeFile(join(f.repo, "same.txt"), "baseline\n")
  await f.action("load")
  expect(await f.text()).toContain("可读取范围内没有代码变更。")
  expect(await f.text()).toContain("1 项受权限保护")
  expect(await f.text()).not.toContain("读取失败")
}, 30000)

it("keeps the file list when cancellation settles before the replacement callback starts", async () => {
  const f = await fixture()
  await writeFile(join(f.repo, "two.txt"), "second file\n")
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", f.baseCommit)
  await f.action("load")
  const entered = Promise.withResolvers<void>()
  let firstFile = true
  f.gitAction.mockImplementation(async (context, action, input) => {
    if (action === "file" && firstFile) {
      firstFile = false
      entered.resolve()
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true })
        if (context.signal.aborted) resolve()
      })
      context.signal.throwIfAborted()
    }
    return f.originalGitAct(context, action, input)
  })
  const first = f.action("file-0").catch((error) => error)
  await entered.promise
  const admitReplacement = Promise.withResolvers<void>()
  const nativeAct = f.session.panes.act.bind(f.session.panes)
  vi.spyOn(f.session.panes, "act").mockImplementation(async (action) => {
    await admitReplacement.promise
    return nativeAct(action)
  })
  const second = f.action("file-1")
  try {
    expect(await first).toBeInstanceOf(Error)
    expect(await f.text()).not.toContain("读取失败")
    expect(await f.text()).toContain("two.txt")
  } finally {
    admitReplacement.resolve()
  }
  await second
  expect(await f.text()).toContain("second file")
  expect(await f.text()).not.toContain("读取失败")
  expect(await f.text()).not.toContain("读取已取消")
}, 30000)

it("explains skipped repository conversions beside the real raw-text preview", async () => {
  const f = await fixture()
  await writeFile(join(f.repo, ".git", "info", "attributes"), "*.txt filter=custom\n")
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", f.baseCommit)
  await f.action("load")
  await f.action("file-0")
  expect(await f.text()).toContain("预览使用文件原始文本，未执行仓库自定义转换。")
  expect(await f.text()).toContain("+main directory change")
  expect(await f.text()).not.toContain("读取失败")
}, 30000)

it.each(["patch", "content"] as const)(
  "carries a byte-bounded Unicode %s through the shipped guest and capability bridge",
  async (kind) => {
    const f = await fixture()
    // Quotes, backslashes and tabs expand in JSON; emoji must survive the cutoff intact.
    const line = '中文😀"\\\t changed line\n'
    const body = kind === "patch" ? line.replace("\n", "").repeat(1000) + "\n" : line.repeat(4000)
    await writeFile(join(f.repo, "same.txt"), body)
    await f.action("directory", "submit", f.repo)
    await f.action("baseline", "submit", f.baseCommit)
    await f.action("load")
    await f.action("file-0")
    const code = nodes((await f.pane()).tree).find((node) => node.type === "Code")
    expect(code, await f.text()).toBeDefined()
    const index = f.gitAction.mock.calls.findLastIndex(([, action]) => action === "file")
    const preview = (await f.gitAction.mock.results[index].value) as ModObject
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(15_000)
    expect(preview.truncated).toBe(true)
    expect(preview.limitations).toContain("capability-byte-limit")
    expect(code!.props.source).toBe(preview[kind])
    expect(String(code!.props.source)).toContain('中文😀"\\\t changed line')
    expect(String(code!.props.source)).not.toContain("�")
    expect(Buffer.from(String(code!.props.source)).toString("utf8")).toBe(code!.props.source)
    expect(await f.text()).not.toContain("读取失败")
  },
  60_000
)

it("paginates long Unicode paths within the bridge budget without skipping any real Git entry", async () => {
  const f = await fixture()
  const paths = Array.from(
    { length: 35 },
    (_, index) => `${"文".repeat(160)}-${String(index).padStart(3, "0")}.txt`
  )
  await Promise.all(paths.map((path) => writeFile(join(f.repo, path), "new file\n")))
  await f.action("directory", "submit", f.repo)
  await f.action("baseline", "submit", f.baseCommit)
  await f.action("load")
  const seen: string[] = []
  const cursors = new Set<string>()
  let first = true
  for (;;) {
    const index = f.gitAction.mock.calls.findLastIndex(([, action]) => action === "list")
    const page = (await f.gitAction.mock.results[index].value) as ModObject
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(15_000)
    const entries = page.entries as ModObject[]
    if (first) {
      expect(entries.length).toBeLessThan(30)
      first = false
    }
    seen.push(...entries.map((entry) => entry.path as string))
    expect(page.total).toBe(paths.length + 1)
    expect(page.truncated).toBe(false)
    expect(await f.text()).not.toContain("读取失败")
    if (!page.nextCursor) break
    expect(cursors.has(page.nextCursor as string)).toBe(false)
    cursors.add(page.nextCursor as string)
    await f.action("next")
  }
  expect(cursors.size).toBeGreaterThan(0)
  expect(seen.sort()).toEqual([...paths, "same.txt"].sort())
  expect(new Set(seen).size).toBe(seen.length)
}, 60_000)
