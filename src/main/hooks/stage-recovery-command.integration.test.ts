import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  prepareStageRecoveryCommand,
  buildStageRecoverySandboxArguments
} from "./stage-recovery-command"
import { startOwnedHookCommand } from "./owned-command"

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
    const owned = startOwnedHookCommand({
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
    const owned = startOwnedHookCommand({
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
