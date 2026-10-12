import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { readPrivateJson } from "./backup-io"
import { windowsSetupMarker } from "./windows-setup-marker"

/** Trusted test-process input only. This checks fixture identity; the actual
 * native factory still verifies package bytes, permissions and the live Job.
 * No fixture environment variable is a native capability or model approval. */
export async function loadWindowsNativeTestConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.CMB_BOT_NATIVE_WINDOWS_TEST !== "1")
    throw new Error("Windows Shell acceptance requires explicit native test preparation")
  const configured = environment.CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY,
    home = environment.CMB_COWORK_AGENT_HOME,
    packageDirectory = environment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY,
    manifestSha256 = environment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256
  if (!configured || !home || !packageDirectory || !manifestSha256)
    throw new Error("Windows Shell acceptance requires a prepared isolated home and native package")
  if (
    ![configured, home, packageDirectory].every(isAbsolute) ||
    !/^[a-f0-9]{64}$/.test(manifestSha256)
  )
    throw new Error("Windows native fixture paths and manifest pin are invalid")
  const directory = await realpath(configured)
  if (directory !== configured || directory !== (await realpath(join(home, "bot-host"))))
    throw new Error("Windows native fixture Host root is not the explicit isolated home")
  for (const path of [resolve(home), directory, packageDirectory]) {
    const value = await lstat(path)
    if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Windows native fixture directory is not physical")
  }
  windowsSetupMarker.parse(
    (await readPrivateJson(directory, "windows-native-setup.json", 4096)).value
  )
  return { directory, windowsNative: { packageDirectory, manifestSha256 } }
}
