import assert from "node:assert/strict"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"

/** A build prepared by the runner, never the user's running preview or profile. */
export function botTestAppOutput(): string {
  const out = process.env.BOT_TEST_APP_OUT
  assert.ok(
    out && isAbsolute(out),
    "Run npm run test:bot-integration:e2e to prepare an isolated build"
  )
  const manifest = JSON.parse(readFileSync(join(out, "bot-test-build.json"), "utf8"))
  assert.equal(manifest.repository, realpathSync("."))
  for (const file of ["main/index.js", "preload/index.js", "renderer/index.html"])
    assert.ok(existsSync(join(out, file)), `Missing test build: ${file}`)
  return out
}
