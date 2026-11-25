import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { syncKnowledgeRepository, validateKnowledgeRepositorySource } from "./knowledge-repository"

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
let sshConfig = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-fallback-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
  vi.stubEnv("GIT_SSH_COMMAND", undefined)
  vi.stubEnv("GIT_SSH", undefined)
  vi.stubEnv("GIT_SSH_VARIANT", undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  httpsFailure = undefined
  sshFailure = undefined
  httpsProbeFailure = undefined
  sshProbeFailure = undefined
  probeExistingCheckout = false
  sshConfig = ""
  runGit.mockReset()
  runGit.mockImplementation(async (_file, args: string[], options: { cwd: string }) => {
    if (args.includes("--get-regexp")) return { stdout: sshConfig, stderr: "" }
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it("cancels a hanging branch validation after ten seconds without cancelling the next validation", async () => {
  vi.useFakeTimers()
  let firstSignal: AbortSignal | undefined
  runGit.mockImplementationOnce(async (_file, _args, options) => {
    firstSignal = options.signal
    return new Promise((_resolve, reject) => {
      firstSignal!.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      )
    })
  })
  const pending = validateKnowledgeRepositorySource(source)
  const assertion = expect(pending).rejects.toThrow("Git 分支配置检查超时（10 秒）")
  await vi.advanceTimersByTimeAsync(9_999)
  expect(firstSignal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await assertion
  expect(firstSignal?.aborted).toBe(true)

  await expect(validateKnowledgeRepositorySource(source)).resolves.toMatchObject(source)
  expect(runGit.mock.calls[1][2].signal.aborted).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it("clones via SSH without trying HTTPS when SSH succeeds", async () => {
  const result = await syncKnowledgeRepository(source)
  const clones = runGit.mock.calls.filter((call) => call[1].includes("clone"))
  expect(clones).toHaveLength(1)
  expect(clones[0][1]).toContain(sshUrl)
  expect(clones[0][2].timeout).toBe(120_000)
  expect(result.commit).toBe(commit)
  expect(console.log).not.toHaveBeenCalled()
})

it.each(["connection failed", "timed out"])("falls back to HTTPS after SSH %s", async (reason) => {
  const previous = await syncKnowledgeRepository({
    role: "read" as const,
    idKey: source.idKey,
    url,
    ref: source.ref
  })
  runGit.mockClear()
  sshFailure = new Error(reason)
  const result = await syncKnowledgeRepository(source)
  const clones = runGit.mock.calls.filter((call) => call[1].includes("clone"))
  expect(clones).toHaveLength(2)
  expect(clones[0][1]).toContain(sshUrl)
  expect(clones[0][2].timeout).toBe(120_000)
  expect(clones[1][1]).toContain(url)
  expect(clones[1][1]).toContain(source.ref)
  expect(clones[1][2].timeout).toBe(20_000)
  expect(result.path).toBe(previous.path)
  expect(await readFile(join(result.path, "AGENTS.md"), "utf8")).toBe("knowledge")
  expect(console.log).toHaveBeenCalledWith(
    "[knowledge_manage] SSH 克隆失败或超时，回退使用 HTTPS 重试",
    { ref: source.ref }
  )
  expect(await readdir(join(root, "knowledge"))).toHaveLength(1)
})

it("preserves the checkout and reports the HTTPS failure first when both clones fail", async () => {
  const previous = await syncKnowledgeRepository(source)
  httpsFailure = new Error("https failed")
  sshFailure = new Error("ssh failed")
  await expect(syncKnowledgeRepository(source)).rejects.toMatchObject({
    errors: [httpsFailure, sshFailure]
  })
  expect(await readFile(join(previous.path, "AGENTS.md"), "utf8")).toBe("knowledge")
  expect(await readdir(join(root, "knowledge"))).toHaveLength(1)
})

it("falls back to HTTPS when an SSH remote check fails", async () => {
  const previous = await syncKnowledgeRepository(source)
  probeExistingCheckout = true
  sshProbeFailure = new Error("remote check timed out")
  runGit.mockClear()
  const result = await syncKnowledgeRepository(source)
  const probes = runGit.mock.calls.filter((call) => call[1].includes("ls-remote"))
  expect(probes).toHaveLength(2)
  expect(probes[0][1]).toContain(sshUrl)
  expect(probes[0][2].timeout).toBe(120_000)
  expect(probes[1][1]).toContain(url)
  expect(probes[1][2].timeout).toBe(20_000)
  expect(result.path).toBe(previous.path)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(0)
  expect(console.log).toHaveBeenCalledWith(
    "[knowledge_manage] SSH 远端检查失败或超时，回退使用 HTTPS 重试",
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
  sshProbeFailure = cancelled
  runGit.mockClear()
  await expect(syncKnowledgeRepository(source)).rejects.toBe(cancelled)
  expect(runGit.mock.calls.filter((call) => call[1].includes("ls-remote"))).toHaveLength(1)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(0)
  expect(await readFile(join(previous.path, "AGENTS.md"), "utf8")).toBe("knowledge")
})

it("does not fall back for an aborted SSH clone", async () => {
  sshFailure = Object.assign(new Error("cancelled"), { name: "AbortError" })
  await expect(syncKnowledgeRepository(source)).rejects.toBe(sshFailure)
  expect(runGit.mock.calls.filter((call) => call[1].includes("clone"))).toHaveLength(1)
  expect(console.log).not.toHaveBeenCalled()
})

it("uses only the configured remote when the SSH address is missing or identical", async () => {
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

it("queries an existing checkout over SSH without prompting or trying HTTPS on success", async () => {
  vi.stubEnv("GCM_INTERACTIVE", "always")
  vi.stubEnv("GIT_ASKPASS", "custom-askpass")
  vi.stubEnv("SSH_ASKPASS", "custom-ssh-askpass")
  await syncKnowledgeRepository(source)
  probeExistingCheckout = true
  runGit.mockClear()

  await expect(syncKnowledgeRepository(source)).resolves.toMatchObject({ updated: false })
  const probes = runGit.mock.calls.filter((call) => call[1].includes("ls-remote"))
  expect(probes).toHaveLength(1)
  expect(probes[0][1]).toContain(sshUrl)
  expect(probes[0][1]).toContain("core.askPass=")
  expect(probes[0][2].env).toMatchObject({
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never"
  })
})

it("adds the batch option while retaining a configured SSH command", async () => {
  sshConfig = 'core.sshcommand\n"/path with spaces/plink.exe" -i custom-key\0ssh.variant\nplink\0'
  await syncKnowledgeRepository(source)
  const clone = runGit.mock.calls.find((call) => call[1].includes("clone"))
  expect(clone?.[2].env.GIT_SSH_COMMAND).toBe('"/path with spaces/plink.exe" -batch -i custom-key')
})

it("respects an explicitly selected SSH command and its configured key", async () => {
  sshConfig = "core.sshcommand\nssh -i old-key\0"
  vi.stubEnv("GIT_SSH_COMMAND", "ssh -i custom-key")

  await syncKnowledgeRepository(source)
  const clone = runGit.mock.calls.find((call) => call[1].includes("clone"))
  expect(clone?.[2].env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -i custom-key")
})

it("keeps the arguments of a Git simple SSH wrapper while suppressing AskPass", async () => {
  vi.stubEnv("GIT_SSH", "custom-ssh-wrapper")
  vi.stubEnv("GIT_SSH_VARIANT", "simple")

  await syncKnowledgeRepository(source)
  const clone = runGit.mock.calls.find((call) => call[1].includes("clone"))
  expect(clone?.[2].env).toMatchObject({
    GIT_SSH: "custom-ssh-wrapper",
    GIT_SSH_VARIANT: "simple",
    SSH_ASKPASS_REQUIRE: "never"
  })
  expect(clone?.[2].env.GIT_SSH_COMMAND).toBeUndefined()
})
