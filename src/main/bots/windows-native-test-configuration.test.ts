import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadWindowsNativeTestConfiguration } from "./windows-native-test-configuration"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
async function configuration() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-ci-config-")))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "home"),
    directory = join(home, "bot-host"),
    packageDirectory = join(root, "native")
  await mkdir(directory, { recursive: true })
  await mkdir(packageDirectory)
  const environment = {
    CMB_BOT_NATIVE_WINDOWS_TEST: "1",
    CMB_COWORK_AGENT_HOME: home,
    CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY: directory,
    CMB_BOT_NATIVE_SANDBOX_DIRECTORY: packageDirectory,
    CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "a".repeat(64)
  }
  return { root, home, directory, packageDirectory, environment }
}
it("refuses fixture admission without explicit native preparation before filesystem access", async () => {
  await expect(loadWindowsNativeTestConfiguration({})).rejects.toThrow(
    "explicit native test preparation"
  )
})
it.each([
  "CMB_COWORK_AGENT_HOME",
  "CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY",
  "CMB_BOT_NATIVE_SANDBOX_DIRECTORY",
  "CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256"
])("missing %s cannot turn a component fixture into a Windows native runner", async (name) => {
  const f = await configuration()
  const environment: NodeJS.ProcessEnv = { ...f.environment }
  delete environment[name]
  await expect(loadWindowsNativeTestConfiguration(environment)).rejects.toThrow(
    "prepared isolated home"
  )
})
it.each([
  { CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: "source-only" },
  { CMB_BOT_NATIVE_SANDBOX_DIRECTORY: "relative-native" }
])(
  "rejects incomplete pins/relative native paths before opening the setup marker",
  async (changed) => {
    const f = await configuration()
    await expect(
      loadWindowsNativeTestConfiguration({ ...f.environment, ...changed })
    ).rejects.toThrow("invalid")
  }
)
it("an existing but uninitialized isolated Host never enables native command tests", async () => {
  const f = await configuration()
  await expect(loadWindowsNativeTestConfiguration(f.environment)).rejects.toMatchObject({
    code: "ENOENT"
  })
})
it("fixture-supplied capability booleans cannot substitute the published setup identity", async () => {
  const f = await configuration()
  await writeFile(
    join(f.directory, "windows-native-setup.json"),
    JSON.stringify({ verified: true, elevatedSetup: "verified" })
  )
  await expect(loadWindowsNativeTestConfiguration(f.environment)).rejects.toThrow()
})
it("rejects a same-root symbolic Host alias before trusting its marker", async () => {
  const f = await configuration()
  const alias = join(f.root, "host-alias")
  await symlink(f.directory, alias, "junction")
  await expect(
    loadWindowsNativeTestConfiguration({
      ...f.environment,
      CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY: alias
    })
  ).rejects.toThrow("explicit isolated home")
})
it("rejects a symbolic native package directory instead of delegating package identity", async () => {
  const f = await configuration()
  const alias = join(f.root, "native-alias")
  await symlink(f.packageDirectory, alias, "junction")
  await expect(
    loadWindowsNativeTestConfiguration({
      ...f.environment,
      CMB_BOT_NATIVE_SANDBOX_DIRECTORY: alias
    })
  ).rejects.toThrow("physical")
})
