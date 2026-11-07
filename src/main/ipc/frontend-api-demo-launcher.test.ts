import { spawn } from "node:child_process"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"

const source = resolve("examples/frontend-api-workbench/demo/start-demo.cmd")

it("ships an ASCII CRLF Windows launcher without a code-page dependency", async () => {
  const bytes = await readFile(source)
  expect([...bytes].every((byte) => byte < 128)).toBe(true)
  const text = bytes.toString("ascii")
  expect(text).not.toMatch(/(?<!\r)\n/)
  expect(text).not.toContain("chcp")
  expect(text).toContain('node "%~dp0server.cjs"')
})

it.skipIf(process.platform !== "win32")(
  "runs under cmd from a Chinese path with spaces and reports a missing node clearly",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "frontend-demo-launcher-"))
    const launch = join(root, "联调 演示.cmd")
    const systemDirectory = join(process.env.SystemRoot ?? "C:/Windows", "System32")
    const run = (env: NodeJS.ProcessEnv) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
        // This fixture's node.cmd only prints its argument; it never starts a server.
        const child = spawn(join(systemDirectory, "cmd.exe"), ["/d", "/c", "call", launch], {
          cwd: root,
          env,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        })
        let stdout = "",
          stderr = ""
        child.stdout.on("data", (data) => {
          stdout += data.toString()
        })
        child.stderr.on("data", (data) => {
          stderr += data.toString()
        })
        child.once("error", no)
        child.once("close", (code) => yes({ code, stdout, stderr }))
        child.stdin.end("\r\n")
      })
    try {
      await copyFile(source, launch)
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key]
      env.Path = systemDirectory
      const missing = await run(env)
      expect(missing.code).toBe(1)
      expect(missing.stdout).toContain("Node.js was not found in PATH.")
      expect(missing.stderr).toBe("")
      await writeFile(
        join(root, "node.cmd"),
        '@echo off\r\necho NODE_STUB_OK\r\nif not "%~1"=="%~dp0server.cjs" exit /b 2\r\nexit /b 0\r\n',
        "ascii"
      )
      env.Path = root + ";" + systemDirectory
      const available = await run(env)
      expect(available.code).toBe(0)
      expect(available.stdout).toContain("NODE_STUB_OK")
      expect(available.stderr).toBe("")
    } finally {
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
      expect(basename(root).startsWith("frontend-demo-launcher-")).toBe(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  10000
)
