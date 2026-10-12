/** Actual BotFiles, authenticated public RPC, physical object store and public
 * offline backup/restore. Only the unrelated outer app store and post-RPC ACK
 * delivery timing are controlled; source inputs are copied before execution. */
import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser, type Page } from "playwright"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { executeBotBackup } from "./backups"
import { serializeBotFailure } from "./error-diagnostic"
import type { BotFileDeleteInput } from "../../shared/bot-file-lifecycle"

const enabled = process.env.CMB_FILE_DELETE_EPOCH_BROWSER_TEST === "1"
let browser: Browser, script: string, styles: string
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src")
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  styles = css.build(
    new Scanner({ sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }] }).scan()
  )
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{BotFiles}from'./src/renderer/src/components/bots/BotFiles';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{Toaster}from'sonner';window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};window.fixtureRefresh=()=>store.getState().refresh();window.fixtureLoad=async id=>{store.setState({selected:id});await store.getState().refresh()};window.fixtureSelect=id=>store.getState().select(id);window.fixtureDraft=artifact=>{const s=store.getState(),id=s.selected;s.draft(id,'CURRENT_REVIEWED_DRAFT');s.attachments(id,[{path:artifact.id,name:artifact.name,size:artifact.size}])};window.fixtureState=()=>({selected:store.getState().selected,snapshot:store.getState().snapshot,drafts:store.getState().drafts});function Fixture(){const s=store();return <main className="h-screen overflow-auto bg-background p-6 text-foreground">{s.snapshot&&s.selected&&<BotFiles key={s.selected+':'+s.snapshot.dataEpoch} conversationId={s.selected} inline/>}<Toaster/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    outfile: "file-delete-epoch-ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"fixture"'
    },
    plugins: [
      await highlightWorkerFixture(renderer),
      {
        name: "outer-app-settings-only",
        setup(b) {
          b.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (a) =>
            a.path === "./store" && !a.importer.startsWith(join(renderer, "lib"))
              ? undefined
              : { path: "app", namespace: "outer" }
          )
          b.onLoad({ filter: /.*/, namespace: "outer" }, () => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              'import{create}from"zustand";export const useAppStore=create(()=>({showCustomizeView:false}));'
          }))
        }
      }
    ]
  })
  const output = bundle.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!output) throw new Error("Missing actual BotFiles JavaScript fixture output")
  script = output.text
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  await browser?.close()
})

type Live = {
  store: BotStore
  files: BotArtifacts
  host: BotHost
  lock: BotHostLock
  server: BotRpcServer
  client: BotTransportClient
  stopped: Promise<void>
}
async function fixture(label: string) {
  const evidenceRoot = resolve("output/file-delete-epoch")
  await mkdir(evidenceRoot, { recursive: true })
  const evidenceDirectory = await realpath(await mkdtemp(join(evidenceRoot, label + "-")))
  // Match the Host's private data lifecycle; write UI evidence separately.
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-file-delete-" + label + "-")))
  await writeFile(
    join(evidenceDirectory, "fixture-root.json"),
    JSON.stringify({ root, evidenceDirectory }, null, 2) + "\n"
  )
  const seed = new BotStore(join(root, "bots.sqlite"))
  const seedFiles = new BotArtifacts(join(root, "objects"), seed)
  const a = seed.createBot({ nonce: "a", name: "A" }),
    b = seed.createBot({ nonce: "b", name: "B" })
  const bytes = Buffer.from("Immutable restored artifact")
  const artifact = await seedFiles.publish(
    {
      id: "artifact-a",
      conversationId: a.conversationId,
      runId: null,
      name: "A.txt",
      mime: "text/plain"
    },
    bytes
  )
  const currentArtifact = await seedFiles.publish(
    {
      id: "artifact-current",
      conversationId: a.conversationId,
      runId: null,
      name: "Current.txt",
      mime: "text/plain"
    },
    bytes
  )
  const other = await seedFiles.publish(
    {
      id: "artifact-b",
      conversationId: b.conversationId,
      runId: null,
      name: "B.txt",
      mime: "text/plain"
    },
    bytes
  )
  await seedFiles.close()
  seed.close()
  const backup = (await executeBotBackup(root, { action: "create", nonce: randomUUID() })).backup!
  let live: Live | undefined
  const open = async () => {
    const lock = BotHostLock.acquire(root)!
    const store = new BotStore(join(root, "bots.sqlite"))
    const files = new BotArtifacts(join(root, "objects"), store)
    await files.recover()
    const host = new BotHost(store, undefined, 1, undefined, files)
    host.bindOwnership(lock)
    host.bindIdleRestartPreflight((signal) =>
      inspectBotOwnedShellMaintenance(root, ownedShellMaintenanceOwner(lock), signal)
    )
    let done!: () => void, failed!: (error: unknown) => void
    const stopped = new Promise<void>((resolve, reject) => {
      done = resolve
      failed = reject
    })
    void stopped.catch(() => {})
    const token = randomBytes(32).toString("hex")
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-file-delete-${token.slice(0, 16)}`
        : join(tmpdir(), `cmb-fde-${token.slice(0, 24)}.sock`)
    const server = new BotRpcServer(host, token, async () => {
      try {
        await server.close()
        await host.stop()
        await files.close()
        store.close()
        lock.release()
        done()
      } catch (error) {
        failed(error)
      }
    })
    await server.listen(socket)
    const client = new BotTransportClient({
      version: 1,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    live = { store, files, host, lock, server, client, stopped }
  }
  await open()
  let page: Page | undefined,
    hold = false,
    release: (() => void) | undefined,
    held = false,
    returned = false,
    stripEpochCapability = false
  const calls: { method: string; input: unknown; epoch: string }[] = [],
    errors: string[] = []
  const createPage = async () => {
    page = await browser.newPage({ viewport: { width: 980, height: 760 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input, epoch: live!.store.dataEpoch() })
      try {
        const result: unknown = await Reflect.apply(live!.client.call, live!.client, [
          method,
          input
        ])
        if (method === "status" && stripEpochCapability) {
          const value = result as { capabilities: string[] }
          return {
            ...value,
            capabilities: value.capabilities.filter(
              (capability) => capability !== "file-delete-epoch"
            )
          }
        }
        if (method === "deleteFile" && hold) {
          hold = false
          held = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          returned = true
        }
        return result
      } catch (error) {
        return { botFailure: serializeBotFailure(error) }
      }
    })
    await page.route("http://127.0.0.1:39487/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script>`
      })
    )
    await page.goto("http://127.0.0.1:39487/")
    await page.evaluate((id) => Reflect.get(window, "fixtureLoad")(id), a.conversationId)
    await page.getByRole("button", { name: "预览 A.txt", exact: true }).waitFor()
    return page
  }
  const stop = async () => {
    if (!live) return
    const current = live
    const result = await current.client.restartIfIdle(current.host.id)
    expect(result.accepted).toBe(true)
    await current.stopped
    await current.client.closeAndWait()
    live = undefined
  }
  const restore = async (selection = backup) => {
    await stop()
    await executeBotBackup(root, {
      action: "restore",
      nonce: randomUUID(),
      backup: { id: selection.id, sha256: selection.sha256 }
    })
    await open()
    expect(live!.store.dataEpoch()).not.toBe("initial")
    expect((await live!.files.read(currentArtifact.id)).bytes).toEqual(bytes)
  }
  const settle = async () => {
    await page!.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
  }
  const close = async () => {
    release?.()
    release = undefined
    if (page) {
      await settle().catch(() => {})
      await writeFile(
        join(evidenceDirectory, "ui-final.json"),
        JSON.stringify(
          {
            calls,
            errors,
            body: await page.locator("body").innerText(),
            state: await page.evaluate(() => Reflect.get(window, "fixtureState")())
          },
          null,
          2
        ) + "\n"
      )
      await page.close()
    }
    await stop()
    await writeFile(
      join(evidenceDirectory, "proof.json"),
      JSON.stringify(
        { root, evidenceDirectory, backup, artifact, currentArtifact, other, calls, errors },
        null,
        2
      ) + "\n"
    )
  }
  return {
    root,
    evidenceDirectory,
    a,
    b,
    artifact,
    currentArtifact,
    other,
    backup,
    createPage,
    restore,
    stop,
    open,
    settle,
    close,
    calls,
    errors,
    get live() {
      return live!
    },
    hold: () => {
      hold = true
    },
    held: () => held,
    returned: () => returned,
    release: () => {
      release?.()
      release = undefined
    },
    stripCapability: () => {
      stripEpochCapability = true
    }
  }
}

it.skipIf(!enabled)(
  "an accepted old delete ACK cannot change a fresh draft or refresh the actual restored workspace",
  async () => {
    const f = await fixture("late-ack")
    try {
      const page = await f.createPage()
      f.hold()
      await page.getByRole("button", { name: "删除文件 A.txt", exact: true }).click()
      await page.getByRole("button", { name: "确认删除文件", exact: true }).click()
      await expect.poll(f.held).toBe(true)
      expect(f.live.store.artifacts(f.a.conversationId).map((file) => file.id)).toEqual([
        f.currentArtifact.id
      ])
      await f.restore()
      await page.evaluate(() => Reflect.get(window, "fixtureRefresh")())
      await page.getByRole("button", { name: "预览 Current.txt", exact: true }).waitFor()
      // The original deletion ledger correctly prevents A.txt resurrection.
      // The fresh draft refers to another verified, live restored artifact; the
      // draft port is controlled, while its ownership and physical bytes are real.
      await page.evaluate((file) => Reflect.get(window, "fixtureDraft")(file), f.currentArtifact)
      const reviewed = await page.evaluate(() => Reflect.get(window, "fixtureState")())
      const epoch = f.live.store.dataEpoch(),
        before = f.calls.filter((call) => ["snapshot", "status"].includes(call.method)).length
      f.release()
      await expect.poll(f.returned).toBe(true)
      await f.settle()
      const current = await page.evaluate(() => Reflect.get(window, "fixtureState")())
      expect(current.snapshot.dataEpoch).toBe(epoch)
      expect(current.drafts[f.a.conversationId]).toEqual(reviewed.drafts[f.a.conversationId])
      expect(f.calls.filter((call) => ["snapshot", "status"].includes(call.method))).toHaveLength(
        before
      )
      expect(f.live.store.artifacts(f.a.conversationId)).toHaveLength(1)
      expect(f.live.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(0)
      expect(f.live.store.db.exec("SELECT COUNT(*) FROM bot_messages")[0].values[0][0]).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  20_000
)

it.skipIf(!enabled)(
  "same-epoch accepted A deletion still clears A drafts after switching to B without touching B",
  async () => {
    const f = await fixture("same-epoch")
    try {
      const page = await f.createPage()
      await page.evaluate((file) => Reflect.get(window, "fixtureDraft")(file), f.artifact)
      f.hold()
      await page.getByRole("button", { name: "删除文件 A.txt", exact: true }).click()
      await page.getByRole("button", { name: "确认删除文件", exact: true }).click()
      await expect.poll(f.held).toBe(true)
      await page.evaluate((id) => Reflect.get(window, "fixtureSelect")(id), f.b.conversationId)
      await page.getByRole("button", { name: "预览 B.txt", exact: true }).waitFor()
      await page.evaluate((file) => Reflect.get(window, "fixtureDraft")(file), f.other)
      f.release()
      await expect.poll(f.returned).toBe(true)
      await f.settle()
      const current = await page.evaluate(() => Reflect.get(window, "fixtureState")())
      expect(current.selected).toBe(f.b.conversationId)
      expect(current.snapshot.dataEpoch).toBe("initial")
      expect(current.drafts[f.a.conversationId].attachments).toEqual([])
      expect(
        current.drafts[f.b.conversationId].attachments.map((file: { path: string }) => file.path)
      ).toEqual([f.other.id])
      expect(f.live.store.artifacts(f.a.conversationId).map((file) => file.id)).toEqual([
        f.currentArtifact.id
      ])
      expect(f.live.store.artifacts(f.b.conversationId)).toHaveLength(1)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  20_000
)

it.skipIf(!enabled)(
  "the replacement authenticated Host rejects the old unconsumed delete input before effects and accepts a fresh exact current scope",
  async () => {
    const f = await fixture("stale-input")
    try {
      const stale = {
        nonce: "old-unconsumed",
        conversationId: f.a.conversationId,
        id: f.artifact.id,
        sha256: f.artifact.sha256
      }
      await f.restore()
      const before = f.live.store.snapshot().cursor
      await expect(f.live.client.call("deleteFile", stale)).rejects.toMatchObject({
        code: "data_epoch"
      })
      expect(f.live.store.snapshot().cursor).toBe(before)
      expect(f.live.store.artifacts(f.a.conversationId)).toHaveLength(2)
      expect(
        f.live.store.db.exec("SELECT nonce FROM bot_receipts WHERE nonce=?", [stale.nonce])[0]
          ?.values ?? []
      ).toEqual([])
      const current = {
        ...stale,
        expectedDataEpoch: f.live.store.dataEpoch()
      } as BotFileDeleteInput
      await expect(
        f.live.client.call("deleteFile", { ...current, conversationId: f.b.conversationId })
      ).rejects.toMatchObject({ code: "artifact_scope" })
      await expect(
        f.live.client.call("deleteFile", { ...current, sha256: "0".repeat(64) })
      ).rejects.toMatchObject({ code: "artifact_changed" })
      const receipt = await f.live.client.call("deleteFile", current)
      expect(await f.live.client.call("deleteFile", current)).toEqual(receipt)
      expect(f.live.store.artifacts(f.a.conversationId).map((file) => file.id)).toEqual([
        f.currentArtifact.id
      ])
      expect(f.live.store.artifacts(f.b.conversationId)).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  20_000
)

it.skipIf(!enabled)(
  "accepted legacy receipts remain readonly Store evidence but never a success ACK on a restored authenticated Host",
  async () => {
    const f = await fixture("legacy-receipt")
    try {
      const legacy = {
        nonce: "accepted-before-backup",
        conversationId: f.a.conversationId,
        id: f.artifact.id,
        sha256: f.artifact.sha256
      }
      const receipt = await f.live.client.call("deleteFile", legacy)
      await f.stop()
      const acceptedBackup = (
        await executeBotBackup(f.root, { action: "create", nonce: randomUUID() })
      ).backup!
      await executeBotBackup(f.root, {
        action: "restore",
        nonce: randomUUID(),
        backup: { id: acceptedBackup.id, sha256: acceptedBackup.sha256 }
      })
      await f.open()
      const before = f.live.store.snapshot().cursor
      expect(f.live.store.deleteArtifact(legacy)).toEqual(receipt)
      expect(f.live.store.snapshot().cursor).toBe(before)
      await expect(f.live.client.call("deleteFile", legacy)).rejects.toMatchObject({
        code: "data_epoch"
      })
      expect(f.live.store.deleteArtifact({ ...legacy, expectedDataEpoch: undefined })).toEqual(
        receipt
      )
      expect(f.live.store.snapshot().cursor).toBe(before)
    } finally {
      await f.close()
    }
  },
  20_000
)

it.skipIf(!enabled)(
  "an advertised file lifecycle without the epoch capability cannot submit a new UI delete",
  async () => {
    const f = await fixture("legacy-capability")
    try {
      // Controlled compatibility projection of the actual status response; not a
      // claim that a separately packaged legacy Host was executed.
      f.stripCapability()
      const page = await f.createPage()
      const button = page.getByRole("button", { name: "删除文件 A.txt", exact: true })
      expect(await button.isDisabled()).toBe(true)
      expect(f.calls.filter((call) => call.method === "deleteFile")).toEqual([])
      expect(f.live.store.artifacts(f.a.conversationId)).toHaveLength(2)
      expect(f.errors).toEqual([])
    } finally {
      await f.close()
    }
  },
  20_000
)
