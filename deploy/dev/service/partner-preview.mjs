/** Legacy Java-backed preview lifecycle. Only status/stop remain supported by the current App. */
import { createRequire } from "node:module"
import { constants } from "node:fs"
import { open, readdir, readFile, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { privateDirectory } from "../docker/host.mjs"
import { run } from "../process.mjs"
import {
  partnerEntry,
  partnerPrivateFile,
  partnerWrite,
  PARTNER_PROJECT
} from "./partner-dev-resources.mjs"
import {
  partnerDevStart,
  partnerDevStatus,
  partnerDevStop,
  partnerProcessInfo
} from "./partner-dev.mjs"

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL("../../../", import.meta.url))
const require = createRequire(import.meta.url)
const check = (value) => {
  if (!value) throw Error("PARTNER_PREVIEW")
}
const recordPath = (entry) => join(entry.dir, "preview-process.json")
const profilePath = (entry) => join(entry.dir, "preview-app")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let phase = "arguments"

// Keep the user's normal HOME unchanged. Only App-owned stores get isolated.
export function previewEnvironment(profile, inherited = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(inherited))
    if (value && /^(PATH|HOME|SHELL|USER|LOGNAME|LANG|LC_.*|TMPDIR|__CF.*|DISPLAY)$/i.test(key))
      env[key] = value
  return Object.assign(env, {
    PATH: [
      dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(":"),
    CMB_COWORK_AGENT_HOME: join(profile, "data"),
    CMB_PARTNER_LOCAL_CONNECTION_FILE: join(dirname(profile), "connection.json"),
    ELECTRON_RENDERER_URL: pathToFileURL(join(root, "out/renderer/index.html")).href,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
}

export function disabledViteKeys(sources) {
  const keys = new Set()
  for (const source of sources)
    for (const match of source.matchAll(/\b(?:MAIN_)?VITE_[A-Z0-9_]+\b/g)) keys.add(match[0])
  return keys
}
async function safeBuildEnvironment(profile) {
  const sources = []
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(entry.name))
        sources.push(await readFile(path, "utf8"))
    }
  }
  await collect(join(root, "src"))
  sources.push(await readFile(join(root, "electron.vite.config.ts"), "utf8"))
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isFile() && entry.name.startsWith(".env"))
      sources.push(await readFile(join(root, entry.name), "utf8"))
  const env = previewEnvironment(profile)
  for (const key of disabledViteKeys(sources)) env[key] = ""
  return Object.assign(env, {
    VITE_TASK_CARDS_MOCK: "1",
    VITE_TRACE_EVOLVER_MOCK: "true",
    CMB_TASK_CARDS_MOCK: "1",
    CMB_TASK_CARDS_ENDPOINT: ""
  })
}

export function validatePreviewRecord(value, entry) {
  check(
    value?.version === 1 &&
      value.project === entry.project &&
      value.nonce === entry.nonce &&
      value.profile === profilePath(entry)
  )
  check(
    Number.isInteger(value.pid) &&
      value.pid > 1 &&
      typeof value.info === "string" &&
      value.info.endsWith(`${process.execPath} ${self} start`)
  )
  check(
    value.app === null ||
      (Number.isInteger(value.app?.pid) &&
        value.app.pid > 1 &&
        typeof value.app.info === "string" &&
        value.app.info.includes(`--user-data-dir=${join(value.profile, "electron")}`))
  )
  return value
}
export async function previewRecord(entry, processInfo = partnerProcessInfo) {
  let value
  try {
    value = validatePreviewRecord(
      JSON.parse(await partnerPrivateFile(recordPath(entry), 16384)),
      entry
    )
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  const actual = await processInfo(value.pid)
  if (actual !== null) {
    check(actual === value.info)
    return { ...value, alive: true }
  }
  // A lost supervisor must not be mistaken for an exited Electron process.
  if (value.app) check((await processInfo(value.app.pid)) === null)
  return { ...value, alive: false }
}
async function rejectUntrackedApp(entry) {
  const processes = await run("/bin/ps", ["-ww", "-axo", "command="], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    maxOutput: 1048576
  })
  check(!processes.includes(`--user-data-dir=${join(profilePath(entry), "electron")}`))
}
async function claim(entry) {
  const previous = await previewRecord(entry)
  if (previous?.alive) return null
  await rejectUntrackedApp(entry)
  if (previous) await unlink(recordPath(entry)) // Confirmed dead, validated private task record only.
  const value = {
    version: 1,
    project: entry.project,
    nonce: entry.nonce,
    profile: profilePath(entry),
    pid: process.pid,
    info: await partnerProcessInfo(process.pid),
    app: null
  }
  validatePreviewRecord(value, entry)
  const file = await open(
    recordPath(entry),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.writeFile(JSON.stringify(value) + "\n")
    await file.sync()
  } finally {
    await file.close()
  }
  return value
}

export async function closePreview(app, stopService) {
  // Do not stop the service underneath a still-running App/graph.
  if (app) await app.close()
  await stopService()
}
export async function waitForPreviewExit(value, processInfo = partnerProcessInfo) {
  const deadline = Date.now() + 5000
  for (;;) {
    const actual = await processInfo(value.pid)
    if (actual === null) return
    check(actual === value.info && Date.now() < deadline)
    await pause(50)
  }
}
export function retainSignalHandlers(previous, target = process) {
  for (const [signal, handlers] of previous)
    for (const handler of target.listeners(signal))
      if (!handlers.includes(handler)) target.removeListener(signal, handler)
}
export function retainManualPreviewDialogs(page) {
  // Playwright dismisses unobserved dialogs. This foreground preview belongs to
  // the human: leave the native dialog open, without accepting or dismissing it.
  const observe = () => {}
  page.on("dialog", observe)
  // Keep the subscription throughout App shutdown; removing it earlier can
  // dismiss a pending confirmation. Release only our listener after page close.
  page.once("close", () => page.removeListener("dialog", observe))
}
async function start(entry) {
  phase = "claim"
  const owned = await claim(entry)
  if (!owned) {
    console.log(JSON.stringify({ status: "already-running", project: entry.project }))
    return
  }
  const controller = new AbortController()
  let app,
    appProcess,
    closePromise,
    serviceStarted = false,
    ready = false,
    failure
  const closeApp = () =>
    app &&
    (closePromise ??= (async () => {
      try {
        await app.close()
      } catch (error) {
        phase = "app-close-call-failed"
        throw error
      }
      if (owned.app) {
        try {
          await waitForPreviewExit(owned.app)
        } catch (error) {
          phase = "app-exit-check-failed"
          throw error
        }
      }
    })())
  const cancel = () => {
    controller.abort()
    void closeApp()?.catch(() => {})
  }
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    try {
      await privateDirectory(owned.profile, true)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    await privateDirectory(owned.profile)
    phase = "build"
    console.log("构建本地预览：禁用远程页面、模型目录、更新与上报地址……")
    await run(
      process.execPath,
      [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "build"],
      {
        cwd: root,
        env: await safeBuildEnvironment(owned.profile),
        signal: controller.signal,
        timeoutMs: 240000,
        maxOutput: 1048576
      }
    )
    check(!controller.signal.aborted)
    phase = "service-start"
    const existing = await partnerDevStatus(entry)
    const service = await partnerDevStart(entry, controller.signal)
    serviceStarted = existing.status !== "running"
    console.log(
      JSON.stringify({
        stage: "service-ready",
        port: service.port,
        connectionFile: service.connectionFile
      })
    )
    const { _electron } = require("playwright")
    phase = "app-start"
    const signalHandlers = new Map(
      ["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)])
    )
    app = await _electron.launch({
      executablePath: require("electron"),
      cwd: root,
      env: previewEnvironment(owned.profile),
      timeout: 45000,
      args: [
        join(root, "out/main/index.js"),
        `--user-data-dir=${join(owned.profile, "electron")}`,
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=localhost;127.0.0.1"
      ]
    })
    // Playwright's default SIGINT exits the supervisor before DB cleanup. This
    // dedicated wrapper owns its signals; keep unrelated pre-existing listeners.
    retainSignalHandlers(signalHandlers)
    // Capture before Playwright disposes its application object on close.
    appProcess = app.process()
    owned.app = { pid: appProcess.pid, info: await partnerProcessInfo(appProcess.pid) }
    validatePreviewRecord(owned, entry)
    await partnerWrite(recordPath(entry), JSON.stringify(owned) + "\n")
    check(!controller.signal.aborted)
    phase = "open-partner-page"
    const page = await app.firstWindow()
    retainManualPreviewDialogs(page)
    page.setDefaultTimeout(15000)
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "DevClaw 伙伴", exact: true }).click()
    await page.getByTestId("partner-dev-panel").waitFor()
    const status = await page.evaluate(() => window.api.partnerDev.getStatus())
    check(
      status.model === "simulated" &&
        status.connected &&
        status.connectionMode === "local-default" &&
        !status.nodeEnabled
    )
    ready = true
    phase = "ready"
    console.log(
      JSON.stringify({
        status: "ready",
        project: entry.project,
        appPid: owned.app.pid,
        profile: owned.profile,
        connectionFile: service.connectionFile,
        model: "simulated",
        connected: true,
        nodeEnabled: false
      })
    )
    console.log(
      "伙伴页面已打开并自动连接。创建专家后默认准备数据目录，明确启用本机即可测试；npm run stop:bot-preview 停止，保留数据。"
    )
    if (controller.signal.aborted) await closeApp()
    else await app.waitForEvent("close", { timeout: 0 })
  } catch (error) {
    if (!controller.signal.aborted) failure = error
  } finally {
    try {
      phase = "close-app"
      await closePreview(
        app
          ? {
              close: async () => {
                if (appProcess?.exitCode === null) await closeApp()
              }
            }
          : null,
        () => {
          phase = "service-stop"
          return ready || serviceStarted ? partnerDevStop(entry) : Promise.resolve()
        }
      )
      // Leave the record intact on cleanup failure; never assume the App exited.
      if (owned.app) await waitForPreviewExit(owned.app)
      phase = "release-record"
      const current = validatePreviewRecord(
        JSON.parse(await partnerPrivateFile(recordPath(entry), 16384)),
        entry
      )
      check(current.pid === owned.pid && current.info === owned.info)
      await unlink(recordPath(entry))
    } finally {
      process.removeListener("SIGINT", cancel)
      process.removeListener("SIGTERM", cancel)
    }
  }
  if (failure) throw failure
  console.log(JSON.stringify({ status: "stopped", project: entry.project, data: "preserved" }))
}
async function stop(entry) {
  const current = await previewRecord(entry)
  if (current?.alive) {
    check((await partnerProcessInfo(current.pid)) === current.info)
    process.kill(current.pid, "SIGTERM")
    const deadline = Date.now() + 45000
    while ((await partnerProcessInfo(current.pid)) !== null) {
      check(Date.now() < deadline)
      await pause(100)
    }
  }
  await rejectUntrackedApp(entry)
  const status = await partnerDevStop(entry)
  console.log(JSON.stringify({ ...status, app: "stopped", profile: profilePath(entry) }))
}
async function status(entry) {
  const current = await previewRecord(entry)
  console.log(
    JSON.stringify({
      ...(await partnerDevStatus(entry)),
      app: current?.alive ? (current.app ? "running" : "starting") : "stopped",
      profile: profilePath(entry)
    })
  )
}

// Reuse an installed Node22 on this Mac; never download a runtime implicitly.
function bootstrapNode22() {
  if (process.versions.node.split(".")[0] === "22") return false
  const candidates = [
    process.env.DEVCLAW_NODE22,
    "/opt/homebrew/opt/node@22/bin/node",
    join(homedir(), ".npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node")
  ].filter(Boolean)
  for (const binary of candidates) {
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" })
    if (version.status === 0 && /^v22\./.test(version.stdout.trim())) {
      const result = spawnSync(binary, [self, ...process.argv.slice(2)], { stdio: "inherit" })
      process.exitCode = result.status ?? 1
      return true
    }
  }
  throw Error("NODE22_REQUIRED")
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    check(process.argv.length === 3 && ["start", "status", "stop"].includes(process.argv[2]))
    if (process.argv[2] === "start") {
      console.error(
        "LEGACY_PREVIEW_UNSUPPORTED: 当前本地 MVP 请使用 npm run dev；此脚本仅保留旧预览的 status/stop。"
      )
      process.exitCode = 1
    } else if (!bootstrapNode22()) {
      let entry
      try {
        entry = await partnerEntry({ create: process.argv[2] === "start" })
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        console.log(
          JSON.stringify({ status: "not-created", project: PARTNER_PROJECT, app: "stopped" })
        )
      }
      if (entry) await { start, status, stop }[process.argv[2]](entry)
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        phase,
        category: error.message === "NODE22_REQUIRED" ? "NODE22_REQUIRED" : "PARTNER_PREVIEW",
        hint: "检查 Node22/JDK8/任务Docker环境；不自动强杀或清空数据。"
      })
    )
    process.exitCode = 1
  }
}
