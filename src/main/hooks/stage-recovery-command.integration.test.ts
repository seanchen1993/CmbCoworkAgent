import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  prepareStageRecoveryCommand,
  buildStageRecoverySandboxArguments
} from "./stage-recovery-command"
import * as ownedCommands from "./owned-command"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir())) throw Error("UNSAFE_FIXTURE_CLEANUP")
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-recovery-command-"))
  roots.push(root)
  const workspace = join(root, "branch"),
    source = join(root, "package"),
    original = join(root, "original")
  await Promise.all([mkdir(workspace), mkdir(source), mkdir(original)])
  const shell = join(
    process.env.SystemRoot ?? "C:/Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe"
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string"
    )
  )
  return { root, workspace, source, original, shell, env }
}

it("builds only the explicit workspace profile, with no normal-shell or network-enabled fallback", async () => {
  const f = await fixture()
  const args = buildStageRecoverySandboxArguments({
    workspace: f.workspace,
    shell: f.shell,
    args: ["-NoProfile"]
  })
  expect(args).toContain('sandbox_mode="workspace-write"')
  expect(args).toContain("sandbox_workspace_write.network_access=false")
  expect(args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true")
  expect(args).not.toContain("--full-auto")
  expect(args.join(" ")).not.toContain("network_access=true")
  expect(args.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(f.workspace)}]`
  )
})

it.runIf(process.platform === "win32")(
  "runs a real approved command through Codex and the owned Job, preserving read-only upstream and stdin",
  async () => {
    const f = await fixture()
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
    const script =
      `$ErrorActionPreference='Stop';$raw=[Console]::In.ReadToEnd();` +
      `[IO.File]::WriteAllText('result.txt',$raw);` +
      `try{[IO.File]::WriteAllText(${quote(join(f.original, "escape.txt"))},'unsafe');exit 19}catch{};` +
      `try{[IO.File]::WriteAllText(${quote(join(f.source, "escape.txt"))},'unsafe');exit 20}catch{};` +
      `'RECOVERY_COMMAND_PASSED'`
    await writeFile(join(f.source, "check.ps1"), script)
    const plan = await prepareStageRecoveryCommand({
      workspace: f.workspace,
      snapshotRoot: f.source,
      policy: { readOnlyRoots: [f.source, f.original], networkAccess: "explicitly-approved" },
      env: f.env,
      shell: f.shell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(f.source, "check.ps1")],
      stdin: '{"stage":"review","artifact":"actual"}',
      guard: () => {}
    })
    expect(plan.env.TEMP).toBe(join(f.workspace, ".dcr"))
    const chunks: Buffer[] = [],
      errors: Buffer[] = []
    const controller = new AbortController()
    const owned = ownedCommands.startOwnedHookCommand({
      ...plan,
      stdin: '{"stage":"review","artifact":"actual"}',
      signal: controller.signal,
      stdout: (chunk) => chunks.push(chunk),
      stderr: (chunk) => errors.push(chunk)
    })
    const timer = setTimeout(() => controller.abort(), 10000)
    let result: Awaited<typeof owned.completion>
    try {
      result = await owned.completion
    } finally {
      clearTimeout(timer)
      await plan.cleanup()
    }
    expect(result!.code, Buffer.concat(errors).toString()).toBe(0)
    expect(Buffer.concat(chunks).toString()).toContain("RECOVERY_COMMAND_PASSED")
    expect(await readFile(join(f.workspace, "result.txt"), "utf8")).toBe(
      '{"stage":"review","artifact":"actual"}'
    )
    expect(existsSync(join(f.original, "escape.txt"))).toBe(false)
    expect(existsSync(join(f.source, "escape.txt"))).toBe(false)
  },
  20000
)

it.runIf(process.platform === "win32")(
  "cancels the real sandbox process tree and never reports an interrupted validator as passed",
  async () => {
    const f = await fixture()
    const plan = await prepareStageRecoveryCommand({
      workspace: f.workspace,
      snapshotRoot: f.source,
      policy: { readOnlyRoots: [f.source, f.original], networkAccess: "explicitly-approved" },
      env: f.env,
      shell: f.shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[IO.File]::WriteAllText('started.txt','actual child');Start-Sleep -Seconds 30;[IO.File]::WriteAllText('late.txt','unsafe')"
      ],
      stdin: "{}",
      guard: () => {}
    })
    const controller = new AbortController()
    const owned = ownedCommands.startOwnedHookCommand({
      ...plan,
      stdin: "{}",
      signal: controller.signal,
      stdout: () => {},
      stderr: () => {}
    })
    const timer = setTimeout(() => controller.abort(), 10000)
    let result: Awaited<typeof owned.completion>
    try {
      const deadline = Date.now() + 9000
      while (!existsSync(join(f.workspace, "started.txt")) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25))
      expect(existsSync(join(f.workspace, "started.txt"))).toBe(true)
      controller.abort()
      result = await owned.completion
    } finally {
      clearTimeout(timer)
      await plan.cleanup()
    }
    expect(result!.code).not.toBe(0)
    expect(existsSync(join(f.workspace, "late.txt"))).toBe(false)
  },
  20000
)

it("rejects an overlapping upstream root before modifying ACLs or spawning a validator", async () => {
  const f = await fixture()
  const inputs = {
    workspace: f.workspace,
    snapshotRoot: f.source,
    policy: { readOnlyRoots: [f.workspace], networkAccess: "explicitly-approved" as const },
    env: f.env,
    shell: f.shell,
    args: [],
    stdin: "{}",
    guard: () => {}
  }
  await expect(prepareStageRecoveryCommand(inputs)).rejects.toThrow(
    process.platform === "win32" ? "COMMAND_SCOPE_INVALID" : "COMMAND_SANDBOX_UNAVAILABLE"
  )
})

const replacementMarker = "Keep this replacement and outside file"
const commandPayload = '{"stage":"private-home-identity"}'
type HomeReplacement = "junction" | "file" | "directory"

function replaceSandboxHome(
  f: Awaited<ReturnType<typeof fixture>>,
  home: string,
  kind: HomeReplacement
) {
  const temporary = join(f.workspace, ".dcr")
  if (dirname(home) !== temporary || !basename(home).startsWith("h-"))
    throw Error("UNSAFE_FIXTURE_HOME")
  const original = lstatSync(home, { bigint: true })
  if (!original.isDirectory() || original.isSymbolicLink() || realpathSync(home) !== home)
    throw Error("UNSAFE_FIXTURE_HOME")
  const entries = readdirSync(home).sort()
  const retained = join(temporary, `retained-${basename(home)}`)
  if (existsSync(retained)) throw Error("FIXTURE_HOME_ALREADY_RETAINED")
  const outside = join(f.root, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "i"), replacementMarker)
  renameSync(home, retained)
  if (kind === "junction") symlinkSync(outside, home, "junction")
  else if (kind === "file") writeFileSync(home, replacementMarker)
  else {
    mkdirSync(home)
    writeFileSync(join(home, "i"), replacementMarker)
  }
  return { home, retained, outside, original, entries }
}

async function assertHomeReplacementUnchanged(
  replacement: ReturnType<typeof replaceSandboxHome>,
  kind: HomeReplacement
) {
  const current = lstatSync(replacement.retained, { bigint: true })
  expect([current.dev, current.ino]).toEqual([
    replacement.original.dev, replacement.original.ino
  ])
  expect(readdirSync(replacement.retained).sort()).toEqual(replacement.entries)
  expect(await readFile(join(replacement.outside, "i"), "utf8")).toBe(replacementMarker)
  if (kind === "file")
    expect(await readFile(replacement.home, "utf8")).toBe(replacementMarker)
  else expect(await readFile(join(replacement.home, "i"), "utf8")).toBe(replacementMarker)
}

function prepareFixtureCommand(f: Awaited<ReturnType<typeof fixture>>, guard: () => void) {
  return prepareStageRecoveryCommand({
    workspace: f.workspace,
    snapshotRoot: f.source,
    policy: { readOnlyRoots: [f.source, f.original], networkAccess: "explicitly-approved" },
    env: f.env,
    shell: f.shell,
    args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::In.ReadToEnd()"],
    stdin: commandPayload,
    guard
  })
}

it.runIf(process.platform === "win32").each(["junction", "file", "directory"] as const)(
  "rejects a private Home replaced with a %s before payload creation or provider start",
  async (kind) => {
    const f = await fixture()
    let replacement: ReturnType<typeof replaceSandboxHome> | undefined
    const starts = vi.spyOn(ownedCommands, "startOwnedHookCommand")
    try {
      await expect(prepareFixtureCommand(f, () => {
        const temporary = join(f.workspace, ".dcr")
        if (replacement || !existsSync(temporary)) return
        const name = readdirSync(temporary).find((entry) => entry.startsWith("h-"))
        if (name) replacement = replaceSandboxHome(f, join(temporary, name), kind)
      })).rejects.toThrow(kind === "directory"
        ? "PROJECT_STAGE_DEBUG_COMMAND_SCOPE_CHANGED" : "PROJECT_HOST_DIRECTORY_INVALID")
      expect(starts).not.toHaveBeenCalled()
      expect(replacement).toBeDefined()
      if (!replacement) throw Error("PRIVATE_HOME_REPLACEMENT_NOT_REACHED")
      await assertHomeReplacementUnchanged(replacement, kind)
    } finally {
      starts.mockRestore()
    }
  }
)

it.runIf(process.platform === "win32").each(["junction", "file", "directory"] as const)(
  "retains a private Home %s replacement and its payload during cleanup",
  async (kind) => {
    const f = await fixture()
    const starts = vi.spyOn(ownedCommands, "startOwnedHookCommand")
    try {
      const plan = await prepareFixtureCommand(f, () => {})
      const payloadIndex = plan.args.indexOf("recovery-argv-file")
      expect(payloadIndex).toBeGreaterThanOrEqual(0)
      expect(plan.args[payloadIndex + 1]).toBe(join(plan.env.CODEX_HOME, "i"))
      const replacement = replaceSandboxHome(f, plan.env.CODEX_HOME, kind)
      await plan.cleanup()
      expect(starts).not.toHaveBeenCalled()
      await assertHomeReplacementUnchanged(replacement, kind)
      expect(await readFile(join(replacement.retained, "i"), "utf8")).toBe(commandPayload)
    } finally {
      starts.mockRestore()
    }
  }
)
