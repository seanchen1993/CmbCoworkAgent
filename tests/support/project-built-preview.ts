import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication } from "playwright"

/** Explicit test-only alternative. A selected package can never silently fall back to a build. */
export function projectBuiltPreview(
  root: string,
  packagedDirectory: string | undefined,
  environment: NodeJS.ProcessEnv = process.env
) {
  const preview = environment.CMB_PROJECT_BUILT_PREVIEW === "1"
  assert(!(preview && packagedDirectory !== undefined), "PROJECT_LAUNCH_MODES_CONFLICT")
  assert(preview || packagedDirectory?.trim(), "PROJECT_REVIEWED_PACKAGE_OR_PREVIEW_REQUIRED")
  const entry = join(root, "out/main/index.js")
  const expected = environment.CMB_PROJECT_EXPECTED_MAIN_SHA256
  const assertCurrent = () => {
    if (!preview) return
    assert.match(expected ?? "", /^[a-f0-9]{64}$/, "PROJECT_PREVIEW_MAIN_SHA_REQUIRED")
    assert.equal(createHash("sha256").update(readFileSync(entry)).digest("hex"), expected,
      "PROJECT_PREVIEW_MAIN_CHANGED")
  }
  assertCurrent()
  return {
    preview,
    execution: preview ? "normal-built-Electron" : "packaged-asar",
    assertCurrent,
    async verify(app: ElectronApplication, expectedAppPath: string) {
      if (!preview) return undefined // Original packaged launchers own their unchanged ASAR checks.
      assertCurrent()
      const actual = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged, path: app.getAppPath(), executable: process.execPath
      }))
      assert.equal(actual.packaged, false)
      assert.equal(realpathSync(actual.path), realpathSync(expectedAppPath))
      assertCurrent()
      return { ...actual, entry, sha256: expected, execution: "normal-built-Electron" }
    }
  }
}
