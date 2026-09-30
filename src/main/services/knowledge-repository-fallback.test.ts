import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { syncKnowledgeRepository } from "./knowledge-repository"

const { runGit } = vi.hoisted(() => ({ runGit: vi.fn() }))
vi.mock("child_process", async () => {
  const { promisify } = await import("util")
  return { execFile: Object.assign(() => undefined, { [promisify.custom]: runGit }) }
})

const url = "https://example.com/knowledge.git"
const sshUrl = "git@example.com:knowledge.git"
const source = { role: "read" as const, idKey: "release-next", url, sshUrl, ref: "release/next" }
const commit = "a".repeat(40)
let root: string
let httpsFailure: Error | undefined
let sshFailure: Error | undefined
let httpsProbeFailure: Error | undefined
let sshProbeFailure: Error | undefined
let probeExistingCheckout = false

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-fallback-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  httpsFailure = undefined
  sshFailure = undefined
  httpsProbeFailure = undefined
  sshProbeFailure = undefined
  probeExistingCheckout = false
  runGit.mockReset()
  runGit.mockImplementation(async (_file, args: string[], options: { cwd: string }) => {
    if (args.includes("ls-remote")) {
      if (args.includes(url) && httpsProbeFailure) throw httpsProbeFailure
      if (args.includes(sshUrl) && sshProbeFailure) throw sshProbeFailure
      return { stdout: `${commit}\trefs/heads/${source.ref}\n`, stderr: "" }
    }
    if (args.includes("--show-toplevel") && probeExistingCheckout) {
      return { stdout: `${options.cwd}\n`, stderr: "" }
    }
    if (probeExistingCheckout && args.includes("get-url")) return { stdout: url, stderr: "" }
    if (probeExistingCheckout && args.includes("symbolic-ref"))
      return { stdout: source.ref, stderr: "" }
    if (args.includes("clone")) {
      const checkout = args[args.length - 1]
      // Model a failed clone leaving partial files behind.
      await mkdir(checkout)
      await writeFile(join(checkout, "AGENTS.md"), "knowledge")
      if (args.includes(url) && httpsFailure) throw httpsFailure
      if (args.includes(sshUrl) && sshFailure) throw sshFailure
    }
    return { stdout: args.includes("rev-parse") ? `${commit}\n` : "", stderr: "" }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it("uses a 20 second HTTPS clone timeout and does not fall back on success", async () => {
  const result = await syncKnowledgeRepository(source)
  const clones = runGit.mock.calls.filter((call) => call[1].includes("clone"))
  expect(clones).toHaveLength(1)
  expect(clones[0][2].timeout).toBe(20_000)
  expect(result.commit).toBe(commit)
  expect(console.log).not.toHaveBeenCalled()
})

it.each(["connection failed", "timed out"])("falls back to SSH after HTTPS %s", async (reason) => {
  const previous = await syncKnowledgeRepository({
    role: "read" as const,
    idKey: source.idKey,
    url,
    ref: source.ref
  })
  runGit.mockClear()
  httpsFailure = new Error(reason)
  const result = await syncKnowledgeRepository(source)
  const clones = runGit.mock.calls.filter((call) => call[1].includes("clone"))
  expect(clones).toHaveLength(2)
  expect(clones[0][2].timeout).toBe(20_000)
  expect(clones[1][1]).toContain(sshUrl)
  expect(clones[1][1]).toContain(source.ref)
  expect(clones[1][2].timeout).toBe(120_000)
  expect(result.path).toBe(previous.path)
  expect(await readFile(join(result.path, "AGENTS.md"), "utf8")).toBe("knowledge")
  expect(console.log).toHaveBeenCalledWith(
    "[knowledge_manage] HTTPS 克隆失败或超时，回退使用 sshUrl 重试",
    { ref: source.ref }
  )
  expect(await readdir(join(root, "knowledge"))).toHaveLength(1)
})

it("preserves the previous checkout and both errors when SSH also fails", async () => {
  const previous = await syncKnowledgeRepository(source)
  httpsFailure = new Error("https failed")
  sshFailure = new Error("ssh failed")
  await expect(syncKnowledgeRepository(source)).rejects.toMatchObject({
    errors: [httpsFailure, sshFailure]
  })
  expect(await readFile(join(previous.path, "AGENTS.md"), "utf8")).toBe("knowledge")
  expect(await readdir(join(root, "knowledge"))).toHaveLength(1)
})

it("falls back to SSH when an HTTPS remote check fails", async () => {
  const previous = await syncKnowledgeRepository(source)
  probeExistingCheckout = true
  httpsProbeFailure = new Error("remote check timed out")
  runGit.mockClear()
  const result = await syncKnowledgeRepository(source)
  const probes = runGit.mock.calls.filter((call) => call[1].includes("ls-remote"))
  expect(probes).toHaveLength(2)
  expect(probes[0][1]).toContain(url)
  expect(probes[0][2].timeout).toBe(20_000)
  expect(probes[1][1]).toContain(sshUrl)
  expect(probes[1][2].timeout).toBe(120_000)
  expect(result.path).toBe(previous.path)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(0)
  expect(console.log).toHaveBeenCalledWith(
    "[knowledge_manage] HTTPS 远端检查失败或超时，回退使用 sshUrl 重试",
    { ref: source.ref }
  )
})

it("preserves the checkout when both remote checks fail", async () => {
  const previous = await syncKnowledgeRepository(source)
  probeExistingCheckout = true
  httpsProbeFailure = new Error("https remote check failed")
  sshProbeFailure = new Error("ssh remote check failed")
  runGit.mockClear()
  await expect(syncKnowledgeRepository(source)).rejects.toMatchObject({
    errors: [httpsProbeFailure, sshProbeFailure]
  })
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(0)
  expect(await readFile(join(previous.path, "AGENTS.md"), "utf8")).toBe("knowledge")
  expect(await readdir(join(root, "knowledge"))).toHaveLength(1)
})

it("does not fall back or clone after an aborted remote check", async () => {
  const previous = await syncKnowledgeRepository(source)
  probeExistingCheckout = true
  const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" })
  httpsProbeFailure = cancelled
  runGit.mockClear()
  await expect(syncKnowledgeRepository(source)).rejects.toBe(cancelled)
  expect(runGit.mock.calls.filter((call) => call[1].includes("ls-remote"))).toHaveLength(1)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(0)
  expect(await readFile(join(previous.path, "AGENTS.md"), "utf8")).toBe("knowledge")
})

it("does not fall back for an aborted HTTPS clone", async () => {
  httpsFailure = Object.assign(new Error("cancelled"), { name: "AbortError" })
  await expect(syncKnowledgeRepository(source)).rejects.toBe(httpsFailure)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(1)
  expect(console.log).not.toHaveBeenCalled()
})

it("does not fall back without sshUrl or for a non-HTTPS primary URL", async () => {
  httpsFailure = new Error("https failed")
  await expect(
    syncKnowledgeRepository({ role: "read" as const, idKey: "https-only", url, ref: source.ref })
  ).rejects.toBe(httpsFailure)
  sshFailure = new Error("ssh failed")
  await expect(
    syncKnowledgeRepository({ ...source, role: "read" as const, idKey: "ssh-only", url: sshUrl })
  ).rejects.toBe(sshFailure)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(2)
  expect(console.log).not.toHaveBeenCalled()
})
