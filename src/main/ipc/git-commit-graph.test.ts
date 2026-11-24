import { EventEmitter } from "node:events"
import { execFileSync, spawnSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { gitGraphRefAt, type GitGraphPage } from "../../shared/git-graph"

const { handle, graphProcess } = vi.hoisted(() => ({
  handle: vi.fn(),
  graphProcess: { maxBuffer: undefined as number | undefined }
}))
vi.mock("electron", () => ({ ipcMain: { handle } }))
vi.mock("../services/git-graph-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-graph-process")>()
  const runGitProcessTree: typeof actual.runGitProcessTree = (args, options) =>
    actual.runGitProcessTree(args, { ...options, maxBuffer: graphProcess.maxBuffer ?? options.maxBuffer })
  return { runGitProcessTree }
})
import { registerGitHandlers } from "./git"
import { readCommitGraph } from "../services/git-commit-graph"
import { runGitProcessTree } from "../services/git-graph-process"

// These integration cases create real repositories and run several Git processes per page.
vi.setConfig({ testTimeout: 20_000 })
registerGitHandlers()
const graph = handle.mock.calls.find(([channel]) => channel === "git:getCommitGraph")![1] as (
  event: { sender: EventEmitter & { id: number } },
  input: unknown
) => Promise<GitGraphPage>
const event = { sender: Object.assign(new EventEmitter(), { id: 7 }) }
const temp: string[] = []
afterEach(() => {
  for (const cwd of temp.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "cmb-graph-test-"))
  temp.push(cwd)
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd, input, encoding: "utf8" }).trim()
  git(["init", "--quiet"])
  git(["symbolic-ref", "HEAD", "refs/heads/main"])
  git(["config", "user.name", "Test"])
  git(["config", "user.email", "test@example.invalid"])
  git(["config", "commit.gpgSign", "false"])
  git(["config", "core.hooksPath", path.join(cwd, ".no-hooks")])
  return { cwd, git }
}

function partialRepository() {
  const { cwd, git } = repository()
  git(["config", "uploadpack.allowFilter", "true"])
  git(["config", "uploadpack.allowAnySHA1InWant", "true"])
  for (const subject of ["one", "two", "three", "four"]) {
    git(["commit", "--allow-empty", "--quiet", "-m", subject])
  }
  const partial = path.join(cwd, "partial")
  const clone = spawnSync(
    "git",
    [
      "clone",
      "--filter=object:type=tree",
      "--no-checkout",
      "--single-branch",
      pathToFileURL(cwd).href,
      partial
    ],
    { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_ALLOW_PROTOCOL: "file" } }
  )
  if (/(?:invalid filter-spec|unknown option).*object:type=tree/.test(clone.stderr ?? "")) return
  expect(clone.status, clone.error?.message ?? clone.stderr).toBe(0)
  git(["-C", partial, "remote", "set-url", "origin", "ssh://graph-test.invalid/ignored"])
  vi.stubEnv("GIT_SSH_VARIANT", "ssh")
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "ssh")
  vi.stubEnv("GIT_NO_LAZY_FETCH", undefined)
  return { cwd, partial }
}

function shellArgument(argument: string): string {
  return "'" + argument.replaceAll("'", "'\\''") + "'"
}

function readWithoutHeadDecoration(cwd: string, args: string[], input?: string): string {
  // Older Git versions do not match HEAD against --decorate-refs patterns.
  const result = spawnSync(
    "git",
    args.filter((arg) => arg !== "--decorate-refs=HEAD"),
    { cwd, input, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw Object.assign(new Error(result.stderr), { code: result.status, stderr: result.stderr })
  }
  return result.stdout
}

function readGraphGit(cwd: string): Parameters<typeof readCommitGraph>[0] {
  return (args, input, consume) =>
    runGitProcessTree(args, {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
      input,
      consume,
      timeout: 10_000,
      operation: "读取 Git 图谱",
      maxBuffer: 20 * 1024 * 1024
    })
}

function writeDenseGraphRefs(cwd: string, hash: string): void {
  const refs = Array.from({ length: 4200 }, (_, i) =>
    `${hash} refs/heads/dense/${String(i).padStart(4, "0")}\n`
  )
  writeFileSync(path.join(cwd, ".git", "packed-refs"), "# pack-refs with: sorted\n" + refs.join(""))
}

it("rejects malformed requests before accessing a repository", async () => {
  for (const input of [
    null,
    [],
    { cwd: 1 },
    { cwd: "relative" },
    { skip: -1 },
    { skip: 2 ** 31 },
    { snapshot: {} }
  ]) {
    await expect(graph(event, input)).rejects.toThrow("无效")
  }
})

it.skipIf(process.platform === "win32")(
  "stops a partial clone's transport when the graph closes and can fetch on reopen",
  async ({ skip }) => {
    const repo = partialRepository()
    if (!repo) return skip("Git does not support filtering commit objects from a partial clone")
    const { cwd, partial } = repo

    const transport = path.join(cwd, "local-ssh")
    const marker = `${transport}.pid`
    const release = `${transport}.release`
    writeFileSync(
      transport,
      [
        "#!/bin/sh",
        'echo "$$" > "$0.pid"',
        'while [ ! -f "$0.release" ]; do sleep 0.02; done',
        'exec git upload-pack "$CMB_TEST_GRAPH_ORIGIN"',
        ""
      ].join("\n"),
      { mode: 0o755 }
    )
    const packDir = path.join(partial, ".git", "objects", "pack")
    const packCount = () => readdirSync(packDir).filter((name) => name.endsWith(".idx")).length
    const transportExited = (pid: number) => {
      const status = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
      if (status.error) throw status.error
      return status.status === 1 || status.stdout.trim().startsWith("Z")
    }

    vi.stubEnv("GIT_SSH_COMMAND", shellArgument(transport))
    vi.stubEnv("CMB_TEST_GRAPH_ORIGIN", cwd)
    const cancel = handle.mock.calls.find(([channel]) => channel === "git:cancelCommitGraph")![1]
    const pending = graph(event, { cwd: partial }).catch((error: unknown) => error)
    let transportPid = 0
    try {
      await vi.waitFor(
        () => {
          transportPid = Number(readFileSync(marker, "utf8"))
          expect(transportPid).toBeGreaterThan(0)
        },
        { timeout: 5_000 }
      )
      expect(packCount()).toBe(1)
      cancel(event)
      await expect(pending).resolves.toMatchObject({ name: "AbortError" })
      await vi.waitFor(() => expect(transportExited(transportPid)).toBe(true))
      expect(packCount()).toBe(1)

      writeFileSync(release, "")
      const page = await graph(event, { cwd: partial })
      expect(page.commits.map(({ subject }) => subject)).toEqual(["four", "three", "two", "one"])
      expect(packCount()).toBeGreaterThan(1)
    } finally {
      cancel(event)
      if (transportPid > 0 && !transportExited(transportPid)) {
        try {
          process.kill(transportPid, "SIGTERM")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      writeFileSync(release, "")
      await pending
      vi.unstubAllEnvs()
    }
  }
)

it.skipIf(process.platform === "win32")(
  "releases the graph queue when a detached transport process holds a Git pipe",
  async ({ skip }) => {
    const repo = partialRepository()
    if (!repo) return skip("Git does not support filtering commit objects from a partial clone")
    const { cwd, partial } = repo
    const transport = path.join(cwd, "detached-ssh.cjs")
    const marker = path.join(cwd, "detached.pid")
    writeFileSync(
      transport,
      [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        // Keep Git's stderr open from a different process group.
        'const worker = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", "inherit"] })',
        "writeFileSync(process.argv[2], String(worker.pid))"
      ].join("\n")
    )
    vi.stubEnv("GIT_SSH_COMMAND", [process.execPath, transport, marker].map(shellArgument).join(" "))
    const cancel = handle.mock.calls.find(([channel]) => channel === "git:cancelCommitGraph")![1]
    const other = { sender: Object.assign(new EventEmitter(), { id: 8 }) }
    const pending = graph(event, { cwd: partial }).catch((error: unknown) => error)
    let next: Promise<GitGraphPage> | undefined
    let detachedPid = 0
    try {
      await vi.waitFor(
        () => {
          detachedPid = Number(readFileSync(marker, "utf8"))
          expect(detachedPid).toBeGreaterThan(0)
        },
        { timeout: 5_000 }
      )
      cancel(event)
      next = graph(other, { cwd })
      let settled = false
      const onSettled = () => {
        settled = true
      }
      void next.then(onSettled, onSettled)
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 })
      await expect(pending).resolves.toMatchObject({ name: "AbortError" })
      expect((await next).commits.map(({ subject }) => subject)).toEqual([
        "four",
        "three",
        "two",
        "one"
      ])
      expect(process.kill(detachedPid, 0)).toBe(true)
    } finally {
      cancel(event)
      cancel(other)
      if (detachedPid > 0) {
        try {
          process.kill(detachedPid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await Promise.allSettled([pending, next])
      vi.unstubAllEnvs()
    }
  }
)

it("pages through visible history and resets after a same-length rewrite", async () => {
  const { cwd, git } = repository()
  expect((await graph(event, { cwd })).commits).toEqual([])
  const stream = Array.from(
    { length: 53 },
    (_, i) =>
      `commit refs/heads/main\ncommitter Test <test@example.invalid> ${10000000 + i} +0000\ndata ${String(i).length}\n${i}\n\n`
  ).join("")
  git(["fast-import", "--quiet"], stream)
  git(["branch", "origin/a,b", "HEAD"])
  git(["update-ref", "refs/remotes/origin/a,b", "HEAD"])
  git(["tag", "a,b", "HEAD"])
  git(["update-ref", "refs/internal/private", "HEAD"])
  const first = await graph(event, { cwd })
  expect(first.commits).toHaveLength(50)
  expect(first.hasMore).toBe(true)
  expect(first.commits[0].refs).toEqual(
    expect.arrayContaining([
      { kind: "head", name: "HEAD" },
      { kind: "local", name: "main" },
      { kind: "local", name: "origin/a,b" },
      { kind: "remote", name: "origin/a,b" },
      { kind: "tag", name: "a,b" }
    ])
  )
  expect(first.commits[0].refs).toHaveLength(5)
  const next = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
  expect(next.commits.map((c) => c.subject)).toEqual(["2", "1", "0"])
  expect(next.hasMore).toBe(false)
  git(["commit", "--amend", "--allow-empty", "--quiet", "-m", "rewritten"])
  const reset = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
  expect(reset.reset).toBe(true)
  expect(reset.commits[0].subject).toBe("rewritten")
})

it("keeps a page on its captured tips when a branch moves away and back during the walk", async () => {
  const { cwd, git } = repository()
  const history = (ref: string, prefix: string, length: number, time: number) =>
    Array.from({ length }, (_, i) => {
      const subject = `${prefix}-${i}`
      return (
        `commit ${ref}\ncommitter Test <test@example.invalid> ${time + i} +0000\n` +
        `data ${subject.length}\n${subject}\n\n`
      )
    }).join("")
  const topic = "refs/heads/topic"
  const checkpoint = "refs/internal/checkpoint"
  git(
    ["fast-import", "--quiet"],
    history("refs/heads/main", "main", 55, 10000000) + history(checkpoint, "hidden", 52, 20000000)
  )
  git(["update-ref", topic, "main~51"])

  const first = await graph(event, { cwd })
  const expected = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
  const read = readGraphGit(cwd)
  let moved = false
  const next = await readCommitGraph(
    async (args, input, consume) => {
      if (!args.includes("--topo-order") || moved) return read(args, input, consume)
      moved = true
      git(["update-ref", topic, checkpoint])
      try {
        return await read(args, input, consume)
      } finally {
        git(["update-ref", topic, "main~51"])
      }
    },
    50,
    first.snapshot
  )

  expect(moved).toBe(true)
  expect(next.reset).toBe(false)
  expect(next.snapshot).toBe(first.snapshot)
  expect(next.commits).toEqual(expected.commits)
  expect(next.commits.find(({ subject }) => subject === "main-3")?.refs).toContainEqual({
    kind: "local",
    name: "topic"
  })
})

it("keeps one captured HEAD when an external checkout moves it away and back during tip capture", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "main tip"])
  git(["checkout", "--quiet", "-b", "topic"])
  git(["commit", "--allow-empty", "--quiet", "-m", "topic tip"])
  git(["checkout", "--quiet", "main"])

  const read = readGraphGit(cwd)
  const expected = await readCommitGraph(read, 0)
  let switched = false
  const page = await readCommitGraph(async (args, input, consume) => {
    if (switched || !args.includes("--no-walk=unsorted")) return read(args, input, consume)
    switched = true
    git(["checkout", "--quiet", "topic"])
    try {
      return await read(args, input, consume)
    } finally {
      git(["checkout", "--quiet", "main"])
    }
  }, 0)

  expect(switched).toBe(true)
  expect(page.snapshot).toBe(expected.snapshot)
  expect(page.commits).toEqual(expected.commits)
  const headCommits = page.commits.flatMap(({ subject, refs }) =>
    refs.filter(({ kind }) => kind === "head").map(() => subject)
  )
  expect(headCommits).toEqual(["main tip"])
})

it("streams oversized ref snapshots while returning bounded pages with decorations", async () => {
  const { cwd, git } = repository()
  const tag = (index: number) => `history-${index}-${"topic".repeat(18)}`
  const history = Array.from({ length: 120 }, (_, index) => {
    const message = String(index)
    return (
      `commit refs/heads/main\nmark :${index + 1}\n` +
      `committer Test <test@example.invalid> ${10000000 + index} +0000\n` +
      `data ${message.length}\n${message}\n\n` +
      `reset refs/tags/${tag(index)}\nfrom :${index + 1}\n\n`
    )
  }).join("")
  git(["fast-import", "--quiet"], history)
  const maxBuffer = 14 * 1024
  const refBytes = Buffer.byteLength(git(["for-each-ref", "--format=%(refname)%00%(objectname)"]))
  expect(refBytes).toBeGreaterThan(maxBuffer)
  graphProcess.maxBuffer = maxBuffer
  try {
    const first = await graph(event, { cwd })
    expect(first.commits).toHaveLength(50)
    expect(first.commits[0].refs).toContainEqual({ kind: "tag", name: tag(119) })
    const next = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
    expect(next.reset).toBe(false)
    expect(next.commits).toHaveLength(50)
    expect(next.commits[0].refs).toContainEqual({ kind: "tag", name: tag(69) })

    git(["tag", "off-page", "refs/tags/" + tag(0)])
    const reset = await graph(event, { cwd, skip: 50, snapshot: next.snapshot })
    expect(reset.reset).toBe(true)
    expect(reset.commits[0].hash).toBe(first.commits[0].hash)
  } finally {
    graphProcess.maxBuffer = undefined
  }
})

it("rescans a large ref snapshot only for pages with uncached decorations", async () => {
  const { cwd } = repository()
  const read = readGraphGit(cwd)
  const hash = (n: number) => n.toString(16).padStart(40, "0")
  // Stream valid, distinct long tag names just beyond the label cache budget.
  const tags = Array.from({ length: 80 }, (_, i) => {
    const lines = Array.from({ length: 1024 }, (_, j) => {
      const n = 1 + i * 1024 + j
      return `${hash(n)}\ttag: refs/tags/${"v".repeat(156)}-${n}\n`
    })
    return Buffer.from(lines.join(""))
  })
  const last = 80 * 1024
  let scans = 0
  let oversizedFrom = Infinity
  let oversizedUntil = -1
  let pageIds = [1, last + 1] // A cached tag and an ancestor without any tag.
  const readPage: typeof read = async (args, input, consume) => {
    if (args.includes("--no-walk=unsorted")) {
      scans++
      for (const chunk of tags) {
        if (chunk === tags[tags.length - 1] && scans >= oversizedFrom && scans <= oversizedUntil) {
          consume!(chunk.subarray(0, chunk.lastIndexOf(10, chunk.length - 2) + 1))
          consume!(Buffer.from(`${hash(last)}\ttag: refs/tags/${"v".repeat(20 * 1024 * 1024)}\n`))
        } else {
          consume!(chunk)
        }
      }
      return ""
    }
    if (args.includes("--topo-order")) {
      return pageIds.map((n) => [hash(n), "", "test", "1", "subject", ""].join("\0")).join("")
    }
    return read(args, input, consume)
  }

  const first = await readCommitGraph(readPage, 0)
  expect(scans).toBe(1)
  expect(first.commits.map((c) => c.refs.length)).toEqual([1, 0])
  pageIds = [1, last]
  const next = await readCommitGraph(readPage, 50, first.snapshot)
  expect(scans).toBe(3)
  expect(next.reset).toBe(false)
  expect(next.commits.map((c) => c.refs[0]?.name)).toEqual(
    pageIds.map((n) => `${"v".repeat(156)}-${n}`)
  )
  // An oversized decoration from a different snapshot must trigger a retry.
  oversizedFrom = oversizedUntil = scans + 2
  const retried = await readCommitGraph(readPage, 50, first.snapshot)
  expect(retried.reset).toBe(true)
  expect(retried.commits).toEqual(next.commits)
  expect(scans).toBe(7)
  oversizedFrom = scans + 1
  oversizedUntil = Infinity
  await expect(readCommitGraph(readPage, 0)).rejects.toThrow("单条提交的 Git 引用过多")
})

it("includes detached and linked worktree HEAD and observes shallow boundary changes", async () => {
  const { cwd, git } = repository()
  for (const subject of ["one", "two", "three"])
    git(["commit", "--allow-empty", "--quiet", "-m", subject])
  const linked = path.join(cwd, "linked")
  git(["worktree", "add", "--detach", linked])
  git(["-C", linked, "commit", "--allow-empty", "--quiet", "-m", "linked tip"])
  const page = await graph(event, { cwd: linked })
  expect(page.commits.find((c) => c.subject === "linked tip")?.refs).toContainEqual({
    kind: "head",
    name: "HEAD"
  })
  const shallow = path.join(cwd, "shallow")
  git(["clone", "--quiet", "--no-local", "--depth=1", cwd, shallow])
  const before = await graph(event, { cwd: shallow })
  expect(before.commits).toHaveLength(1)
  git(["-C", shallow, "fetch", "--quiet", "--deepen=1"])
  const after = await graph(event, { cwd: shallow, snapshot: before.snapshot, skip: 50 })
  expect(after.reset).toBe(true)
  expect(after.commits).toHaveLength(2)

  let unshallowed = false
  const complete = await readCommitGraph(
    async (args, input) => {
      if (!unshallowed && args[0] === "hash-object" && path.basename(args.at(-1)!) === "shallow") {
        git(["-C", shallow, "fetch", "--quiet", "--unshallow"])
        unshallowed = true
      }
      return execFileSync("git", args, {
        cwd: shallow,
        input,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"]
      })
    },
    50,
    after.snapshot
  )
  expect(unshallowed).toBe(true)
  expect(complete.reset).toBe(true)
  expect(complete.commits).toHaveLength(3)
})

it("restores HEAD decorations and resets after checkout on Git with legacy decoration filters", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "first"])
  git(["branch", "topic"])
  git(["tag", "HEAD"])
  git(["config", "log.excludeDecoration", "refs/heads/main"])
  const read = async (args: string[], input?: string) => readWithoutHeadDecoration(cwd, args, input)
  const first = await readCommitGraph(read, 0)
  const head = { kind: "head", name: "HEAD" }
  expect(first.commits[0].refs.slice(0, 2)).toEqual([head, { kind: "local", name: "main" }])

  git(["checkout", "--quiet", "topic"])
  const next = await readCommitGraph(read, 50, first.snapshot)
  expect(next.reset).toBe(true)
  expect(next.commits[0].refs.slice(0, 2)).toEqual([head, { kind: "local", name: "topic" }])

  git(["checkout", "--quiet", "--detach", "refs/heads/topic"])
  const detached = await readCommitGraph(read, 50, next.snapshot)
  expect(detached.reset).toBe(true)
  expect(detached.commits[0].refs[0]).toEqual(head)

  git(["symbolic-ref", "HEAD", "refs/heads/unborn"])
  const unborn = await readCommitGraph(read, 50, detached.snapshot)
  expect(unborn.reset).toBe(true)
  expect(unborn.commits[0].refs).not.toContainEqual(head)
  expect(unborn.commits[0].refs).toContainEqual({ kind: "tag", name: "HEAD" })
  expect(unborn.commits[0].refs).toContainEqual({ kind: "local", name: "main" })
})

it("resets to existing history when HEAD changes from detached to unborn during detection", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "first"])
  git(["checkout", "--quiet", "--detach", "main"])
  git(["commit", "--allow-empty", "--quiet", "-m", "detached-only"])
  const detached = await graph(event, { cwd })
  expect(detached.commits.map(({ subject }) => subject)).toEqual(["detached-only", "first"])

  const read = readGraphGit(cwd)
  let moved = false
  const unborn = await readCommitGraph(
    async (args, input, consume) => {
      if (!moved && args[0] === "show-ref") {
        git(["symbolic-ref", "HEAD", "refs/heads/unborn"])
        moved = true
      }
      return read(args, input, consume)
    },
    50,
    detached.snapshot
  )

  expect(moved).toBe(true)
  expect(unborn.reset).toBe(true)
  expect(unborn.commits.map(({ subject }) => subject)).toEqual(["first"])
  expect(unborn.commits[0].refs).toEqual([{ kind: "local", name: "main" }])
})

it("retries if a legacy HEAD is read after the visible tips change", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "first"])
  git(["checkout", "--detach", "--quiet"])
  git(["commit", "--allow-empty", "--quiet", "-m", "detached-only"])
  git(["update-ref", "refs/internal/private", "HEAD"])
  const read = async (args: string[], input?: string) => readWithoutHeadDecoration(cwd, args, input)
  const detached = await readCommitGraph(read, 0)
  expect(detached.commits.map(({ subject }) => subject)).toEqual(["detached-only", "first"])

  let checkedOut = false
  const after = await readCommitGraph(
    async (args, input) => {
      if (!checkedOut && args[0] === "symbolic-ref") {
        git(["checkout", "--quiet", "main"])
        checkedOut = true
      }
      return read(args, input)
    },
    50,
    detached.snapshot
  )
  expect(checkedOut).toBe(true)
  expect(after.reset).toBe(true)
  expect(after.commits.map(({ subject }) => subject)).toEqual(["first"])
  expect(after.commits[0].refs).toContainEqual({ kind: "head", name: "HEAD" })
})

it("observes legacy graft boundaries and decodes commit subjects as UTF-8", async () => {
  const { cwd, git } = repository()
  git(["config", "i18n.logOutputEncoding", "ISO-8859-1"])
  git(["commit", "--allow-empty", "--quiet", "-m", "first"])
  git(["commit", "--allow-empty", "--quiet", "-m", "déjà vu"])
  const first = await graph(event, { cwd })
  expect(first.commits[0].subject).toBe("déjà vu")
  writeFileSync(path.join(cwd, ".git/info/grafts"), first.commits[0].hash + "\n")
  const updated = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
  expect(updated.reset).toBe(true)
  expect(updated.commits).toHaveLength(1)
})

it("reads history when the optional graft path is a directory", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "visible"])
  mkdirSync(path.join(cwd, ".git/info/grafts"), { recursive: true })
  const page = await graph(event, { cwd })
  expect(page.commits.map(({ subject }) => subject)).toEqual(["visible"])
})

it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
  "reads the same visible history as Git when optional grafts are unreadable",
  async () => {
    const { cwd, git } = repository()
    git(["commit", "--allow-empty", "--quiet", "-m", "first"])
    git(["commit", "--allow-empty", "--quiet", "-m", "second"])
    const grafts = path.join(cwd, ".git/info/grafts")
    mkdirSync(path.dirname(grafts), { recursive: true })
    writeFileSync(grafts, git(["rev-parse", "HEAD"]) + "\n", { mode: 0o600 })
    const initial = await graph(event, { cwd })
    expect(initial.commits.map(({ subject }) => subject)).toEqual(["second"])

    chmodSync(grafts, 0)
    try {
      const log = spawnSync(
        "git",
        ["log", "HEAD", "--branches", "--tags", "--remotes", "--topo-order", "--format=%s"],
        { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }
      )
      expect(log.status, log.error?.message ?? log.stderr).toBe(0)
      expect(log.stderr).toContain("Permission denied")
      const subjects = log.stdout.trimEnd().split(/\r?\n/)
      expect(subjects).toEqual(["second", "first"])
      const updated = await graph(event, { cwd, skip: 50, snapshot: initial.snapshot })
      expect(updated.reset).toBe(true)
      expect(updated.commits.map(({ subject }) => subject)).toEqual(subjects)
    } finally {
      chmodSync(grafts, 0o600)
    }
  }
)

it("keeps graph reads and branch writes in the selected repository with inherited Git overrides", async () => {
  const launcher = repository()
  const selected = repository()
  launcher.git(["commit", "--quiet", "--allow-empty", "-m", "launcher"])
  selected.git(["commit", "--quiet", "--allow-empty", "-m", "selected"])
  const create = handle.mock.calls.find(([channel]) => channel === "git:createBranch")![1]
  vi.stubEnv("GIT_DIR", path.join(launcher.cwd, ".git"))
  vi.stubEnv("GIT_WORK_TREE", launcher.cwd)
  try {
    const page = await graph(event, { cwd: selected.cwd })
    expect(page.commits.map((commit) => commit.subject)).toEqual(["selected"])
    await expect(
      create(event, { cwd: selected.cwd, branch: "test-selected" })
    ).resolves.toMatchObject({
      success: true,
      branch: "test-selected"
    })
  } finally {
    vi.unstubAllEnvs()
  }
  expect(selected.git(["symbolic-ref", "--short", "HEAD"])).toBe("test-selected")
  expect(launcher.git(["symbolic-ref", "--short", "HEAD"])).toBe("main")
})

it("discards a page if a history boundary changes during traversal", async () => {
  const { cwd, git } = repository()
  const stream = Array.from(
    { length: 65 },
    (_, i) =>
      `commit refs/heads/main\ncommitter Test <t@example.invalid> ${10000000 + i} +0000\ndata ${String(i).length}\n${i}\n\n`
  ).join("")
  git(["fast-import", "--quiet"], stream)
  const first = await graph(event, { cwd })
  let walked = 0
  const page = await readCommitGraph(
    async (args, input) => {
      if (args.includes("--topo-order") && walked++ === 0) {
        writeFileSync(path.join(cwd, ".git/info/grafts"), git(["rev-parse", "HEAD"]) + "\n")
      }
      return execFileSync("git", args, {
        cwd,
        input,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"]
      })
    },
    50,
    first.snapshot
  )
  expect(page.reset).toBe(true)
  expect(page.snapshot).not.toBe(first.snapshot)
  expect(page.commits.map((commit) => commit.subject)).toEqual(["64"])
})

it("resets the graph when replacement configuration changes between pages", async () => {
  const { cwd, git } = repository()
  for (const subject of ["one", "two", "three"]) {
    git(["commit", "--quiet", "--allow-empty", "-m", subject])
  }
  git(["replace", "--graft", "HEAD", "HEAD~2"])
  const alternate = path.join(cwd, "launcher.gitconfig")
  writeFileSync(alternate, "[core]\nuseReplaceRefs = true\n")
  vi.stubEnv("GIT_CONFIG", alternate)
  try {
    const first = await graph(event, { cwd })
    expect(first.commits.map((commit) => commit.subject)).toEqual(["three", "one"])
    git(["config", "--file", path.join(cwd, ".git", "config"), "core.useReplaceRefs", "false"])
    const reset = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
    expect(reset.reset).toBe(true)
    expect(reset.commits.map((commit) => commit.subject)).toEqual(
      git(["log", "--topo-order", "--format=%s", "HEAD"]).split(/\r?\n/)
    )
  } finally {
    vi.unstubAllEnvs()
  }
})

it("tracks replacements in a custom replacement namespace", async () => {
  const { cwd, git } = repository()
  for (const subject of ["one", "two", "three"]) {
    git(["commit", "--quiet", "--allow-empty", "-m", subject])
  }
  vi.stubEnv("GIT_REPLACE_REF_BASE", "refs/custom/replacements/")
  try {
    const first = await graph(event, { cwd })
    expect(first.commits.map(({ subject }) => subject)).toEqual(["three", "two", "one"])
    git(["replace", "--graft", "HEAD", "HEAD~2"])

    const next = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
    expect(next.reset).toBe(true)
    expect(next.commits.map(({ subject }) => subject)).toEqual(["three", "one"])
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(["refs/alt", ""])("tracks replacements with a literal Git prefix %j", async (base) => {
  const { cwd, git } = repository()
  const stream = Array.from(
    { length: 55 },
    (_, i) =>
      `commit refs/heads/main\ncommitter Test <test@example.invalid> ${10000000 + i} +0000\ndata ${String(i).length}\n${i}\n\n`
  ).join("")
  git(["fast-import", "--quiet"], stream)
  const target = git(["rev-parse", "HEAD~48"])
  try {
    vi.stubEnv("GIT_REPLACE_REF_BASE", "refs/replacement-test/")
    git(["replace", "--graft", target, "HEAD~52"])
    const replacement = git(["rev-parse", `refs/replacement-test/${target}`])
    git(["replace", "--delete", target])

    vi.stubEnv("GIT_REPLACE_REF_BASE", base)
    const first = await graph(event, { cwd })
    expect(first.hasMore).toBe(true)
    expect(first.commits.slice(-2).map(({ subject }) => subject)).toEqual(["6", "5"])

    git(["update-ref", `refs/alternative/${target}`, replacement])
    const next = await graph(event, { cwd, skip: 50, snapshot: first.snapshot })
    expect(next.reset).toBe(true)
    expect(next.snapshot).not.toBe(first.snapshot)
    expect(next.commits.slice(-2).map(({ subject }) => subject)).toEqual(["6", "2"])
  } finally {
    vi.unstubAllEnvs()
  }
})

it("keeps dense dialog labels ordered and readable across packed block boundaries", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "tip"])
  const tip = git(["rev-parse", "HEAD"])
  const commands = Array.from({ length: 900 }, (_, i) => {
    const namespace = ["heads", "remotes/origin", "tags"][i % 3]
    return `update refs/${namespace}/长标签,分支-${i} ${tip}\n`
  })
  git(["update-ref", "--stdin"], commands.join(""))
  for (const detached of [false, true]) {
    if (detached) git(["checkout", "--quiet", "--detach", tip])
    const full = (await graph(event, { cwd })).commits[0]
    const packed = (await graph(event, { cwd, forDialog: true })).commits[0]
    expect(packed.refs).toEqual(full.refs.slice(0, 4))
    expect(packed.packedRefs?.length).toBe(full.refs.length)
    expect(full.refs.map((_, index) => gitGraphRefAt(packed, index))).toEqual(full.refs)
  }
})

it("captures dense direct refs with Git's commit and decoration order", async () => {
  const { cwd, git } = repository()
  const addRoot = (ref: string, subject: string) =>
    `commit ${ref}\ncommitter Test <test@example.invalid> 10000000 +0000\n` +
    `data ${subject.length}\n${subject}\n\n`
  git(["fast-import", "--quiet"],
    addRoot("refs/heads/main", "main tip") +
    addRoot("refs/heads/topic", "topic tip") +
    addRoot("refs/tags/version", "tag tip") +
    addRoot("refs/remotes/origin/topic", "remote tip")
  )
  git(["symbolic-ref", "refs/heads/local-alias", "refs/heads/main"])
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic"])
  writeDenseGraphRefs(cwd, git(["rev-parse", "HEAD"]))

  const read = readGraphGit(cwd)
  const original = await readCommitGraph(read, 0)
  const commands: string[][] = []
  const readDialog: typeof read = (args, input, consume) => {
    commands.push(args)
    return read(args, input, consume)
  }
  const dense = await readCommitGraph(readDialog, 0, undefined, undefined, true)
  expect(commands.some((args) => args[0] === "cat-file")).toBe(true)
  expect(commands.some((args) => args.includes("--decorate=full"))).toBe(false)
  expect(dense.snapshot).toBe(original.snapshot)
  expect(dense.commits.map(({ packedRefs, refs, ...commit }) => ({
    ...commit,
    refs: packedRefs
      ? Array.from({ length: packedRefs.length }, (_, i) => gitGraphRefAt({ ...commit, packedRefs, refs }, i))
      : refs
  }))).toEqual(original.commits)
  expect((await readCommitGraph(readDialog, 0, dense.snapshot, undefined, true)).reset).toBe(false)

  git(["tag", "-a", "annotated", "-m", "nested target", "refs/tags/version"])
  git(["-c", "advice.nestedTag=false", "tag", "-a", "nested", "-m", "nested tag", "refs/tags/annotated"])
  commands.length = 0
  const annotated = await readCommitGraph(readDialog, 0, dense.snapshot, undefined, true)
  expect(commands.some((args) => args.includes("--decorate=full"))).toBe(true)
  expect(annotated.reset).toBe(true)
  expect(annotated.commits.find(({ subject }) => subject === "tag tip")?.refs).toEqual([
    { kind: "tag", name: "version" },
    { kind: "tag", name: "nested" },
    { kind: "tag", name: "annotated" }
  ])
})

it("distinguishes HEAD branches with identical decoded names in dense and native snapshots", async () => {
  const { cwd, git } = repository()
  const tree = git(["mktree"], "")
  const date = "2001-01-01T00:00:00Z"
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  const commit = (subject: string) => execFileSync("git", ["commit-tree", tree, "-m", subject], {
    cwd, env, encoding: "utf8"
  }).trim()
  const main = commit("main")
  git(["update-ref", "refs/heads/main", main])
  writeDenseGraphRefs(cwd, main)

  const branches = [Buffer.from("\uFFFD"), Buffer.of(0xfe), Buffer.of(0xff)].map((suffix, index) => {
    const ref = Buffer.concat([Buffer.from("refs/heads/zz-分支-"), suffix])
    const hash = commit(`branch ${index}`)
    git(["update-ref", `refs/heads/zzzz-é-${index}`, hash])
    appendFileSync(path.join(cwd, ".git", "packed-refs"), Buffer.concat([
      Buffer.from(`${hash} `), ref, Buffer.from("\n")
    ]))
    return { ref, hash }
  })
  const read = readGraphGit(cwd)
  const commands: string[][] = []
  const readDialog: typeof read = (args, input, consume) => {
    commands.push(args)
    return read(args, input, consume)
  }
  const setHead = (ref: Buffer) => writeFileSync(path.join(cwd, ".git", "HEAD"), Buffer.concat([
    Buffer.from("ref: "), ref, Buffer.from("\n")
  ]))

  for (const { ref, hash } of branches) {
    setHead(ref)
    const nativeOrder = git([
      "log", "HEAD", "--branches", "--tags", "--remotes", "--topo-order", "--format=%H"
    ]).split(/\r?\n/)
    const regular = await readCommitGraph(read, 0)
    commands.length = 0
    const dense = await readCommitGraph(readDialog, 0, regular.snapshot, undefined, true)
    expect(commands.some((args) => args[0] === "cat-file")).toBe(true)
    expect(commands.some((args) => args.includes("--decorate=full"))).toBe(false)
    expect(dense.reset).toBe(false)
    expect(dense.snapshot).toBe(regular.snapshot)
    for (const page of [regular, dense]) {
      expect(page.commits.map((commit) => commit.hash)).toEqual(nativeOrder)
      expect(page.commits.filter((commit) => commit.refs.some((label) => label.kind === "head"))
        .map((commit) => commit.hash)).toEqual([hash])
      expect(page.commits.find((commit) => commit.hash === hash)?.refs.slice(0, 2)).toEqual([
        { kind: "head", name: "HEAD" },
        { kind: "local", name: "zz-分支-\uFFFD" }
      ])
    }
  }
})

it("continues pagination when any optional dense Git read fails", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "parent"])
  git(["commit", "--allow-empty", "--quiet", "-m", "tip"])
  writeDenseGraphRefs(cwd, git(["rev-parse", "HEAD"]))
  git(["checkout", "--quiet", "--detach"])
  git(["commit", "--allow-empty", "--quiet", "-m", "detached tip"])

  const read = readGraphGit(cwd)
  const first = await readCommitGraph(read, 0, undefined, undefined, true)
  expect(first.commits[0].refs).toEqual([{ kind: "head", name: "HEAD" }])
  for (const command of ["rev-parse", "for-each-ref", "cat-file"]) {
    let failed = false
    const readFailing: typeof read = async (args, input, consume) => {
      if (args[0] === command && (consume || command === "cat-file")) {
        failed = true
        throw new Error(`${command} failed`)
      }
      return read(args, input, consume)
    }
    const next = await readCommitGraph(readFailing, 1, first.snapshot, undefined, true)
    expect(failed, command).toBe(true)
    expect(next.reset, command).toBe(false)
    expect(next.snapshot, command).toBe(first.snapshot)
    expect(next.commits.map(({ subject }) => subject), command).toEqual(["tip", "parent"])
  }
})

it("propagates the cancellation reason from an optional probe", async () => {
  const { cwd } = repository()
  const controller = new AbortController()
  const reason = new Error("graph closed")
  const read = readGraphGit(cwd)
  const readAborted: typeof read = async (args, input, consume) => {
    if (args[0] === "rev-parse" && args.includes("--branches")) {
      controller.abort(reason)
      throw new Error("the optional probe was interrupted")
    }
    expect(args.includes("--decorate=full")).toBe(false)
    return read(args, input, consume)
  }
  await expect(readCommitGraph(readAborted, 0, undefined, controller.signal, true)).rejects.toBe(reason)
})

it("skips the dense label scan when the ref probe sees many distinct tips", async () => {
  const { cwd, git } = repository()
  git(["commit", "--allow-empty", "--quiet", "-m", "tip"])
  const read = readGraphGit(cwd)
  const sample = Array.from({ length: 513 }, (_, i) => i.toString(16).padStart(40, "0")).join("\n")
  let consumedAll = false
  let labelScan = false
  const readDialog: typeof read = async (args, input, consume) => {
    if (args[0] === "rev-parse" && args.includes("--branches")) {
      consume!(Buffer.from(sample + "\n"))
      consumedAll = true
      return ""
    }
    if (args[0] === "for-each-ref" && consume) labelScan = true
    return read(args, input, consume)
  }
  const page = await readCommitGraph(readDialog, 0, undefined, undefined, true)
  expect(page.commits.map(({ subject }) => subject)).toEqual(["tip"])
  expect(consumedAll).toBe(false)
  expect(labelScan).toBe(false)
})

it.skipIf(process.platform === "win32")(
  "stops sibling graph metadata commands when a metadata read fails",
  async () => {
    const { cwd } = repository()
    const marker = path.join(cwd, "metadata.pid")
    const script = [
      "#!/bin/sh",
      'case "$1" in',
      "  for-each-ref)",
      `    until [ -s ${shellArgument(marker)} ]; do sleep 0.02; done`,
      '    printf "%s\\n" "test metadata failure" >&2',
      "    exit 128 ;;",
      "  rev-parse)",
      `    printf "%s\\n" "$$" > ${shellArgument(marker)}`,
      "    exec sleep 30 ;;",
      "esac",
      "exit 69",
      ""
    ].join("\n")
    writeFileSync(path.join(cwd, "git"), script, { mode: 0o755 })
    vi.stubEnv("PATH", [cwd, process.env.PATH].join(path.delimiter))
    vi.stubEnv("GIT_REPLACE_REF_BASE", undefined)
    try {
      await expect(graph(event, { cwd })).rejects.toThrow("test metadata failure")
      const pid = Number(readFileSync(marker, "utf8"))
      expect(pid).toBeGreaterThan(0)
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/))
    } finally {
      try {
        const pid = Number(readFileSync(marker, "utf8"))
        if (pid > 0) process.kill(pid, "SIGKILL")
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      } finally {
        vi.unstubAllEnvs()
      }
    }
  }
)
