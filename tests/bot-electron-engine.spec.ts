/** Isolated engine compatibility probe; never connects to a user's open application. */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication } from "playwright"

async function main() {
  const require = createRequire(__filename)
  const root = await mkdtemp(join(tmpdir(), "cmb-bot-engine-"))
  const entry = join(root, "engine.cjs")
  await writeFile(
    entry,
    `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "profile"))});
app.on('window-all-closed', () => {});
app.whenReady();`
  )
  let application: ElectronApplication | undefined
  try {
    application = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 20_000
    })
    const app = application
    const create = async () => {
      const opened = app.waitForEvent("window", { timeout: 10_000 })
      const id = await app.evaluate(async ({ BrowserWindow }) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
        })
        await win.loadURL("about:blank")
        return win.webContents.id
      })
      await opened
      return id
    }
    const a = await create(),
      b = await create()
    const pairs = await Promise.all(
      app
        .windows()
        .map(async (page) => ({
          page,
          id: await (await app.browserWindow(page)).evaluate((win) => win.webContents.id)
        }))
    )
    assert.equal(pairs.length, 2)
    assert.notEqual(a, b)
    const first = pairs.find((pair) => pair.id === a)!.page,
      second = pairs.find((pair) => pair.id === b)!.page
    await first.setContent("<label>Name <input></label>")
    await second.setContent("<label>Name <input></label>")
    await first.getByLabel("Name").fill("Bot A 中文")
    assert.equal(await second.getByLabel("Name").inputValue(), "")
    assert.equal(await first.getByLabel("Name").inputValue(), "Bot A 中文")
    await app.evaluate(async ({ session }) => {
      await session.defaultSession.cookies.set({
        url: "https://example.test",
        name: "engine_probe",
        value: "persisted",
        expirationDate: Date.now() / 1000 + 3600
      })
      await session.defaultSession.cookies.flushStore()
    })
    await app.close()
    application = undefined
    application = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      timeout: 20_000
    })
    const cookies = await application.evaluate(({ session }) =>
      session.defaultSession.cookies.get({ name: "engine_probe" })
    )
    assert.equal(cookies[0]?.value, "persisted")
    console.log(
      "PASS: bundled Electron engine, exact WebContents ownership, same-URL input isolation, persistent login storage, process restart."
    )
  } finally {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
