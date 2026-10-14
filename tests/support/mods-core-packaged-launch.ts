import assert from "node:assert/strict"
import { lstatSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { _electron } from "playwright"

/** Test-only launch selection. An invalid explicit package must never fall back to out/main. */
export function modsCoreLaunchOptions(
  root: string,
  isolated: string,
  env: Record<string, string>,
  packagedDirectory: string | undefined
) {
  const options = {
    executablePath: join(root, "tests/support/electron-launcher.cmd"),
    args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
    cwd: root,
    env
  }
  if (packagedDirectory === undefined) return { options, packaged: undefined }
  if (!packagedDirectory.trim()) throw Error("MODS_CORE_PACKAGE_PATH_EMPTY")
  const directory = resolve(root, packagedDirectory)
  const resources = join(directory, "resources")
  const executable = join(directory, "CMBDevClaw.exe")
  const asar = join(resources, "app.asar")
  for (const path of [directory, resources, executable, asar]) {
    const info = lstatSync(path)
    if (
      info.isSymbolicLink() ||
      ([directory, resources].includes(path) ? !info.isDirectory() : !info.isFile())
    )
      throw Error("MODS_CORE_PACKAGE_FILE_INVALID")
  }
  const packaged = { executable: realpathSync(executable), asar: realpathSync(asar) }
  return {
    options: {
      ...options,
      args: [`--user-data-dir=${join(isolated, "electron")}`],
      env: { ...env, CMB_E2E_ELECTRON_BIN: packaged.executable, CMB_MODS_E2E: "0" }
    },
    packaged
  }
}

/** Pin the same binary/profile for every boot, including the suites' real restart checks. */
export function createModsCoreLauncher(
  root: string,
  isolated: string,
  env: Record<string, string>,
  artifacts: string
) {
  const selected = modsCoreLaunchOptions(root, isolated, env, process.env.CMB_MODS_PACKAGED_DIR)
  const launches: Record<string, unknown>[] = []
  return async (timeout: number) => {
    const app = await _electron.launch({ ...selected.options, timeout })
    if (!selected.packaged) return app
    try {
      await app.firstWindow()
      // Reuse the existing offline suite boundary. Do not navigate corporate SSO in a fixture.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("open-login-page")
        ipcMain.handle("open-login-page", () => undefined)
      })
      const actual = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
        executable: process.execPath,
        pid: process.pid
      }))
      assert.equal(actual.packaged, true)
      assert.equal(realpathSync(actual.path), selected.packaged.asar)
      assert.equal(realpathSync(actual.executable), selected.packaged.executable)
      const asar = createRequire(join(root, "package.json"))("@electron/asar") as {
        listPackage(path: string): string[]
      }
      const files = asar.listPackage(actual.path).map((file) => file.replace(/\\/g, "/"))
      assert(!files.some((file) => file.endsWith("/mods-e2e.js")))
      assert(files.some((file) => file.endsWith("/out/main/function-mod-host.js")))
      launches.push({
        ...actual,
        launcherPid: app.process().pid,
        userData: join(isolated, "electron"),
        testEntryAbsent: true
      })
      writeFileSync(
        join(artifacts, "packaged-launches.json"),
        JSON.stringify(launches, null, 2) + "\n"
      )
      return app
    } catch (error) {
      // The caller has not yet received this application, so it cannot close it on failure.
      try {
        await app.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "MODS_CORE_PACKAGE_LAUNCH_CLEANUP_FAILED", {
          cause: error
        })
      }
      throw error
    }
  }
}
