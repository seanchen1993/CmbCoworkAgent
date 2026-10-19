import assert from "node:assert/strict"
import { test } from "node:test"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { EventEmitter } from "node:events"
import {
  closePreview,
  disabledViteKeys,
  previewEnvironment,
  previewRecord,
  validatePreviewRecord,
  waitForPreviewExit,
  retainSignalHandlers,
  retainManualPreviewDialogs
} from "../../../deploy/dev/service/partner-preview.mjs"

test("preview isolates only App stores; no personal credentials, endpoints, or inherited proxy", () => {
  const env = previewEnvironment("/task/preview", {
    HOME: "/user",
    PATH: "/personal",
    LANG: "C",
    OPENAI_API_KEY: "secret",
    CMB_COWORK_AGENT_HOME: "/personal-data",
    VITE_RENDER_URL: "https://remote",
    HTTPS_PROXY: "https://remote"
  })
  assert.equal(env.HOME, "/user")
  assert.equal(env.CMB_COWORK_AGENT_HOME, "/task/preview/data")
  assert.equal(env.CMB_PARTNER_LOCAL_CONNECTION_FILE, "/task/connection.json")
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.VITE_RENDER_URL, undefined)
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9")
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost")
  assert(env.ELECTRON_RENDERER_URL.startsWith("file://"))
  assert(env.ELECTRON_RENDERER_URL.endsWith("/out/renderer/index.html"))
})
test("safe build discovers all Vite keys without using their private values", () => {
  assert.deepEqual(
    [
      ...disabledViteKeys([
        "VITE_ES_NODES='private'\nexport VITE_RENDER_URL=x",
        "import.meta.env.VITE_UPDATE_SERVER_URL; MAIN_VITE_CUSTOM=value; VITE_ES_NODES"
      ])
    ].sort(),
    ["MAIN_VITE_CUSTOM", "VITE_ES_NODES", "VITE_RENDER_URL", "VITE_UPDATE_SERVER_URL"]
  )
})
test("owned record rejects foreign project, profile, nonce, supervisor and child", () => {
  const entry = { project: "devclaw-bot-partner-dev", dir: "/task", nonce: "nonce" }
  const script = new URL("../../../deploy/dev/service/partner-preview.mjs", import.meta.url)
    .pathname
  const value = {
    version: 1,
    project: entry.project,
    nonce: entry.nonce,
    profile: "/task/preview-app",
    pid: 123,
    info: `birth ${process.execPath} ${script} start`,
    app: null
  }
  assert.equal(validatePreviewRecord(value, entry), value)
  for (const patch of [
    { project: "other" },
    { nonce: "other" },
    { profile: "/personal" },
    { pid: 0 },
    { info: "other-process" },
    { app: { pid: 456, info: "personal Electron" } }
  ])
    assert.throws(() => validatePreviewRecord({ ...value, ...patch }, entry), /PARTNER_PREVIEW/)
  assert.equal(
    validatePreviewRecord(
      {
        ...value,
        app: { pid: 456, info: `Electron --user-data-dir=${join(value.profile, "electron")}` }
      },
      entry
    ).app.pid,
    456
  )
})
test("stop closes App before service; close failure cannot pull service from under a live graph", async () => {
  const events = []
  await closePreview(
    {
      close: async () => {
        events.push("app")
      }
    },
    async () => {
      events.push("service")
    }
  )
  assert.deepEqual(events, ["app", "service"])
  await assert.rejects(
    closePreview(
      {
        close: async () => {
          throw Error("busy")
        }
      },
      async () => {
        events.push("must-not-stop")
      }
    ),
    /busy/
  )
  assert.deepEqual(events, ["app", "service"])
})
test("stale supervisor, reused PID, live orphan and uncertain process lookup fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devclaw-preview-record-"))
  try {
    const entry = { project: "devclaw-bot-partner-dev", dir, nonce: "nonce" }
    const script = new URL("../../../deploy/dev/service/partner-preview.mjs", import.meta.url)
      .pathname
    const value = {
      version: 1,
      project: entry.project,
      nonce: entry.nonce,
      profile: join(dir, "preview-app"),
      pid: 123,
      info: `birth ${process.execPath} ${script} start`,
      app: { pid: 456, info: `Electron --user-data-dir=${join(dir, "preview-app/electron")}` }
    }
    await writeFile(join(dir, "preview-process.json"), JSON.stringify(value), { mode: 0o600 })
    assert.equal((await previewRecord(entry, async () => null)).alive, false)
    assert.equal((await previewRecord(entry, async () => value.info)).alive, true)
    await assert.rejects(
      previewRecord(entry, async () => "reused PID"),
      /PARTNER_PREVIEW/
    )
    await assert.rejects(
      previewRecord(entry, async (pid) => (pid === 123 ? null : value.app.info)),
      /PARTNER_PREVIEW/
    )
    await assert.rejects(
      previewRecord(entry, async () => {
        throw Error("unknown")
      }),
      /unknown/
    )
  } finally {
    await rm(dir, { recursive: true })
  }
})
test("App close may precede OS process exit; wait narrowly and reject a reused PID", async () => {
  let probes = 0
  await waitForPreviewExit({ pid: 456, info: "owned" }, async () =>
    ++probes === 1 ? "owned" : null
  )
  assert.equal(probes, 2)
  await assert.rejects(
    waitForPreviewExit({ pid: 456, info: "owned" }, async () => "other"),
    /PARTNER_PREVIEW/
  )
})
test("preview retains original signal listeners; helper auto-exit cannot bypass service cleanup", () => {
  const target = new EventEmitter(),
    own = () => {},
    unrelated = () => {},
    helper = () => {}
  target.on("SIGINT", own)
  target.on("SIGTERM", unrelated)
  const previous = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, target.listeners(signal)])
  )
  target.on("SIGINT", helper)
  target.on("SIGTERM", helper)
  retainSignalHandlers(previous, target)
  assert.deepEqual(target.listeners("SIGINT"), [own])
  assert.deepEqual(target.listeners("SIGTERM"), [unrelated])
})

test("installed Playwright auto-closes unobserved dialogs; manual preview subscription leaves them untouched", () => {
  const require = createRequire(import.meta.url)
  const { DialogManager } = require(
    join(dirname(require.resolve("playwright-core/package.json")), "lib/server/dialog.js")
  )
  const page = new EventEmitter()
  page.frameManager = { frames: () => [] }
  const manager = new DialogManager({ onDialog() {} })
  manager.addDialogHandler((dialog) => dialog.page().emit("dialog", dialog))
  const actions = []
  const dialog = (type) => ({
    page: () => page,
    type: () => type,
    async close() {
      actions.push("close")
    },
    async accept() {
      actions.push("accept")
    },
    async dismiss() {
      actions.push("dismiss")
    }
  })
  const unobserved = dialog("confirm")
  manager.dialogDidOpen(unobserved)
  assert.deepEqual(actions, ["close"])
  manager.dialogWillClose(unobserved)
  actions.length = 0

  retainManualPreviewDialogs(page)
  for (const type of ["confirm", "alert", "prompt", "beforeunload"]) {
    const observed = dialog(type)
    manager.dialogDidOpen(observed)
    assert.deepEqual(actions, [])
    manager.dialogWillClose(observed)
  }
  page.emit("close")
  assert.equal(page.listenerCount("dialog"), 0)
})

test("manual dialog subscription stays until page close and cleanup retains unrelated listeners", async () => {
  const page = new EventEmitter(),
    otherPage = new EventEmitter(),
    events = []
  const unrelated = () => {}
  page.on("dialog", unrelated)
  retainManualPreviewDialogs(page)
  retainManualPreviewDialogs(otherPage)
  await closePreview(
    {
      close: async () => {
        assert.equal(page.listenerCount("dialog"), 2)
        assert.equal(otherPage.listenerCount("dialog"), 1)
        events.push("app")
        page.emit("close")
        assert.deepEqual(page.listeners("dialog"), [unrelated])
        assert.equal(page.listenerCount("close"), 0)
        assert.equal(otherPage.listenerCount("dialog"), 1)
      }
    },
    async () => {
      events.push("service")
    }
  )
  assert.deepEqual(events, ["app", "service"])
  otherPage.emit("close")
  assert.equal(otherPage.listenerCount("dialog"), 0)
})
