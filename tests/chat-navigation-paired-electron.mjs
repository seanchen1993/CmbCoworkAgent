/** Same-machine comparison of the production Electron chat UI from two source trees. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createReadStream } from "node:fs"
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises"
import { createRequire } from "node:module"
import { cpus, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import AdmZip from "adm-zip"
import { _electron } from "playwright"

const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const { values: options } = parseArgs({
  options: {
    baseline: { type: "string" },
    mods: { type: "string" },
    electron: { type: "string" },
    mode: { type: "string", default: "no-match" },
    calibration: { type: "string" },
    output: { type: "string" },
    pairs: { type: "string", default: "8" },
    directory: { type: "string", default: "500" },
    rows: { type: "string", default: "180" },
    protect: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    idle: { type: "boolean", default: false },
    "trace-ipc": { type: "boolean", default: false }
  }
})
assert(["aa", "off", "no-match", "active"].includes(options.mode), "Invalid --mode")
assert(options.baseline && options.output && (options.mode === "aa" || options.mods),
  "Pass --baseline and --output, and --mods for candidate comparisons")
assert(options.mode !== "aa" || !options.mods, "A/A measures the exact baseline in both arms")
assert(!options.protect || ["no-match", "active"].includes(options.mode),
  "Protection requires an enabled candidate")
assert(!options.calibration || options.mode !== "aa", "A/A produces its own calibration")
const pairedRuns = Number(options.pairs)
const directoryCount = Number(options.directory)
const rowCount = Number(options.rows)
assert(Number.isInteger(pairedRuns) && pairedRuns >= 1)
assert(Number.isInteger(directoryCount) && directoryCount >= 3)
assert(Number.isInteger(rowCount) && rowCount >= 100)

const output = resolve(options.output)
await mkdir(output, { recursive: true })
const runOutput = await mkdtemp(join(output, "electron-pair-"))
const runtime = await realpath(await mkdtemp(join(tmpdir(), "cmb-electron-pair-")))
const workspace = join(runtime, "synthetic-workspace")
await mkdir(workspace)
const runtimePath = join(runOutput, "runtime.txt")
await writeFile(runtimePath, runtime + "\n")
const applications = {
  baseline: { root: resolve(options.baseline) },
  mods: { root: resolve(options.mode === "aa" ? options.baseline : options.mods) }
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  }).trim()
const sha = async (path) => {
  const digest = createHash("sha256")
  for await (const part of createReadStream(path)) digest.update(part)
  return digest.digest("hex")
}
const wheelDeltas = [-540, -540, 540, -540, 540, -540, -540, 540, -540, 540, -540, 540]
const wheelIntervalMs = 72
const protectedCanary = "Bearer FIXTURE_PUBLICATION_CANARY_1234567890"
const activeMarker = "PAIRED_ACTIVE_DECORATION "
const activePluginName = "paired-display-electron"
const activePluginSource = `export function register(on) {
  on("ui.render", {component: "AssistantMessage"}, ($, event, next) => next({
    ...event, props: { ...event.props, text: ${JSON.stringify(activeMarker)} + event.props.text }
  }))
}`
function activePluginZip() {
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name: activePluginName, version: "1.0.0" })))
  zip.addFile("mods/manifest.json", Buffer.from(JSON.stringify({
    apiVersion: "cmb.mods/v2", id: activePluginName, entry: "main.ts"
  })))
  zip.addFile("mods/main.ts", Buffer.from(activePluginSource))
  return [...zip.toBuffer()]
}

// These experience limits are set before the candidate is measured. A/A checks
// that the machine can resolve the strictest budget; it never expands a budget.
const budgets = {
  off: { coldMs: 20, warmP95Ms: 20, framesP95Ms: 3, wheelP95Ms: 2, blankMs: 0 },
  "no-match": { coldMs: 35, warmP95Ms: 30, framesP95Ms: 4, wheelP95Ms: 2, blankMs: 0 },
  active: { coldMs: 100, warmP95Ms: 50, framesP95Ms: 8, wheelP95Ms: 4, blankMs: 100 }
}
const targets = ["A", "B"].map((name) => ({
  name,
  title: `Paired Electron transcript ${name}`,
  row: `paired-${name}-${rowCount - 1}`
}))
const manifest = {
  node: process.version,
  playwright: require("playwright/package.json").version,
  rowCount,
  directoryCount,
  driverSha256: await sha(fileURLToPath(import.meta.url)),
  launcherSha256: await sha(join(driverRoot, "tests/support/electron-launcher.cmd")),
  rowMetadataBytes: 512 * 1024,
  wheelDeltas,
  wheelIntervalMs,
  mode: options.mode,
  protected: options.protect,
  activeSourceSha256: options.mode === "active" ? createHash("sha256").update(activePluginSource).digest("hex") : null,
  budgets,
  gpu: "normal",
  runtime,
  branches: {}
}

for (const [name, app] of Object.entries(applications)) {
  const appRequire = createRequire(join(app.root, "package.json"))
  app.electron = options.electron ? resolve(options.electron) : appRequire("electron")
  app.version = appRequire("./package.json").version
  app.entry = join(app.root, "out/main/index.js")
  const renderer = join(app.root, "out/renderer/assets")
  const lock = join(app.root, "package-lock.json")
  const gitDiff = git(
    app.root,
    "diff",
    "--binary",
    "HEAD",
    "--",
    "src",
    "resources",
    "electron.vite.config.ts",
    "patches",
    "package.json",
    "package-lock.json"
  )
  manifest.branches[name] = {
    ...app,
    head: git(app.root, "rev-parse", "HEAD"),
    diffSha256: createHash("sha256").update(gitDiff).digest("hex"),
    sourceStatus: git(
      app.root,
      "status",
      "--short",
      "--",
      "src",
      "resources",
      "patches",
      "electron.vite.config.ts",
      "package.json",
      "package-lock.json"
    ),
    electronSha256: await sha(app.electron),
    lockSha256: await sha(lock),
    mainSha256: await sha(app.entry),
    preloadSha256: await sha(join(app.root, "out/preload/index.js")),
    rendererAssets: await Promise.all(
      (await readdir(renderer))
        .filter((name) => /\.(js|css)$/.test(name))
        .sort()
        .map(async (name) => [name, await sha(join(renderer, name))])
    )
  }
}
assert.equal(
  manifest.branches.baseline.electronSha256,
  manifest.branches.mods.electronSha256,
  "Both branches must use the same Electron binary"
)
const calibrationFingerprint = {
  driverSha256: manifest.driverSha256,
  launcherSha256: manifest.launcherSha256,
  node: manifest.node,
  playwright: manifest.playwright,
  rowCount,
  directoryCount,
  pairs: pairedRuns,
  wheelDeltas,
  wheelIntervalMs,
  baseline: manifest.branches.baseline
}
if (options.calibration) {
  assert(options.idle && !options["trace-ipc"], "Calibrated measurements require --idle and no tracing")
  const calibrated = JSON.parse(await readFile(resolve(options.calibration), "utf8"))
  assert.equal(calibrated.mode, "aa", "Calibration must compare the baseline against itself")
  assert.equal(calibrated.status, "passed", "Calibration failed to resolve the experience budget")
  assert.deepEqual(calibrated.fingerprint, calibrationFingerprint, "Baseline or driver changed since calibration")
  manifest.calibration = resolve(options.calibration)
}
await writeFile(join(runOutput, "manifest.json"), JSON.stringify(manifest, null, 2))
console.log(
  JSON.stringify({
    artifacts: runOutput,
    baseline: manifest.branches.baseline.head,
    mods: manifest.branches.mods.head,
    pairedRuns
  })
)

const nativeEnvKeys =
  /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|display|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang)$/i
async function profile(directory, app, seed) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => value && nativeEnvKeys.test(name))
  )
  for (const [name, suffix] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "openwork",
    TEMP: "temp",
    TMP: "temp",
    TMPDIR: "temp",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data"
  })) {
    env[name] = join(directory, suffix)
    await mkdir(env[name], { recursive: true })
  }
  if (seed) await cp(seed, env.CMB_COWORK_AGENT_HOME, { recursive: true })
  else
    await writeFile(
      join(env.CMB_COWORK_AGENT_HOME, "userinfo-models.json"),
      JSON.stringify({ sapId: "localhost-fixture", userName: "Isolated performance fixture" })
    )
  return {
    ...env,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_ELECTRON_BIN: app.electron,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "localhost,127.0.0.1"
  }
}

async function runElectron(branch, directory, label, seed, run) {
  const app = applications[branch]
  const env = await profile(directory, app, seed)
  const errors = []
  const modsErrors = new Set()
  const blockedRequests = new Set()
  const launcher = join(driverRoot, "tests/support/electron-launcher.cmd")
  const startedAt = Date.now()
  let electron, page
  const logPath = join(runOutput, `${label}-electron.log`)
  let logWrites = Promise.resolve()
  const log = (bytes) => {
    logWrites = logWrites.then(() => appendFile(logPath, bytes))
  }
  try {
    electron = await _electron.launch({
      executablePath: process.platform === "win32" ? launcher : app.electron,
      args: [app.entry, `--user-data-dir=${join(directory, "electron")}`],
      cwd: app.root,
      env,
      timeout: 60_000
    })
    electron.process().stdout?.on("data", log)
    electron.process().stderr?.on("data", log)
    await electron.context().route(/^https?:/, (route) => {
      const url = new URL(route.request().url())
      if (
        url.protocol === "https:" &&
        /^archguardservice\.paas\.[a-z0-9.-]+\.cn$/i.test(url.hostname) &&
        url.pathname === "/cowork/login-info"
      ) {
        // The UAT shell refreshes its synthetic login during the first thread hydration.
        return route.fulfill({
          json: {
            returnCode: "SUC0000",
            body: { sapId: "localhost-fixture", userName: "Isolated performance fixture" }
          },
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "ystrefreshtoken, ystcode",
            "access-control-allow-methods": "GET, OPTIONS"
          }
        })
      }
      blockedRequests.add(url.hostname + url.pathname)
      return route.abort()
    })
    page = await electron.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (error) => errors.push({ message: error.message, stack: error.stack }))
    page.on("console", (message) => {
      for (const code of message.text().match(/MODS_(?:UI_SITE_LIMIT|RUNTIME_SESSION_BUSY)/g) ?? [])
        modsErrors.add(code)
    })
    await page.waitForFunction(() => Boolean(window.api?.threads && window.api?.workspace))
    await page.getByText("Initializing...", { exact: true }).waitFor({ state: "hidden" })
    const applicationReadyMs = Date.now() - startedAt
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      window.setSize(1260, 820)
      return window.getSize()
    })
    await page.bringToFront()
    const versions = await electron.evaluate(() => ({ ...process.versions }))
    await page.waitForTimeout(600)
    const bootErrors = errors.splice(0)
    assert(
      bootErrors.every((error) => blockedRequests.size > 0 && error.message === "Failed to fetch"),
      "Unexpected renderer initialization errors: " + JSON.stringify(bootErrors)
    )
    if (options["trace-ipc"] && seed) {
      await electron.evaluate(({ ipcMain }) => {
        const trace = []
        globalThis.pairedIpcTrace = trace
        for (const [channel, handler] of ipcMain._invokeHandlers) {
          ipcMain._invokeHandlers.set(channel, async (...args) => {
            const input = args[1]
            const record = {
              channel,
              startedAt: performance.timeOrigin + performance.now(),
              threadId: typeof input === "string" ? input : input?.threadId,
              component: input?.component,
              readId: input?.readId
            }
            trace.push(record)
            try {
              return await handler(...args)
            } catch (error) {
              record.error = String(error)
              throw error
            } finally {
              record.endedAt = performance.timeOrigin + performance.now()
            }
          })
        }
      })
    }
    const result = await run(page)
    if (options["trace-ipc"] && seed) {
      const ipcTrace = await electron.evaluate(() => globalThis.pairedIpcTrace)
      await writeFile(join(runOutput, `${label}-ipc-trace.json`), JSON.stringify(ipcTrace, null, 2))
    }
    assert.deepEqual(errors, [], "Renderer errors occurred")
    return {
      ...result,
      versions,
      bootErrors,
      blockedRequests: [...blockedRequests],
      errors,
      modsErrors: [...modsErrors],
      applicationReadyMs,
      startedAt,
      endedAt: Date.now()
    }
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(runOutput, `${label}-failure.png`) }).catch(() => {})
      const ui = await page
        .locator("body")
        .innerText({ timeout: 2_000 })
        .catch(() => "unavailable")
      await writeFile(join(runOutput, `${label}-failure.txt`), `${error.stack}\n\n${ui}\n`)
    }
    throw error
  } finally {
    await electron?.close()
    await logWrites
  }
}

async function seedBranch(branch) {
  const directory = join(runtime, `seed-${branch}`)
  const mode = branch === "baseline" || options.mode === "aa" ? "native" : options.mode
  const result = await runElectron(branch, directory, `seed-${branch}`, undefined, (page) =>
    page.evaluate(
      async ({ workspace, directoryCount, rowCount, targets, version, protect, mode,
        protectedCanary, activePluginName, pluginZip }) => {
        const api = window.api
        if ((mode !== "native") !== Boolean(api.mods?.configureGlobal))
          throw new Error("Incorrect application surface for paired measurement")
        for (const guide of [
          { guideId: "application-controls-walkthrough", revision: 2, maxShowCount: 1 },
          { guideId: "project-mode-getting-started", revision: 2, maxShowCount: 3 },
          ...["", ":locations"].map((suffix) => ({
            guideId: `release-introduction:${version}${suffix}`,
            revision: 20261103,
            maxShowCount: 1
          }))
        ]) {
          if (api.uiGuides?.acknowledge) await api.uiGuides.acknowledge(guide)
        }
        if (mode !== "native") {
          const enabled = mode !== "off"
          await api.mods.configureGlobal(enabled)
          if (await api.mods.globalEnabled() !== enabled) throw Error("Global Mods setting did not persist")
        }
        for (let index = 0; index < directoryCount - targets.length - 1; index++) {
          await api.threads.create({
            title: `Paired directory ${String(index).padStart(4, "0")}`,
            workspacePath: workspace,
            agentMode: "normal"
          })
        }
        const seeded = []
        for (const target of targets) {
          const thread = await api.threads.create({
            title: target.title,
            workspacePath: workspace,
            agentMode: "normal",
            llmFileHistory: { syntheticHistory: "x".repeat(512 * 1024) }
          })
          const id = thread.thread_id ?? thread.id
          if (!id) throw new Error("Missing seed thread ID")
          await api.workspace.set(id, workspace)
          if (mode === "no-match" || mode === "active") {
            const status = await api.mods.status(id)
            await api.mods.configure(id, true, protect, status.workspace)
            if (mode === "no-match" && (await api.mods.clawView(id)).active)
              throw Error("Unselected Mods profile unexpectedly active")
          }
          const messages = Array.from({ length: rowCount }, (_, index) => {
            const marker = `PAIRED_BODY_${target.name}_${index}`
            const role = index % 2 || index === rowCount - 1 ? "assistant" : "user"
            const content =
              index % 7 === 0 && index !== rowCount - 1
                ? `${marker}\n\n### Reference\n\n${"Paragraph with **bold** and `code`.\n\n".repeat(8)}`
                : `${marker} — ${role === "assistant" ? "Persisted **assistant response**." : "Persisted user question."}`
            return {
              id: `paired-${target.name}-${index}`,
              role,
              content: index === rowCount - 1 || index % 17 === 0 ? `${content} ${protectedCanary}` : content,
              created_at: new Date(1_700_000_000_000 + index * 3_000)
            }
          })
          const persisted = await api.threads.appendMessages(id, messages)
          if (persisted.count !== messages.length) throw new Error("Incomplete seed history")
          seeded.push({ ...target, id, marker: `PAIRED_BODY_${target.name}_${rowCount - 1}` })
        }
        let activePlugin = null
        if (mode === "active") {
          const installed = await api.plugins.install(new Uint8Array(pluginZip).buffer,
            `${activePluginName}.zip`, "local", undefined, true)
          if (!installed.success) throw Error(installed.error)
          const id = seeded[0].id
          const status = await api.mods.status(id)
          const plugin = status.functionMods?.find(row => row.name === activePluginName)
          if (!plugin?.digest) throw Error("Missing installed display Mod identity")
          await api.mods.approveFunction(id, plugin.pluginId, plugin.digest, status.workspace)
          const profile = {
            id: "paired-display", name: "Paired display benchmark",
            capabilities: [{ pluginId: plugin.pluginId, name: plugin.name, digest: plugin.digest }]
          }
          const initial = await api.mods.clawView(id)
          await api.mods.clawChange(id, { kind: "save", profile,
            workspace: initial.workspace, revision: initial.revision })
          for (const target of seeded) {
            const before = await api.mods.clawView(target.id)
            const after = await api.mods.clawChange(target.id, { kind: "apply", id: profile.id,
              workspace: before.workspace, revision: before.revision, bindingRevision: before.bindingRevision })
            if (after.active?.capabilities[0]?.digest !== plugin.digest) throw Error("Display Mod not applied")
          }
          activePlugin = { id: plugin.pluginId, digest: plugin.digest }
        }
        const lobby = await api.threads.create({
          title: "Paired Electron lobby",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await api.workspace.set(lobby.thread_id ?? lobby.id, workspace)
        return { targets: seeded, mode, activePlugin, persistedDirectoryCount: (await api.threads.list()).length }
      },
      {
        workspace,
        directoryCount,
        rowCount,
        targets,
        version: applications[branch].version,
        protect: options.protect,
        mode,
        protectedCanary,
        activePluginName,
        pluginZip: mode === "active" ? activePluginZip() : undefined
      }
    )
  )
  await writeFile(join(runOutput, `seed-${branch}.json`), JSON.stringify(result, null, 2))
  return { home: join(directory, "openwork"), targets: result.targets, mode }
}

async function openThread(page, target, kind, mode) {
  const title = page.getByText(target.title, { exact: true }).first()
  await title.evaluate((element, { target, requiredMarker, protectedCanary }) => {
    element.addEventListener(
      "click",
      () => {
        const started = performance.now()
        const epochStartedAt = performance.timeOrigin + started
        let sawScope = null,
          sawRow = null,
          sawText = null,
          stable = 0
        let rawCanaryFrames = 0
        const frames = { noScope: 0, noTargetRow: 0, noBody: 0, hiddenOrPending: 0, ready: 0 }
        window.pairedOpen = new Promise((resolve, reject) => {
          function frame(now) {
            const scope = document.querySelector(`[data-chat-thread-id="${target.id}"]`)
            if (scope && sawScope === null) sawScope = now - started
            const row = scope?.querySelector(`[data-chat-message-id="${target.row}"]`)
            if (row && sawRow === null) sawRow = now - started
            const marker = row?.textContent?.includes(requiredMarker)
            if (row?.textContent?.includes(protectedCanary)) rawCanaryFrames++
            if (marker && sawText === null) sawText = now - started
            const viewport = row?.closest("[data-radix-scroll-area-viewport]")
            const style = viewport?.getBoundingClientRect(),
              box = row?.getBoundingClientRect()
            const ready =
              row &&
              viewport &&
              box &&
              style &&
              box.height > 0 &&
              box.bottom > style.top &&
              box.top < style.bottom &&
              marker &&
              !row.querySelector("[data-function-site-pending]") &&
              !row.closest('[aria-hidden="true"], [inert]') &&
              row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            if (!scope) frames.noScope++
            else if (!row) frames.noTargetRow++
            else if (!marker) frames.noBody++
            else if (!ready) frames.hiddenOrPending++
            else frames.ready++
            stable = ready ? stable + 1 : 0
            if (stable >= 2)
              resolve({
                ms: now - started,
                epochStartedAt,
                scopeMs: sawScope,
                rowMs: sawRow,
                markerMs: sawText,
                frames,
                rawCanaryFrames,
                mountedRows: scope.querySelectorAll("[data-chat-message-id]").length,
                viewportHeight: viewport.clientHeight
              })
            else if (now - started >= 12_000)
              reject(new Error(`No readable row for ${target.title}`))
            else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
      },
      { once: true, capture: true }
    )
  }, { target, requiredMarker: mode === "active" ? activeMarker + target.marker : target.marker, protectedCanary })
  const started = performance.now()
  await title.click()
  const ready = await page.evaluate(() => window.pairedOpen)
  assert(ready && Number.isFinite(ready.ms), "Click did not resolve a readable row")
  return { kind, thread: target.name, driverMs: performance.now() - started, ...ready }
}

async function scrollThread(page, target, wave, diagnostic = false) {
  const viewport = page
    .locator(`[data-chat-thread-id="${target.id}"] [data-radix-scroll-area-viewport]`)
    .filter({ has: page.locator("[data-chat-message-id]") })
    .first()
  const box = await viewport.boundingBox()
  assert(box && box.height > 200, "Visible chat viewport required for native wheel input")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await viewport.evaluate((view, { diagnostic, protectedCanary }) => {
    const started = [],
      frames = []
    const visibility = {
      frames: 0, noRows: 0, noBody: 0, partial: 0, allReadable: 0,
      lostReadable: 0, rawCanaryFrames: 0, errorFrames: 0, maxBlankMs: 0
    }
    let visibleBody = new Map(), blankSince = null
    const top = view.scrollTop
    const sampleVisible = () => {
      const rect = view.getBoundingClientRect()
      const rows = [...view.querySelectorAll("[data-chat-message-id]")].filter((row) => {
        const box = row.getBoundingClientRect()
        return box.height > 0 && box.bottom > rect.top && box.top < rect.bottom
      })
      const body = new Map(rows.map((row) => [row.getAttribute("data-chat-message-id"),
          row.textContent?.includes("PAIRED_BODY_") &&
          !row.closest('[aria-hidden="true"], [inert]') &&
          row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ]))
      return { visible: rows.length, readable: [...body.values()].filter(Boolean).length, body }
    }
    let pending,
      last,
      token,
      scrollEvents = 0
    const wheel = (event) => {
      pending = {
        deltaY: event.deltaY,
        time: performance.now(),
        initialTop: view.scrollTop,
        moved: null,
        trusted: event.isTrusted
      }
      started.push(pending)
    }
    const scroll = () => {
      scrollEvents++
    }
    const frame = (now) => {
      if (started.length) {
        if (last !== undefined) frames.push(now - last)
        last = now
        if (pending && pending.moved === null && Math.abs(pending.initialTop - view.scrollTop) >= 1)
          pending.moved = Math.max(0, now - pending.time)
        if (diagnostic) {
          const sample = sampleVisible()
          visibility.frames++
          if (!sample.visible) visibility.noRows++
          else if (!sample.readable) visibility.noBody++
          else if (sample.readable < sample.visible) visibility.partial++
          else visibility.allReadable++
          for (const [id, readable] of sample.body)
            if (!readable && visibleBody.get(id)) visibility.lostReadable++
          visibleBody = sample.body
          if (view.textContent?.includes(protectedCanary)) visibility.rawCanaryFrames++
          if (view.querySelector('[data-function-site] [role="alert"]')) visibility.errorFrames++
          if (blankSince !== null) visibility.maxBlankMs = Math.max(visibility.maxBlankMs, now - blankSince)
          blankSince = sample.readable ? null : blankSince ?? now
        }
      }
      token = requestAnimationFrame(frame)
    }
    view.addEventListener("wheel", wheel, { passive: true, capture: true })
    view.addEventListener("scroll", scroll, { passive: true })
    token = requestAnimationFrame(frame)
    window.finishPairedScroll = () => {
      cancelAnimationFrame(token)
      view.removeEventListener("wheel", wheel, true)
      view.removeEventListener("scroll", scroll)
      if (blankSince !== null)
        visibility.maxBlankMs = Math.max(visibility.maxBlankMs, performance.now() - blankSince)
      const { visible, readable } = sampleVisible()
      return {
        frames,
        wheels: started,
        top,
        endTop: view.scrollTop,
        scrollEvents,
        visible,
        readable,
        viewportHeight: view.clientHeight,
        ...(diagnostic ? { visibility } : {})
      }
    }
  }, { diagnostic, protectedCanary })
  for (const delta of wheelDeltas) {
    await page.mouse.wheel(0, delta)
    await wait(wheelIntervalMs)
  }
  const result = await page.evaluate(() => window.finishPairedScroll())
  assert.equal(result.wheels.length, wheelDeltas.length)
  assert(
    result.wheels.every((wheel) => wheel.trusted),
    "Actual native wheel events required"
  )
  assert(
    result.scrollEvents >= wheelDeltas.length / 2 && result.frames.length >= 12,
    "Did not observe enough real scrolling"
  )
  assert(result.readable > 0, "No readable transcript after scrolling")
  return { wave, diagnostic, ...result }
}

async function removeRun(directory) {
  const accessible = await realpath(directory)
  const path = relative(runtime, accessible)
  assert(path && !isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..")
  await rm(accessible, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}

const observations = []
let passed = false
let comparison = null
let preflight = []
const cpuTotal = () =>
  cpus().reduce(
    (counters, cpu) => ({
      idle: counters.idle + cpu.times.idle,
      total: counters.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    }),
    { idle: 0, total: 0 }
  )

async function confirmIdle() {
  const samples = []
  let idleSamples = 0
  // Background work can linger briefly after the seed processes exit.
  for (let trial = 0; trial < 18 && idleSamples < 3; trial++) {
    const before = cpuTotal(),
      startedAt = Date.now()
    await wait(5000)
    const after = cpuTotal()
    const sample = {
      startedAt,
      durationMs: Date.now() - startedAt,
      cpuActivePercent: 100 * (1 - (after.idle - before.idle) / (after.total - before.total))
    }
    samples.push(sample)
    idleSamples = sample.cpuActivePercent <= 20 ? idleSamples + 1 : 0
  }
  await writeFile(join(runOutput, "preflight.json"), JSON.stringify(samples, null, 2))
  console.log(JSON.stringify({ preflight: samples }))
  assert(
    idleSamples === 3,
    "CPU idle criterion <= 20% unmet"
  )
  return samples
}

function statistics(values) {
  const data = values.slice().sort((a, b) => a - b)
  if (!data.length) return { count: 0 }
  const mid = Math.floor(data.length / 2)
  const median = data.length % 2 ? data[mid] : (data[mid - 1] + data[mid]) / 2
  const at = (q) => data[Math.ceil(data.length * q) - 1]
  return {
    count: data.length,
    min: data[0],
    median,
    p95: at(0.95),
    p99: at(0.99),
    max: data.at(-1)
  }
}

function laneStatistics(record) {
  const scrolls = record.scrolls.filter((scroll) => !scroll.diagnostic)
  const frames = scrolls.flatMap((scroll) => scroll.frames)
  const wheel = scrolls.flatMap((scroll) => scroll.wheels)
  return {
    firstOpenMs: record.opens[0].ms,
    firstScopeMs: record.opens[0].scopeMs,
    otherThreadMs: record.opens[1].ms,
    warmSwitch: statistics(record.opens.slice(2).map((open) => open.ms)),
    frameIntervals: statistics(frames),
    frameGaps33Ms: frames.filter((ms) => ms > 33.33).length,
    frameGaps50Ms: frames.filter((ms) => ms > 50).length,
    wheelResponse: statistics(wheel.map((wheel) => wheel.moved).filter((ms) => ms !== null)),
    wheelWithoutMotion: wheel.filter((wheel) => wheel.moved === null).length,
    visibility: record.scrolls.find((scroll) => scroll.diagnostic).visibility,
    viewportHeight: record.opens[0].viewportHeight
  }
}

function comparisonReport() {
  const left = observations.filter((record) => record.branch === "baseline")
  const right = observations.filter((record) => record.branch === "mods")
  const opens = (records, index) => statistics(records.map((record) => record.opens[index].ms))
  const paired = (index) => statistics(right.map((record, pair) => record.opens[index].ms - left[pair].opens[index].ms))
  function aggregate(records) {
    const measured = records.flatMap((record) => record.scrolls.filter((scroll) => !scroll.diagnostic))
    const visibility = records.map((record) => record.scrolls.find((scroll) => scroll.diagnostic).visibility)
    return {
      applicationReady: statistics(records.map((record) => record.applicationReadyMs)),
      firstOpen: opens(records, 0),
      firstVisitOther: opens(records, 1),
      warmSwitch: statistics(records.flatMap((record) => record.opens.slice(2).map((open) => open.ms))),
      frameIntervals: statistics(measured.flatMap((scroll) => scroll.frames)),
      wheelResponse: statistics(measured.flatMap((scroll) => scroll.wheels.flatMap(
        (wheel) => wheel.moved === null ? [] : [wheel.moved]))),
      lostReadable: visibility.reduce((sum, sample) => sum + sample.lostReadable, 0),
      errorFrames: visibility.reduce((sum, sample) => sum + sample.errorFrames, 0),
      rawCanaryFrames: visibility.reduce((sum, sample) => sum + sample.rawCanaryFrames, 0) +
        records.flatMap((record) => record.opens).reduce((sum, open) => sum + open.rawCanaryFrames, 0),
      maxBlankMs: Math.max(...visibility.map((sample) => sample.maxBlankMs)),
      modsErrors: [...new Set(records.flatMap((record) => record.modsErrors))]
    }
  }
  const baseline = aggregate(left), candidate = aggregate(right)
  const firstOpen = paired(0), firstVisitOther = paired(1)
  const deltas = {
    firstOpenMs: firstOpen.median,
    firstVisitOtherMs: firstVisitOther.median,
    warmP95Ms: candidate.warmSwitch.p95 - baseline.warmSwitch.p95,
    framesP95Ms: candidate.frameIntervals.p95 - baseline.frameIntervals.p95,
    wheelP95Ms: candidate.wheelResponse.p95 - baseline.wheelResponse.p95
  }
  const calibration = options.mode === "aa"
  const budget = budgets[calibration ? "off" : options.mode]
  const metrics = {
    firstOpenMs: budget.coldMs,
    firstVisitOtherMs: budget.coldMs,
    warmP95Ms: budget.warmP95Ms,
    framesP95Ms: budget.framesP95Ms,
    wheelP95Ms: budget.wheelP95Ms
  }
  const regressions = []
  for (const [metric, max] of Object.entries(metrics)) {
    const delta = calibration ? Math.abs(deltas[metric]) : deltas[metric]
    if (!Number.isFinite(delta) || delta > max) regressions.push({ metric, observed: delta, max })
  }
  for (const [side, result] of [["baseline", baseline], ["candidate", candidate]]) {
    const quality = { lostReadable: 0, errorFrames: 0, maxBlankMs: side === "candidate" ? budget.blankMs : 0 }
    if (side === "candidate" && options.protect) quality.rawCanaryFrames = 0
    for (const [metric, max] of Object.entries(quality))
      if (result[metric] > max) regressions.push({ side, metric, observed: result[metric], max })
    if (result.modsErrors.length) regressions.push({ side, metric: "modsErrors", observed: result.modsErrors })
  }
  const qualified = options.idle && pairedRuns >= 8 && !options["trace-ipc"] && (calibration || !!options.calibration)
  return {
    mode: options.mode,
    status: qualified ? regressions.length ? "failed" : "passed" : "diagnostic",
    fingerprint: calibrationFingerprint,
    baseline,
    candidate,
    paired: { firstOpen, firstVisitOther },
    deltas,
    budget,
    regressions
  }
}

try {
  const seeds = {}
  for (const branch of Object.keys(applications)) seeds[branch] = await seedBranch(branch)
  if (options.idle) preflight = await confirmIdle()
  for (let pair = 0; pair < pairedRuns; pair++) {
    const order = pair % 2 ? ["mods", "baseline"] : ["baseline", "mods"]
    for (const branch of order) {
      const directory = join(runtime, `${pair}-${branch}`)
      const seed = seeds[branch]
      const result = await runElectron(
        branch,
        directory,
        `${pair}-${branch}`,
        seed.home,
        async (page) => {
          const first = seed.targets[pair % 2],
            second = seed.targets[1 - (pair % 2)]
          await page.getByText(first.title, { exact: true }).first().waitFor({ state: "visible" })
          await page.getByText(second.title, { exact: true }).first().waitFor({ state: "visible" })
          // Starting from the directory avoids mixing application startup into the first click.
          assert.equal(
            await page.locator(`[data-chat-thread-id="${first.id}"]`).count(),
            0,
            "First measured thread already loaded"
          )
          await page.waitForTimeout(300)
          const opens = [await openThread(page, first, "first-open", seed.mode)]
          opens.push(await openThread(page, second, "first-visit-other-thread", seed.mode))
          for (let index = 0; index < 8; index++)
            opens.push(await openThread(page, index % 2 ? second : first, "warm-switch", seed.mode))
          const scrolls = []
          for (let wave = 0; wave < 3; wave++) scrolls.push(await scrollThread(page, second, wave))
          scrolls.push(await scrollThread(page, second, 3, true))
          return {
            opens,
            scrolls,
            windowSize: await page.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              devicePixelRatio
            }))
          }
        }
      )
      const record = { pair, order, branch, ...result }
      observations.push(record)
      await appendFile(join(runOutput, "pairs.ndjson"), JSON.stringify(record) + "\n")
      console.log(
        JSON.stringify({
          pair,
          branch,
          firstMs: result.opens[0].ms,
          scrollFrames: result.scrolls.map((scroll) => scroll.frames.length),
          windowSize: result.windowSize
        })
      )
      if (!options.keep) await removeRun(directory)
    }
  }
  passed = true
  comparison = comparisonReport()
  await writeFile(join(runOutput, "comparison.json"), JSON.stringify(comparison, null, 2))
  console.log(JSON.stringify({ gate: comparison.status, deltas: comparison.deltas, regressions: comparison.regressions }))
  if (comparison.status === "failed") process.exitCode = 1
} finally {
  await writeFile(
    join(runOutput, "observations.json"),
    JSON.stringify({ passed, gate: comparison?.status ?? null, manifest, preflight, observations }, null, 2)
  )
  const lanes = observations.map((record) => ({
    pair: record.pair,
    branch: record.branch,
    ...laneStatistics(record)
  }))
  await writeFile(join(runOutput, "lane-statistics.json"), JSON.stringify(lanes, null, 2))
  if (passed && comparison?.status !== "failed" && !options.keep) {
    for (const branch of Object.keys(applications)) await removeRun(join(runtime, `seed-${branch}`))
    await removeRun(workspace)
    await rmdir(runtime)
  }
  console.log(
    JSON.stringify({ passed, gate: comparison?.status ?? null, artifacts: runOutput,
      runtimePreserved: !passed || comparison?.status === "failed" || options.keep })
  )
}
