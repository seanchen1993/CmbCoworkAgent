import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { LocalSandbox } from "./local-sandbox"

interface MutableShellResolutionState {
  _cachedResolvedShell: string | null
  _resolvedShellPromise: Promise<string> | null
}

const locale = Intl.DateTimeFormat().resolvedOptions().locale
const runsRealChineseCmd = process.platform === "win32" && /^zh(?:-|$)/i.test(locale)
const describeRealChineseCmd = runsRealChineseCmd ? describe : describe.skip

describeRealChineseCmd("LocalSandbox Windows cmd background output", () => {
  it("decodes short Chinese text in both final output and live onData", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmb-local-sandbox-cmd-output-"))
    const shellState = LocalSandbox as unknown as MutableShellResolutionState
    const previousShell = shellState._cachedResolvedShell
    const previousPromise = shellState._resolvedShellPromise
    const cmd = process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe"
    shellState._cachedResolvedShell = cmd
    shellState._resolvedShellPromise = null

    try {
      const liveOutput: string[] = []
      const sandbox = new LocalSandbox({
        rootDir,
        runId: `cmd-output-${Date.now()}`,
        windowsSandbox: "none"
      })
      const result = await sandbox.executeRaw("echo 中", "none", 30_000, undefined, {
        background: true,
        onData: (text) => liveOutput.push(text)
      })

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain("中")
      expect(liveOutput.join("")).toContain("中")
      expect(result.output).not.toContain("�")
      expect(liveOutput.join("")).not.toContain("�")

      const utf8Script = path.join(rootDir, "split-utf8-output.js")
      await fs.writeFile(
        utf8Script,
        "process.stdout.write(Buffer.from([0x55,0x54,0x46,0x38,0xe4]));" +
          "setTimeout(() => process.stdout.write(Buffer.from([0xb8,0xad])), 50)\n",
        "utf8"
      )
      const utf8LiveOutput: string[] = []
      const utf8Result = await sandbox.executeRaw(
        `"${process.execPath}" "${utf8Script}"`,
        "none",
        30_000,
        undefined,
        {
          background: true,
          onData: (text) => utf8LiveOutput.push(text)
        }
      )

      expect(utf8Result.exitCode).toBe(0)
      expect(utf8Result.output).toBe("UTF8中")
      expect(utf8LiveOutput.join("")).toBe("UTF8中")
    } finally {
      shellState._cachedResolvedShell = previousShell
      shellState._resolvedShellPromise = previousPromise
      await fs.rm(rootDir, { recursive: true, force: true })
    }
  }, 45_000)
})
