import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { _electron } from "playwright"

const root = resolve(import.meta.dirname, "../..")

/** Exercise the installed Electron runtime without access to the developer's live profile or keys. */
export async function launchAttachmentElectron(profile, fixtureEnv = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*)$/i.test(
        key
      )
    )
  )
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "CMB_COWORK_AGENT_HOME",
    "TEMP"
  ]) {
    env[key] = join(profile, key)
    await mkdir(env[key])
  }
  env.HOME = env.USERPROFILE
  env.TMP = env.TEMP
  env.CMB_E2E_ELECTRON_BIN = createRequire(import.meta.url)("electron")
  env.CMB_E2E_DISABLE_GPU = "1"
  env.HTTPS_PROXY = env.HTTP_PROXY = "http://127.0.0.1:9"
  env.NO_PROXY = "localhost,127.0.0.1"
  const packaged = process.env.CHAT_ATTACHMENT_PACKAGED_EXECUTABLE
  return _electron.launch({
    executablePath:
      packaged ||
      (process.platform === "win32"
        ? join(root, "tests/support/electron-launcher.cmd")
        : env.CMB_E2E_ELECTRON_BIN),
    args: [
      ...(packaged ? [] : [join(root, "out/main/index.js")]),
      "--disable-gpu",
      "--proxy-server=http://127.0.0.1:9",
      "--user-data-dir=" + join(profile, "electron")
    ],
    cwd: root,
    env: { ...env, ...fixtureEnv },
    timeout: 60_000
  })
}
