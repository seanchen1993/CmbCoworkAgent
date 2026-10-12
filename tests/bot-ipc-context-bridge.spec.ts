/** Real IPC + isolated preload + main-world renderer facade. No Host/model needed. */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron, type ElectronApplication } from "playwright"

type FixtureMethods = Record<string, (input: Record<string, unknown>) => Promise<unknown>>
type FixtureWindow = Window & { fixture: { bots: FixtureMethods; host: FixtureMethods } }

async function main(): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "cmb-bot-bridge-"))
  let app: ElectronApplication | undefined
  try {
    await build({
      stdin: {
        contents: `import {contextBridge} from 'electron';
          import {createCoworkBotAPI,createBotHostControlAPI} from './src/preload/bot-api';
          contextBridge.exposeInMainWorld('api',{bots:createCoworkBotAPI(),botHost:createBotHostControlAPI()});`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: join(folder, "preload.cjs")
    })
    await build({
      stdin: {
        contents: `import {botApi,botHostApi} from './src/renderer/src/lib/bot-api';
          window.fixture = {bots:botApi,host:botHostApi};`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: join(folder, "renderer.js")
    })
    await writeFile(
      join(folder, "index.html"),
      '<html><body><script src="renderer.js"></script></body></html>'
    )
    await writeFile(
      join(folder, "main.cjs"),
      `
      const {app,BrowserWindow,ipcMain}=require('electron');
      app.setPath('userData',require('path').join(__dirname,'data'));
      for(const method of ['runRoutine','send','retryMemory','host:restart']) ipcMain.handle('bots:'+method,(_,input)=>{
        if(input.nonce==='lost') throw new Error('fixture transport disconnected');
        if(input.nonce==='accepted') return {id:'accepted',status:'queued'};
        return {botFailure:{code:method==='host:restart'?'host_busy':'version_conflict',message:'请确认新版本'}};
      });
      app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{preload:require('path').join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(require('path').join(__dirname,'index.html'));});
    `
    )
    const env: Record<string, string> = { HOME: folder, USERPROFILE: folder, TMPDIR: folder }
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value &&
        /^(path|systemroot|windir|comspec|pathext|display|xauthority|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang)$/i.test(
          key
        )
      )
        env[key] = value
    }
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), join(folder, "main.cjs")],
      env,
      timeout: 30_000
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as FixtureWindow).fixture))
    const result = await page.evaluate(async () => {
      const fixture = (window as FixtureWindow).fixture
      const errors = []
      for (const operation of ["runRoutine", "send", "retryMemory", "restart"]) {
        try {
          await (operation === "restart" ? fixture.host : fixture.bots)[operation]({
            id: "routine",
            revision: 1,
            nonce: "stale",
            hostId: "host"
          })
        } catch (error) {
          errors.push({
            code: (error as { code?: string }).code,
            message: (error as Error).message,
            isError: error instanceof Error
          })
        }
      }
      let unknown = null
      try {
        await fixture.bots.runRoutine({ nonce: "lost" })
      } catch (error) {
        unknown = {
          code: (error as { code?: string }).code ?? null,
          message: (error as Error).message
        }
      }
      return {
        errors,
        unknown,
        accepted: await fixture.bots.runRoutine({ nonce: "accepted" }),
        raw: await window.api.bots.runRoutine({ id: "routine", nonce: "stale", revision: 1 })
      }
    })
    assert.deepEqual(
      result.errors.map((item) => item.code),
      ["version_conflict", "version_conflict", "version_conflict", "host_busy"]
    )
    assert.ok(result.errors.every((item) => item.isError && item.message === "请确认新版本"))
    assert.deepEqual(result.raw, {
      botFailure: { code: "version_conflict", message: "请确认新版本" }
    })
    assert.deepEqual(result.accepted, { id: "accepted", status: "queued" })
    assert.equal(result.unknown?.code, null)
    assert.match(result.unknown!.message, /transport disconnected/)
    console.log(
      "PASS real Electron IPC/contextBridge: domain codes, readable Error, raw envelope, success and unknown failure"
    )
  } finally {
    await app?.close()
    await rm(folder, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
