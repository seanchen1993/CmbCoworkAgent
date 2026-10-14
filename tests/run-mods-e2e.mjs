import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const artifactBase = process.env.CMB_MODS_E2E_ARTIFACTS_BASE
function run(entry, args, extraEnv = {}) {
  return (
    spawnSync(process.execPath, [join(root, entry), ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true
    }).status ?? 1
  )
}
let result = 1
try {
  result = run("scripts/build-windows-background-job-controller.mjs", [])
  if (!result)
    result = run("node_modules/electron-vite/bin/electron-vite.js", ["build"], {
      CMB_MODS_E2E: "1"
    })
  if (!result) {
    const focuses = process.argv.slice(2)
    if (!focuses.length) result = run("node_modules/tsx/dist/cli.mjs", ["tests/mods-e2e.spec.ts"])
    for (const focus of focuses) {
      result = run("node_modules/tsx/dist/cli.mjs", ["tests/mods-e2e.spec.ts"], {
        CMB_MODS_E2E_FOCUS: focus,
        ...(artifactBase ? { CMB_MODS_E2E_ARTIFACTS: join(resolve(artifactBase), focus) } : {})
      })
      if (result) break
    }
  }
} finally {
  // Restore ordinary output so the test-only entry cannot enter a later installer.
  const restored = run("node_modules/electron-vite/bin/electron-vite.js", ["build"], {
    CMB_MODS_E2E: "0"
  })
  if (restored || existsSync(join(root, "out/main/mods-e2e.js"))) result = 1
}
process.exitCode = result
