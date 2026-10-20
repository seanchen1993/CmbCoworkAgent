import { afterEach, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import {
  readWindowsProcessIdentities,
  WindowsProcessQueryError
} from "../support/mods-windows-process-observer"

vi.mock("node:child_process", () => ({ execFile: vi.fn() }))
const execute = vi.mocked(execFile)
const identity = { pid: 41, parent: 40, born: "2026-10-20T06:00:00.0000000Z" }
function result(stdout: string, stderr = "", error: unknown = null) {
  execute.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void
    callback(error, stdout, stderr)
    return {} as ReturnType<typeof execFile>
  })
}
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

it("pins native Windows PowerShell modules without mutating the calling environment", async () => {
  vi.stubEnv("PSModulePath", "C:/PowerShell/7/Modules")
  result(JSON.stringify(identity))
  expect(await readWindowsProcessIdentities([41])).toEqual([identity])
  const [shell, args, options] = execute.mock.calls[0] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }
  ]
  expect(shell.replaceAll("\\", "/")).toMatch(
    /System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/
  )
  expect(options.timeout).toBe(30_000)
  expect(options.windowsHide).toBe(true)
  expect(options.env.PSModulePath?.replaceAll("\\", "/")).toMatch(
    /System32\/WindowsPowerShell\/v1\.0\/Modules$/
  )
  expect(process.env.PSModulePath).toBe("C:/PowerShell/7/Modules")
  expect(args.at(-2)).toBe("-EncodedCommand")
  const query = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  expect(query).toContain("$ErrorActionPreference = 'Stop'")
  expect(query).toContain("$ProgressPreference = 'SilentlyContinue'")
  expect(query).toContain("Modules/CimCmdlets/CimCmdlets.psd1")
  expect(query).toContain("-Filter 'ProcessId = 41'")
  expect(query).toContain("$_.CreationDate.ToUniversalTime()")
  expect(query).not.toMatch(/Stop-Process|taskkill/i)
})

it("retains both requested process identities and accepts only successful empty absence", async () => {
  const child = { ...identity, pid: 42, parent: 41 }
  result(JSON.stringify([identity, child]))
  expect(await readWindowsProcessIdentities([41, 42])).toEqual([identity, child])
  result("")
  expect(await readWindowsProcessIdentities([41, 42])).toEqual([])
  result("[]")
  expect(await readWindowsProcessIdentities([41, 42])).toEqual([])
})

it.each([
  { code: 1, signal: null, killed: false },
  { code: null, signal: "SIGTERM", killed: true },
  { code: "ENOENT", signal: null, killed: false }
])("fails closed with structured subprocess diagnostics (%j)", async (failure) => {
  result("partial output", "CIM failure", Object.assign(new Error("failed"), failure))
  const error = await readWindowsProcessIdentities([41]).catch((reason) => reason)
  expect(error).toBeInstanceOf(WindowsProcessQueryError)
  expect(error.diagnostics).toEqual({
    pids: [41],
    timeoutMs: 30_000,
    ...failure,
    stderr: "CIM failure",
    stdout: "partial output"
  })
  expect(error.message).toContain("MODS_WINDOWS_PROCESS_QUERY_FAILED")
})

it("does not mistake a PowerShell error with exit zero for a reaped process", async () => {
  result("", "provider query failed")
  await expect(readWindowsProcessIdentities([41])).rejects.toBeInstanceOf(WindowsProcessQueryError)
})

it("bounds retained subprocess output in failure artifacts", async () => {
  result("o".repeat(9000), "e".repeat(9000), Object.assign(new Error("failed"), { code: 1 }))
  const error = await readWindowsProcessIdentities([41]).catch((reason) => reason)
  expect(error).toBeInstanceOf(WindowsProcessQueryError)
  expect(error.diagnostics.stdout).toHaveLength(4096)
  expect(error.diagnostics.stderr).toHaveLength(4096)
})

it.each([
  "null",
  "{}",
  "broken JSON",
  JSON.stringify({ ...identity, pid: 50 }),
  JSON.stringify([identity, identity]),
  JSON.stringify({ ...identity, born: "invalid" }),
  JSON.stringify({ ...identity, parent: -1 })
])("rejects ambiguous process identity output (%s)", async (raw) => {
  result(raw)
  await expect(readWindowsProcessIdentities([41])).rejects.toThrow(
    "MODS_WINDOWS_PROCESS_QUERY_OUTPUT_INVALID"
  )
})

it.each([[], [0], [-1], [1.5], [41, 41], [0x100000000]].map((pids) => ({ pids })))(
  "rejects unsafe PID selection (%j)",
  async ({ pids }) => {
    await expect(readWindowsProcessIdentities(pids)).rejects.toThrow(
      "MODS_WINDOWS_PROCESS_QUERY_PIDS_INVALID"
    )
    expect(execute).not.toHaveBeenCalled()
  }
)
