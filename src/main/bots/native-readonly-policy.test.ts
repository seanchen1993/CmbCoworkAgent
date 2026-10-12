import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createWindowsBotHostShellFactory } from "./windows-host-shell-factory"
import { createLinuxBotHostShellFactory } from "./linux-host-shell-factory"
import type { VerifiedNativeShellPackage } from "./native-shell-package"
import type { BotShellRequest } from "./shell-contract"

const native = vi.hoisted(() => ({ pkg: undefined as VerifiedNativeShellPackage | undefined }))
vi.mock("./native-shell-package", () => ({ verifyNativeShellPackage: async () => native.pkg }))
vi.mock("./windows-native-resource", () => ({
  probeWindowsBotNativeOwner: async () => ({
    protocol: "cmb-atomic-windows-job-v2",
    type: "capabilities",
    nonce: "9e6d13d0-0b7b-4cf3-bc3e-adfd8bbf6a51",
    bootId: "9e6d13d0-0b7b-4cf3-bc3e-adfd8bbf6a51",
    sessionId: 1,
    pointerSize: 8,
    startupBytes: 104,
    processInformationBytes: 24,
    extendedLimitBytes: 144,
    accountingBytes: 48,
    limitsVerified: true,
    noBreakaway: true,
    killOnClose: true
  })
}))
vi.mock("./linux-bot-cgroup", async (original) => ({
  ...(await original<typeof import("./linux-bot-cgroup")>()),
  assertLinuxBotDelegation: async () => {}
}))
const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(platform: "win32" | "linux") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-readonly-policy-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const folder of [
    "host",
    "project",
    "shared-git",
    "runtime",
    "package",
    "tools",
    "delegated"
  ])
    await mkdir(join(root, folder), { mode: 0o700 })
  // Module discovery uses the helper's physical installation ancestry. Supply
  // the real locked package marker in that layout rather than mocking discovery.
  // This policy-only fixture does not execute a worker or claim package integrity.
  const moduleRoot = join(root, "runtime", "node_modules")
  if (platform === "win32") {
    const marker = await readFile(createRequire(import.meta.url).resolve("zod/package.json"))
    const directory = join(moduleRoot, "zod")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, "package.json"), marker, { flag: "wx", mode: 0o600 })
    expect(await readFile(join(directory, "package.json"))).toEqual(marker)
  }
  const artifact = (name: string) => ({
    entry: join(root, "package", name),
    sha256: "a".repeat(64)
  })
  const arch = process.arch
  if (arch !== "x64" && arch !== "arm64") throw new Error("Unsupported native test architecture")
  const pkg: VerifiedNativeShellPackage = {
    directory: join(root, "package"),
    manifestSha256: "a".repeat(64),
    manifest: {
      format: 1,
      platform,
      arch,
      revision: "954fa9057bf3a4521ea34dbd010ff291d5b39763",
      protocol: "codex-cmb-owned-sandbox-v1",
      patchSha256: "a".repeat(64),
      cli: { name: platform === "win32" ? "codex.exe" : "codex", sha256: "a".repeat(64) },
      helper: {
        name: platform === "win32" ? "codex-command-runner.exe" : "codex-linux-sandbox",
        sha256: "a".repeat(64)
      },
      sourceArchive: { name: "native-sources.tgz", sha256: "a".repeat(64) },
      licenses: [
        { name: "CODEX-LICENSE", sha256: "a".repeat(64) },
        { name: "CODEX-NOTICE", sha256: "a".repeat(64) },
        { name: platform === "win32" ? "CMB-LICENSE" : "BWRAP-LICENSE", sha256: "a".repeat(64) }
      ],
      ...(platform === "win32"
        ? {
            setup: { name: "codex-windows-sandbox-setup.exe", sha256: "a".repeat(64) },
            jobOwner: { name: "bot-resource-owner.exe", sha256: "a".repeat(64) },
            ownerProtocol: "cmb-atomic-windows-job-v2"
          }
        : { bwrap: { name: "bwrap", sha256: "a".repeat(64) } })
    },
    cli: artifact(platform === "win32" ? "codex.exe" : "codex"),
    nativeHelper: artifact(
      platform === "win32" ? "codex-command-runner.exe" : "codex-linux-sandbox"
    ),
    ...(platform === "win32"
      ? { setup: artifact("setup.exe"), jobOwner: artifact("owner.exe") }
      : { bwrap: artifact("bwrap") }),
    artifactPins: ["cli", "helper", "manifest"].map((name) => ({
      entry: join(root, "package", name),
      dev: "1",
      ino: "2",
      size: "3",
      mtimeNs: "4",
      ctimeNs: "5"
    })),
    assertCurrent: async () => {}
  }
  native.pkg = pkg
  vi.stubEnv("PATH", join(root, "tools"))
  const old = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...old, value: platform })
  cleanup.push(() => {
    Object.defineProperty(process, "platform", old)
  })
  const binding = {
    directory: join(root, "host"),
    helperEntry: join(root, "runtime", "helper.js"),
    workerEntry: join(root, "runtime", "worker.js"),
    hostId: () => "host",
    dataEpoch: () => "epoch",
    assertOwnership: async () => {}
  }
  const config = {
    packageDirectory: pkg.directory,
    manifestSha256: pkg.manifestSha256
  }
  const artifacts = {
    helper: { entry: binding.helperEntry, sha256: "a".repeat(64) },
    worker: { entry: binding.workerEntry, sha256: "b".repeat(64) }
  }
  const factory =
    platform === "win32"
      ? await createWindowsBotHostShellFactory(binding, config, artifacts)
      : await createLinuxBotHostShellFactory(
          binding,
          { ...config, delegatedCgroupDirectory: join(root, "delegated") },
          artifacts
        )
  const base: BotShellRequest = {
    command: "inspect",
    cwd: join(root, "project"),
    runId: "run",
    timeoutMs: 1000,
    execution: { windowsSandbox: "readonly", resourceDirectory: root }
  }
  return { root, factory, base, moduleRoot }
}

it.each([undefined, false])(
  "the real Windows native factory never grants project writes when configured readonly even if readOnly=%s",
  async (readOnly) => {
    const f = await fixture("win32")
    const value = await f.factory(
      { ...f.base, ...(readOnly === undefined ? {} : { readOnly }) },
      new AbortController().signal
    )
    try {
      const policy = JSON.parse(value.launch.nativePlan!.policy)
      const granted = policy.permissionProfile.file_system.entries
        .filter(
          (entry: { path: { type: string; path?: string }; access: string }) =>
            entry.path.type === "path" && entry.path.path === f.base.cwd
        )
        .map((entry: { access: string }) => entry.access)
      expect(granted).toEqual(["read"])
      expect(
        policy.permissionProfile.file_system.entries
          .filter(
            (entry: { path: { type: string; path?: string }; access: string }) =>
              entry.path.type === "path" && entry.path.path === f.moduleRoot
          )
          .map((entry: { access: string }) => entry.access)
      ).toEqual(["read"])
    } finally {
      await value.releasePrepared?.(true)
    }
  }
)

it.each(["win32", "linux"] as const)(
  "the real %s factory preserves explicit workflow read-only over project and shared git roots",
  async (platform) => {
    const f = await fixture(platform)
    const value = await f.factory(
      {
        ...f.base,
        execution: { ...f.base.execution, windowsSandbox: "elevated" },
        readOnly: true,
        worktree: {
          workspaceRoot: f.base.cwd,
          worktreeRoot: f.base.cwd,
          commonDir: join(f.root, "shared-git"),
          branch: "read-branch"
        }
      },
      new AbortController().signal
    )
    try {
      const policy = JSON.parse(value.launch.nativePlan!.policy)
      const writes = policy.permissionProfile.file_system.entries
        .filter((entry: { access: string }) => entry.access === "write")
        .map((entry: { path: { path: string } }) => entry.path.path)
      expect(writes).not.toContain(f.base.cwd)
      expect(writes).not.toContain(join(f.root, "shared-git"))
      expect(writes).toHaveLength(1)
      expect(writes[0]).toContain("cmb-bot-command-")
    } finally {
      await value.releasePrepared?.(true)
    }
  }
)

it.each(["win32", "linux"] as const)(
  "the real %s factory retains normal approved workspace write grants",
  async (platform) => {
    const f = await fixture(platform)
    const value = await f.factory(
      {
        ...f.base,
        execution: { ...f.base.execution, windowsSandbox: "elevated" },
        readOnly: false
      },
      new AbortController().signal
    )
    try {
      const policy = JSON.parse(value.launch.nativePlan!.policy)
      expect(policy.permissionProfile.file_system.entries).toContainEqual({
        path: { type: "path", path: f.base.cwd },
        access: "write"
      })
    } finally {
      await value.releasePrepared?.(true)
    }
  }
)

it("the real Linux factory does not treat a Windows-only readonly preference as Linux authority", async () => {
  const f = await fixture("linux")
  const value = await f.factory(f.base, new AbortController().signal)
  try {
    const policy = JSON.parse(value.launch.nativePlan!.policy)
    expect(policy.permissionProfile.file_system.entries).toContainEqual({
      path: { type: "path", path: f.base.cwd },
      access: "write"
    })
  } finally {
    await value.releasePrepared?.(true)
  }
})
