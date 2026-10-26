import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."))
const out = await mkdtemp(join(tmpdir(), "bot-integration-build-"))
const configPath = join(root, `.bot-test-${randomUUID()}.config.mts`)
const envDir = join(out, "empty-env")
await mkdir(envDir)
await mkdir(join(out, "artifacts"))
// Avoid build-time injection of local credentials. Runtime fixtures set their own
// isolated profile, block external network and use only a localhost fake model.
const env = Object.fromEntries(
  ["PATH", "Path", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR"]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]])
)
async function run(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
    windowsHide: true
  })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
  if (code) throw new Error(`Bot integration check failed (exit ${code}): ${args.at(-1)}`)
}
try {
  await writeFile(
    configPath,
    `
import config from "./electron.vite.config"
const out = ${JSON.stringify(out)}
export default Object.fromEntries(["main","preload","renderer"].map((name) => [
  name, {
    ...config[name],
    envDir: ${JSON.stringify(envDir)},
    envPrefix: "BOT_TEST_BUILD_UNUSED_",
    cacheDir: out + "/cache/" + name,
    build: { ...config[name]?.build, outDir: out + "/" + name, emptyOutDir: true }
  }
]))
`
  )
  await run(
    ["node_modules/electron-vite/bin/electron-vite.js", "build", "--config", configPath],
    process.argv.includes("--browser") ? { CMB_BOTS_E2E: "1" } : {}
  )
  for (const directory of ["resources", "skills", "main/generated"])
    await cp(join(root, "out", directory), join(out, directory), { recursive: true })
  await symlink(join(root, "node_modules"), join(out, "node_modules"), "junction")
  await writeFile(
    join(out, "bot-test-build.json"),
    JSON.stringify({ repository: root, builtAt: new Date().toISOString() })
  )
  console.log("Isolated Bot test build:", out)
  if (process.argv.includes("--browser")) {
    await run(["--import", "tsx", "tests/bot-native-browser-host.spec.ts"], {
      BOT_TEST_APP_OUT: out
    })
    await run(["--import", "tsx", "tests/bots-browser-preview-browser.spec.ts"])
    await run(["--import", "tsx", "tests/bots-browser-panel-browser.spec.ts"])
  } else if (!process.argv.includes("--build-only")) {
    const testEnv = { BOT_TEST_APP_OUT: out }
    for (const test of [
      "bots-local-work-app.spec.ts",
      "bots-conversation-link-app.spec.ts",
      "bots-memory-app.spec.ts",
      "bots-mock-channel-app.spec.ts"
    ])
      await run(["--import", "tsx", `tests/${test}`], testEnv)
    await run(["--import", "tsx", "tests/bots-memory-app.spec.ts"], {
      ...testEnv,
      BOT_TEST_LEGACY_MEMORY: "1"
    })
    await run(["--import", "tsx", "tests/bots-local-work-app.spec.ts"], {
      ...testEnv,
      BOT_TEST_EXPLICIT_WORKSPACE: "1"
    })
    await run(["--import", "tsx", "tests/bots-mock-channel-app.spec.ts"], {
      ...testEnv,
      M05_MOCK_MESSAGE_CONTROLS_ONLY: "1"
    })
    console.log("Bot integration App journeys passed. Build and screenshots:", out)
  }
} finally {
  await rm(configPath, { force: true })
}
