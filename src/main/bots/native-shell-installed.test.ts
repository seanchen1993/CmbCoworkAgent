import { beforeEach, afterEach, expect, test } from "vitest"
import { mkdtemp, realpath, rm, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withInstalledBotNativeConfiguration } from "./native-shell-installed"
import { botHostStartupEnvironment } from "./host-startup-environment"
import { botShellEnvironment } from "./shell-contract"
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-installed-native-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const pin = {
  format: 1 as const,
  platform: "win32" as const,
  arch: "x64" as const,
  manifestSha256: "a".repeat(64)
}
const context = () => ({
  pin,
  platform: "win32" as const,
  arch: "x64",
  resourcesDirectory: root
})
const install = async () => {
  const dir = join(root, "bot-native-sandbox/win32-x64")
  await mkdir(dir, { recursive: true })
  return dir
}
test("installed default uses only matching physical release and independent embedded digest", async () => {
  const dir = await install(),
    source = { PATH: "/tools" }
  const result = withInstalledBotNativeConfiguration(source, context())
  expect(result).toEqual({
    PATH: "/tools",
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: dir,
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: pin.manifestSha256
  })
  expect(source).toEqual({ PATH: "/tools" })
  expect(botHostStartupEnvironment(result)).toEqual(result)
  expect(botShellEnvironment(result)).toEqual(source)
})
test.each([{ pin: null }, { platform: "linux" as const }, { arch: "arm64" }])(
  "nonmatching or absent component keeps Host unconfigured: %j",
  async (mismatch) => {
    await install()
    expect(
      withInstalledBotNativeConfiguration({ PATH: "/tools" }, { ...context(), ...mismatch })
    ).toEqual({ PATH: "/tools" })
  }
)
test("missing component is optional for chat; a directory alias cannot become native authority", async () => {
  expect(withInstalledBotNativeConfiguration({}, context())).toEqual({})
  await mkdir(join(root, "elsewhere"))
  await mkdir(join(root, "bot-native-sandbox"))
  await symlink(join(root, "elsewhere"), join(root, "bot-native-sandbox/win32-x64"), "dir")
  expect(withInstalledBotNativeConfiguration({}, context())).toEqual({})
})
test.each([
  { CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "" },
  { CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "" },
  {
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "/operator/native",
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "f".repeat(64)
  }
])("explicit configuration preserves strict validation including empty inputs", async (source) => {
  await install()
  expect(withInstalledBotNativeConfiguration(source, context())).toEqual(source)
})
test("Linux installation requires deployment-owned delegation, never manufactures a kernel verdict", async () => {
  await mkdir(join(root, "bot-native-sandbox/linux-x64"), { recursive: true })
  const ctx = {
    ...context(),
    pin: { ...pin, platform: "linux" as const },
    platform: "linux" as const
  }
  expect(withInstalledBotNativeConfiguration({}, ctx)).toEqual({})
  const env = withInstalledBotNativeConfiguration(
    { CMB_BOT_DELEGATED_CGROUP_DIRECTORY: "/delegated" },
    ctx
  )
  expect(env.CMB_BOT_NATIVE_SANDBOX_DIRECTORY).toBe(join(root, "bot-native-sandbox/linux-x64"))
  expect(env).not.toHaveProperty("CMB_BOT_NATIVE_FORCE_READY")
  expect(botShellEnvironment(env)).toEqual({})
})
test.each(["electron", "standalone"] as const)(
  "compiled %s embedded pin supplies installation defaults without operator environment",
  async (mode) => {
    const resourcesDirectory = mode === "electron" ? root : join(root, "out/resources")
    const dir = join(resourcesDirectory, "bot-native-sandbox/win32-x64")
    await mkdir(dir, { recursive: true })
    const { build } = await import("esbuild")
    const { writeFile } = await import("node:fs/promises")
    const { createRequire } = await import("node:module")
    const output = join(root, "out/main/compiled-default.cjs")
    await mkdir(join(root, "out/main"), { recursive: true })
    const source = join(process.cwd(), "src/main/bots/host-startup-environment.ts")
    const result = await build({
      stdin: {
        contents: `export {botHostStartupEnvironment} from ${JSON.stringify(source)}`,
        resolveDir: process.cwd(),
        sourcefile: "embedded-default.ts"
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      define: {
        __BOT_NATIVE_DISTRIBUTION__: JSON.stringify(pin),
        "process.platform": JSON.stringify("win32"),
        "process.arch": JSON.stringify("x64"),
        "process.resourcesPath":
          mode === "electron" ? JSON.stringify(resourcesDirectory) : "undefined"
      },
      logLevel: "silent"
    })
    await writeFile(output, result.outputFiles![0].contents)
    const compiled = createRequire(import.meta.url)(output) as {
      botHostStartupEnvironment: (env: NodeJS.ProcessEnv) => Record<string, string>
    }
    const resultEnv = compiled.botHostStartupEnvironment({ PATH: "/tools" })
    expect(resultEnv).toEqual({
      PATH: "/tools",
      CMB_BOT_NATIVE_SANDBOX_DIRECTORY: dir,
      CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: pin.manifestSha256
    })
    expect(botShellEnvironment(resultEnv)).toEqual({ PATH: "/tools" })
  }
)
