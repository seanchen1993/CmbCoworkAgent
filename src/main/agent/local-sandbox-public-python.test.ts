import { expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalSandbox } from "./local-sandbox"

it.each([true, false])(
  "public project execute respects only its bound plugin cache declaration (%s)",
  async (declared) => {
    const plugin = mkdtempSync(join(tmpdir(), "public-execute-plugin-"))
    const workspace = mkdtempSync(join(tmpdir(), "public-execute-workspace-"))
    try {
      const declare = (root: string) => {
        writeFileSync(
          join(root, "devclaw.stage-checks.json"),
          JSON.stringify({ apiVersion: "devclaw.stage-check-adapter/v1", adapter: "autobiz-v1" })
        )
        writeFileSync(
          join(root, "devclaw.project-runtime.json"),
          JSON.stringify({
            apiVersion: "devclaw.project-runtime/v1",
            mode: "legacy",
            stateOwner: "plugin"
          })
        )
      }
      declare(workspace)
      if (declared) declare(plugin)
      writeFileSync(join(plugin, "fixture_module.py"), "VALUE = 42\n")
      const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "" }
      const sandbox = new LocalSandbox({ rootDir: workspace, pluginRoot: plugin, env })
      const result = await sandbox.executeRaw(
        `python -c "import sys; sys.path.insert(0, '${plugin.replaceAll("\\", "/")}'); import fixture_module; print(fixture_module.VALUE)"`,
        "none"
      )
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output.trim()).toBe("42")
      expect(readdirSync(plugin).includes("__pycache__")).toBe(!declared)
      expect(env.PYTHONDONTWRITEBYTECODE).toBe("")
    } finally {
      rmSync(plugin, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }
)
