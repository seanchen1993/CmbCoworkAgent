import fs from "node:fs/promises"
import { afterEach, expect, it, vi } from "vitest"
import {
  fallbackCommandShell,
  resolveCommandShell,
  resolveCommandShellContext,
  resolveWindowsCommandShell
} from "./command-shell-resolution"

afterEach(() => vi.restoreAllMocks())

const windows = {
  platform: "win32" as const,
  env: {
    Path: "D:\\Git\\cmd;C:\\Windows\\System32",
    PATHEXT: ".EXE",
    ComSpec: "C:\\Windows\\System32\\cmd.exe"
  }
}
function files(values: string[]) {
  const found = new Set(values.map((value) => value.toLowerCase()))
  return vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if (!found.has(String(file).toLowerCase())) throw new Error("ENOENT")
  })
}

it.each([
  { platform: "darwin" as const, shell: undefined, expected: "/bin/zsh" },
  { platform: "linux" as const, shell: undefined, expected: "/bin/sh" },
  { platform: "linux" as const, shell: "/usr/bin/fish", expected: "/bin/sh" },
  { platform: "darwin" as const, shell: "/bin/bash", expected: "/bin/bash" }
])("keeps $platform shell selection ($shell)", async ({ platform, shell, expected }) => {
  const access = files([])
  const context = { platform, env: shell ? { SHELL: shell } : {} }
  expect(await resolveCommandShell(context)).toBe(expected)
  expect(fallbackCommandShell(context)).toBe(expected)
  expect(access).not.toHaveBeenCalled()
})

it.each(["SHELL", "GIT_BASH_PATH"])("preserves explicit %s before probing", async (key) => {
  const access = files([])
  expect(
    await resolveCommandShell({
      ...windows,
      env: { ...windows.env, [key]: "D:\\Portable\\bash.exe" }
    })
  ).toBe("D:\\Portable\\bash.exe")
  expect(access).not.toHaveBeenCalled()
})

it("finds Git Bash using a Windows PATH supplied as a plain sanitized object", async () => {
  files(["D:\\Git\\cmd\\git.EXE", "D:\\Git\\bin\\bash.exe"])
  expect(await resolveCommandShell(windows)).toBe("D:\\Git\\bin\\bash.exe")
  expect(await resolveCommandShellContext("none", windows)).toMatchObject({
    name: "bash",
    guidance: expect.stringContaining("Unix shell syntax")
  })
})

it.each(["pwsh", "powershell", "cmd"])(
  "describes the actual restricted %s shell",
  async (shell) => {
    files(shell === "cmd" ? [] : [`C:\\Windows\\System32\\${shell}.EXE`])
    const context = { ...windows, env: { ...windows.env, GIT_BASH_PATH: "D:\\Portable\\bash.exe" } }
    const resolved = await resolveWindowsCommandShell(context)
    expect(resolved.shell.toLowerCase()).toContain(`${shell}.exe`)
    const prompt = await resolveCommandShellContext("unelevated", context)
    expect(prompt.name).toBe(shell)
    expect(prompt.guidance).toContain(shell === "cmd" ? "%VAR%" : "$env:VAR")
    expect(prompt.guidance).not.toContain("Unix shell syntax")
    expect(resolved.flags).toEqual(
      shell === "cmd" ? ["/c"] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]
    )
  }
)

it("uses configured program-files discovery without assuming the default system drive", async () => {
  files(["E:\\Apps\\Git\\bin\\bash.exe"])
  expect(
    await resolveCommandShell({ ...windows, env: { ...windows.env, ProgramFiles: "E:\\Apps" } })
  ).toBe("E:\\Apps\\Git\\bin\\bash.exe")
})

it("keeps inaccessible discoveries as cmd fallback, not a promise of bash support", async () => {
  files([])
  expect(await resolveCommandShell(windows)).toBe(windows.env.ComSpec)
  expect(await resolveCommandShellContext("none", windows)).toMatchObject({
    name: "cmd",
    guidance: expect.stringContaining("cmd.exe syntax")
  })
})
